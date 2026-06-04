import { mkdirSync, statSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, extname, resolve as resolvePath } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  redactSecrets,
  type ApprovalRequest,
  type ArtifactType,
  type CreateApprovalRequestInput,
  type MediaJob,
  type MediaJobStatus,
  type ProviderPreset,
  type RunArtifact,
  type RunStore,
  type SecretResolver,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import {
  executeMediaJob as executeMediaAdapterJob,
  resolveMediaVendorTransportGateConfig,
  type MediaExecutionArtifact,
} from "@ling-stack/providers";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { normalizeArtifactPath } from "../../shared/path.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { writeJson } from "../../shared/response.js";
import { formatTimestampSlug } from "../../shared/time.js";
import { resolveProviderSecret } from "../providers/secrets.js";
import { assertMediaJobProvider, createMediaAdapterForProvider } from "./provider.js";

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_PREVIEW_LIMIT = 1_200;
const MEDIA_RUNTIME_SEMAPHORE_TTL_MS = 6 * 60 * 60 * 1000;

export interface MediaRuntimeStartRequest {
  readonly store: RunStore;
  readonly kind: "media_job";
  readonly ownerType: "media_job";
  readonly ownerId: string;
  readonly providerPresetId: string;
  readonly linkedMediaJobId: string;
  readonly idempotencyKey: string;
  readonly request: {
    readonly mediaJobId: string;
    readonly providerPresetId: string;
    readonly operation: string;
  };
}

export interface MediaRuntimeHandle {
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
}

export interface MediaRuntimeTerminalTransitionRequest {
  readonly store: RunStore;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly event: "runner_succeeded" | "runner_failed";
  readonly attemptStatus: "succeeded" | "failed";
  readonly runtimeEventType: "work_unit_succeeded" | "work_unit_failed";
  readonly actor: "provider";
  readonly now: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface RunMediaJobHooks {
  readonly expirePendingMediaApprovals: (store: RunStore, mediaJobId: string) => void;
  readonly startRuntimeWorkUnit: (input: MediaRuntimeStartRequest) => MediaRuntimeHandle;
  readonly transitionRuntimeWorkUnitTerminal: (input: MediaRuntimeTerminalTransitionRequest) => void;
}

type MediaCostApprovalGateResult =
  | { readonly kind: "not_required" }
  | { readonly kind: "approved"; readonly approval: ApprovalRequest }
  | { readonly kind: "waiting_for_approval"; readonly mediaJob: MediaJob; readonly approval: ApprovalRequest }
  | { readonly kind: "blocked"; readonly mediaJob: MediaJob; readonly approval: ApprovalRequest };

export async function handleRunMediaJob(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  mediaJobId: string,
  hooks: RunMediaJobHooks,
): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  let store: RunStore | undefined;
  let job: MediaJob | undefined;
  let supervised: MediaRuntimeHandle | undefined;
  let startedExecution = false;
  try {
    store = storeRegistry.getStore(cwd);
    job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Media job not found: ${mediaJobId}` });
      return;
    }
    if (!isRunnableMediaJobStatus(job.status)) {
      writeJson(response, 409, {
        error: "media_job_not_runnable",
        message: `Media job cannot be run from status ${job.status}: ${mediaJobId}`,
      });
      return;
    }

    const provider = assertMediaJobProvider(store, {
      providerPresetId: job.providerPresetId,
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
    }, secretResolver);
    const mediaSecret = provider.apiKeyRef ? resolveProviderSecret(store, provider, secretResolver) : undefined;
    const mediaSecretValues = [mediaSecret?.value];

    const approvalGate = applyMediaCostApprovalGate(store, job, provider, hooks);
    if (approvalGate.kind === "waiting_for_approval") {
      writeJson(response, 200, { mediaJob: approvalGate.mediaJob, approval: approvalGate.approval, artifacts: [] });
      return;
    }
    if (approvalGate.kind === "blocked") {
      writeJson(response, 200, { mediaJob: approvalGate.mediaJob, approval: approvalGate.approval, artifacts: [] });
      return;
    }

    supervised = hooks.startRuntimeWorkUnit({
      store,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: job.id,
      providerPresetId: job.providerPresetId,
      linkedMediaJobId: job.id,
      idempotencyKey: `media_job:${job.id}:${job.status}`,
      request: {
        mediaJobId: job.id,
        providerPresetId: job.providerPresetId,
        operation: job.operation,
      },
    });
    const semaphore = store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "media_provider",
      resourceKey: provider.id,
      limit: 2,
      ownerType: "work_unit_attempt",
      ownerId: supervised.attempt.id,
      workUnitId: supervised.workUnit.id,
      attemptId: supervised.attempt.id,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + MEDIA_RUNTIME_SEMAPHORE_TTL_MS).toISOString(),
    });
    if (!semaphore) {
      throw new HttpError(409, "runtime_semaphore_conflict", `Media provider is busy: ${provider.id}`);
    }
    store.appendRuntimeEvent({
      workUnitId: supervised.workUnit.id,
      attemptId: supervised.attempt.id,
      type: "semaphore_acquired",
      actor: "system",
      ts: new Date().toISOString(),
      data: { id: semaphore.id, resourceType: semaphore.resourceType, resourceKey: semaphore.resourceKey },
    });

    job = store.updateMediaJobStatus(job.id, { status: "running", errorMessage: null }, new Date().toISOString()) ?? job;
    startedExecution = true;

    const requestedAt = new Date().toISOString();
    const execution = await executeMediaAdapterJob(createMediaAdapterForProvider(store, provider, secretResolver), {
      jobId: job.id,
      provider: {
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        providerId: provider.providerId,
        model: provider.model,
        api: provider.api,
        baseUrl: provider.baseUrl,
        apiKeyRef: provider.apiKeyRef,
        capabilities: provider.capabilities,
      },
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
      requestedAt,
    });

    if (execution.status === "failed") {
      const failed = store.updateMediaJobStatus(
        job.id,
        {
          status: "failed",
          errorMessage: execution.errorMessage ?? "Media adapter execution failed.",
        },
        new Date().toISOString(),
      ) ?? job;
      hooks.transitionRuntimeWorkUnitTerminal({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        event: "runner_failed",
        attemptStatus: "failed",
        runtimeEventType: "work_unit_failed",
        actor: "provider",
        now: new Date().toISOString(),
        errorCode: "media_adapter_failed",
        errorMessage: execution.errorMessage ?? "Media adapter execution failed.",
      });
      writeJson(response, 200, { mediaJob: failed, artifacts: [] });
      return;
    }

    const completedAt = new Date().toISOString();
    const artifacts = createMediaJobArtifacts(store, job, execution.artifacts, completedAt, mediaSecretValues);
    const artifactIds = [...new Set([...job.artifactIds, ...artifacts.map((artifact) => artifact.id)])];
    const succeeded = store.updateMediaJobStatus(
      job.id,
      {
        status: "succeeded",
        artifactIds,
        errorMessage: null,
      },
      completedAt,
    ) ?? job;
    for (const artifact of artifacts) {
      store.appendRuntimeEvent({
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        type: "artifact_created",
        actor: "provider",
        ts: completedAt,
        data: { artifactId: artifact.id, title: artifact.title, path: artifact.path },
      });
    }
    hooks.transitionRuntimeWorkUnitTerminal({
      store,
      workUnitId: supervised.workUnit.id,
      attemptId: supervised.attempt.id,
      event: "runner_succeeded",
      attemptStatus: "succeeded",
      runtimeEventType: "work_unit_succeeded",
      actor: "provider",
      now: completedAt,
    });

    writeJson(response, 200, { mediaJob: succeeded, artifacts });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : startedExecution ? 500 : 400;
    const provider = store && job ? store.getProviderPreset(job.providerPresetId) : undefined;
    const mediaSecret = store && provider?.apiKeyRef ? resolveProviderSecret(store, provider, secretResolver) : undefined;
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [mediaSecret?.value]);
    const failed = store && job && startedExecution
      ? store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, new Date().toISOString())
      : undefined;
    if (store && supervised) {
      hooks.transitionRuntimeWorkUnitTerminal({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        event: "runner_failed",
        attemptStatus: "failed",
        runtimeEventType: "work_unit_failed",
        actor: "provider",
        now: new Date().toISOString(),
        errorCode: error instanceof HttpError ? error.code : "media_job_execution_failed",
        errorMessage: message,
      });
    }
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : startedExecution ? "media_job_execution_failed" : "bad_request",
      message,
      ...(failed ? { mediaJob: failed } : {}),
    });
  } finally {
    if (store && supervised) {
      store.releaseRuntimeSemaphoreSlotsForOwner(supervised.attempt.id, new Date().toISOString(), "media-job-finished");
    }
  }
}

function applyMediaCostApprovalGate(
  store: RunStore,
  job: MediaJob,
  provider: ProviderPreset,
  hooks: RunMediaJobHooks,
): MediaCostApprovalGateResult {
  const gate = resolveMediaVendorTransportGateConfig(provider.compat);
  if (!gate.ok || gate.config?.mode !== "live") {
    return { kind: "not_required" };
  }

  hooks.expirePendingMediaApprovals(store, job.id);
  const approvals = store
    .listApprovalRequests({ mediaJobId: job.id, limit: 500 })
    .filter((approval) => approval.actionType === "media_cost");

  for (const approval of approvals) {
    if (approval.status === "pending") {
      return {
        kind: "waiting_for_approval",
        mediaJob: markMediaJobWaitingForApproval(store, job),
        approval,
      };
    }
    if (approval.status === "approved") {
      return { kind: "approved", approval };
    }
    if (approval.status === "denied" || approval.status === "expired") {
      return {
        kind: "blocked",
        mediaJob: failMediaJobForApprovalDecision(store, job, approval),
        approval,
      };
    }
  }

  const approval = store.createApprovalRequest(createMediaCostApprovalInput(job, provider), new Date().toISOString());
  return {
    kind: "waiting_for_approval",
    mediaJob: markMediaJobWaitingForApproval(store, job),
    approval,
  };
}

function createMediaCostApprovalInput(job: MediaJob, provider: ProviderPreset): CreateApprovalRequestInput {
  return {
    mediaJobId: job.id,
    actionType: "media_cost",
    risk: "high",
    title: "Approve media job cost",
    description: `${provider.displayName} ${job.operation} requires approval before live media execution.`,
    payload: {
      type: "media_cost",
      providerPresetId: provider.id,
      model: provider.model,
      operation: job.operation,
      promptPreview: truncatePreview(job.prompt),
    },
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function markMediaJobWaitingForApproval(store: RunStore, job: MediaJob): MediaJob {
  if (job.status === "waiting_for_approval" && !job.errorMessage) {
    return job;
  }
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "waiting_for_approval",
      errorMessage: null,
    },
    new Date().toISOString(),
  ) ?? job;
}

function failMediaJobForApprovalDecision(store: RunStore, job: MediaJob, approval: ApprovalRequest): MediaJob {
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "failed",
      errorMessage: `Media cost approval ${approval.status} before live media execution.`,
    },
    new Date().toISOString(),
  ) ?? job;
}

function createMediaJobArtifacts(
  store: RunStore,
  job: MediaJob,
  candidates: readonly MediaExecutionArtifact[],
  createdAt: string,
  extraSecrets: readonly (string | undefined)[] = [],
): RunArtifact[] {
  return candidates
    .map((candidate, index) => createMediaJobArtifact(store, job, candidate, index, createdAt, extraSecrets))
    .filter((artifact): artifact is RunArtifact => Boolean(artifact));
}

function createMediaJobArtifact(
  store: RunStore,
  job: MediaJob,
  candidate: MediaExecutionArtifact,
  index: number,
  createdAt: string,
  extraSecrets: readonly (string | undefined)[] = [],
): RunArtifact | undefined {
  if (candidate.content === undefined && candidate.contentBytes === undefined) {
    return undefined;
  }
  const artifactDir = resolvePath(store.paths.artifactsDir, "media_jobs", job.id);
  mkdirSync(artifactDir, { recursive: true });
  const relativePath = normalizeArtifactPath(`media_jobs/${job.id}/${formatMediaArtifactFilename(index, candidate, createdAt)}`);
  const absolutePath = resolvePath(store.paths.artifactsDir, relativePath);
  if (candidate.contentBytes !== undefined) {
    writeFileSync(absolutePath, Buffer.from(candidate.contentBytes));
  } else {
    const content = redactMediaArtifactContent(candidate.content ?? "", extraSecrets);
    writeFileSync(absolutePath, content, "utf8");
  }
  const stats = statSync(absolutePath);

  return store.createArtifact({
    mediaJobId: job.id,
    type: candidate.type,
    path: relativePath,
    title: candidate.title,
    contentType: candidate.contentType ?? contentTypeForArtifactType(candidate.type),
    sizeBytes: Number(stats.size),
    createdAt,
  });
}

function formatMediaArtifactFilename(index: number, candidate: MediaExecutionArtifact, createdAt: string): string {
  const hintedName = candidate.pathHint ? basename(candidate.pathHint) : "";
  const titleSlug = (hintedName || candidate.title)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `artifact-${formatTimestampSlug(createdAt)}`;
  const extension = extname(titleSlug) ? "" : `.${artifactExtensionForType(candidate.type)}`;
  return `${String(index + 1).padStart(3, "0")}-${titleSlug}${extension}`;
}

function artifactExtensionForType(type: ArtifactType): string {
  if (type === "markdown") {
    return "md";
  }
  if (type === "diff") {
    return "diff";
  }
  if (type === "json") {
    return "json";
  }
  if (type === "log") {
    return "log";
  }
  if (type === "image") {
    return "png";
  }
  if (type === "video") {
    return "mp4";
  }
  return "txt";
}

function contentTypeForArtifactType(type: ArtifactType): string {
  if (type === "json") {
    return "application/json; charset=utf-8";
  }
  if (type === "markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (type === "diff") {
    return "text/x-diff; charset=utf-8";
  }
  if (type === "log" || type === "file") {
    return "text/plain; charset=utf-8";
  }
  if (type === "image") {
    return "image/png";
  }
  if (type === "video") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

function redactMediaArtifactContent(content: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const redacted = redactSecrets(content, extraSecrets);
  return typeof redacted === "string" ? redacted : content;
}

function truncatePreview(value: string, limit = APPROVAL_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function isRunnableMediaJobStatus(status: MediaJobStatus): boolean {
  return status === "queued" || status === "waiting_for_approval" || status === "failed" || status === "cancelled";
}

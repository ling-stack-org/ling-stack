import { mkdirSync, statSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, extname, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  normalizeProviderPresetForMediaRuntime,
  redactSecrets,
  resolveMediaProviderRuntimeState,
  type ApprovalRequest,
  type ArtifactType,
  type MediaJob,
  type MediaJobStatus,
  type MediaStoreFacet,
  type ProviderPreset,
  type ProviderStoreFacet,
  type RunArtifact,
  type RunExecutionStoreFacet,
  type RunStorePathsFacet,
  type RuntimeSupervisorStoreFacet,
  type SecretResolver,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import {
  executeMediaJob as executeMediaAdapterJob,
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

const MEDIA_RUNTIME_SEMAPHORE_TTL_MS = 6 * 60 * 60 * 1000;

type MediaExecutionStore =
  MediaStoreFacet &
  ProviderStoreFacet &
  RunExecutionStoreFacet &
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet;
type MediaRuntimeStartStore =
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet &
  RunExecutionStoreFacet;
type MediaRuntimeTerminalStore = RuntimeSupervisorStoreFacet;
type MediaApprovalDecisionStore = MediaStoreFacet & ProviderStoreFacet;
type MediaReadinessStore = ProviderStoreFacet;
type MediaArtifactStore = RunStorePathsFacet & RunExecutionStoreFacet;

export interface MediaRuntimeStartRequest {
  readonly store: MediaRuntimeStartStore;
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
  readonly store: MediaRuntimeTerminalStore;
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
  readonly startRuntimeWorkUnit: (input: MediaRuntimeStartRequest) => MediaRuntimeHandle;
  readonly transitionRuntimeWorkUnitTerminal: (input: MediaRuntimeTerminalTransitionRequest) => void;
}

export interface MediaJobExecutionResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

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

  const result = await runMediaJobExecution({
    cwd,
    storeRegistry,
    secretResolver,
    mediaJobId,
    hooks,
  });
  writeJson(response, result.statusCode, result.body);
}

export async function runMediaJobExecution(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly mediaJobId: string;
  readonly hooks: RunMediaJobHooks;
}): Promise<MediaJobExecutionResult> {
  let store: MediaExecutionStore | undefined;
  let job: MediaJob | undefined;
  let supervised: MediaRuntimeHandle | undefined;
  let startedExecution = false;
  try {
    store = input.storeRegistry.getStore(input.cwd);
    job = store.getMediaJob(input.mediaJobId);
    if (!job) {
      return {
        statusCode: 404,
        body: { error: "media_job_not_found", message: `Generation task not found: ${input.mediaJobId}` },
      };
    }
    if (!isRunnableMediaJobStatus(job.status)) {
      return {
        statusCode: 409,
        body: {
          error: "media_job_not_runnable",
          message: `Generation task cannot be run from status ${job.status}: ${input.mediaJobId}`,
        },
      };
    }

    const provider = assertMediaJobProvider(store, {
      providerPresetId: job.providerPresetId,
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
    }, input.secretResolver);
    const liveReadiness = resolveLiveMediaExecutionReadiness(store, provider, job.operation, input.secretResolver);
    if (!liveReadiness.ok) {
      const failed = store.updateMediaJobStatus(
        job.id,
        { status: "failed", errorMessage: liveReadiness.message },
        new Date().toISOString(),
      ) ?? job;
      return {
        statusCode: 400,
        body: {
          error: liveReadiness.code,
          message: liveReadiness.message,
          mediaJob: failed,
          artifacts: [],
        },
      };
    }
    const mediaSecret = provider.apiKeyRef ? resolveProviderSecret(store, provider, input.secretResolver) : undefined;
    const mediaSecretValues = [mediaSecret?.value];

    supervised = input.hooks.startRuntimeWorkUnit({
      store,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: job.id,
      providerPresetId: job.providerPresetId,
      linkedMediaJobId: job.id,
      idempotencyKey: `media_job:${job.id}:${randomUUID()}`,
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
      throw new HttpError(409, "runtime_semaphore_conflict", `Generation model is busy: ${provider.id}`);
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
    const execution = await executeMediaAdapterJob(createMediaAdapterForProvider(store, provider, input.secretResolver), {
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
      input.hooks.transitionRuntimeWorkUnitTerminal({
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
      return { statusCode: 200, body: { mediaJob: failed, artifacts: [] } };
    }

    const completedAt = new Date().toISOString();
    if (!mediaExecutionHasRequiredArtifact(execution.artifacts, job.operation)) {
      const message = "生成供应商没有返回可用的图片或视频结果，请检查模型、权限和返回格式。";
      const failed = store.updateMediaJobStatus(
        job.id,
        {
          status: "failed",
          errorMessage: message,
        },
        completedAt,
      ) ?? job;
      input.hooks.transitionRuntimeWorkUnitTerminal({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        event: "runner_failed",
        attemptStatus: "failed",
        runtimeEventType: "work_unit_failed",
        actor: "provider",
        now: completedAt,
        errorCode: "media_artifact_missing",
        errorMessage: message,
      });
      return { statusCode: 200, body: { mediaJob: failed, artifacts: [] } };
    }
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
    input.hooks.transitionRuntimeWorkUnitTerminal({
      store,
      workUnitId: supervised.workUnit.id,
      attemptId: supervised.attempt.id,
      event: "runner_succeeded",
      attemptStatus: "succeeded",
      runtimeEventType: "work_unit_succeeded",
      actor: "provider",
      now: completedAt,
    });

    return { statusCode: 200, body: { mediaJob: succeeded, artifacts } };
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : startedExecution ? 500 : 400;
    const provider = store && job ? store.getProviderPreset(job.providerPresetId) : undefined;
    const mediaSecret = store && provider?.apiKeyRef ? resolveProviderSecret(store, provider, input.secretResolver) : undefined;
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [mediaSecret?.value]);
    const failed = store && job && startedExecution
      ? store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, new Date().toISOString())
      : undefined;
    if (store && supervised) {
      input.hooks.transitionRuntimeWorkUnitTerminal({
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
    return {
      statusCode,
      body: {
        error: error instanceof HttpError ? error.code : startedExecution ? "media_job_execution_failed" : "bad_request",
        message,
        ...(failed ? { mediaJob: failed } : {}),
      },
    };
  } finally {
    if (store && supervised) {
      store.releaseRuntimeSemaphoreSlotsForOwner(supervised.attempt.id, new Date().toISOString(), "media-job-finished");
    }
  }
}

export function syncMediaJobForApprovalDecision(input: {
  readonly cwd: string;
  readonly store: MediaApprovalDecisionStore;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly approval: ApprovalRequest;
  readonly hooks: RunMediaJobHooks;
  readonly now: string;
}): MediaJob | undefined {
  const { approval } = input;
  if (approval.actionType !== "media_cost" || !approval.mediaJobId) {
    return undefined;
  }

  const job = input.store.getMediaJob(approval.mediaJobId);
  if (!job) {
    return undefined;
  }

  if (approval.status === "approved") {
    const currentJob = job.status === "waiting_for_approval"
      ? input.store.updateMediaJobStatus(job.id, { status: "queued", errorMessage: null }, input.now) ?? job
      : job;
    void runMediaJobExecution({
      cwd: input.cwd,
      storeRegistry: input.storeRegistry,
      secretResolver: input.secretResolver,
      mediaJobId: job.id,
      hooks: input.hooks,
    }).catch((error) => {
      const latest = input.store.getMediaJob(job.id);
      if (!latest || latest.status === "succeeded" || latest.status === "failed" || latest.status === "cancelled") {
        return;
      }
      const provider = input.store.getProviderPreset(latest.providerPresetId);
      const mediaSecret = provider?.apiKeyRef ? resolveProviderSecret(input.store, provider, input.secretResolver) : undefined;
      const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [mediaSecret?.value]);
      input.store.updateMediaJobStatus(latest.id, { status: "failed", errorMessage: message }, new Date().toISOString());
    });
    return input.store.getMediaJob(job.id) ?? currentJob;
  }

  if ((approval.status === "denied" || approval.status === "expired") && job.status === "waiting_for_approval") {
    return failMediaJobForApprovalDecision(input.store, job, approval);
  }

  return job;
}

function resolveLiveMediaExecutionReadiness(
  store: MediaReadinessStore,
  provider: ProviderPreset,
  operation: MediaJob["operation"],
  secretResolver: SecretResolver,
): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string } {
  const normalizedProvider = normalizeProviderPresetForMediaRuntime(provider);
  const state = resolveMediaProviderRuntimeState(normalizedProvider, operation);
  if (state.reason === "live_transport_invalid") {
    return {
      ok: false,
      code: "invalid_request",
      message: "生成模型真实生成配置无效，请在模型工作台重新保存。",
    };
  }
  if (state.reason === "live_transport_required") {
    return {
      ok: false,
      code: "live_media_transport_required",
      message: "当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。",
    };
  }
  if (state.reason === "base_url_missing") {
    return { ok: false, code: "bad_request", message: "生成模型缺少 Base URL，请在模型工作台补充后重试。" };
  }
  if (!normalizedProvider.apiKeyRef) {
    return { ok: false, code: "secret_missing", message: "生成模型缺少 API Key，请在模型工作台补充后重试。" };
  }
  const secret = resolveProviderSecret(store, normalizedProvider, secretResolver);
  if (!secret.configured) {
    return { ok: false, code: "secret_missing", message: "生成模型 API Key 尚未配置，请在模型工作台保存密钥后重试。" };
  }
  if (state.reason === "unsupported_live_adapter" || !state.liveAdapterSupported) {
    return {
      ok: false,
      code: "unsupported_capability",
      message: "当前只支持 OpenAI Images 图片生成、Seedream 图片生成和 Seedance 视频生成的真实执行，其他生成模型暂未接入真实生成。",
    };
  }
  if (!state.canRun) {
    return {
      ok: false,
      code: state.reason ?? "unsupported_capability",
      message: "当前生成模型尚未满足真实生成条件，请在模型工作台检查配置。",
    };
  }
  return { ok: true };
}

function mediaExecutionHasRequiredArtifact(
  artifacts: readonly MediaExecutionArtifact[],
  operation: MediaJob["operation"],
): boolean {
  if (operation === "image_generate" || operation === "image_edit") {
    return artifacts.some((artifact) => artifact.type === "image" && artifact.contentBytes !== undefined);
  }
  if (operation === "video_generate") {
    return artifacts.some((artifact) => artifact.type === "video" && artifact.contentBytes !== undefined);
  }
  return false;
}

function failMediaJobForApprovalDecision(store: MediaStoreFacet, job: MediaJob, approval: ApprovalRequest): MediaJob {
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
  store: MediaArtifactStore,
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
  store: MediaArtifactStore,
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

function isRunnableMediaJobStatus(status: MediaJobStatus): boolean {
  return status === "queued" || status === "waiting_for_approval" || status === "failed" || status === "cancelled";
}

import type { ServerResponse } from "node:http";
import {
  type ApprovalRequest,
  type MediaJob,
  type MediaStoreFacet,
  type ProviderStoreFacet,
  type RunExecutionStoreFacet,
  type RunStorePathsFacet,
  type RuntimeSupervisorStoreFacet,
  type SecretResolver,
  type WorkUnit,
  type WorkUnitAttempt,
} from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { writeJson } from "../../shared/response.js";
import { resolveProviderSecret } from "../providers/secrets.js";
import {
  recoverPendingConversationMediaWorkUnits,
  synchronizeConversationMediaWorkUnitTerminal,
} from "./conversation-runtime-recovery.js";
import { resumePendingProviderMediaJobs, runProviderMediaJobExecution } from "./provider-executor.js";
import { resumePendingWorkflowMediaJobs, runWorkflowMediaJobExecution } from "./workflows/workflow-executor.js";

type MediaRuntimeStartStore =
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet &
  RunExecutionStoreFacet;
type MediaRuntimeTerminalStore = RuntimeSupervisorStoreFacet;
type MediaApprovalDecisionStore = MediaStoreFacet & ProviderStoreFacet;

export interface MediaRuntimeStartRequest {
  readonly store: MediaRuntimeStartStore;
  readonly kind: "media_job";
  readonly ownerType: "media_job";
  readonly ownerId: string;
  readonly providerPresetId?: string;
  readonly linkedMediaJobId: string;
  readonly idempotencyKey: string;
  readonly request: {
    readonly mediaJobId: string;
    readonly providerPresetId?: string;
    readonly workflowVersionId?: string;
    readonly operation: string;
  };
}

export interface MediaRuntimeHandle {
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
}

export interface MediaRuntimeRecoveryRequest {
  readonly store: MediaRuntimeStartStore;
  readonly workUnit: WorkUnit;
  readonly reason: string;
  readonly providerPresetId?: string;
}

export interface MediaRuntimeTerminalTransitionRequest {
  readonly store: MediaRuntimeTerminalStore;
  readonly workUnitId: string;
  readonly attemptId: string;
  readonly event: "runner_succeeded" | "runner_failed";
  readonly attemptStatus: "succeeded" | "failed";
  readonly runtimeEventType: "work_unit_succeeded" | "work_unit_failed";
  readonly actor: "provider" | "system";
  readonly now: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface RunMediaJobHooks {
  readonly startRuntimeWorkUnit: (input: MediaRuntimeStartRequest) => MediaRuntimeHandle;
  readonly recoverRuntimeWorkUnit: (input: MediaRuntimeRecoveryRequest) => MediaRuntimeHandle | undefined;
  readonly transitionRuntimeWorkUnitTerminal: (input: MediaRuntimeTerminalTransitionRequest) => void;
  readonly transitionRuntimeWorkUnitCancelled: (input: {
    readonly store: MediaRuntimeTerminalStore;
    readonly workUnitId: string;
    readonly attemptId: string;
    readonly reason: string;
  }) => void;
  readonly onMediaJobProjectionChanged?: (input: {
    readonly cwd: string;
    readonly mediaJobId: string;
    readonly createdArtifactIds?: readonly string[];
  }) => void;
}

export interface MediaJobExecutionResult {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

export interface RunMediaJobExecutionInput {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly mediaJobId: string;
  readonly hooks: RunMediaJobHooks;
  /** Only the explicit POST /run action may revive a terminal job. */
  readonly retryTerminal?: boolean;
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
    retryTerminal: true,
  });
  writeJson(response, result.statusCode, result.body);
}

export async function runMediaJobExecution(input: RunMediaJobExecutionInput): Promise<MediaJobExecutionResult> {
  const store = input.storeRegistry.getStore(input.cwd);
  const job = store.getMediaJob(input.mediaJobId);
  if (!job) {
    return { statusCode: 404, body: { error: "media_job_not_found", message: `生成任务不存在：${input.mediaJobId}` } };
  }
  return job.executionSource.kind === "workflow"
    ? await runWorkflowMediaJobExecution(input)
    : await runProviderMediaJobExecution(input);
}

export function dispatchMediaJobExecution(input: RunMediaJobExecutionInput): void {
  void runMediaJobExecution(input).catch((error) => {
    const store = input.storeRegistry.getStore(input.cwd);
    const job = store.getMediaJob(input.mediaJobId);
    if (!job || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return;
    }
    const provider = job.providerPresetId ? store.getProviderPreset(job.providerPresetId) : undefined;
    const mediaSecret = provider?.apiKeyRef ? resolveProviderSecret(store, provider, input.secretResolver) : undefined;
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [mediaSecret?.value]);
    const failedAt = new Date().toISOString();
    store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, failedAt);
    synchronizeConversationMediaWorkUnitTerminal(store, job.id, "failed", failedAt);
    try {
      input.hooks.onMediaJobProjectionChanged?.({ cwd: input.cwd, mediaJobId: job.id });
    } catch {
      // Projection invalidation is best-effort; persisted state remains authoritative.
    }
  });
}

export function resumePendingMediaJobExecutions(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly hooks: RunMediaJobHooks;
  readonly dispatchInitialConversationMediaJob?: (mediaJobId: string) => void;
}): void {
  recoverPendingConversationMediaWorkUnits(
    input.storeRegistry.getStore(input.cwd),
    new Date().toISOString(),
  );
  resumePendingWorkflowMediaJobs(input);
  resumePendingProviderMediaJobs(input);
  const store = input.storeRegistry.getStore(input.cwd);
  for (const workUnit of store.listWorkUnits({ kind: "media_job", status: "queued", limit: 500 })) {
    const request = isRecord(workUnit.request) ? workUnit.request : {};
    const mediaJobId = workUnit.linkedMediaJobId;
    if (
      workUnit.ownerType !== "conversation_run" ||
      request.source !== "conversation_media_tool" ||
      !mediaJobId ||
      store.getMediaJobExecutionHandle(mediaJobId)
    ) {
      continue;
    }
    const mediaJob = store.getMediaJob(mediaJobId);
    if (!mediaJob || mediaJob.status !== "queued") continue;
    if (input.dispatchInitialConversationMediaJob) {
      input.dispatchInitialConversationMediaJob(mediaJobId);
    } else {
      dispatchMediaJobExecution({ ...input, mediaJobId });
    }
  }
}

export { recoverPendingConversationMediaWorkUnits } from "./conversation-runtime-recovery.js";

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
    input.hooks.onMediaJobProjectionChanged?.({ cwd: input.cwd, mediaJobId: job.id });
    dispatchMediaJobExecution({
      cwd: input.cwd,
      storeRegistry: input.storeRegistry,
      secretResolver: input.secretResolver,
      mediaJobId: job.id,
      hooks: input.hooks,
    });
    return input.store.getMediaJob(job.id) ?? currentJob;
  }

  if ((approval.status === "denied" || approval.status === "expired") && job.status === "waiting_for_approval") {
    const failed = failMediaJobForApprovalDecision(input.store, job, approval);
    input.hooks.onMediaJobProjectionChanged?.({ cwd: input.cwd, mediaJobId: job.id });
    return failed;
  }

  return job;
}

function failMediaJobForApprovalDecision(store: MediaStoreFacet, job: MediaJob, approval: ApprovalRequest): MediaJob {
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "failed",
      errorMessage: approval.status === "denied"
        ? "媒体生成费用确认未通过，任务没有执行。"
        : "媒体生成费用确认已失效，任务没有执行。",
    },
    new Date().toISOString(),
  ) ?? job;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

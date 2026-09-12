import { randomUUID } from "node:crypto";
import { toRuntimeAttemptFence, type MediaJob, type RunStore, type SecretResolver, type WorkUnit, type WorkUnitAttempt } from "@ling-stack/core";
import type { MediaExecutionHandle } from "@ling-stack/providers";
import type { RunStoreRegistry } from "../../../runtime/store-registry.js";
import { redactTextWithSecrets } from "../../../shared/redaction.js";
import { createMediaJobArtifacts, mediaExecutionHasRequiredArtifact } from "../artifact-collector.js";
import {
  bindMediaExecutionHandleToRuntime,
  findConversationMediaWorkUnit,
  prepareConversationMediaWorkUnitForExplicitRetry,
  synchronizeConversationMediaWorkUnitTerminal,
} from "../conversation-runtime-recovery.js";
import type { MediaJobExecutionResult, MediaRuntimeHandle, RunMediaJobHooks } from "../executor.js";
import { restoreOrRecoverMediaRuntimeHandle } from "../runtime-recovery.js";
import { requiresMediaProductionApproval } from "../media-cost-approval.js";
import { selectInitialMediaSceneResult } from "../scene-result-selection.js";
import { createComfyUiWorkflowAdapter } from "./workflow-adapter.js";
import { requireConnection, requireDefinition, requireVersion, resolveMediaWorkflowSecret } from "./workflow-service.js";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 10_800;
const MEDIA_RUNTIME_SEMAPHORE_TTL_MS = 6 * 60 * 60 * 1000;
const pendingOperationPrefix = "ling-pending:";
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<MediaJobExecutionResult>>();

export async function runWorkflowMediaJobExecution(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly mediaJobId: string;
  readonly hooks: RunMediaJobHooks;
  readonly retryTerminal?: boolean;
}): Promise<MediaJobExecutionResult> {
  const key = `${input.cwd}\u0000${input.mediaJobId}`;
  const existing = inFlight.get(key);
  if (existing) return await existing;
  const execution = runWorkflowMediaJobExecutionOwner(input);
  inFlight.set(key, execution);
  try {
    return await execution;
  } finally {
    if (inFlight.get(key) === execution) inFlight.delete(key);
  }
}

async function runWorkflowMediaJobExecutionOwner(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly mediaJobId: string;
  readonly hooks: RunMediaJobHooks;
  readonly retryTerminal?: boolean;
}): Promise<MediaJobExecutionResult> {
  const store = input.storeRegistry.getStore(input.cwd);
  let job = store.getMediaJob(input.mediaJobId);
  if (!job) return { statusCode: 404, body: { error: "media_job_not_found", message: `生成任务不存在：${input.mediaJobId}` } };
  if (job.executionSource.kind !== "workflow") {
    return { statusCode: 400, body: { error: "invalid_execution_source", message: "该任务不是工作流生成任务。" } };
  }
  const workflowVersionId = job.executionSource.workflowVersionId;
  if (job.status === "succeeded") {
    settleExecutionHandle(store, job.id, "succeeded", "media-workflow-already-succeeded");
    clearScheduled(job.id);
    selectInitialMediaSceneResult(store, job.id, new Date().toISOString());
    return { statusCode: 200, body: { mediaJob: job, artifacts: [] } };
  }
  if (job.status === "waiting_for_approval" && requiresMediaProductionApproval(job)) {
    return { statusCode: 409, body: { error: "media_job_waiting_for_approval", message: "媒体任务正在等待费用审批。" } };
  }
  let supervised: MediaRuntimeHandle | undefined;
  let handle = store.getMediaJobExecutionHandle(job.id);
  let secretValue: string | undefined;
  try {
    if (job.status === "waiting_for_approval") {
      job = store.updateMediaJobStatus(job.id, { status: "queued", errorMessage: null }, new Date().toISOString()) ?? job;
    }
    const terminalStatus = job.status === "failed" || job.status === "cancelled" ? job.status : undefined;
    const retryingTerminal = terminalStatus !== undefined && input.retryTerminal === true && (!handle || isPendingHandle(handle));
    if (terminalStatus && !retryingTerminal) {
      const child = findConversationMediaWorkUnit(store, job.id);
      const shouldAuditPreSubmissionCancellation = terminalStatus === "cancelled" &&
        !handle && Boolean(child && !isTerminalWorkUnitStatus(child.status));
      if (shouldAuditPreSubmissionCancellation) {
        // Adopt the queued conversation child below so pre-submission cancellation still records one attempt.
      } else {
        if (terminalStatus === "cancelled" && handle && !isPendingHandle(handle)) {
          await cancelPersistedWorkflowOperation(store, workflowVersionId, handle, input.secretResolver);
        }
        synchronizeConversationMediaWorkUnitTerminal(store, job.id, terminalStatus, new Date().toISOString());
        settleExecutionHandle(store, job.id, terminalStatus, `media-workflow-already-${terminalStatus}`);
        clearScheduled(job.id);
        notifyProjection(input, job.id);
        return terminalMediaJobResult(job);
      }
    }
    if (retryingTerminal) {
      if (handle && isPendingHandle(handle)) {
        store.deleteMediaJobExecutionHandle(job.id);
        handle = undefined;
      }
      job = store.updateMediaJobStatus(job.id, { status: "queued", errorMessage: null }, new Date().toISOString()) ?? job;
      const child = prepareConversationMediaWorkUnitForExplicitRetry(store, job.id, new Date().toISOString());
      if (child && child.status !== "queued") {
        throw new Error(`Conversation media work unit could not be retried: ${child.id} (${child.status}).`);
      }
      handle = store.getMediaJobExecutionHandle(job.id);
    }
    supervised = restoreOrRecoverMediaRuntimeHandle({
      store,
      handle,
      hooks: input.hooks,
      reason: "media-workflow-daemon-recovery",
    }) ?? restoreConversationRuntimeHandle(store, job.id) ?? input.hooks.startRuntimeWorkUnit({
      store,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: job.id,
      linkedMediaJobId: job.id,
      idempotencyKey: `media_job:${job.id}:workflow:${randomUUID()}`,
      request: { mediaJobId: job.id, workflowVersionId, operation: job.operation },
    });
    if (handle) {
      handle = bindMediaExecutionHandleToRuntime(store, handle, supervised, new Date().toISOString());
    }
    if (job.status === "cancelled") {
      if (handle && !isPendingHandle(handle)) {
        await cancelPersistedWorkflowOperation(store, workflowVersionId, handle, input.secretResolver);
      }
      input.hooks.transitionRuntimeWorkUnitCancelled({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        reason: "媒体任务已取消。",
      });
      finishExecution(store, job.id, supervised, "cancelled", "media-workflow-cancelled-before-submission");
      notifyProjection(input, job.id);
      return { statusCode: 200, body: { mediaJob: job, artifacts: [] } };
    }
    if (job.status === "failed" && !retryingTerminal) {
      terminalFailure(store, input.hooks, supervised, "media_workflow_failed", "媒体任务已经失败，需要用户明确重试。");
      finishExecution(store, job.id, supervised, "failed", "media-workflow-already-failed");
      notifyProjection(input, job.id);
      return terminalMediaJobResult(job);
    }
    const version = requireVersion(store, workflowVersionId);
    const definition = requireDefinition(store, version.workflowDefinitionId);
    const isTest = job.input.workflowTest === true;
    if (!isTest && (definition.status !== "ready" || definition.currentVersionId !== version.id)) {
      throw mediaExecutionError("generation_target_not_runnable", "该工作流版本尚未启用，不能用于场景生成。");
    }
    const connection = requireConnection(store, definition.connectionId);
    if (connection.status !== "ready") {
      throw mediaExecutionError("invalid_request", "工作流连接尚未检查通过。");
    }
    secretValue = resolveMediaWorkflowSecret(connection, input.secretResolver);
    const adapter = createComfyUiWorkflowAdapter({ store, connection, version, apiKey: secretValue });
    handle = handle ?? persistPendingHandle(store, job, supervised);
    if (!ensureSemaphore(store, job.workspaceId, connection.id, supervised)) {
      scheduleWorkflowPoll(input, POLL_INTERVAL_MS);
      return { statusCode: 202, body: { mediaJob: job, pending: true } };
    }
    recordHeartbeat(store, supervised);
    const running = job.status === "running"
      ? job
      : store.updateMediaJobStatus(job.id, { status: "running", errorMessage: null }, new Date().toISOString()) ?? job;
    notifyProjection(input, job.id);
    if (isPendingHandle(handle)) {
        const values = isRecord(job.input.workflowInputValues) ? job.input.workflowInputValues : {};
        const submission = await adapter.submit({ jobId: job.id, prompt: job.prompt, inputValues: values, requestedAt: new Date().toISOString() });
        if (submission.status === "failed") {
          throw mediaExecutionError(submission.errorCode ?? "media_workflow_failed", submission.errorMessage);
        }
        handle = store.upsertMediaJobExecutionHandle({
          mediaJobId: job.id,
          adapterKind: submission.handle.adapterKind,
          externalOperationId: submission.handle.externalOperationId,
          recovery: submission.handle.recovery,
          nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
          pollAttempts: 0,
          workUnitId: supervised.workUnit.id,
          attemptId: supervised.attempt.id,
        }, new Date().toISOString());
        scheduleWorkflowPoll(input, POLL_INTERVAL_MS);
        return { statusCode: 202, body: { mediaJob: running, pending: true } };
    }
    const delay = millisecondsUntil(handle.nextPollAt);
    if (delay > 0) {
      scheduleWorkflowPoll(input, delay);
      return { statusCode: 202, body: { mediaJob: running, pending: true } };
    }
    if (handle.pollAttempts >= MAX_POLL_ATTEMPTS) throw new Error("工作流生成等待超时，请在生成任务中重试。");
    const poll = await adapter.poll(toExecutionHandle(handle));
    if (poll.status === "pending") {
      store.upsertMediaJobExecutionHandle({
        mediaJobId: job.id,
        adapterKind: handle.adapterKind,
        externalOperationId: handle.externalOperationId,
        recovery: handle.recovery,
        nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
        pollAttempts: handle.pollAttempts + 1,
      }, new Date().toISOString());
      scheduleWorkflowPoll(input, POLL_INTERVAL_MS);
      return { statusCode: 202, body: { mediaJob: running, pending: true } };
    }
    if (poll.status === "failed") {
      throw mediaExecutionError(poll.errorCode ?? "media_workflow_failed", poll.errorMessage);
    }
    handle = store.upsertMediaJobExecutionHandle({
      mediaJobId: job.id,
      adapterKind: handle.adapterKind,
      externalOperationId: handle.externalOperationId,
      recovery: poll.recovery,
      nextPollAt: null,
      pollAttempts: handle.pollAttempts + 1,
    }, new Date().toISOString());
    const execution = await adapter.collectArtifacts(toExecutionHandle(handle));
    if (execution.status === "failed") {
      throw mediaExecutionError(
        execution.errorCode ?? "media_workflow_failed",
        execution.errorMessage ?? "工作流产物收集失败。",
      );
    }
    if (!mediaExecutionHasRequiredArtifact(execution.artifacts, job.operation)) {
      throw mediaExecutionError("media_result_unavailable", "工作流没有返回当前任务需要的图片或视频结果。");
    }
    const completedAt = new Date().toISOString();
    const artifacts = createMediaJobArtifacts(store, job, execution.artifacts, completedAt, [secretValue]);
    const succeeded = store.updateMediaJobStatus(job.id, {
      status: "succeeded",
      artifactIds: [...new Set([...job.artifactIds, ...artifacts.map((artifact) => artifact.id)])],
      errorMessage: null,
    }, completedAt) ?? job;
    notifyProjection(input, job.id, artifacts.map((artifact) => artifact.id));
    selectInitialMediaSceneResult(store, job.id, completedAt);
    for (const artifact of artifacts) {
      store.appendRuntimeEvent({
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        runtimeInstanceId: supervised.attempt.runtimeInstanceId,
        fencingToken: supervised.attempt.fencingToken,
        type: "artifact_created",
        actor: "system",
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
        actor: "system",
        now: completedAt,
      });
    finishExecution(store, job.id, supervised, "succeeded", "media-workflow-succeeded");
    return { statusCode: 200, body: { mediaJob: succeeded, artifacts } };
  } catch (error) {
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [secretValue]);
    const errorCode = mediaExecutionErrorCode(error, "media_workflow_failed");
    const failed = store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, new Date().toISOString()) ?? job;
    notifyProjection(input, job.id);
    if (supervised) terminalFailure(store, input.hooks, supervised, errorCode, message);
    if (supervised) finishExecution(store, job.id, supervised, "failed", "media-workflow-failed");
    else {
      synchronizeConversationMediaWorkUnitTerminal(store, job.id, "failed", new Date().toISOString());
      settleExecutionHandle(store, job.id, "failed", "media-workflow-failed-before-runtime-start");
      clearScheduled(job.id);
    }
    return { statusCode: 400, body: { error: "media_workflow_failed", message, mediaJob: failed } };
  }
}

function terminalMediaJobResult(job: MediaJob): MediaJobExecutionResult {
  return job.status === "cancelled"
    ? { statusCode: 200, body: { mediaJob: job, artifacts: [] } }
    : {
        statusCode: 200,
        body: {
          error: "media_job_already_failed",
          message: job.errorMessage ?? "媒体任务已经失败，需要用户明确重试。",
          mediaJob: job,
        },
      };
}

function isTerminalWorkUnitStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function mediaExecutionError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

function mediaExecutionErrorCode(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return fallback;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : fallback;
}

export function resumePendingWorkflowMediaJobs(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly hooks: RunMediaJobHooks;
}): void {
  const store = input.storeRegistry.getStore(input.cwd);
  for (const handle of store.listMediaJobExecutionHandles()) {
    const job = store.getMediaJob(handle.mediaJobId);
    if (job?.executionSource.kind === "workflow" && (job.status === "queued" || job.status === "running")) {
      scheduleWorkflowPoll({ ...input, mediaJobId: job.id }, Math.max(0, millisecondsUntil(handle.nextPollAt)));
    }
  }
}

function persistPendingHandle(store: RunStore, job: MediaJob, supervised: MediaRuntimeHandle) {
  return store.upsertMediaJobExecutionHandle({
    mediaJobId: job.id,
    adapterKind: "comfyui",
    externalOperationId: `${pendingOperationPrefix}${job.id}`,
    recovery: { phase: "waiting_for_submission" },
    nextPollAt: new Date().toISOString(),
    pollAttempts: 0,
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
  }, new Date().toISOString());
}

function ensureSemaphore(
  store: RunStore,
  workspaceId: string,
  connectionId: string,
  supervised: MediaRuntimeHandle,
): boolean {
  if (store.listRuntimeSemaphoreSlots({ ownerId: supervised.attempt.id, status: "active", limit: 1 })[0]) return true;
  const acquiredAt = new Date().toISOString();
  const semaphore = store.acquireRuntimeSemaphoreSlot({
    workspaceId,
    resourceType: "media_provider",
    resourceKey: `workflow:${connectionId}`,
    limit: 1,
    ownerType: "work_unit_attempt",
    ownerId: supervised.attempt.id,
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    runtimeInstanceId: supervised.attempt.runtimeInstanceId,
    fencingToken: supervised.attempt.fencingToken,
    acquiredAt,
    expiresAt: new Date(Date.now() + MEDIA_RUNTIME_SEMAPHORE_TTL_MS).toISOString(),
  });
  if (!semaphore) return false;
  store.appendRuntimeEvent({
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    runtimeInstanceId: supervised.attempt.runtimeInstanceId,
    fencingToken: supervised.attempt.fencingToken,
    type: "semaphore_acquired",
    actor: "system",
    ts: acquiredAt,
    data: { id: semaphore.id, resourceType: semaphore.resourceType, resourceKey: semaphore.resourceKey },
  });
  return true;
}

function recordHeartbeat(store: RunStore, supervised: MediaRuntimeHandle): void {
  store.recordRuntimeHeartbeat({
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    runtimeInstanceId: supervised.attempt.runtimeInstanceId,
    fencingToken: supervised.attempt.fencingToken,
    ts: new Date().toISOString(),
    source: "provider",
    detail: { phase: "workflow_tick" },
  });
}

function finishExecution(
  store: RunStore,
  mediaJobId: string,
  supervised: MediaRuntimeHandle,
  status: "succeeded" | "failed" | "cancelled",
  reason: string,
): void {
  const handle = settleExecutionHandle(store, mediaJobId, status, reason);
  if (!handle || handle.attemptId !== supervised.attempt.id) {
    store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(supervised.attempt), new Date().toISOString(), reason);
  }
  clearScheduled(mediaJobId);
}

function settleExecutionHandle(
  store: RunStore,
  mediaJobId: string,
  status: "succeeded" | "failed" | "cancelled",
  reason: string,
): ReturnType<RunStore["getMediaJobExecutionHandle"]> {
  const handle = store.getMediaJobExecutionHandle(mediaJobId);
  if (!handle) return undefined;
  if (handle.attemptId) {
    const attempt = store.getWorkUnitAttempt(handle.attemptId);
    if (attempt) {
      store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), new Date().toISOString(), reason);
    }
  }
  if (status === "succeeded" || isPendingHandle(handle)) {
    store.deleteMediaJobExecutionHandle(mediaJobId);
    return handle;
  }
  store.upsertMediaJobExecutionHandle({
    mediaJobId: handle.mediaJobId,
    adapterKind: handle.adapterKind,
    externalOperationId: handle.externalOperationId,
    recovery: handle.recovery,
    nextPollAt: null,
    pollAttempts: handle.pollAttempts,
    workUnitId: null,
    attemptId: null,
  }, new Date().toISOString());
  return handle;
}

function isPendingHandle(handle: NonNullable<ReturnType<RunStore["getMediaJobExecutionHandle"]>>): boolean {
  return handle.externalOperationId.startsWith(pendingOperationPrefix) && handle.recovery.phase === "waiting_for_submission";
}

function scheduleWorkflowPoll(
  input: Parameters<typeof runWorkflowMediaJobExecution>[0],
  delayMs: number,
): void {
  clearScheduled(input.mediaJobId);
  const timer = setTimeout(() => {
    scheduled.delete(input.mediaJobId);
    void runWorkflowMediaJobExecution(input).catch(() => {
      // The execution owner persists normal failures; this only closes entry-level promise rejection.
    });
  }, Math.max(0, delayMs));
  timer.unref?.();
  scheduled.set(input.mediaJobId, timer);
}

function clearScheduled(mediaJobId: string): void {
  const timer = scheduled.get(mediaJobId);
  if (timer) clearTimeout(timer);
  scheduled.delete(mediaJobId);
}

function restoreConversationRuntimeHandle(store: RunStore, mediaJobId: string): MediaRuntimeHandle | undefined {
  const workUnit = findConversationMediaWorkUnit(store, mediaJobId);
  const attempt = workUnit?.activeAttemptId ? store.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
  return workUnit && attempt ? { workUnit, attempt } : undefined;
}

function notifyProjection(
  input: Parameters<typeof runWorkflowMediaJobExecution>[0],
  mediaJobId: string,
  createdArtifactIds?: readonly string[],
): void {
  try {
    input.hooks.onMediaJobProjectionChanged?.({ cwd: input.cwd, mediaJobId, createdArtifactIds });
  } catch {
    // Projection invalidation is best-effort; persisted state remains authoritative.
  }
}

function toExecutionHandle(handle: NonNullable<ReturnType<RunStore["getMediaJobExecutionHandle"]>>): MediaExecutionHandle {
  return { adapterKind: handle.adapterKind, externalOperationId: handle.externalOperationId, recovery: handle.recovery };
}

async function cancelPersistedWorkflowOperation(
  store: RunStore,
  workflowVersionId: string,
  handle: NonNullable<ReturnType<RunStore["getMediaJobExecutionHandle"]>>,
  secretResolver: SecretResolver,
): Promise<void> {
  try {
    const version = requireVersion(store, workflowVersionId);
    const definition = requireDefinition(store, version.workflowDefinitionId);
    const connection = requireConnection(store, definition.connectionId);
    const cancellationSecret = resolveMediaWorkflowSecret(connection, secretResolver);
    const adapter = createComfyUiWorkflowAdapter({ store, connection, version, apiKey: cancellationSecret });
    await adapter.cancel(toExecutionHandle(handle));
  } catch {
    // The local cancellation remains authoritative when the original workflow cannot be reconstructed.
  }
}

function terminalFailure(store: RunStore, hooks: RunMediaJobHooks, supervised: { readonly workUnit: WorkUnit; readonly attempt: WorkUnitAttempt }, code: string, message: string): void {
  hooks.transitionRuntimeWorkUnitTerminal({
    store,
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    event: "runner_failed",
    attemptStatus: "failed",
    runtimeEventType: "work_unit_failed",
    actor: "system",
    now: new Date().toISOString(),
    errorCode: code,
    errorMessage: message,
  });
}

function millisecondsUntil(value: string | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  normalizeProviderPresetForMediaRuntime,
  resolveMediaProviderRuntimeState,
  type MediaJob,
  type MediaStoreFacet,
  type ProviderPreset,
  type ProviderStoreFacet,
  type RunExecutionStoreFacet,
  type RunStore,
  type RunStorePathsFacet,
  type RuntimeSupervisorStoreFacet,
  type SecretResolver,
} from "@ling-stack/core";
import {
  executeMediaJob as executeMediaAdapterJob,
  type MediaAdapter,
  type MediaExecutionHandle,
  type MediaExecutionRequest,
  type MediaExecutionResult,
} from "@ling-stack/providers";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { redactTextWithSecrets } from "../../shared/redaction.js";
import { resolveProviderSecret } from "../providers/secrets.js";
import { createMediaJobArtifacts, mediaExecutionHasRequiredArtifact } from "./artifact-collector.js";
import {
  bindMediaExecutionHandleToRuntime,
  findConversationMediaWorkUnit,
  prepareConversationMediaWorkUnitForExplicitRetry,
  synchronizeConversationMediaWorkUnitTerminal,
} from "./conversation-runtime-recovery.js";
import type { MediaJobExecutionResult, MediaRuntimeHandle, RunMediaJobHooks } from "./executor.js";
import { requiresMediaProductionApproval } from "./media-cost-approval.js";
import { assertMediaJobProvider, createMediaAdapterForProvider } from "./provider.js";
import { selectInitialMediaSceneResult } from "./scene-result-selection.js";

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 10_800;
const MEDIA_RUNTIME_SEMAPHORE_TTL_MS = 6 * 60 * 60 * 1000;
const pendingOperationPrefix = "ling-pending:";
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Map<string, Promise<MediaJobExecutionResult>>();

type ProviderExecutionStore =
  MediaStoreFacet &
  ProviderStoreFacet &
  RunExecutionStoreFacet &
  RuntimeSupervisorStoreFacet &
  RunStorePathsFacet;

export async function runProviderMediaJobExecution(input: {
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
  const execution = runProviderMediaJobExecutionOwner(input);
  inFlight.set(key, execution);
  try {
    return await execution;
  } finally {
    if (inFlight.get(key) === execution) inFlight.delete(key);
  }
}

async function runProviderMediaJobExecutionOwner(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly mediaJobId: string;
  readonly hooks: RunMediaJobHooks;
  readonly retryTerminal?: boolean;
}): Promise<MediaJobExecutionResult> {
  const store = input.storeRegistry.getStore(input.cwd);
  let job = store.getMediaJob(input.mediaJobId);
  if (!job) return notFound(input.mediaJobId);
  if (job.executionSource.kind !== "provider") {
    return { statusCode: 400, body: { error: "invalid_execution_source", message: "该任务不是模型直接生成任务。" } };
  }
  if (job.status === "succeeded") {
    settleExecutionHandle(store, job.id, "succeeded", "media-job-already-succeeded");
    clearScheduled(job.id);
    selectInitialMediaSceneResult(store, job.id, now());
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
      job = store.updateMediaJobStatus(job.id, { status: "queued", errorMessage: null }, now()) ?? job;
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
          await cancelPersistedProviderOperation(store, job, handle, input.secretResolver);
        }
        synchronizeConversationMediaWorkUnitTerminal(store, job.id, terminalStatus, now());
        settleExecutionHandle(store, job.id, terminalStatus, `media-job-already-${terminalStatus}`);
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
      job = store.updateMediaJobStatus(job.id, { status: "queued", errorMessage: null }, now()) ?? job;
      const child = prepareConversationMediaWorkUnitForExplicitRetry(store, job.id, now());
      if (child && child.status !== "queued") {
        throw new Error(`Conversation media work unit could not be retried: ${child.id} (${child.status}).`);
      }
      handle = store.getMediaJobExecutionHandle(job.id);
    }
    supervised = restoreRuntimeHandle(store, handle) ?? restoreConversationRuntimeHandle(store, job.id) ?? input.hooks.startRuntimeWorkUnit({
      store,
      kind: "media_job",
      ownerType: "media_job",
      ownerId: job.id,
      providerPresetId: job.providerPresetId,
      linkedMediaJobId: job.id,
      idempotencyKey: `media_job:${job.id}:provider:${randomUUID()}`,
      request: { mediaJobId: job.id, providerPresetId: job.providerPresetId, operation: job.operation },
    });
    if (handle) {
      handle = bindMediaExecutionHandleToRuntime(store, handle, supervised, now());
    }
    if (job.status === "cancelled") {
      if (handle) {
        await cancelPersistedProviderOperation(store, job, handle, input.secretResolver);
      }
      input.hooks.transitionRuntimeWorkUnitCancelled({
        store,
        workUnitId: supervised.workUnit.id,
        attemptId: supervised.attempt.id,
        reason: "媒体任务已取消。",
      });
      finishExecution(store, job.id, supervised, "cancelled", "media-job-cancelled-before-submission");
      notifyProjection(input, job.id);
      return { statusCode: 200, body: { mediaJob: job, artifacts: [] } };
    }
    if (job.status === "failed" && !retryingTerminal) {
      terminalFailure(store, input.hooks, supervised, "media_job_execution_failed", "媒体任务已经失败，需要用户明确重试。");
      finishExecution(store, job.id, supervised, "failed", "media-job-already-failed");
      notifyProjection(input, job.id);
      return terminalMediaJobResult(job);
    }
    const provider = assertMediaJobProvider(store, {
      providerPresetId: job.providerPresetId,
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
    }, input.secretResolver);
    const readiness = resolveLiveMediaExecutionReadiness(store, provider, job.operation, input.secretResolver);
    if (!readiness.ok) {
      const failed = store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: readiness.message }, now()) ?? job;
      terminalFailure(store, input.hooks, supervised, readiness.code, readiness.message);
      finishExecution(store, job.id, supervised, "failed", "media-job-not-runnable");
      notifyProjection(input, job.id);
      return { statusCode: 400, body: { error: readiness.code, message: readiness.message, mediaJob: failed, artifacts: [] } };
    }
    secretValue = provider.apiKeyRef ? resolveProviderSecret(store, provider, input.secretResolver).value : undefined;
    const adapter = createMediaAdapterForProvider(store, provider, input.secretResolver);
    handle = handle ?? persistPendingHandle(store, job, adapter, supervised);
    if (!ensureSemaphore(store, provider, supervised)) {
      scheduleProviderPoll(input, POLL_INTERVAL_MS);
      return { statusCode: 202, body: { mediaJob: job, pending: true } };
    }
    recordHeartbeat(store, supervised, "provider_tick");

    job = job.status === "running"
      ? job
      : store.updateMediaJobStatus(job.id, { status: "running", errorMessage: null }, now()) ?? job;
    notifyProjection(input, job.id);
    const request = mediaExecutionRequest(job, provider);
    const tick = hasRecoverableLifecycle(adapter)
      ? await runRecoverableTick(store, job, adapter, request, handle)
      : await runNonRecoverableExecution(store, job, adapter, request, handle);
    if (tick.pending) {
      scheduleProviderPoll(input, tick.delayMs);
      return { statusCode: 202, body: { mediaJob: job, pending: true } };
    }
    const execution = tick.execution;
    if (execution.status === "failed") {
      throw mediaExecutionError(
        execution.errorCode ?? "media_job_execution_failed",
        execution.errorMessage ?? "媒体生成执行失败。",
      );
    }
    if (!mediaExecutionHasRequiredArtifact(execution.artifacts, job.operation)) {
      throw mediaExecutionError(
        "media_result_unavailable",
        "生成供应商没有返回可用的图片或视频结果，请检查模型、权限和返回格式。",
      );
    }
    const completedAt = now();
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
    finishExecution(store, job.id, supervised, "succeeded", "media-job-succeeded");
    return { statusCode: 200, body: { mediaJob: succeeded, artifacts } };
  } catch (error) {
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [secretValue]);
    const errorCode = mediaExecutionErrorCode(error, "media_job_execution_failed");
    const failed = store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, now()) ?? job;
    notifyProjection(input, job.id);
    if (supervised) {
      terminalFailure(store, input.hooks, supervised, errorCode, message);
      finishExecution(store, job.id, supervised, "failed", "media-job-failed");
    } else {
      synchronizeConversationMediaWorkUnitTerminal(store, job.id, "failed", now());
      settleExecutionHandle(store, job.id, "failed", "media-job-failed-before-runtime-start");
      clearScheduled(job.id);
    }
    return { statusCode: 200, body: { error: "media_job_execution_failed", message, mediaJob: failed } };
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

export function resumePendingProviderMediaJobs(input: {
  readonly cwd: string;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly hooks: RunMediaJobHooks;
}): void {
  const store = input.storeRegistry.getStore(input.cwd);
  for (const handle of store.listMediaJobExecutionHandles()) {
    const job = store.getMediaJob(handle.mediaJobId);
    if (job?.executionSource.kind === "provider" && (job.status === "queued" || job.status === "running")) {
      scheduleProviderPoll({ ...input, mediaJobId: job.id }, Math.max(0, millisecondsUntil(handle.nextPollAt)));
    }
  }
}

function hasRecoverableLifecycle(adapter: MediaAdapter): adapter is MediaAdapter & Required<Pick<MediaAdapter, "submit" | "poll" | "collectArtifacts">> {
  return Boolean(adapter.submit && adapter.poll && adapter.collectArtifacts);
}

async function runRecoverableTick(
  store: ProviderExecutionStore,
  job: MediaJob,
  adapter: MediaAdapter & Required<Pick<MediaAdapter, "submit" | "poll" | "collectArtifacts">>,
  request: MediaExecutionRequest,
  handle: NonNullable<ReturnType<ProviderExecutionStore["getMediaJobExecutionHandle"]>>,
): Promise<{ readonly pending: true; readonly delayMs: number } | { readonly pending: false; readonly execution: MediaExecutionResult }> {
  let current = handle;
  if (isPendingHandle(current)) {
    const submission = await adapter.submit(request);
    if (submission.status === "failed") {
      return { pending: false, execution: { status: "failed", artifacts: [], errorCode: submission.errorCode, errorMessage: submission.errorMessage } };
    }
    current = store.upsertMediaJobExecutionHandle({
      mediaJobId: job.id,
      adapterKind: submission.handle.adapterKind,
      externalOperationId: submission.handle.externalOperationId,
      recovery: submission.handle.recovery,
      nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
      pollAttempts: 0,
    }, now());
    return { pending: true, delayMs: POLL_INTERVAL_MS };
  }
  const delay = millisecondsUntil(current.nextPollAt);
  if (delay > 0) return { pending: true, delayMs: delay };
  if (current.pollAttempts >= MAX_POLL_ATTEMPTS) {
    return { pending: false, execution: { status: "failed", artifacts: [], errorCode: "timeout", errorMessage: "视频生成等待超时，请在生成任务中重试。" } };
  }
  const poll = await adapter.poll(toExecutionHandle(current));
  if (poll.status === "pending") {
    store.upsertMediaJobExecutionHandle({
      mediaJobId: job.id,
      adapterKind: current.adapterKind,
      externalOperationId: current.externalOperationId,
      recovery: current.recovery,
      nextPollAt: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
      pollAttempts: current.pollAttempts + 1,
    }, now());
    return { pending: true, delayMs: POLL_INTERVAL_MS };
  }
  if (poll.status === "failed") {
    return { pending: false, execution: { status: "failed", artifacts: [], errorCode: poll.errorCode, errorMessage: poll.errorMessage } };
  }
  current = store.upsertMediaJobExecutionHandle({
    mediaJobId: job.id,
    adapterKind: current.adapterKind,
    externalOperationId: current.externalOperationId,
    recovery: poll.recovery,
    nextPollAt: null,
    pollAttempts: current.pollAttempts + 1,
  }, now());
  return { pending: false, execution: await adapter.collectArtifacts(toExecutionHandle(current)) };
}

async function runNonRecoverableExecution(
  store: ProviderExecutionStore,
  job: MediaJob,
  adapter: MediaAdapter,
  request: MediaExecutionRequest,
  handle: NonNullable<ReturnType<ProviderExecutionStore["getMediaJobExecutionHandle"]>>,
): Promise<{ readonly pending: false; readonly execution: MediaExecutionResult }> {
  if (!isPendingHandle(handle) && handle.recovery.phase === "nonrecoverable_execution") {
    return {
      pending: false,
      execution: { status: "failed", artifacts: [], errorCode: "provider_internal_error", errorMessage: "生成服务在执行中断开，无法安全恢复，请重试。" },
    };
  }
  store.upsertMediaJobExecutionHandle({
    mediaJobId: job.id,
    adapterKind: adapter.id,
    externalOperationId: `${pendingOperationPrefix}${job.id}`,
    recovery: { phase: "nonrecoverable_execution" },
    nextPollAt: null,
  }, now());
  return { pending: false, execution: await executeMediaAdapterJob(adapter, request) };
}

function persistPendingHandle(
  store: ProviderExecutionStore,
  job: MediaJob,
  adapter: MediaAdapter,
  supervised: MediaRuntimeHandle,
) {
  return store.upsertMediaJobExecutionHandle({
    mediaJobId: job.id,
    adapterKind: adapter.id,
    externalOperationId: `${pendingOperationPrefix}${job.id}`,
    recovery: { phase: "waiting_for_submission" },
    nextPollAt: new Date().toISOString(),
    pollAttempts: 0,
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
  }, now());
}

function ensureSemaphore(store: ProviderExecutionStore, provider: ProviderPreset, supervised: MediaRuntimeHandle): boolean {
  const active = store.listRuntimeSemaphoreSlots({ ownerId: supervised.attempt.id, status: "active", limit: 1 })[0];
  if (active) return true;
  const acquiredAt = now();
  const semaphore = store.acquireRuntimeSemaphoreSlot({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "media_provider",
    resourceKey: provider.id,
    limit: 2,
    ownerType: "work_unit_attempt",
    ownerId: supervised.attempt.id,
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    acquiredAt,
    expiresAt: new Date(Date.now() + MEDIA_RUNTIME_SEMAPHORE_TTL_MS).toISOString(),
  });
  if (!semaphore) return false;
  store.appendRuntimeEvent({
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    type: "semaphore_acquired",
    actor: "system",
    ts: acquiredAt,
    data: { id: semaphore.id, resourceType: semaphore.resourceType, resourceKey: semaphore.resourceKey },
  });
  return true;
}

function recordHeartbeat(store: ProviderExecutionStore, supervised: MediaRuntimeHandle, phase: string): void {
  store.recordRuntimeHeartbeat({
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    runtimeInstanceId: supervised.attempt.runtimeInstanceId,
    ts: now(),
    source: "provider",
    detail: { phase },
  });
}

function finishExecution(
  store: ProviderExecutionStore,
  mediaJobId: string,
  supervised: MediaRuntimeHandle,
  status: "succeeded" | "failed" | "cancelled",
  reason: string,
): void {
  settleExecutionHandle(store, mediaJobId, status, reason);
  store.releaseRuntimeSemaphoreSlotsForOwner(supervised.attempt.id, now(), reason);
  clearScheduled(mediaJobId);
}

function settleExecutionHandle(
  store: ProviderExecutionStore,
  mediaJobId: string,
  status: "succeeded" | "failed" | "cancelled",
  reason: string,
): void {
  const handle = store.getMediaJobExecutionHandle(mediaJobId);
  if (!handle) return;
  if (handle.attemptId) {
    store.releaseRuntimeSemaphoreSlotsForOwner(handle.attemptId, now(), reason);
  }
  if (status === "succeeded" || isPendingHandle(handle)) {
    store.deleteMediaJobExecutionHandle(mediaJobId);
    return;
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
  }, now());
}

function mediaExecutionRequest(job: MediaJob, provider: ProviderPreset): MediaExecutionRequest {
  return {
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
    requestedAt: now(),
  };
}

async function cancelProviderOperation(
  adapter: MediaAdapter,
  handle: NonNullable<ReturnType<ProviderExecutionStore["getMediaJobExecutionHandle"]>>,
): Promise<void> {
  if (!adapter.cancel || isPendingHandle(handle)) return;
  await adapter.cancel(toExecutionHandle(handle));
}

async function cancelPersistedProviderOperation(
  store: ProviderExecutionStore,
  job: MediaJob,
  handle: NonNullable<ReturnType<ProviderExecutionStore["getMediaJobExecutionHandle"]>>,
  secretResolver: SecretResolver,
): Promise<void> {
  if (isPendingHandle(handle) || !job.providerPresetId) return;
  try {
    const provider = store.getProviderPreset(job.providerPresetId);
    if (!provider) return;
    const adapter = createMediaAdapterForProvider(store, provider, secretResolver);
    await cancelProviderOperation(adapter, handle);
  } catch {
    // The local cancellation remains authoritative when the original target cannot be reconstructed.
  }
}

function restoreRuntimeHandle(store: RunStore, handle: ReturnType<RunStore["getMediaJobExecutionHandle"]>): MediaRuntimeHandle | undefined {
  if (!handle?.workUnitId || !handle.attemptId) return undefined;
  const workUnit = store.getWorkUnit(handle.workUnitId);
  const attempt = store.getWorkUnitAttempt(handle.attemptId);
  return workUnit && attempt ? { workUnit, attempt } : undefined;
}

function restoreConversationRuntimeHandle(store: RunStore, mediaJobId: string): MediaRuntimeHandle | undefined {
  const workUnit = findConversationMediaWorkUnit(store, mediaJobId);
  const attempt = workUnit?.activeAttemptId ? store.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
  return workUnit && attempt ? { workUnit, attempt } : undefined;
}

function notifyProjection(
  input: Parameters<typeof runProviderMediaJobExecution>[0],
  mediaJobId: string,
  createdArtifactIds?: readonly string[],
): void {
  try {
    input.hooks.onMediaJobProjectionChanged?.({ cwd: input.cwd, mediaJobId, createdArtifactIds });
  } catch {
    // Projection invalidation is best-effort; persisted state remains authoritative.
  }
}

function terminalFailure(
  store: ProviderExecutionStore,
  hooks: RunMediaJobHooks,
  supervised: MediaRuntimeHandle,
  code: string,
  message: string,
): void {
  hooks.transitionRuntimeWorkUnitTerminal({
    store,
    workUnitId: supervised.workUnit.id,
    attemptId: supervised.attempt.id,
    event: "runner_failed",
    attemptStatus: "failed",
    runtimeEventType: "work_unit_failed",
    actor: "provider",
    now: now(),
    errorCode: code,
    errorMessage: message,
  });
}

function resolveLiveMediaExecutionReadiness(
  store: ProviderStoreFacet,
  provider: ProviderPreset,
  operation: MediaJob["operation"],
  secretResolver: SecretResolver,
): { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string } {
  const normalizedProvider = normalizeProviderPresetForMediaRuntime(provider);
  const state = resolveMediaProviderRuntimeState(normalizedProvider, operation);
  if (state.reason === "live_transport_invalid") return blocked("invalid_request", "生成模型真实生成配置无效，请在模型工作台重新保存。");
  if (state.reason === "live_transport_required") return blocked("live_media_transport_required", "当前没有可真实生成的模型，请先在模型工作台配置具备图片或视频能力的模型。");
  if (state.reason === "base_url_missing") return blocked("bad_request", "生成模型缺少 Base URL，请在模型工作台补充后重试。");
  if (!normalizedProvider.apiKeyRef) return blocked("secret_missing", "生成模型缺少 API Key，请在模型工作台补充后重试。");
  const secret = resolveProviderSecret(store, normalizedProvider, secretResolver);
  if (!secret.configured) return blocked("secret_missing", "生成模型 API Key 尚未配置，请在模型工作台保存密钥后重试。");
  if (state.reason === "unsupported_live_adapter" || !state.liveAdapterSupported) {
    return blocked("unsupported_capability", "当前只支持 OpenAI Images 图片生成、Seedream 图片生成和 Seedance 视频生成的真实执行，其他生成模型暂未接入真实生成。");
  }
  if (!state.canRun) return blocked(state.reason ?? "unsupported_capability", "当前生成模型尚未满足真实生成条件，请在模型工作台检查配置。");
  return { ok: true };
}

function blocked(code: string, message: string) {
  return { ok: false as const, code, message };
}

function toExecutionHandle(handle: NonNullable<ReturnType<ProviderExecutionStore["getMediaJobExecutionHandle"]>>): MediaExecutionHandle {
  return { adapterKind: handle.adapterKind, externalOperationId: handle.externalOperationId, recovery: handle.recovery };
}

function isPendingHandle(handle: NonNullable<ReturnType<ProviderExecutionStore["getMediaJobExecutionHandle"]>>): boolean {
  return handle.externalOperationId.startsWith(pendingOperationPrefix) && handle.recovery.phase === "waiting_for_submission";
}

function scheduleProviderPoll(input: Parameters<typeof runProviderMediaJobExecution>[0], delayMs: number): void {
  clearScheduled(input.mediaJobId);
  const timer = setTimeout(() => {
    scheduled.delete(input.mediaJobId);
    void runProviderMediaJobExecution(input).catch(() => {
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

function millisecondsUntil(value: string | undefined): number {
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp - Date.now() : 0;
}

function now(): string {
  return new Date().toISOString();
}

function notFound(mediaJobId: string): MediaJobExecutionResult {
  return { statusCode: 404, body: { error: "media_job_not_found", message: `生成任务不存在：${mediaJobId}` } };
}

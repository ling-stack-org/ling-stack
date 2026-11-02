import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve as resolvePath } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  type Channel,
  type ResourceLease,
  type RunStore,
  type Task,
  type UserInputContinuationBinding,
  type UserInputContinuationClaim,
  type WorkUnit,
  type WorkUnitAttempt,
  toRuntimeAttemptFence,
} from "@ling-stack/core";
import { HttpError } from "../../errors.js";
import { DEFAULT_RUNNER_ID } from "../../runtime/work-units.js";
import { removeUndefined } from "../../shared/validation.js";
import { usesSideEffectTools } from "./approvals.js";
import type { RunRequest } from "./schemas.js";

const RESOURCE_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export type QueueableRunConflictCode = "resource_conflict" | "runtime_semaphore_conflict";

export interface PreparedRunConcurrency {
  readonly channel?: Channel;
  readonly task?: Task;
  readonly taskExists: boolean;
  readonly leases: readonly ResourceLease[];
}

export function prepareRunConcurrency(input: {
  readonly store: RunStore;
  readonly runRequest: RunRequest;
  readonly runId: string;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  /** Host-only identity of an already activated same-Run continuation, never a request flag. */
  readonly existingContinuationId?: string;
  readonly now: string;
}): PreparedRunConcurrency {
  input.store.expireResourceLeases(input.now);

  const taskId = input.runRequest.task.id;
  const task = input.store.getTask(taskId);
  const channelId = input.runRequest.task.channelId ?? task?.channelId;
  const channel = channelId ? input.store.getChannel(channelId) : undefined;
  if (channelId && !channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${channelId}`);
  }
  if (channel?.status === "paused") {
    throw new HttpError(409, "channel_paused", `Channel is paused: ${channel.id}`);
  }
  if (channel?.status === "archived") {
    throw new HttpError(409, "channel_archived", `Channel is archived: ${channel.id}`);
  }

  if (task && input.runRequest.idempotencyKey) {
    const duplicate = input.store.findStateTransitionByIdempotency("task", task.id, input.runRequest.idempotencyKey);
    if (duplicate) {
      const runId = duplicate.reason?.startsWith("run:") ? duplicate.reason.slice("run:".length) : undefined;
      if (runId) {
        if (!canReuseTaskClaimForContinuation(input, task, runId)) {
          throw new DuplicateRunRequestError(runId);
        }
      } else {
        throw new HttpError(409, "duplicate_run_request", "Duplicate run request");
      }
    }
  }

  const leases: ResourceLease[] = [];
  const leaseInputs = buildRunLeaseInputs({
    runId: input.runId,
    workUnit: input.workUnit,
    attempt: input.attempt,
    runRequest: input.runRequest,
    channel,
    taskId: task ? taskId : undefined,
    now: input.now,
  });

  for (const leaseInput of leaseInputs) {
    const lease = input.store.acquireResourceLease(leaseInput);
    if (!lease) {
      const blockingLease = input.store.getBlockingResourceLease(leaseInput.resourceType, leaseInput.resourceKey);
      input.store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(input.attempt), input.now, "run-concurrency-conflict");
      const message = blockingLease
        ? `Resource is locked by ${blockingLease.ownerType}:${blockingLease.ownerId}: ${blockingLease.resourceType}:${blockingLease.resourceKey}`
        : `Resource is locked: ${leaseInput.resourceType}:${leaseInput.resourceKey}`;
      if (channel?.runtimePolicy.queueOnConflict) {
        throw new QueueableRunConflictError("resource_conflict", message, channel, task);
      }
      throw new HttpError(409, "resource_conflict", message);
    }
    leases.push(lease);
  }

  return {
    channel,
    task,
    taskExists: Boolean(task),
    leases,
  };
}

/**
 * Reopens the exact pre-start resources of an already admitted Attempt.
 *
 * The caller must first validate the durable continuation binding. This helper
 * independently rechecks the Run/WorkUnit/Attempt fence, then reuses only
 * resources owned by that exact fence. Missing rows may be completed after a
 * crash; foreign or extra rows fail closed. Ordinary Run admission must keep
 * using prepareRunConcurrency/acquireRunRuntimeSemaphores.
 */
export function recoverPreparedRunConcurrency(input: {
  readonly store: RunStore;
  readonly claim: UserInputContinuationClaim;
  readonly binding: UserInputContinuationBinding;
  readonly runRequest: RunRequest;
  readonly runId: string;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly channelParallelLimit?: number;
  readonly providerKey: string;
  readonly runnerId?: string;
  readonly now: string;
}): PreparedRunConcurrency {
  assertRecoverablePreparedRunOwner(input);
  if (input.binding.runId !== input.runId
    || !isDeepStrictEqual(input.binding.fence, toRuntimeAttemptFence(input.attempt))) {
    throw recoveryChanged("The admitted answer binding no longer owns this Run Attempt.");
  }

  const taskId = input.runRequest.task.id;
  const task = input.store.getTask(taskId);
  const channelId = input.runRequest.task.channelId ?? task?.channelId;
  const channel = channelId ? input.store.getChannel(channelId) : undefined;
  if (channelId && !channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${channelId}`);
  }
  if (channel?.status === "paused") {
    throw new HttpError(409, "channel_paused", `Channel is paused: ${channel.id}`);
  }
  if (channel?.status === "archived") {
    throw new HttpError(409, "channel_archived", `Channel is archived: ${channel.id}`);
  }
  if (task && ((task.status !== "claimed" && task.status !== "running")
    || task.currentRunId && task.currentRunId !== input.runId)) {
    throw new HttpError(409, "task_not_runnable", `Task ${task.id} is no longer owned by Run ${input.runId}.`);
  }

  const expiresAt = new Date(new Date(input.now).getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
  const leaseInputs = buildRunLeaseInputs({
    runId: input.runId,
    workUnit: input.workUnit,
    attempt: input.attempt,
    runRequest: input.runRequest,
    channel,
    taskId: task ? taskId : undefined,
    now: input.now,
  });
  const semaphoreInputs = buildRunSemaphoreInputs({
    workUnit: input.workUnit,
    attempt: input.attempt,
    channel,
    channelParallelLimit: input.channelParallelLimit,
    providerKey: input.providerKey,
    runnerId: input.runnerId,
    now: input.now,
  });
  const recovered = input.store.recoverUserInputContinuationPrestart({
    claim: input.claim,
    bindingRef: { id: input.binding.id, fingerprint: input.binding.fingerprint },
    sourceFence: input.binding.fence,
    runId: input.runId,
    leases: leaseInputs,
    semaphores: semaphoreInputs,
    now: input.now,
    expiresAt,
  });
  if (recovered.status === "changed") {
    throw recoveryChanged("The admitted Attempt or recovery claim changed during atomic pre-start recovery.");
  }
  if (recovered.status === "busy") {
    throw new UserInputContinuationPrestartDeferredError(recovered.kind,
      recovered.resourceType, recovered.resourceKey);
  }
  return { channel, task, taskExists: Boolean(task), leases: recovered.leases };
}

/**
 * A task claim belongs to the logical Run, not a fresh fenced Attempt. Reuse it
 * only after reading the actual durable continuation and its current target in
 * one snapshot. Resource/semaphore admission still uses the captured target
 * fence, so a takeover after this read cannot acquire the successor's leases.
 */
function canReuseTaskClaimForContinuation(
  input: Parameters<typeof prepareRunConcurrency>[0],
  task: Task,
  claimedRunId: string,
): boolean {
  const continuationId = input.existingContinuationId;
  if (!continuationId || claimedRunId !== input.runId) return false;
  return input.store.readSnapshot(() => {
    const currentTask = input.store.getTask(task.id);
    const continuation = input.store.getRunnerContinuation(continuationId);
    const run = input.store.getRun(input.runId);
    const unit = input.store.getWorkUnit(input.workUnit.id);
    const target = input.store.getWorkUnitAttempt(input.attempt.id);
    const source = continuation ? input.store.getWorkUnitAttempt(continuation.sourceAttemptId) : undefined;
    if (!currentTask || !continuation || !run || !unit || !target || !source) return false;
    return (currentTask.status === "claimed" || currentTask.status === "running")
      && (!currentTask.currentRunId || currentTask.currentRunId === run.id)
      && (continuation.state === "prepared" || (continuation.state === "claimed"
        && Boolean(continuation.claimExpiresAt && continuation.claimExpiresAt > input.now)))
      && continuation.runId === run.id
      && continuation.workUnitId === unit.id
      && continuation.targetAttemptId === target.id
      && continuation.contextViewId === run.contextViewId
      && source.workUnitId === unit.id && source.id !== target.id
      && run.taskId === currentTask.id && run.workUnitId === unit.id
      && (run.status === "queued" || run.status === "running") && !run.endedAt
      && unit.linkedRunId === run.id && unit.activeAttemptId === target.id
      && unit.workspaceId === input.workUnit.workspaceId
      && (unit.status === "queued" || unit.status === "claimed") && !unit.endedAt
      && target.workUnitId === unit.id && input.attempt.workUnitId === unit.id
      && target.status === "created" && !target.endedAt && !target.abortRequestedAt
      && target.runtimeInstanceId === input.attempt.runtimeInstanceId
      && target.fencingToken === input.attempt.fencingToken;
  });
}

export function claimPreparedRunTask(input: {
  readonly store: RunStore;
  readonly task?: Task;
  readonly runRequest: RunRequest;
  readonly runId: string;
  readonly leases: readonly ResourceLease[];
  readonly attempt: WorkUnitAttempt;
  readonly now: string;
}): void {
  const task = input.task;
  if (!task) {
    return;
  }
  const claimEvent = task.status === "todo" ? "claim" : task.status === "failed" ? "retry" : undefined;
  if (claimEvent) {
    const result = input.store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: task.status,
      event: claimEvent,
      actor: "system",
      reason: `run:${input.runId}`,
      idempotencyKey: input.runRequest.idempotencyKey,
      now: input.now,
    });
    if (result.ok) {
      return;
    }
    releasePreparedRunResources(input.store, input.attempt, input.now, "task-claim-failed");
    throw new HttpError(409, result.code, `Task transition failed: ${result.code}`);
  }
  if (task.status !== "claimed") {
    releasePreparedRunResources(input.store, input.attempt, input.now, "task-not-runnable");
    throw new HttpError(409, "task_not_runnable", `Task ${task.id} is ${task.status}`);
  }
}

export function releasePreparedRunResources(
  store: RunStore,
  attempt: WorkUnitAttempt,
  now: string,
  semaphoreReason: string,
): void {
  store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), now, semaphoreReason);
  store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), now, semaphoreReason);
}

export function acquireRunRuntimeSemaphores(input: {
  readonly store: RunStore;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly channel?: Channel;
  readonly channelParallelLimit?: number;
  readonly providerKey: string;
  readonly runnerId?: string;
  readonly now: string;
}): void {
  for (const slotInput of buildRunSemaphoreInputs(input)) {
    const slot = input.store.acquireRuntimeSemaphoreSlot(slotInput);
    if (!slot) {
      input.store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(input.attempt), input.now, "semaphore-conflict");
      input.store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(input.attempt), input.now, "semaphore-conflict");
      const message = `Runtime semaphore is full: ${slotInput.resourceType}:${slotInput.resourceKey}`;
      if (input.channel?.runtimePolicy.queueOnConflict) {
        throw new QueueableRunConflictError("runtime_semaphore_conflict", message, input.channel);
      }
      throw new HttpError(409, "runtime_semaphore_conflict", message);
    }
    appendSemaphoreAcquired(input.store, input.attempt, slot, slotInput.limit, input.now);
  }
}

function assertRecoverablePreparedRunOwner(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
}): void {
  const currentRun = input.store.getRun(input.runId);
  const currentUnit = input.store.getWorkUnit(input.workUnit.id);
  const currentAttempt = input.store.getWorkUnitAttempt(input.attempt.id);
  if (!currentRun || currentRun.status !== "queued" || currentRun.endedAt
    || currentRun.workUnitId !== input.workUnit.id
    || !currentUnit || currentUnit.status !== "claimed" || currentUnit.endedAt
    || currentUnit.linkedRunId !== currentRun.id || currentUnit.activeAttemptId !== input.attempt.id
    || !currentAttempt || currentAttempt.status !== "created" || currentAttempt.endedAt || currentAttempt.abortRequestedAt
    || !isDeepStrictEqual(toRuntimeAttemptFence(currentAttempt), toRuntimeAttemptFence(input.attempt))) {
    throw recoveryChanged("The admitted pre-start Run owner changed before resource recovery.");
  }
}

function buildRunSemaphoreInputs(input: {
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly channel?: Channel;
  readonly channelParallelLimit?: number;
  readonly providerKey: string;
  readonly runnerId?: string;
  readonly now: string;
}): Parameters<RunStore["acquireRuntimeSemaphoreSlot"]>[0][] {
  const expiresAt = new Date(new Date(input.now).getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
  const slots = [
    { resourceType: "provider" as const, resourceKey: input.providerKey, limit: 4 },
    { resourceType: "runner" as const, resourceKey: input.runnerId ?? DEFAULT_RUNNER_ID, limit: 4 },
    ...(input.channel ? [{ resourceType: "channel_parallel" as const, resourceKey: input.channel.id,
      limit: Math.max(input.channelParallelLimit ?? input.channel.runtimePolicy.maxConcurrentRuns, 1) }] : []),
  ];
  return slots.map((slot) => ({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: slot.resourceType,
    resourceKey: slot.resourceKey,
    limit: slot.limit,
    ownerType: "work_unit_attempt" as const,
    ownerId: input.attempt.id,
    ...toRuntimeAttemptFence(input.attempt),
    acquiredAt: input.now,
    expiresAt,
  }));
}

function appendSemaphoreAcquired(
  store: RunStore,
  attempt: WorkUnitAttempt,
  slot: ReturnType<RunStore["listRuntimeSemaphoreSlots"]>[number],
  limit: number,
  now: string,
): void {
  store.appendRuntimeEvent({
    ...toRuntimeAttemptFence(attempt),
    type: "semaphore_acquired",
    actor: "system",
    ts: now,
    data: { id: slot.id, resourceType: slot.resourceType, resourceKey: slot.resourceKey, limit },
  });
}

function recoveryChanged(message: string): HttpError {
  return new HttpError(409, "continuation_resource_recovery_changed", message);
}

function buildRunLeaseInputs(input: {
  readonly runId: string;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly runRequest: RunRequest;
  readonly channel?: Channel;
  readonly taskId?: string;
  readonly now: string;
}): Parameters<RunStore["acquireResourceLease"]>[0][] {
  const expiresAt = new Date(new Date(input.now).getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
  const base = removeUndefined({
    workspaceId: DEFAULT_WORKSPACE_ID,
    ownerType: "run" as const,
    ownerId: input.runId,
    acquiredAt: input.now,
    expiresAt,
    workUnitId: input.workUnit.id,
    attemptId: input.attempt.id,
    runtimeInstanceId: input.attempt.runtimeInstanceId,
    fencingToken: input.attempt.fencingToken,
  });
  const leases: Parameters<RunStore["acquireResourceLease"]>[0][] = [];

  if (input.taskId) {
    leases.push({
      ...base,
      resourceType: "task",
      resourceKey: input.taskId,
    });
  }

  if (usesSideEffectTools(input.runRequest.tools ?? [])) {
    const scope = input.channel?.runtimePolicy.writeLockScope ?? "boundPath";
    if (scope === "workspace") {
      leases.push({ ...base, resourceType: "workspace", resourceKey: DEFAULT_WORKSPACE_ID });
    } else if (scope === "channel" && input.channel) {
      leases.push({ ...base, resourceType: "channel", resourceKey: input.channel.id });
    } else if (scope === "channel") {
      leases.push({ ...base, resourceType: "workspace", resourceKey: DEFAULT_WORKSPACE_ID });
    } else {
      leases.push({ ...base, resourceType: "bound_path", resourceKey: canonicalResourcePath(input.runRequest.cwd) });
    }
  }

  return leases;
}

function canonicalResourcePath(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export class QueueableRunConflictError extends HttpError {
  constructor(
    readonly code: QueueableRunConflictCode,
    message: string,
    readonly channel?: Channel,
    readonly task?: Task,
  ) {
    super(409, code, message);
  }
}

export class UserInputContinuationPrestartDeferredError extends HttpError {
  constructor(
    readonly kind: "resource" | "semaphore" | "sqlite",
    readonly resourceType?: string,
    readonly resourceKey?: string,
  ) {
    const resource = resourceType && resourceKey ? `: ${resourceType}:${resourceKey}` : "";
    super(503, "user_input_continuation_prestart_busy", `Answer continuation pre-start is temporarily busy (${kind})${resource}`);
  }
}

export class DuplicateRunRequestError extends Error {
  constructor(readonly runId: string) {
    super(`Duplicate run request for ${runId}`);
  }
}

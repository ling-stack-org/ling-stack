import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  DEFAULT_WORKSPACE_ID,
  type Channel,
  type ResourceLease,
  type RunStore,
  type Task,
  type WorkUnit,
  type WorkUnitAttempt,
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
  readonly workUnitId?: string;
  readonly attemptId?: string;
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
        throw new DuplicateRunRequestError(runId);
      }
      throw new HttpError(409, "duplicate_run_request", "Duplicate run request");
    }
  }

  const leases: ResourceLease[] = [];
  const leaseInputs = buildRunLeaseInputs({
    runId: input.runId,
    workUnitId: input.workUnitId,
    attemptId: input.attemptId,
    runRequest: input.runRequest,
    channel,
    taskId: task ? taskId : undefined,
    now: input.now,
  });

  for (const leaseInput of leaseInputs) {
    const lease = input.store.acquireResourceLease(leaseInput);
    if (!lease) {
      const blockingLease = input.store.getBlockingResourceLease(leaseInput.resourceType, leaseInput.resourceKey);
      for (const acquiredLease of leases) {
        input.store.releaseResourceLeasesForOwner(acquiredLease.ownerType, acquiredLease.ownerId, input.now);
      }
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

export function claimPreparedRunTask(input: {
  readonly store: RunStore;
  readonly task?: Task;
  readonly runRequest: RunRequest;
  readonly runId: string;
  readonly leases: readonly ResourceLease[];
  readonly attemptId?: string;
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
    releasePreparedRunResources(input.store, input.leases, input.attemptId, input.now, "task-claim-failed");
    throw new HttpError(409, result.code, `Task transition failed: ${result.code}`);
  }
  if (task.status !== "claimed") {
    releasePreparedRunResources(input.store, input.leases, input.attemptId, input.now, "task-not-runnable");
    throw new HttpError(409, "task_not_runnable", `Task ${task.id} is ${task.status}`);
  }
}

export function releasePreparedRunResources(
  store: RunStore,
  leases: readonly ResourceLease[],
  attemptId: string | undefined,
  now: string,
  semaphoreReason: string,
): void {
  for (const lease of leases) {
    store.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, now);
  }
  if (attemptId) {
    store.releaseRuntimeSemaphoreSlotsForOwner(attemptId, now, semaphoreReason);
  }
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
  const expiresAt = new Date(new Date(input.now).getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
  const slots = [
    {
      resourceType: "provider" as const,
      resourceKey: input.providerKey,
      limit: 4,
    },
    {
      resourceType: "runner" as const,
      resourceKey: input.runnerId ?? DEFAULT_RUNNER_ID,
      limit: 4,
    },
    ...(input.channel
      ? [
          {
            resourceType: "channel_parallel" as const,
            resourceKey: input.channel.id,
            limit: Math.max(input.channelParallelLimit ?? input.channel.runtimePolicy.maxConcurrentRuns, 1),
          },
        ]
      : []),
  ];

  for (const slotInput of slots) {
    const slot = input.store.acquireRuntimeSemaphoreSlot({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: slotInput.resourceType,
      resourceKey: slotInput.resourceKey,
      limit: slotInput.limit,
      ownerType: "work_unit_attempt",
      ownerId: input.attempt.id,
      workUnitId: input.workUnit.id,
      attemptId: input.attempt.id,
      acquiredAt: input.now,
      expiresAt,
    });
    if (!slot) {
      input.store.releaseRuntimeSemaphoreSlotsForOwner(input.attempt.id, input.now, "semaphore-conflict");
      for (const lease of input.store.listResourceLeases({ workUnitId: input.workUnit.id, status: "active", limit: 500 })) {
        input.store.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, input.now);
      }
      const message = `Runtime semaphore is full: ${slotInput.resourceType}:${slotInput.resourceKey}`;
      if (input.channel?.runtimePolicy.queueOnConflict) {
        throw new QueueableRunConflictError("runtime_semaphore_conflict", message, input.channel);
      }
      throw new HttpError(409, "runtime_semaphore_conflict", message);
    }
    input.store.appendRuntimeEvent({
      workUnitId: input.workUnit.id,
      attemptId: input.attempt.id,
      type: "semaphore_acquired",
      actor: "system",
      ts: input.now,
      data: {
        id: slot.id,
        resourceType: slot.resourceType,
        resourceKey: slotInput.resourceKey,
        limit: slotInput.limit,
      },
    });
  }
}

function buildRunLeaseInputs(input: {
  readonly runId: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
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
    workUnitId: input.workUnitId,
    attemptId: input.attemptId,
  });
  const leases: Parameters<RunStore["acquireResourceLease"]>[0][] = [];

  if (input.taskId) {
    leases.push({
      ...base,
      resourceType: "task",
      resourceKey: input.taskId,
    });
  }

  if (input.channel?.runtimePolicy.executionMode === "serial") {
    leases.push({
      ...base,
      resourceType: "channel",
      resourceKey: input.channel.id,
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

export class DuplicateRunRequestError extends Error {
  constructor(readonly runId: string) {
    super(`Duplicate run request for ${runId}`);
  }
}

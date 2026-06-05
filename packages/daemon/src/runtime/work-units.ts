import {
  DEFAULT_WORKSPACE_ID,
  type RunnerFallbackReason,
  type RunStore,
  type RuntimeEvent,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitKind,
  type WorkUnitStatus,
} from "@ling-stack/core";
import { DEFAULT_RUNNER_ID } from "./runners.js";
import type { RuntimeSupervisor } from "./supervisor.js";

export { DEFAULT_RUNNER_ID } from "./runners.js";

export function listActiveWorkUnits(store: RunStore): WorkUnit[] {
  return [
    ...store.listWorkUnits({ status: "claimed", limit: 500 }),
    ...store.listWorkUnits({ status: "running", limit: 500 }),
    ...store.listWorkUnits({ status: "waiting_for_approval", limit: 500 }),
    ...store.listWorkUnits({ status: "cancelling", limit: 500 }),
  ];
}

export function isActiveWorkUnitStatus(status: WorkUnitStatus): boolean {
  return status === "claimed" || status === "running" || status === "waiting_for_approval" || status === "cancelling";
}

export function isStuckWorkUnit(workUnit: WorkUnit, now: Date): boolean {
  if (!isActiveWorkUnitStatus(workUnit.status)) {
    return false;
  }
  const heartbeatAge = ageMs(workUnit.lastHeartbeatAt, now);
  if (heartbeatAge !== undefined && heartbeatAge > workUnit.timeoutPolicy.heartbeatTimeoutMs) {
    return true;
  }
  const activityAge = ageMs(workUnit.lastEventAt ?? workUnit.updatedAt, now);
  if (activityAge !== undefined && activityAge > workUnit.timeoutPolicy.idleTimeoutMs) {
    return true;
  }
  const runAge = ageMs(workUnit.startedAt ?? workUnit.createdAt, now);
  return runAge !== undefined && runAge > workUnit.timeoutPolicy.hardTimeoutMs;
}

function ageMs(value: string | undefined, now: Date): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? now.getTime() - parsed : undefined;
}

export function markWorkUnitStale(store: RunStore, workUnit: WorkUnit, now: string, reason: string): WorkUnit {
  const attempt = workUnit.activeAttemptId ? store.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
  const event = workUnit.status === "cancelling" ? "cancel_timeout" : "runner_lost";
  const transition = store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: workUnit.status,
    event,
    actor: "system",
    reason,
    now,
    endedAt: now,
    errorCode: "runtime_stale",
    errorMessage: reason,
  });
  if (transition.ok) {
    store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      attemptId: attempt?.id,
      type: "work_unit_stale",
      actor: "system",
      ts: now,
      data: { reason, fromStatus: transition.from },
    });
  }
  if (attempt) {
    store.updateWorkUnitAttemptStatus({
      attemptId: attempt.id,
      status: "lost",
      now,
      endedAt: now,
      errorCode: "runtime_stale",
      errorMessage: reason,
    });
    store.releaseRuntimeSemaphoreSlotsForOwner(attempt.id, now, "stale-released");
  }
  for (const lease of store.listResourceLeases({ workUnitId: workUnit.id, status: "active", limit: 500 })) {
    store.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, now);
  }
  return store.getWorkUnit(workUnit.id) ?? workUnit;
}

export function startRuntimeWorkUnit(input: {
  readonly store: RunStore;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly kind: WorkUnitKind;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly fallbackReason?: RunnerFallbackReason;
  readonly linkedMessageId?: string;
  readonly linkedMediaJobId?: string;
  readonly linkedExternalWorkId?: string;
  readonly idempotencyKey: string;
  readonly request: unknown;
}): { readonly workUnit: WorkUnit; readonly attempt: WorkUnitAttempt } {
  const now = new Date().toISOString();
  const runtime = input.runtimeSupervisor.getRuntime(input.store.paths.cwd, input.store);
  const effectiveRunnerId = input.effectiveRunnerId ?? DEFAULT_RUNNER_ID;
  const workUnit = input.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: input.kind,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    channelId: input.channelId,
    teammateId: input.teammateId,
    providerPresetId: input.providerPresetId,
    runnerId: effectiveRunnerId,
    requestedRunnerId: input.requestedRunnerId,
    effectiveRunnerId,
    fallbackReason: input.fallbackReason,
    idempotencyKey: input.idempotencyKey,
    createdByActor: "system",
    request: input.request,
    linkedMessageId: input.linkedMessageId,
    linkedMediaJobId: input.linkedMediaJobId,
    linkedExternalWorkId: input.linkedExternalWorkId,
    now,
  });
  input.store.appendRuntimeEvent({
    workUnitId: workUnit.id,
    type: "work_unit_created",
    actor: "system",
    ts: now,
    data: { kind: input.kind, ownerType: input.ownerType, ownerId: input.ownerId },
  });
  const attempt = input.store.createWorkUnitAttempt({
    workUnitId: workUnit.id,
    attemptNumber: workUnit.attemptCount + 1,
    runtimeInstanceId: runtime.runtimeInstanceId,
    runnerId: effectiveRunnerId,
    requestedRunnerId: input.requestedRunnerId,
    effectiveRunnerId,
    fallbackReason: input.fallbackReason,
    providerPresetId: input.providerPresetId,
    now,
  });
  input.store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: "queued",
    event: "claim",
    actor: "system",
    now,
    activeAttemptId: attempt.id,
  });
  input.store.transitionWorkUnitStatus({
    workUnitId: workUnit.id,
    expectedStatus: "claimed",
    event: "runner_started",
    actor: "runner",
    now,
    startedAt: now,
    lastHeartbeatAt: now,
  });
  input.store.updateWorkUnitAttemptStatus({
    attemptId: attempt.id,
    status: "started",
    now,
    startedAt: now,
    lastHeartbeatAt: now,
  });
  input.store.appendRuntimeEvent({
    workUnitId: workUnit.id,
    attemptId: attempt.id,
    type: "work_unit_started",
    actor: "runner",
    ts: now,
    data: {
      linkedMessageId: input.linkedMessageId,
      linkedMediaJobId: input.linkedMediaJobId,
      linkedExternalWorkId: input.linkedExternalWorkId,
    },
  });
  return {
    workUnit: input.store.getWorkUnit(workUnit.id) ?? workUnit,
    attempt: input.store.getWorkUnitAttempt(attempt.id) ?? attempt,
  };
}

export function cancelStandaloneWorkUnit(store: RunStore, workUnit: WorkUnit, reason: string): WorkUnit {
  const attemptId = workUnit.activeAttemptId ?? store.listWorkUnitAttempts(workUnit.id).at(-1)?.id;
  if (attemptId) {
    transitionWorkUnitCancelled(store, workUnit.id, attemptId, reason);
  } else if (!isTerminalWorkUnitStatus(workUnit.status) && workUnit.status !== "stale") {
    const now = new Date().toISOString();
    const cancelling = store.transitionWorkUnitStatus({
      workUnitId: workUnit.id,
      expectedStatus: workUnit.status,
      event: "cancel",
      actor: "local-user",
      reason,
      now,
    });
    if (cancelling.ok) {
      store.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        expectedStatus: "cancelling",
        event: "runner_cancelled",
        actor: "system",
        reason,
        now,
        endedAt: now,
      });
    }
  }
  releaseWorkUnitRuntimeResources(store, workUnit, new Date().toISOString(), "cancelled");
  return store.getWorkUnit(workUnit.id) ?? workUnit;
}

export function releaseWorkUnitRuntimeResources(
  store: RunStore,
  workUnit: WorkUnit,
  now: string,
  releaseReason: string,
): WorkUnit {
  for (const attempt of store.listWorkUnitAttempts(workUnit.id)) {
    store.releaseRuntimeSemaphoreSlotsForOwner(attempt.id, now, releaseReason);
  }
  for (const lease of store.listResourceLeases({ workUnitId: workUnit.id, status: "active", limit: 500 })) {
    store.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, now);
  }
  return store.getWorkUnit(workUnit.id) ?? workUnit;
}

export function transitionWorkUnitTerminal(
  store: RunStore,
  input: {
    readonly workUnitId: string;
    readonly attemptId: string;
    readonly event: Parameters<RunStore["transitionWorkUnitStatus"]>[0]["event"];
    readonly attemptStatus: WorkUnitAttempt["status"];
    readonly runtimeEventType: RuntimeEvent["type"];
    readonly actor: Parameters<RunStore["transitionWorkUnitStatus"]>[0]["actor"];
    readonly now: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  },
): void {
  const current = store.getWorkUnit(input.workUnitId);
  if (!current || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
    return;
  }
  const transition = store.transitionWorkUnitStatus({
    workUnitId: input.workUnitId,
    expectedStatus: current.status,
    event: input.event,
    actor: input.actor,
    now: input.now,
    endedAt: input.now,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
  });
  if (!transition.ok) {
    return;
  }
  store.updateWorkUnitAttemptStatus({
    attemptId: input.attemptId,
    status: input.attemptStatus,
    now: input.now,
    endedAt: input.now,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
  });
  store.appendRuntimeEvent({
    workUnitId: input.workUnitId,
    attemptId: input.attemptId,
    type: input.runtimeEventType,
    actor: input.actor === "runner" ? "runner" : input.actor === "provider" ? "provider" : "system",
    ts: input.now,
    data: {
      fromStatus: transition.from,
      toStatus: transition.to,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    },
  });
}

export function transitionWorkUnitCancelled(store: RunStore, workUnitId: string, attemptId: string, reason: string): void {
  const current = store.getWorkUnit(workUnitId);
  if (!current || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
    return;
  }
  const now = new Date().toISOString();
  const cancelling =
    current.status === "cancelling"
      ? { ok: true as const, from: current.status, to: current.status }
      : store.transitionWorkUnitStatus({
          workUnitId,
          expectedStatus: current.status,
          event: "cancel",
          actor: "local-user",
          reason,
          now,
        });
  if (!cancelling.ok) {
    return;
  }
  const latest = store.getWorkUnit(workUnitId);
  if (!latest || latest.status !== "cancelling") {
    return;
  }
  transitionWorkUnitTerminal(store, {
    workUnitId,
    attemptId,
    event: "runner_cancelled",
    attemptStatus: "cancelled",
    runtimeEventType: "work_unit_cancelled",
    actor: "runner",
    now,
    errorCode: "cancelled",
    errorMessage: reason,
  });
}

export function isTerminalWorkUnitStatus(status: WorkUnitStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

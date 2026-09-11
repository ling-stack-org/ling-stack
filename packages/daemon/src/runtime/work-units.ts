import {
  DEFAULT_WORKSPACE_ID,
  type RunnerFallbackReason,
  type RunExecutionStoreFacet,
  type RunStorePathsFacet,
  type RuntimeSupervisorStoreFacet,
  type TerminalAttemptStatus,
  type TerminalRuntimeEventType,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitKind,
  type WorkUnitStatus,
  toRuntimeAttemptFence,
} from "@ling-stack/core";
import { DEFAULT_RUNNER_ID } from "./runners.js";
import type { RuntimeSupervisor } from "./supervisor.js";

export { DEFAULT_RUNNER_ID } from "./runners.js";

type RuntimeWorkUnitStore = RuntimeSupervisorStoreFacet;
type RuntimeWorkUnitStartStore = RuntimeSupervisorStoreFacet & RunStorePathsFacet & RunExecutionStoreFacet;
type WorkUnitTransitionEvent = Parameters<RuntimeSupervisorStoreFacet["transitionWorkUnitStatus"]>[0]["event"];
type WorkUnitTransitionActor = Parameters<RuntimeSupervisorStoreFacet["transitionWorkUnitStatus"]>[0]["actor"];

export function listActiveWorkUnits(store: RuntimeWorkUnitStore): WorkUnit[] {
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
  // Approval waits are durable user decisions, not stalled execution. Their
  // own approval expiry is the wait bound; runtime idle/hard budgets must not
  // classify the work unit as stuck while it remains waiting.
  if (workUnit.status === "waiting_for_approval") {
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

export function markWorkUnitStale(store: RuntimeWorkUnitStore, workUnit: WorkUnit, now: string, reason: string): WorkUnit {
  const attempt = workUnit.activeAttemptId ? store.getWorkUnitAttempt(workUnit.activeAttemptId) : undefined;
  const event = workUnit.status === "cancelling" ? "cancel_timeout" : "runner_lost";
  if (attempt) {
    const transitioned = store.transitionWorkUnitAttemptTerminal({
      ...toRuntimeAttemptFence(attempt),
      event: event as WorkUnitTransitionEvent,
      attemptStatus: "lost",
      runtimeEventType: "work_unit_stale",
      actor: "system",
      now,
      errorCode: "runtime_stale",
      errorMessage: reason,
    });
    if (transitioned) {
      store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), now, "stale-released");
      store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), now, "stale-released");
    }
  } else {
    store.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        expectedStatus: workUnit.status,
        event: event as WorkUnitTransitionEvent,
        actor: "system",
        reason,
        now,
        endedAt: now,
        errorCode: "runtime_stale",
        errorMessage: reason,
      });
  }
  return store.getWorkUnit(workUnit.id) ?? workUnit;
}

export function startRuntimeWorkUnit(input: {
  readonly store: RuntimeWorkUnitStartStore;
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
  const existingQueuedMediaWorkUnit = input.kind === "media_job" && input.linkedMediaJobId
    ? input.store.listWorkUnits({
        kind: "media_job",
        status: "queued",
        linkedMediaJobId: input.linkedMediaJobId,
        limit: 1,
      })[0]
    : undefined;
  const workUnit = existingQueuedMediaWorkUnit ?? input.store.createWorkUnit({
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
  if (!existingQueuedMediaWorkUnit) {
    input.store.appendRuntimeEvent({
      workUnitId: workUnit.id,
      type: "work_unit_created",
      actor: "system",
      ts: now,
      data: { kind: input.kind, ownerType: input.ownerType, ownerId: input.ownerId },
    });
  }
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
    workUnitId: attempt.workUnitId,
    runtimeInstanceId: attempt.runtimeInstanceId,
    fencingToken: attempt.fencingToken,
    status: "started",
    now,
    startedAt: now,
    lastHeartbeatAt: now,
  });
  input.store.appendRuntimeEvent({
    workUnitId: workUnit.id,
    attemptId: attempt.id,
    runtimeInstanceId: attempt.runtimeInstanceId,
    fencingToken: attempt.fencingToken,
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

export function cancelStandaloneWorkUnit(store: RuntimeWorkUnitStore, workUnit: WorkUnit, reason: string): WorkUnit {
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
  store: RuntimeWorkUnitStore,
  workUnit: WorkUnit,
  now: string,
  releaseReason: string,
): WorkUnit {
  for (const attempt of store.listWorkUnitAttempts(workUnit.id)) {
    store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), now, releaseReason);
    store.releaseResourceLeasesForAttempt(toRuntimeAttemptFence(attempt), now, releaseReason);
  }
  return store.getWorkUnit(workUnit.id) ?? workUnit;
}

export function transitionWorkUnitTerminal(
  store: RuntimeWorkUnitStore,
  input: {
    readonly workUnitId: string;
    readonly attemptId: string;
    readonly event: WorkUnitTransitionEvent;
    readonly attemptStatus: TerminalAttemptStatus;
    readonly runtimeEventType: TerminalRuntimeEventType;
    readonly actor: WorkUnitTransitionActor;
    readonly now: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  },
): void {
  const attempt = store.getWorkUnitAttempt(input.attemptId);
  if (!attempt || attempt.workUnitId !== input.workUnitId) return;
  store.transitionWorkUnitAttemptTerminal({
    ...toRuntimeAttemptFence(attempt),
    event: input.event,
    attemptStatus: input.attemptStatus,
    runtimeEventType: input.runtimeEventType,
    actor: input.actor,
    now: input.now,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  });
}

export function transitionWorkUnitCancelled(store: RuntimeWorkUnitStore, workUnitId: string, attemptId: string, reason: string): void {
  const current = store.getWorkUnit(workUnitId);
  const attempt = store.getWorkUnitAttempt(attemptId);
  if (!current || !attempt || attempt.workUnitId !== workUnitId || current.activeAttemptId !== attempt.id
    || !["created", "started", "waiting_for_approval", "cancelling"].includes(attempt.status)
    || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
    return;
  }
  const now = new Date().toISOString();
  const cancelling =
    current.status === "cancelling"
      ? { ok: true as const, from: current.status, to: current.status }
      : store.transitionWorkUnitStatus({
          // Fence the first logical mutation, not only the terminal transition below.
          ...toRuntimeAttemptFence(attempt),
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

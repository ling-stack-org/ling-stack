import type { HostOperationSource, RunStore } from "@ling-stack/core";
import type { HostRunCapacityStore } from "@ling-stack/core/runtime-host-capacity-store-bridge";
import type { RuntimeHostCapacityAdmission } from "./run-queue.js";

const terminalRunStatus = (status: string): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";
const terminalAttemptStatus = (status: string): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost";

/**
 * Reattaches crash-window Host receipts without turning a consumed dispatch into
 * a retry. A rerun receipt may be released after restart only when its exact
 * terminal Attempt and Host effect coverage are already durable; otherwise the
 * receipt remains held and is reported as an unknown outcome for manual recovery.
 */
export function recoverHostCapacityReservations(input: {
  readonly store: RunStore;
  readonly workspaceId: string;
  readonly host: HostRunCapacityStore;
  readonly admission: RuntimeHostCapacityAdmission;
  readonly now: string;
}): { readonly observed: number; readonly released: number; readonly unknown: number } {
  const observeReservation = input.admission.observeReservation;
  if (!observeReservation) return { observed: 0, released: 0, unknown: 0 };
  let afterReservationId: string | undefined;
  let observed = 0, released = 0, unknown = 0;
  const workspace = input.admission.getWorkspaceIdentity(input.workspaceId);
  do {
    const page = input.host.listHeld(afterReservationId ? { afterReservationId } : undefined);
    for (const reservation of page.reservations) {
      if (reservation.intent.workspaceKey !== workspace.workspaceKey
        || reservation.intent.canonicalCwd !== workspace.canonicalCwd
        || reservation.intent.databasePath !== workspace.databasePath) continue;
      const record = observeReservation({ workspaceId: input.workspaceId,
        intentId: reservation.intent.intentId, now: input.now });
      if (!record) continue;
      observed += 1;
      if (record.dispatchedAt) {
        if (record.intent.ownerKind !== "node_rerun_target" || !record.source) continue;
        const workUnit = input.store.getWorkUnit(record.source.workUnitId);
        const target = workUnit?.ownerType === "node_rerun_intent" && workUnit.ownerId
          ? input.store.getNodeRerunTarget(workUnit.ownerId) : undefined;
        const run = input.store.getRun(record.source.runId);
        const attempt = input.store.getWorkUnitAttempt(record.source.attemptId);
        const completion = input.store.getHostAttemptCompletion(record.source);
        const exactTarget = target && target.runId === record.source.runId
          && target.fence.workUnitId === record.source.workUnitId
          && target.fence.attemptId === record.source.attemptId
          && target.fence.runtimeInstanceId === record.source.runtimeInstanceId
          && target.fence.fencingToken === record.source.fencingToken;
        const provenTerminal = Boolean(exactTarget && run && workUnit && attempt
          && terminalRunStatus(run.status) && terminalRunStatus(workUnit.status)
          && terminalAttemptStatus(attempt.status) && completion?.drainedAt && completion.effectCoverage);
        if (!provenTerminal || !input.admission.releaseStopped({ workspaceId: input.workspaceId,
          source: record.source, intentId: record.intent.intentId, now: input.now })) {
          unknown += 1;
          recordUnknownRerunOutcome(input.store, record.source, input.now, record.dispatchedAt);
        } else {
          released += 1;
        }
        continue;
      }
      if (!record.source) continue;
      const run = input.store.getRun(record.source.runId);
      const workUnit = input.store.getWorkUnit(record.source.workUnitId);
      if (!run || !workUnit || !terminalRunStatus(run.status) || !terminalRunStatus(workUnit.status)) continue;
      if (input.admission.releaseNoDispatch({ workspaceId: input.workspaceId,
        intentId: record.intent.intentId, now: input.now })) released += 1;
    }
    afterReservationId = page.nextCursor;
  } while (afterReservationId);
  return { observed, released, unknown };
}

function recordUnknownRerunOutcome(store: RunStore, source: HostOperationSource,
  now: string, dispatchedAt: string): void {
  try {
    const events = store.listRuntimeEvents(source.workUnitId, { complete: true });
    if (events.some(event => event.type === "diagnostic_stuck_detected"
      && typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
      && (event.data as { readonly code?: unknown }).code === "node_rerun_dispatch_outcome_unknown"
      && event.attemptId === source.attemptId && event.fencingToken === source.fencingToken)) return;
    store.appendRuntimeDiagnosticEvent({ ...source, type: "diagnostic_stuck_detected", actor: "system", ts: now,
      data: { code: "node_rerun_dispatch_outcome_unknown", dispatchedAt, observedAt: now,
        recovery: "manual_stop_or_host_effect_review_required" } });
  } catch {
    // The capacity receipt remains the authoritative retained fact when a
    // diagnostic projection cannot be appended during startup.
  }
}

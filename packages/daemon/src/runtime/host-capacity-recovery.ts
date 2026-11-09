import type { HostRunCapacityStore } from "@ling-stack/core/runtime-host-capacity-store-bridge";
import type { RunStore } from "@ling-stack/core";
import type { RuntimeHostCapacityAdmission } from "./run-queue.js";

const terminalRunStatus = (status: string): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

/** Reattaches crash-window Host receipts and releases only proven pre-dispatch terminal owners. */
export function recoverHostCapacityReservations(input: {
  readonly store: RunStore;
  readonly workspaceId: string;
  readonly host: HostRunCapacityStore;
  readonly admission: RuntimeHostCapacityAdmission;
  readonly now: string;
}): { readonly observed: number; readonly released: number } {
  const observeReservation = input.admission.observeReservation;
  if (!observeReservation) return { observed: 0, released: 0 };
  const workspace = input.store.paths.identity;
  let afterReservationId: string | undefined;
  let observed = 0;
  let released = 0;
  const workspaceKey = input.admission.getWorkspaceKey(input.workspaceId);
  do {
    const page = input.host.listHeld(afterReservationId ? { afterReservationId } : undefined);
    for (const reservation of page.reservations) {
      if (reservation.intent.workspaceKey !== workspaceKey
        || reservation.intent.canonicalCwd !== workspace.canonicalCwd
        || reservation.intent.databasePath !== input.store.paths.databasePath) continue;
      const record = observeReservation({ workspaceId: input.workspaceId,
        intentId: reservation.intent.intentId, now: input.now });
      if (!record) continue;
      observed += 1;
      if (!record.source || record.dispatchedAt) continue;
      const run = input.store.getRun(record.source.runId);
      const workUnit = input.store.getWorkUnit(record.source.workUnitId);
      if (!run || !workUnit || !terminalRunStatus(run.status) || !terminalRunStatus(workUnit.status)) continue;
      if (input.admission.releaseNoDispatch({ workspaceId: input.workspaceId,
        intentId: record.intent.intentId, now: input.now })) released += 1;
    }
    afterReservationId = page.nextCursor;
  } while (afterReservationId);
  return { observed, released };
}

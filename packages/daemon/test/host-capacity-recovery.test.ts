import assert from "node:assert/strict";
import test from "node:test";
import type { RunStore } from "../../core/dist/index.js";
import type { HostRunCapacityStore, HostRunCapacityReservation } from "../../core/dist/runtime-host-capacity-store-bridge.js";
import { recoverHostCapacityReservations } from "../dist/runtime/host-capacity-recovery.js";
import type { RuntimeHostCapacityAdmission } from "../dist/runtime/run-queue.js";

const workspace = {
  workspaceId: "workspace_path_identity",
  canonicalCwd: "/recovery/workspace",
  databasePath: "/recovery/workspace/.ling-stack/ling-stack.sqlite",
};
const domainWorkspaceId = "workspace_domain_identity";

function reservation(intentId: string, overrides: Partial<HostRunCapacityReservation["intent"]> = {}) {
  return { intent: { intentId, workspaceKey: "workspace-key", canonicalCwd: workspace.canonicalCwd,
    databasePath: workspace.databasePath, databaseFileIdentity: "1:2", ownerKind: "attempt" as const,
    ownerKey: `owner-${intentId}`, authorityDigest: "a".repeat(64), ...overrides },
    reservationId: `reservation-${intentId}`, token: "b".repeat(64), policyRevision: 1,
    reservedAt: "2026-11-09T00:00:00.000Z", state: "held" as const };
}

function fixture(options: { runStatus: string; unitStatus: string; held?: readonly HostRunCapacityReservation[]; dispatchedIds?: readonly string[] }) {
  const observed: string[] = [], observedWorkspaceIds: string[] = [], released: string[] = [], releasedWorkspaceIds: string[] = [];
  const runs = new Map([["run", { id: "run", status: options.runStatus }]]);
  const units = new Map([["unit", { id: "unit", status: options.unitStatus }]]);
  const held = options.held ?? [reservation("intent")];
  const store = { paths: { cwd: workspace.canonicalCwd, databasePath: workspace.databasePath, identity: workspace },
    getRun: (id: string) => runs.get(id), getWorkUnit: (id: string) => units.get(id) } as unknown as RunStore;
  const host = { listHeld: ({ afterReservationId }: { afterReservationId?: string } = {}) => ({
    reservations: afterReservationId ? [] : held,
  }) } as unknown as HostRunCapacityStore;
  const admission = {
    observeReservation: ({ workspaceId, intentId }: { workspaceId: string; intentId: string }) => {
      observedWorkspaceIds.push(workspaceId);
      observed.push(intentId);
      return { intent: { intentId }, source: { runId: "run", workUnitId: "unit", attemptId: "attempt",
        runtimeInstanceId: "runtime", fencingToken: "fence" },
        ...(options.dispatchedIds?.includes(intentId) ? { dispatchedAt: "2026-11-09T00:00:00.500Z" } : {}) } as never;
    },
    releaseNoDispatch: ({ workspaceId, intentId }: { workspaceId: string; intentId: string }) => {
      releasedWorkspaceIds.push(workspaceId);
      released.push(intentId);
      return true;
    },
  } as unknown as RuntimeHostCapacityAdmission;
  return { store, host, admission, observed, observedWorkspaceIds, released, releasedWorkspaceIds };
}

test("startup observation reattaches a crash-window receipt without releasing a live owner", () => {
  const f = fixture({ runStatus: "queued", unitStatus: "queued" });
  assert.deepEqual(recoverHostCapacityReservations({ ...f, workspaceId: domainWorkspaceId, now: "2026-11-09T00:00:01.000Z" }), { observed: 1, released: 0 });
  assert.deepEqual(f.observed, ["intent"]);
  assert.deepEqual(f.observedWorkspaceIds, [domainWorkspaceId]);
  assert.deepEqual(f.released, []);
});

test("startup observation releases a proven pre-dispatch terminal owner", () => {
  const f = fixture({ runStatus: "cancelled", unitStatus: "cancelled" });
  assert.deepEqual(recoverHostCapacityReservations({ ...f, workspaceId: domainWorkspaceId, now: "2026-11-09T00:00:01.000Z" }), { observed: 1, released: 1 });
  assert.deepEqual(f.released, ["intent"]);
  assert.deepEqual(f.releasedWorkspaceIds, [domainWorkspaceId]);
});

test("startup recovery ignores another workspace and already dispatched receipts", () => {
  const f = fixture({ runStatus: "cancelled", unitStatus: "cancelled", held: [
    reservation("foreign", { canonicalCwd: "/other", databasePath: "/other/db" }),
    reservation("dispatched"),
  ], dispatchedIds: ["dispatched"] });
  assert.deepEqual(recoverHostCapacityReservations({ ...f, workspaceId: domainWorkspaceId, now: "2026-11-09T00:00:01.000Z" }), { observed: 1, released: 0 });
  assert.deepEqual(f.observed, ["dispatched"]);
  assert.deepEqual(f.released, []);
});

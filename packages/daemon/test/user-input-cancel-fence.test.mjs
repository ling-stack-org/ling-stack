import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "../../core/dist/index.js";
import { transitionWorkUnitCancelled } from "../dist/runtime/work-units.js";

const now = "2026-09-07T00:00:00.000Z";
for (const scenario of ["replaced", "yielded", "current"]) {
  test(`runner cancellation is fenced before the first logical transition: ${scenario}`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-input-cancel-fence-"));
    const store = createSqliteRunStore(cwd);
    t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
    const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "source",
      idempotencyKey: "source", status: scenario === "yielded" ? "waiting_for_input" : "running", createdByActor: "system", request: {}, now });
    const old = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime",
      runnerId: "runner_pi_embedded", status: scenario === "yielded" ? "yielded" : "started", now });
    if (scenario === "replaced") store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2, runtimeInstanceId: "new-runtime",
      runnerId: "runner_pi_embedded", status: "started", now });
    const before = store.getWorkUnit(unit.id);
    transitionWorkUnitCancelled(store, unit.id, old.id, "old callback");
    if (scenario === "current") {
      assert.equal(store.getWorkUnit(unit.id).status, "cancelled");
      assert.equal(store.getWorkUnitAttempt(old.id).status, "cancelled");
    } else assert.deepEqual(store.getWorkUnit(unit.id), before);
  });
}

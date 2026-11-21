import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("App Server state survives SQLite reopen with CAS and idempotency", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-state-"));
  let store = createSqliteRunStore(cwd);
  try {
    const created = store.putAppServerState({
      kind: "verify_plan",
      recordId: "plan-1",
      idempotencyKey: "plan-idem-1",
      payload: { candidateDigest: "candidate-1", checks: ["typecheck"] },
    }, "2026-11-21T00:00:00.000Z");
    assert.equal(created.status, "created");
    assert.equal(created.record.revision, 1);
    const replay = store.putAppServerState({
      kind: "verify_plan",
      recordId: "plan-1",
      expectedRevision: 999,
      idempotencyKey: "plan-idem-1",
      payload: { candidateDigest: "candidate-1", checks: ["typecheck"] },
    }, "2026-11-21T00:01:00.000Z");
    assert.equal(replay.status, "replayed");
    assert.equal(store.putAppServerState({
      kind: "verify_plan",
      recordId: "plan-1",
      expectedRevision: 999,
      payload: { candidateDigest: "candidate-2" },
    }, "2026-11-21T00:02:00.000Z"), undefined);
    store.close();
    store = createSqliteRunStore(cwd);
    assert.deepEqual(store.getAppServerState("verify_plan", "plan-1"), created.record);
    const updated = store.putAppServerState({
      kind: "verify_plan",
      recordId: "plan-1",
      expectedRevision: 1,
      idempotencyKey: "plan-idem-2",
      payload: { candidateDigest: "candidate-1", checks: ["typecheck", "test"] },
    }, "2026-11-21T00:03:00.000Z");
    assert.equal(updated.status, "updated");
    assert.equal(updated.record.revision, 2);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

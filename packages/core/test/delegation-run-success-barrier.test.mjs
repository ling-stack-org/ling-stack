import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureNormalTerminalReportBasis, DelegationCompletionBarrierError } from "../dist/index.js";
import { createBudgetHarness, budgetLater } from "./support/delegation-budget-fixture.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-success-"));
  const f = createBudgetHarness(cwd);
  t.after(async () => { f.store.close(); await rm(cwd, { recursive: true, force: true }); });
  f.freeze(); f.start();
  return f;
}

const succeed = f => f.store.transitionRunExecutionStatus({ runId: "root", sourceFence: f.fence,
  expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: budgetLater, endedAt: budgetLater,
  idempotencyKey: "root-success" });
const unsettled = error => error instanceof DelegationCompletionBarrierError
  && error.code === "delegation.required_children_unsettled" && error.status === "pending";

test("required queued child blocks both execution and legacy Run success without partial state", async t => {
  const f = await fixture(t); f.spawn();
  assert.throws(() => succeed(f), unsettled);
  assert.throws(() => f.store.markRunSucceeded("root", budgetLater), unsettled);
  assert.equal(f.store.getRun("root").status, "running");
  assert.equal(f.store.getRun("root").endedAt, undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM state_transition_events WHERE entity_id='root' AND to_status='succeeded'").get().n, 0);
});

test("successful no-child Run still uses existing execution and idempotency semantics", async t => {
  const f = await fixture(t);
  assert.equal(succeed(f).ok, true);
  assert.equal(f.store.getRun("root").status, "succeeded");
  assert.equal(succeed(f).code, "stale_transition", "a terminal Run no longer accepts execution-owned writes");
  assert.equal(f.store.transitionRunStatus({ runId: "root", event: "runner_succeeded", actor: "system",
    now: budgetLater, idempotencyKey: "root-success" }).duplicate, true);
});

test("optional work retains its optional disposition but must actually stop before root success", async t => {
  const f = await fixture(t); const child = f.spawn({ required: false });
  assert.throws(() => succeed(f), unsettled);
  assert.equal(f.store.getRun("root").status, "running");
  const evidence = f.store.getDelegationCompletionEvidence({ rootRunIds: ["root"] });
  assert.equal(evidence.status, "pending");
  assert.equal(evidence.steps[0].step.required, false);
  assert.equal(evidence.steps[0].reservation.state, "reserved");
  assert.equal(f.store.listWorkUnitAttempts(child.childWorkUnit.id).length, 0);
});

test("failed success barrier joins an outer transaction without rolling back its owner", async t => {
  const f = await fixture(t); f.spawn();
  f.db.exec("BEGIN IMMEDIATE");
  try {
    f.db.prepare("UPDATE run_sessions SET summary_path='outer-owner' WHERE id='root'").run();
    assert.throws(() => succeed(f), unsettled);
    assert.equal(f.store.getRun("root").summaryPath, "outer-owner");
    f.db.exec("COMMIT");
  } catch (error) { f.db.exec("ROLLBACK"); throw error; }
  assert.equal(f.store.getRun("root").summaryPath, "outer-owner");
  assert.equal(f.store.getRun("root").status, "running");
});

test("stale execution ownership is rejected before descendant admission", async t => {
  const f = await fixture(t); f.spawn();
  const result = f.store.transitionRunExecutionStatus({ runId: "root", sourceFence: { ...f.fence, fencingToken: "stale" },
    expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: budgetLater });
  assert.equal(result.ok, false); assert.equal(result.code, "stale_transition");
  assert.equal(f.store.getRun("root").status, "running");
});

test("normal report success cannot trust raw succeeded state over pending required descendants", async t => {
  const f = await fixture(t);
  const thread = f.store.createLingThread({ kind: "conversation", title: "Dedicated QA", objective: "Verify fan-in" }, budgetLater);
  const accepted = f.store.appendConversationUserTurn({ threadId: thread.id, itemId: "source", turnId: "turn",
    title: "Dedicated QA", userInstruction: "Verify fan-in", actorType: "local_user", actorId: "local-user", idempotencyKey: "qa-input",
    payload: { body: "Verify fan-in", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, budgetLater);
  // Isolated fixture ownership: no real workspace or historical database is mutated.
  f.db.prepare("UPDATE run_sessions SET thread_id=? WHERE id='root'").run(thread.id);
  f.store.linkRunToLingTurn({ turnId: accepted.turnId, runId: "root", now: budgetLater });
  const before = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: accepted.turnId });
  assert.ok(before); f.spawn();
  const after = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: accepted.turnId });
  assert.notEqual(after.fingerprint, before.fingerprint, "original child facts must participate in the synthesis CAS");
  // Fault injection represents stale/corrupt pre-barrier status, not accepted completion.
  f.db.prepare("UPDATE run_sessions SET status='succeeded',ended_at=?,updated_at=? WHERE id='root'").run(budgetLater, budgetLater);
  f.store.reconcileLingTurnStatus(accepted.turnId, budgetLater);
  const forged = captureNormalTerminalReportBasis(f.store, { kind: "turn", id: accepted.turnId });
  assert.equal(forged.effectiveRunStatus, "succeeded");
  assert.equal(forged.successAllowed, false, "normal report must independently read the required subtree");
});

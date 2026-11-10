import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toRuntimeAttemptFence } from "../dist/index.js";
import { assertUserInputDurableQuiescence } from "../dist/storage/sqlite/user-input-durable-quiescence.js";
import { createBudgetHarness, budgetNow, budgetLater } from "./support/delegation-budget-fixture.mjs";

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-delegation-attempt-scope-"));
  const f = createBudgetHarness(cwd);
  let finish, completion;
  t.after(async () => {
    if (finish) { finish(); await completion; }
    f.store.close(); await rm(cwd, { recursive: true, force: true });
  });
  f.start();
  const oldSource = { runId: "root", ...f.fence };
  const ticket = f.store.prepareHostCommandExecution({ runId: "root", sourceFence: f.fence, toolCallId: "reused-call", cwd,
    command: { kind: "shell", command: "echo fixture", shell: "bash" } });
  f.store.settleHostCommandExecution(ticket, options.unknown ? { kind: "observed", observation: {
    scope: "process_group", leaderExited: true, stdioClosed: true, descendants: "unverified", settledBy: "close",
    signalFailures: [], stopReason: "cancelled" } } : { kind: "not_started" });
  const lifetime = options.pending ? new Promise(resolve => { finish = resolve; }) : Promise.resolve();
  completion = f.store.trackHostAttemptCompletion(oldSource, lifetime, () => options.unknown ? true : ["reused-call"]);
  if (!options.pending) await completion;
  const endedAt = new Date().toISOString();
  f.db.prepare("UPDATE work_unit_attempts SET status='cancelled',ended_at=? WHERE id=?").run(endedAt, f.attempt.id);
  const next = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2, runtimeInstanceId: "runtime-2", runnerId: "pi", status: "started", now: endedAt });
  const nextFence = toRuntimeAttemptFence(next);
  const at = () => Date.now() + 1000;
  return { ...f, oldSource, next, nextFence, at, completion };
}

test("whole-Run quiescence still refuses mixed Attempts, explicit exact scope verifies then excludes closed old facts", async t => {
  const f = await fixture(t);
  assert.throws(() => assertUserInputDurableQuiescence(f.db, "root", f.nextFence, f.at()), { code: "not_quiescent" });
  assert.equal(assertUserInputDurableQuiescence(f.db, "root", f.nextFence, f.at(), "exact_attempt").size, 0);
});

test("reused toolCallId in a later Attempt is scoped by the complete source, not globally deduplicated", async t => {
  const f = await fixture(t);
  const ticket = f.store.prepareHostCommandExecution({ runId: "root", sourceFence: f.nextFence, toolCallId: "reused-call", cwd: f.cwd,
    command: { kind: "shell", command: "echo next fixture", shell: "bash" } });
  f.store.settleHostCommandExecution(ticket, { kind: "not_started" });
  assert.deepEqual([...assertUserInputDurableQuiescence(f.db, "root", f.nextFence, f.at(), "exact_attempt")], [["reused-call", "bash"]]);
});

for (const options of [{ pending: true }, { unknown: true }]) test(`unverified historical ${Object.keys(options)[0]} remains a stop veto`, async t => {
  const f = await fixture(t, options);
  assert.throws(() => assertUserInputDurableQuiescence(f.db, "root", f.nextFence, f.at(), "exact_attempt"), { code: "not_quiescent" });
});

for (const field of ["attemptId", "runtimeInstanceId", "fencingToken", "workUnitId"]) test(`a foreign historical ${field} is never discarded as another Attempt`, async t => {
  const f = await fixture(t);
  const row = f.db.prepare("SELECT id,data_json FROM run_events WHERE run_id='root' AND type='host_command_prepared'").get();
  const data = JSON.parse(row.data_json);
  data.source[field] = "orphan";
  f.db.prepare("UPDATE run_events SET data_json=? WHERE id=?").run(JSON.stringify(data), row.id);
  assert.throws(() => assertUserInputDurableQuiescence(f.db, "root", f.nextFence, f.at(), "exact_attempt"), { code: "not_quiescent" });
});

test("historical nonterminal Attempt cannot be excluded even with an ended Host lifetime", async t => {
  const f = await fixture(t);
  f.db.prepare("UPDATE work_unit_attempts SET status='cancelled',ended_at=? WHERE id=?")
    .run(new Date().toISOString(), f.next.id);
  f.db.prepare("UPDATE work_unit_attempts SET status='started',ended_at=NULL WHERE id=?").run(f.attempt.id);
  assert.throws(() => assertUserInputDurableQuiescence(f.db, "root", f.nextFence, f.at(), "exact_attempt"), { code: "not_quiescent" });
});

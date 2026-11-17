import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSqliteRunStore, createSqliteGoalSupervisionStore, parseGoalSupervisionPolicy, type RunStore } from "../dist/index.js";

const now = "2026-11-16T00:00:00.000Z", later = "2026-11-16T00:01:00.000Z";
async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-goal-supervision-")), store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createLingThread({ kind: "conversation", title: "Goal", objective: "Verify acceptance" }, now);
  return { cwd, store, thread };
}
function run(store: RunStore, cwd: string, threadId: string, id: string) {
  const result = store.createRun({ id, cwd, threadId, taskId: `${id}-task`, providerName: "fixture", providerModel: "fixture", createdAt: later,
    taskSnapshot: { id: `${id}-task`, title: "Acceptance", prompt: "Verify acceptance" }, providerSnapshot: {}, requestSnapshot: {} });
  store.markRunStarted(result.id, later); store.markRunSucceeded(result.id, later); return store.getRun(id)!;
}

test("declared goal criteria require scoped terminal evidence and a matching immutable artifact digest", async t => {
  const f = await fixture(t);
  const goal = f.store.createLingThreadGoal({ threadId: f.thread.id, objective: "Verify", acceptanceCriteria: [
    { id: "result", description: "Persist verified result", kind: "artifact" }, { id: "execution", description: "Successful run", kind: "run_succeeded" },
  ] }, now);
  const result = run(f.store, f.cwd, f.thread.id, "acceptance-run");
  const artifact = f.store.createArtifact({ runId: result.id, type: "json", path: "result.json", sealedPayload: { verified: true }, createdAt: later });
  const complete = { status: "complete" as const, completedBy: "ling-agent" as const, completionVerificationSummary: "Verified result and successful run",
    completionEvidenceRefs: [{ kind: "artifact" as const, id: artifact.id }, { kind: "run" as const, id: result.id }],
    acceptanceEvidence: [{ criterionId: "result", evidence: { kind: "artifact" as const, id: artifact.id } }, { criterionId: "execution", evidence: { kind: "run" as const, id: result.id } }] };
  assert.throws(() => f.store.updateLingThreadGoal(goal.id, { ...complete, acceptanceEvidence: [] }, later), /acceptance_incomplete/);
  assert.equal(f.store.getLingThreadGoal(f.thread.id)?.status, "active");
  const other = f.store.createLingThread({ kind: "conversation", title: "Other", objective: "Other goal" }, now);
  const unrelated = run(f.store, f.cwd, other.id, "unrelated-run");
  assert.throws(() => f.store.updateLingThreadGoal(goal.id, { ...complete,
    completionEvidenceRefs: [{ kind: "run", id: unrelated.id }] }, later), /evidence_invalid/);
  f.store.updateLingThreadGoal(goal.id, { acceptanceCriteria: [{ id: "result", description: "Exact artifact", kind: "artifact", contentSha256: "a".repeat(64) }] }, later);
  assert.throws(() => f.store.updateLingThreadGoal(goal.id, { ...complete, acceptanceEvidence: [complete.acceptanceEvidence[0]] }, later), /digest_mismatch/);
  f.store.updateLingThreadGoal(goal.id, { acceptanceCriteria: [{ id: "result", description: "Exact artifact", kind: "artifact", contentSha256: artifact.contentSha256 }] }, later);
  const completed = f.store.updateLingThreadGoal(goal.id, { ...complete, acceptanceEvidence: [complete.acceptanceEvidence[0]] }, later);
  assert.equal(completed?.status, "complete"); assert.deepEqual(completed.acceptanceEvidence, [complete.acceptanceEvidence[0]]);
});

test("supervision options survive reopen and continuation reservation is atomic and idempotent across connections", async t => {
  const f = await fixture(t), policy = parseGoalSupervisionPolicy({ maxContinuations: 25, maxTimeSeconds: 3600 });
  const goal = f.store.createLingThreadGoal({ threadId: f.thread.id, objective: "Long goal", supervisionPolicy: policy }, now);
  const result = run(f.store, f.cwd, f.thread.id, "continuation-source");
  f.store.updateLingThread(f.thread.id, { lastRunId: result.id }, later);
  const other = createSqliteRunStore(f.cwd); t.after(() => other.close());
  assert.deepEqual(other.getLingThreadGoal(f.thread.id)?.supervisionPolicy, policy);
  const input = { goalId: goal.id, expectedUpdatedAt: goal.updatedAt, sourceRunId: result.id, instruction: "Continue toward acceptance",
    noEvidenceCount: 0, evidenceDelta: { newEvidenceRefs: 1, artifacts: 1, changedFiles: 0, acceptedPlans: 0, statusChanged: false }, now: later };
  assert.ok(createSqliteGoalSupervisionStore(f.store).queue(input));
  assert.equal(createSqliteGoalSupervisionStore(other).queue(input), undefined);
  assert.equal(f.store.getLingThreadGoal(f.thread.id)?.continuationDepth, 1);
  assert.equal(f.store.listRunInterventions({ sourceRunId: result.id }).length, 1);
  const current = f.store.getLingThreadGoal(f.thread.id)!;
  f.store.updateLingThreadGoal(goal.id, { status: "paused" }, later);
  assert.equal(createSqliteGoalSupervisionStore(other).queue({ ...input, expectedUpdatedAt: current.updatedAt }), undefined);
  assert.throws(() => parseGoalSupervisionPolicy({ maxContinuations: 1001 }), /invalid/);
});

test("automatic acceptance requires explicitly enabled and fully bound evidence, and respects pending work", async t => {
  const f = await fixture(t);
  const policy = parseGoalSupervisionPolicy({ autoComplete: true, maxContinuations: 20 });
  const goal = f.store.createLingThreadGoal({ threadId: f.thread.id, objective: "Wait for exact proof", supervisionPolicy: policy,
    acceptanceCriteria: [{ id: "proof", description: "Verified execution", kind: "run_succeeded", evidenceId: "future-proof" }] }, now);
  const supervision = createSqliteGoalSupervisionStore(f.store);
  assert.equal(supervision.reconcileAcceptance(f.thread.id, later), false);
  const result = run(f.store, f.cwd, f.thread.id, "future-proof");
  const pending = f.store.createRun({ id: "still-working", cwd: f.cwd, threadId: f.thread.id, taskId: "pending-task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: later });
  assert.equal(supervision.reconcileAcceptance(f.thread.id, later), false);
  f.store.markRunStarted(pending.id, later); f.store.markRunSucceeded(pending.id, later);
  assert.equal(supervision.reconcileAcceptance(f.thread.id, later), true);
  assert.equal(f.store.getLingThreadGoal(f.thread.id), undefined);
  assert.equal(supervision.reconcileAcceptance(f.thread.id, later), false);
  assert.equal(result.status, "succeeded"); assert.ok(goal.id);
});

test("final acceptance verifies current proof while retaining failed execution history", async t => {
  const f = await fixture(t);
  const goal = f.store.createLingThreadGoal({ threadId: f.thread.id, objective: "Recover and verify",
    acceptanceCriteria: [{ id: "execution", description: "Successful recovery", kind: "run_succeeded" }] }, now);
  const failed = f.store.createRun({ id: "failed-history", cwd: f.cwd, threadId: f.thread.id, taskId: "failed-task",
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: later });
  f.store.markRunStarted(failed.id, later); f.store.markRunFailed(failed.id, later, "Recoverable failure");
  f.store.updateLingThreadGoal(goal.id, { completionEvidenceRefs: [{ kind: "run", id: failed.id }] }, later);
  const result = run(f.store, f.cwd, f.thread.id, "recovery-proof");
  const completed = f.store.updateLingThreadGoal(goal.id, { status: "complete", completedBy: "ling-agent",
    completionVerificationSummary: "Recovery succeeded", completionEvidenceRefs: [{ kind: "run", id: result.id }],
    acceptanceEvidence: [{ criterionId: "execution", evidence: { kind: "run", id: result.id } }] }, later);
  assert.equal(completed?.status, "complete");
  assert.deepEqual(completed.completionEvidenceRefs, [{ kind: "run", id: failed.id }, { kind: "run", id: result.id }]);
});

test("criteria supplied with completion are verified in the same transaction", async t => {
  const f = await fixture(t);
  const goal = f.store.createLingThreadGoal({ threadId: f.thread.id, objective: "Verify atomic specification" }, now);
  assert.throws(() => f.store.updateLingThreadGoal(goal.id, { status: "complete", completedBy: "local-user",
    acceptanceCriteria: [{ id: "proof", description: "Required execution", kind: "run_succeeded" }] }, later), /summary_required/);
  assert.equal(f.store.getLingThreadGoal(f.thread.id)?.status, "active");
  assert.deepEqual(f.store.getLingThreadGoal(f.thread.id)?.acceptanceCriteria, []);
});

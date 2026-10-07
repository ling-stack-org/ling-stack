import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { userInputTranscriptFixture, now } from "./support/user-input-transcript-fixture.mjs";

async function fixture(t) {
  const f = await userInputTranscriptFixture(t);
  f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running", event: "runner_succeeded", actor: "runner", now });
  if (f.store.getLingTurn(f.turn.turnId).status !== "succeeded") {
    assert.equal(f.store.transitionLingTurnStatus({ turnId: f.turn.turnId,
      event: "succeed", actor: "system", now }).ok, true);
  }
  assert.equal(f.store.getLingTurn(f.turn.turnId).status, "succeeded");
  f.input = { childThreadId: "fork-child", parentThreadId: f.thread.id, parentTurnId: f.turn.turnId, sourceRunId: f.run.id,
    title: "Fork", objective: "Frozen branch" };
  f.capture = source => ({ projection: { projectionVersion: "fork-test-v1", sourceStateFingerprint: "state",
    threadId: source.thread.id, turnId: source.turn.id, segmentId: f.turn.contextSegmentId,
    throughItemSequence: source.item.sequence, summaryIds: [], sourceRefs: [{ type: "conversation_item", id: source.item.id }],
    policyVersion: "fork-test-v1", visibilityFingerprint: "visible" }, payload: { schemaVersion: 1, text: "FROZEN_PARENT" } });
  f.create = capture => f.store.createNormalConversationFork(f.input, capture ?? f.capture, now);
  return f;
}
test("normal fork freezes its own immutable seed atomically and reopens without recapturing the parent", async t => {
  const f = await fixture(t);
  const result = f.create();
  assert.equal(result.created, true);
  assert.equal(result.thread.kind, "conversation");
  assert.equal(result.thread.relationKind, "branch");
  assert.equal(result.thread.parentThreadId, f.thread.id);
  assert.equal(result.thread.forkContextSnapshotId, result.seed.id);
  assert.equal(result.seed.childThreadId, result.thread.id);
  assert.equal(result.seed.threadId, f.thread.id, "the source projection is not relabelled as the child");
  assert.equal(result.seed.sourceItemId, f.turn.item.id);
  assert.equal(result.seed.payload.text, "FROZEN_PARENT");
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.create(() => assert.fail("must not recapture")).seed, result.seed);
  assert.equal(f.create(() => assert.fail("must not recapture")).created, false);
  assert.deepEqual(f.store.getNormalConversationForkSeed(result.thread.id), result.seed);
  assert.equal(f.store.getConversationAcceptedInputSnapshot(f.turn.item.id), undefined, "fork rows cannot masquerade as accepted input");
  assert.equal(f.store.getConversationContextSnapshot(result.seed.id), undefined, "channel fork DTO cannot consume a normal seed");
});
test("normal fork refuses source mismatch, active turns and idempotency conflicts", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.createNormalConversationFork({ ...f.input, parentTurnId: "foreign" }, f.capture, now), /source/);
  const result = f.create();
  assert.throws(() => f.store.createNormalConversationFork({ ...f.input, sourceRunId: undefined }, f.capture, now), /conflict/);
  f.db.prepare("UPDATE ling_turns SET status='running' WHERE id=?").run(f.turn.turnId);
  assert.throws(() => f.store.createNormalConversationFork({ ...f.input, childThreadId: "new-fork" }, f.capture, now), /terminal/);
  assert.deepEqual(f.store.getNormalConversationForkSeed(result.thread.id), result.seed, "later parent activity does not rewrite the seed");
});
test("capture, serialization, snapshot insert and COMMIT failures leave neither child nor orphan seed", async t => {
  const f = await fixture(t);
  for (const capture of [() => { throw new Error("capture failed"); }, async () => ({}), () => Promise.resolve({}),
    source => ({ ...f.capture(source), payload: { toJSON() { f.store.createLingThread({ kind: "conversation", title: "forbidden", objective: "forbidden" }, now); return {}; } } })]) {
    assert.throws(() => f.create(capture));
    assert.equal(f.store.getLingThread(f.input.childThreadId), undefined);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots WHERE snapshot_use='normal_conversation_fork_seed'").get().n, 0);
  }
  f.db.exec(`CREATE TABLE fork_commit_failure (id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_fork_commit AFTER INSERT ON ling_threads WHEN NEW.id='fork-child'
    BEGIN INSERT INTO fork_commit_failure VALUES ('missing-parent'); END;`);
  assert.throws(() => f.create(), /FOREIGN KEY constraint failed/);
  assert.equal(f.store.getLingThread(f.input.childThreadId), undefined);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots WHERE snapshot_use='normal_conversation_fork_seed'").get().n, 0);
  f.db.exec("DROP TRIGGER reject_fork_commit");
  assert.equal(f.create().created, true);
});
for (const column of ["snapshot_use", "payload_version", "payload_json", "payload_fingerprint", "thread_id"]) {
  test("normal fork rejects a corrupted " + column + " without fallback to current parent history", async t => {
    const f = await fixture(t), first = f.create();
    const value = column === "payload_version" ? 2 : column === "payload_json" ? "{}" : column === "thread_id" ? first.thread.id : "bad";
    f.db.prepare(`UPDATE conversation_context_snapshots SET ${column}=? WHERE id=?`).run(value, first.seed.id);
    assert.throws(() => f.store.getNormalConversationForkSeed(first.thread.id), /invalid/);
    assert.throws(() => f.create(() => assert.fail("corruption is not a request to recapture")), /invalid/);
  });
}
test("permanent deletion cannot destroy a live fork source; deleting its leaf removes only that leaf seed", async t => {
  const f = await fixture(t), fork = f.create();
  f.store.updateLingThread(f.thread.id, { status: "archived", archivedAt: now }, now);
  assert.throws(() => f.store.hardDeleteLingThread(f.thread.id, {}, now), error => error.code === "normal_fork_source_in_use");
  assert.ok(f.store.getLingThread(f.thread.id));
  assert.deepEqual(f.store.getNormalConversationForkSeed(fork.thread.id), fork.seed);
  f.store.updateLingThread(fork.thread.id, { status: "archived", archivedAt: now }, now);
  assert.ok(f.store.hardDeleteLingThread(fork.thread.id, {}, now));
  assert.equal(f.db.prepare("SELECT id FROM conversation_context_snapshots WHERE id=?").get(fork.seed.id), undefined);
  assert.ok(f.store.getLingThread(f.thread.id));
  assert.ok(f.store.hardDeleteLingThread(f.thread.id, {}, now));
});
test("normal fork capture is isolated from competing writers and snapshot insert failure rolls back", async t => {
  const f = await fixture(t);
  f.db.exec("PRAGMA busy_timeout=1");
  f.db.exec("CREATE TRIGGER reject_fork_snapshot BEFORE INSERT ON conversation_context_snapshots WHEN NEW.snapshot_use='normal_conversation_fork_seed' BEGIN SELECT RAISE(ABORT, 'fork snapshot rejected'); END");
  assert.throws(() => f.create(source => {
    assert.equal(f.db.prepare("SELECT id FROM ling_threads WHERE id=?").get(f.input.childThreadId), undefined);
    assert.throws(() => f.db.exec("BEGIN IMMEDIATE"), /busy|locked/);
    return f.capture(source);
  }), /fork snapshot rejected/);
  assert.equal(f.store.getLingThread(f.input.childThreadId), undefined);
  f.db.exec("DROP TRIGGER reject_fork_snapshot");
  assert.equal(f.create().created, true);
});

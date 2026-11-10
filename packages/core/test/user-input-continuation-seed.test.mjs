import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { createSqliteRunStore } from "../dist/index.js";
import { userInputTranscriptFixture, claimedAt } from "./support/user-input-transcript-fixture.mjs";

const expiredAt = "2026-09-07T00:00:04.000Z";
const code = expected => error => error.code === expected;
const seedId = f => `user_input_continuation_seed:${f.receipt.deliveryId}`;
const read = f => f.store.getUserInputContinuationSeed(f.thread.id, f.receipt.deliveryId);
const row = f => f.db.prepare("SELECT * FROM conversation_context_snapshots WHERE id=?").get(seedId(f));
async function fixture(t, surface = "normal") {
  const f = await userInputTranscriptFixture(t, { surface });
  f.submit([{ questionId: "theme", kind: "text", text: "深色\n```js\nconsole.log('ready');\n```" }]);
  return f;
}

for (const surface of ["normal", "private", "channel"]) {
  test(`first claim atomically freezes exact ${surface} answer and original logical owner`, async t => {
    const f = await fixture(t, surface);
    assert.equal(read(f), undefined);
    const delivery = f.claim(), seed = read(f);
    assert.equal(seed.use, "user_input_continuation_seed");
    assert.equal(seed.successorRunId, delivery.successorRunId);
    assert.equal(seed.source.threadId, f.thread.id);
    assert.equal(seed.source.turnId, f.turn.turnId);
    assert.equal(seed.source.participantId, f.participantId);
    assert.equal(seed.source.fence.workUnitId, f.unit.id);
    assert.equal(seed.source.fence.attemptId, f.attempt.id);
    assert.equal(seed.source.channelId, f.channel?.id);
    assert.deepEqual(seed.answer.answers[0], { questionId: "theme", kind: "text", text: "深色\n```js\nconsole.log('ready');\n```" });
    assert.equal(seed.request.questions[0].prompt, "选择主题\n保留换行");
    assert.equal(seed.request.itemId, f.request.itemId);
    assert.equal(seed.checkpoint.source.runId, f.run.id);
    assert.equal(seed.checkpointFingerprint, createHash("sha256").update(JSON.stringify(seed.checkpoint)).digest("hex"));
    assert.deepEqual(seed.itemRefs.map(ref => ref.id), [f.turn.item.id, f.request.itemId, f.receipt.answerItemId]);
    assert.ok(seed.itemRefs.every(ref => ref.sequence >= 1 && ref.revision >= 0));
    assert.equal(seed.projection.throughItemSequence, seed.itemRefs[2].sequence);
    assert.ok(Object.isFrozen(seed.answer.answers));
    assert.throws(() => { seed.answer.answers[0].text = "mutated"; }, TypeError);
    assert.equal(f.store.getRun(delivery.successorRunId), undefined);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, delivery.deliveryId).status, "claimed");
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ling_turns").get().n, 1);
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "waiting_for_input");
    assert.equal(row(f).source_item_id, null);
    assert.equal(f.store.getConversationAcceptedInputSnapshot(f.receipt.answerItemId), undefined);
    const json = JSON.stringify(seed);
    assert.ok(!json.includes(delivery.claim.token));
    assert.ok(!json.includes("permissionConfirmation"));
    assert.ok(!json.includes("providerSnapshot"));
  });
}
test("lease replacement and database reopen reuse the first seed without new Turn or Run", async t => {
  const f = await fixture(t), delivery = f.claim(), seed = read(f);
  const other = createSqliteRunStore(f.cwd);
  try {
    const next = other.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: delivery.deliveryId,
      expectedRevision: delivery.revision, ownerId: "worker-b", leaseMs: 1000 }, expiredAt);
    assert.notEqual(next.claim.token, delivery.claim.token);
    assert.deepEqual(other.getUserInputContinuationSeed(f.thread.id, delivery.deliveryId), seed);
    assert.deepEqual(read(f), seed);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_context_snapshots WHERE snapshot_use='user_input_continuation_seed'").get().n, 1);
  } finally { other.close(); }
});
test("concurrent connections have one claim winner and one frozen input", async t => {
  const f = await fixture(t);
  f.claim();
  const gate = new SharedArrayBuffer(4);
  const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
  const workers = ["worker-b", "worker-c"].map(ownerId => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createSqliteRunStore } = await import(workerData.moduleUrl);
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.gate),0,0);
      try { parentPort.postMessage({delivery:store.claimUserInputDelivery(workerData.input,workerData.now)}); }
      catch (error) { parentPort.postMessage({error:error.code}); }
      finally { store.close(); }
    })();`, { eval: true, workerData: { moduleUrl, cwd: f.cwd, gate, now: expiredAt,
      input: { threadId: f.thread.id, deliveryId: f.receipt.deliveryId, expectedRevision: 2, ownerId, leaseMs: 1000 } } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => once(worker, "message")));
  const results = Promise.all(workers.map(worker => once(worker, "message")));
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
  const values = (await results).map(([value]) => value);
  assert.equal(values.filter(value => value.delivery).length, 1);
  assert.equal(values.filter(value => value.error === "delivery_conflict").length, 1);
  assert.equal(read(f).successorRunId, values.find(value => value.delivery).delivery.successorRunId);
});
test("seed and claim roll back together if seed insert or COMMIT fails", async t => {
  for (const deferred of [false, true]) {
    const f = await fixture(t);
    if (deferred) {
      f.db.exec("CREATE TABLE seed_commit_failure(id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED)");
      f.db.exec("CREATE TRIGGER seed_failure AFTER INSERT ON conversation_context_snapshots WHEN NEW.snapshot_use='user_input_continuation_seed' BEGIN INSERT INTO seed_commit_failure VALUES ('missing'); END");
    } else {
      f.db.exec("CREATE TRIGGER seed_failure BEFORE INSERT ON conversation_context_snapshots WHEN NEW.snapshot_use='user_input_continuation_seed' BEGIN SELECT RAISE(ABORT,'seed failure'); END");
    }
    assert.throws(() => f.claim(), deferred ? /FOREIGN KEY/ : /seed failure/);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId).status, "pending");
    assert.equal(row(f), undefined);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE entity_type='user_input_delivery'").get().n, 0);
    f.db.exec("DROP TRIGGER seed_failure");
    assert.equal(f.claim().status, "claimed");
    assert.ok(read(f));
  }
});
for (const mutation of [
  "DELETE FROM conversation_context_snapshots WHERE snapshot_use='user_input_continuation_seed'",
  "UPDATE conversation_context_snapshots SET snapshot_use='unknown'",
  "UPDATE conversation_context_snapshots SET payload_version=99",
  "UPDATE conversation_context_snapshots SET payload_json='{}'",
  "UPDATE conversation_context_snapshots SET payload_fingerprint='changed'",
  "UPDATE conversation_context_snapshots SET source_item_id='wrong'",
  "UPDATE conversation_context_snapshots SET source_refs_json='[]'",
  "UPDATE conversation_context_snapshots SET through_item_sequence=999",
  "UPDATE conversation_context_snapshots SET thread_id='foreign'",
]) {
  test(`damaged claimed seed never recaptures: ${mutation}`, async t => {
    const f = await fixture(t), delivery = f.claim();
    if (mutation.includes("thread_id='foreign'")) f.db.exec("PRAGMA foreign_keys=OFF");
    f.db.exec(mutation);
    assert.throws(() => read(f), code("invalid_record"));
    assert.throws(() => f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: delivery.deliveryId,
      expectedRevision: delivery.revision, ownerId: "new-worker", leaseMs: 1000 }, expiredAt), code("invalid_record"));
    assert.equal(f.store.getUserInputDelivery(f.thread.id, delivery.deliveryId).revision, delivery.revision);
  });
}
test("scope is resolved before decoding another thread's corrupt snapshot", async t => {
  const f = await fixture(t); f.claim();
  f.db.exec("UPDATE conversation_context_snapshots SET payload_json='not json'");
  assert.equal(f.store.getUserInputContinuationSeed("foreign", f.receipt.deliveryId), undefined);
  assert.throws(() => read(f), code("invalid_record"));
});
test("cancelling after freeze retains the exact answer seed but cannot resume it", async t => {
  const f = await fixture(t), delivery = f.claim(), seed = read(f);
  f.store.cancelUserInputWait({ threadId: f.thread.id, sourceRunId: f.run.id }, claimedAt);
  assert.deepEqual(read(f), seed);
  assert.equal(f.store.getUserInputDelivery(f.thread.id, delivery.deliveryId).status, "obsolete");
});
test("an orphan preexisting snapshot cannot be adopted by the first claim", async t => {
  const f = await fixture(t); f.claim();
  f.db.exec("UPDATE user_input_deliveries SET status='pending',status_revision=1,attempt_count=0,successor_run_id=NULL,claim_owner_id=NULL,claim_token=NULL,claim_expires_at=NULL");
  assert.throws(() => read(f), code("invalid_record"));
  assert.throws(() => f.claim(), code("invalid_record"));
});
test("canonical answer edits invalidate a frozen seed even if it has a valid checksum", async t => {
  const f = await fixture(t); f.claim();
  const stored = row(f), seed = JSON.parse(stored.payload_json);
  seed.answer.answers[0].text = "different answer";
  const { fingerprint, ...body } = seed;
  seed.fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  f.db.prepare("UPDATE conversation_context_snapshots SET payload_json=?,payload_fingerprint=? WHERE id=?")
    .run(JSON.stringify(seed), seed.fingerprint, stored.id);
  assert.throws(() => read(f), code("invalid_record"));
});
test("storage errors are not hidden behind seed corruption errors", async t => {
  const f = await fixture(t); f.claim();
  const original = f.store.getUserInputWait;
  f.store.getUserInputWait = () => { throw new Error("storage offline"); };
  try { assert.throws(() => read(f), /storage offline/); }
  finally { f.store.getUserInputWait = original; }
});
test("later topic corrections do not change the frozen assignment or accepted answer", async t => {
  const f = await fixture(t); f.claim(); const seed = read(f);
  const old = f.store.getEffectiveTurnContextAssignment(f.turn.turnId);
  const corrected = f.store.applyTurnContextAssignment({ turnId: f.turn.turnId, expectedPreviousRevision: old.revision,
    target: { kind: "new", state: "active", label: "Corrected topic" }, status: "committed",
    decisionSource: "user", policyVersion: "test" }, expiredAt);
  assert.notEqual(corrected.segment.id, seed.projection.segmentId);
  assert.equal(seed.contextAssignment.id, old.id);
  assert.deepEqual(read(f), seed);
});
test("frozen assignment damage is rejected even if the segment still exists", async t => {
  const f = await fixture(t); f.claim();
  f.db.prepare("UPDATE turn_context_assignments SET revision=revision+10 WHERE turn_id=?").run(f.turn.turnId);
  assert.throws(() => read(f), code("invalid_record"));
});
test("a late source Item revision cannot silently regenerate accepted input", async t => {
  const f = await fixture(t), delivery = f.claim();
  f.db.prepare("UPDATE conversation_items SET revision=revision+1 WHERE id=?").run(f.turn.item.id);
  assert.throws(() => read(f), code("invalid_record"));
  assert.throws(() => f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: delivery.deliveryId,
    expectedRevision: delivery.revision, ownerId: "new-worker", leaseMs: 1000 }, expiredAt), code("invalid_record"));
});
test("a seed cannot claim creation after its current delivery lease update", async t => {
  const f = await fixture(t); f.claim();
  const stored = row(f), seed = JSON.parse(stored.payload_json);
  seed.createdAt = expiredAt;
  const { fingerprint, ...body } = seed;
  seed.fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  f.db.prepare("UPDATE conversation_context_snapshots SET created_at=?,payload_json=?,payload_fingerprint=? WHERE id=?")
    .run(expiredAt, JSON.stringify(seed), seed.fingerprint, stored.id);
  assert.throws(() => read(f), code("invalid_record"));
});
test("first freeze rolls back if current context ownership cannot be read", async t => {
  const f = await fixture(t), original = f.store.getEffectiveTurnContextAssignment;
  f.store.getEffectiveTurnContextAssignment = () => undefined;
  try { assert.throws(() => f.claim(), code("invalid_record")); }
  finally { f.store.getEffectiveTurnContextAssignment = original; }
  assert.equal(row(f), undefined);
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId).status, "pending");
});
test("damaged historical assignment timestamps have a typed corruption error", async t => {
  const f = await fixture(t); f.claim();
  f.db.prepare("UPDATE turn_context_assignments SET created_at='invalid' WHERE turn_id=?").run(f.turn.turnId);
  assert.throws(() => read(f), code("invalid_record"));
});
test("damaged original source Item payload has a typed corruption error", async t => {
  const f = await fixture(t); f.claim();
  f.db.prepare("UPDATE conversation_items SET payload_json='{}' WHERE id=?").run(f.turn.item.id);
  assert.throws(() => read(f), code("invalid_record"));
});

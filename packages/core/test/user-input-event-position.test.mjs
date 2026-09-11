import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore, toRuntimeAttemptFence } from "../dist/index.js";
import { userInputTranscriptFixture as fixture, now } from "./support/user-input-transcript-fixture.mjs";

const event = f => f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "read", toolName: "read", input: {} });
function position(f, afterEventSequence = 0, afterEventId) {
  return { runId: f.run.id, attemptId: f.attempt.id, afterEventSequence, ...(afterEventId ? { afterEventId } : {}) };
}
test("request stores the exact empty-run boundary rather than inventing an event", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.store.getConversationItem(f.request.itemId).payload.runEventPosition, position(f));
  assert.deepEqual(f.read()[0].runEventPosition, position(f));
  assert.equal(f.store.countEvents(f.run.id), 0);
});
test("request captures the current run boundary once and is stable on idempotent replay", async t => {
  const f = await fixture(t);
  f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: f.request.requestId, expectedStatusRevision: 1 }, now);
  const first = event(f);
  const input = { sourceRunId: f.run.id, sourceItemId: f.turn.item.id, sourceFence: toRuntimeAttemptFence(f.attempt),
    toolCallId: "another-question", idempotencyKey: "another-question", toolInput: { schemaVersion: 1,
      waitMode: "optional", questions: f.request.questions } };
  const created = f.store.createUserInputRequest(input, now);
  event(f);
  assert.equal(f.store.createUserInputRequest(input, now).request.itemId, created.request.itemId);
  assert.deepEqual(f.read([created.request.itemId])[0].runEventPosition, position(f, first.seq, first.id));
});
test("answer freezes its own later boundary, not the request position or later tool updates", async t => {
  const f = await fixture(t); const before = event(f); f.submit();
  const original = f.store.getConversationItem(f.receipt.answerItemId).payload.runEventPosition;
  assert.deepEqual(original, position(f, before.seq, before.id));
  event(f); f.submit();
  assert.deepEqual(f.read().map(record => record.runEventPosition), [position(f), original]);
});
test("reopen reads the persisted boundary without recomputing latest event sequence", async t => {
  const f = await fixture(t); const before = event(f); f.submit(); event(f);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.read()[1].runEventPosition, position(f, before.seq, before.id));
});
for (const kind of ["request", "answer"]) {
  for (const corruption of ["run", "attempt", "sequence", "event", "missing-event"]) {
    test(kind + " rejects corrupt " + corruption + " boundary rather than moving content", async t => {
      const f = await fixture(t); const before = event(f); f.submit();
      const id = kind === "request" ? f.request.itemId : f.receipt.answerItemId;
      const boundary = position(f, before.seq, before.id);
      if (corruption === "run") boundary.runId = "foreign-run";
      if (corruption === "attempt") boundary.attemptId = "foreign-attempt";
      if (corruption === "sequence") boundary.afterEventSequence = before.seq + 100;
      if (corruption === "event") boundary.afterEventId = "foreign-event";
      if (corruption === "missing-event") delete boundary.afterEventId;
      const item = f.store.getConversationItem(id);
      f.db.prepare("UPDATE conversation_items SET payload_json=? WHERE id=?")
        .run(JSON.stringify({ ...item.payload, runEventPosition: boundary }), id);
      assert.equal(f.read([id])[0].availability, "unavailable");
    });
  }
}
test("failed append rolls back request and its captured boundary as one transaction", async t => {
  const f = await fixture(t); event(f);
  f.db.exec("CREATE TRIGGER reject_persisted_input_answer BEFORE INSERT ON user_input_answers BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  assert.throws(() => f.submit(), /fixture/);
  assert.equal(f.store.getUserInputRequest(f.thread.id, f.request.requestId).status, "pending");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='user_input_answer'").get().n, 0);
});

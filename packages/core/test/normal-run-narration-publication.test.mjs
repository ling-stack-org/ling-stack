import assert from "node:assert/strict";
import test from "node:test";
test("deferred COMMIT failure rolls back the actual SQL sequence, canonical item and outbox together", async t => {
  const f = await fixture(t); f.finish();
  const before = f.db.prepare("SELECT next_item_sequence AS n FROM ling_threads WHERE id=?").get(f.thread.id).n;
  assert.ok(Number.isSafeInteger(before));
  f.db.exec(`CREATE TABLE narration_commit_failure (missing_id TEXT REFERENCES ling_threads(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_narration_commit AFTER INSERT ON conversation_items WHEN NEW.kind='assistant_message'
    BEGIN INSERT INTO narration_commit_failure VALUES ('missing-thread'); END;`);
  assert.throws(f.publish, /FOREIGN KEY constraint failed/);
  assert.equal(f.db.prepare("SELECT next_item_sequence AS n FROM ling_threads WHERE id=?").get(f.thread.id).n, before);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='assistant_message'").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE action='conversation_narration.published'").get().n, 0);
  f.db.exec("DROP TRIGGER reject_narration_commit");
  assert.equal(f.publish().ok, true);
});
test("retry publishes a successor item without overwriting the original and old completion cannot replace it", async t => {
  const f = await fixture(t); f.finish("failed");
  const old = f.publish().item;
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2,
    runtimeInstanceId: "retry-runtime", runnerId: f.attempt.runnerId, status: "started", now: endedAt });
  const next = f.store.createRun({ id: "retry-run", cwd: f.cwd, taskId: "retry-task", threadId: f.thread.id,
    turnId: f.turn.turnId, teammateId: f.participantId, workUnitId: f.unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: endedAt });
  f.store.appendEvent(next.id, "run_created", { workUnitId: f.unit.id, attemptId: attempt.id, threadId: f.thread.id, teammateId: f.participantId });
  f.store.appendEvent(next.id, "message_end", { role: "assistant", text: "Retry answer." });
  f.store.transitionRunStatus({ runId: next.id, expectedStatus: "queued", event: "runner_started", actor: "runner", now: endedAt });
  f.store.transitionRunStatus({ runId: next.id, expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: endedAt });
  const replacement = f.store.publishNormalRunNarration(next.id, endedAt);
  assert.equal(replacement.ok, true);
  assert.equal(replacement.item.supersedesItemId, old.id);
  assert.equal(replacement.item.payload.runNarration.messageId, old.payload.runNarration.messageId);
  assert.notEqual(replacement.item.id, old.id);
  assert.deepEqual(f.store.getConversationItem(old.id), old);
  assert.deepEqual(f.publish().item, old);
});
import { createSqliteRunStore } from "../dist/index.js";
import { userInputTranscriptFixture, now } from "./support/user-input-transcript-fixture.mjs";

const endedAt = "2026-09-07T00:01:00.000Z";
async function fixture(t) {
  const f = await userInputTranscriptFixture(t);
  f.store.appendEvent(f.run.id, "run_created", { workUnitId: f.unit.id, attemptId: f.attempt.id,
    threadId: f.thread.id, teammateId: f.participantId });
  f.first = f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "Before tool.\n\n```js\nlet a = 1;\n```" });
  f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "read", toolName: "read", input: {} });
  f.store.appendEvent(f.run.id, "tool_end", { toolCallId: "read", toolName: "read", output: "not narration" });
  f.last = f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "After tool." });
  f.finish = status => f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running",
    event: status === "failed" ? "runner_failed" : "runner_succeeded", actor: "runner", now: endedAt });
  f.publish = () => f.store.publishNormalRunNarration(f.run.id, endedAt);
  return f;
}

test("terminal narration atomically publishes one canonical message and outbox, preserving exact segments after reopen", async t => {
  const f = await fixture(t); f.finish();
  const result = f.publish();
  assert.equal(result.ok, true);
  const item = result.item;
  assert.equal(item.kind, "assistant_message");
  assert.equal(item.payload.runNarration.messageId, "conversation-assistant:" + f.turn.turnId);
  assert.equal(item.payload.runNarration.source.attemptId, f.attempt.id);
  assert.equal(item.payload.runNarration.sourceItemId, f.turn.item.id);
  assert.equal(item.payload.runNarration.segments.length, 2);
  assert.equal(item.payload.runNarration.segments[0].firstEventId, f.first.id);
  assert.equal(item.payload.runNarration.segments[1].lastEventId, f.last.id);
  assert.equal(item.payload.body.includes("not narration"), false);
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.publish().item, item);
  assert.equal(f.publish().duplicate, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='assistant_message'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM control_plane_events WHERE action='conversation_narration.published'").get().n, 1);
});

test("publication refuses active Run, foreign creation source and mismatched source actor", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.publish(), { ok: false, code: "run_not_terminal" });
  f.finish();
  f.store.appendEvent(f.run.id, "tool_update", { toolCallId: "read", toolName: "read", partialResult: {}, attemptId: "foreign" });
  assert.deepEqual(f.publish(), { ok: false, code: "narration_source_conflict" });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='assistant_message'").get().n, 0);
  const g = await fixture(t); g.finish();
  g.db.prepare("UPDATE conversation_items SET actor_type='system' WHERE id=?").run(g.turn.item.id);
  assert.deepEqual(g.publish(), { ok: false, code: "source_item_conflict" });
});

test("publication rollback includes item, thread sequence and invalidation when outbox insert fails", async t => {
  const f = await fixture(t); f.finish();
  const before = f.db.prepare("SELECT next_item_sequence AS n FROM ling_threads WHERE id=?").get(f.thread.id).n;
  assert.ok(Number.isSafeInteger(before));
  f.db.exec("CREATE TRIGGER reject_narration BEFORE INSERT ON control_plane_events WHEN NEW.action='conversation_narration.published' BEGIN SELECT RAISE(ABORT, 'narration outbox rejected'); END");
  assert.throws(f.publish, /narration outbox rejected/);
  assert.equal(f.db.prepare("SELECT next_item_sequence AS n FROM ling_threads WHERE id=?").get(f.thread.id).n, before);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM conversation_items WHERE kind='assistant_message'").get().n, 0);
  f.db.exec("DROP TRIGGER reject_narration");
  assert.equal(f.publish().ok, true);
});

test("audit-only events do not republish or extend the frozen narration watermark; late text is a conflict", async t => {
  const f = await fixture(t); f.finish();
  const first = f.publish();
  f.store.appendEvent(f.run.id, "tool_update", { toolCallId: "read", toolName: "read", output: "audit" });
  assert.deepEqual(f.publish().item, first.item);
  f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "Late host write" });
  assert.deepEqual(f.publish(), { ok: false, code: "publication_conflict" });
});

test("incomplete and oversized narration never fabricates successful publication or changes the Run outcome", async t => {
  const f = await fixture(t);
  f.store.appendEvent(f.run.id, "assistant_text_delta", { text: "Not ended" }); f.finish();
  assert.deepEqual(f.publish(), { ok: false, code: "narration_incomplete" });
  assert.equal(f.store.getRun(f.run.id).status, "succeeded");
  const g = await fixture(t);
  g.store.appendEvent(g.run.id, "message_end", { role: "assistant", text: "x".repeat(128_001) }); g.finish();
  assert.deepEqual(g.publish(), { ok: false, code: "narration_budget_exceeded" });
  assert.equal(g.store.getRun(g.run.id).status, "succeeded");
  const h = await fixture(t);
  h.store.appendEvent(h.run.id, "assistant_text_delta", { text: "Partial failure" }); h.finish("failed");
  assert.equal(h.publish().item.status, "committed", "a failed execution still produced durable narrative");
  assert.equal(h.publish().item.payload.deliveryStatus, "failed");
  assert.ok(h.store.listConversationItemsForTurn({ turnId: h.turn.turnId }).some(item => item.id === "narration:" + h.run.id));
  assert.equal(h.publish().item.payload.runNarration.segments.at(-1).completed, false);
});

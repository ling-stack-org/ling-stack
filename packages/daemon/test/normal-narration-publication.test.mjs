import assert from "node:assert/strict";
import test from "node:test";
test("failed terminal narration remains canonical history for the next accepted turn, without a second Run replay", async t => {
  const f = await fixture(t);
  f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running", event: "runner_failed", actor: "runner", now: later });
  const published = publishNormalNarrationAfterRun(f.store, f.run.id, later);
  assert.equal(published.item.status, "committed");
  const next = f.store.appendConversationUserTurn({ threadId: f.thread.id, teammateId: f.participantId,
    title: "Continue", userInstruction: "Continue", idempotencyKey: "next",
    payload: { body: "Continue", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, "2026-09-07T00:03:00.000Z");
  const { captureNormalConversationContext } = await import("../dist/features/conversations/normal-conversation-context.js");
  const context = captureNormalConversationContext({ store: f.store, threadId: f.thread.id, sourceItemId: next.item.id });
  const entries = context.hydration.entries.filter(entry => entry.role === "assistant");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].origin, "canonical_item");
  assert.equal(entries[0].text, published.item.payload.body);
  assert.equal(context.hydration.runEventWatermarks.length, 0);
});
import { createSqliteRunStore } from "../../core/dist/index.js";
import { userInputTranscriptFixture, now } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { buildConversationDetail } from "../dist/features/conversations/routes.js";
import { syncLingThreadForTerminalRun } from "../dist/features/runs/threads.js";
import { configureNormalNarrationPublication, publishNormalNarrationAfterRun, recoverNormalNarrationPublications } from "../dist/features/conversations/normal-narration-publication.js";

const later = "2026-09-07T00:02:00.000Z";
async function fixture(t) {
  const f = await userInputTranscriptFixture(t);
  f.store.appendEvent(f.run.id, "run_created", { workUnitId: f.unit.id, attemptId: f.attempt.id, threadId: f.thread.id, teammateId: f.participantId });
  f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "Before.\n\n```js\nconst x = 1;\n```" });
  f.store.appendEvent(f.run.id, "tool_start", { toolCallId: "read", toolName: "read", input: {} });
  f.store.appendEvent(f.run.id, "tool_end", { toolCallId: "read", toolName: "read", output: "result" });
  f.store.appendEvent(f.run.id, "message_end", { role: "assistant", text: "After." });
  f.finish = () => f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running", event: "runner_succeeded", actor: "runner", now: later });
  return f;
}
test("terminal hook publishes canonical narration and detail reads it without replay or duplicate assistant messages", async t => {
  const f = await fixture(t), events = [];
  configureNormalNarrationPublication(f.store, event => events.push(event));
  f.finish(); syncLingThreadForTerminalRun(f.store, f.run.id, later);
  assert.equal(events.filter(event => event.action === "conversation_narration.published").length, 1);
  const item = f.store.getConversationItem("narration:" + f.run.id);
  assert.ok(item);
  const original = f.store.listEvents.bind(f.store);
  f.store.listEvents = () => { throw new Error("Published message must not replay the Run"); };
  // Exercise the dedicated canonical reader; the full detail also reads events for other evidence.
  const { publishedNormalConversationMessage } = await import("../dist/features/conversations/normal-conversation-published-message.js");
  const dto = publishedNormalConversationMessage(f.store, f.thread, f.store.getLingTurn(f.turn.turnId), f.store.getRun(f.run.id));
  assert.equal(dto.canonicalItemId, item.id);
  assert.equal(dto.id, "conversation-assistant:" + f.turn.turnId);
  assert.equal(dto.content, item.payload.body);
  assert.equal(dto.contentSource, "run_narration");
  f.store.listEvents = original;
  const detail = buildConversationDetail(f.store, f.cwd, f.store.getLingThread(f.thread.id));
  assert.equal(detail.messages.filter(message => message.role === "assistant").length, 1);
  assert.equal(detail.messages.find(message => message.role === "assistant").canonicalItemId, item.id);
  assert.equal(detail.conversationItems.filter(item => item.kind === "assistant_message").length, 1);
});
test("publication storage failure is explicit and does not alter success; restart recovers the missing item", async t => {
  const f = await fixture(t); f.finish();
  f.db.exec("CREATE TRIGGER block_publication BEFORE INSERT ON conversation_items WHEN NEW.kind='assistant_message' BEGIN SELECT RAISE(ABORT, 'private exception must not leak'); END");
  syncLingThreadForTerminalRun(f.store, f.run.id, later);
  assert.equal(f.store.getRun(f.run.id).status, "succeeded");
  assert.equal(f.store.getConversationItem("narration:" + f.run.id), undefined);
  const failures = f.store.listControlPlaneEvents({ workspaceId: f.thread.workspaceId }).filter(event => event.action === "conversation_narration.publication_failed");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].data.code, "publication_storage_error");
  assert.equal(JSON.stringify(failures).includes("private exception"), false);
  f.db.exec("DROP TRIGGER block_publication");
  f.store.close(); f.store = createSqliteRunStore(f.cwd);
  assert.ok(f.store.listUnpublishedNormalNarrationRunIds("", 100).includes(f.run.id));
  await recoverNormalNarrationPublications(f.store, later);
  assert.ok(f.store.getConversationItem("narration:" + f.run.id));
  assert.deepEqual(f.store.listUnpublishedNormalNarrationRunIds("", 100), []);
});
test("delivery callback failure does not undo durable publication and recovery is paginated past 200 rows", async t => {
  const f = await fixture(t); f.finish();
  configureNormalNarrationPublication(f.store, () => { throw new Error("disconnected"); });
  assert.equal(publishNormalNarrationAfterRun(f.store, f.run.id, later).ok, true);
  assert.equal(f.store.listControlPlaneEvents({ workspaceId: f.thread.workspaceId }).filter(event => event.action === "conversation_narration.published").length, 1);
  const ids = Array.from({ length: 205 }, (_, i) => "run-" + String(i).padStart(3, "0")), seen = [];
  await recoverNormalNarrationPublications({
    listUnpublishedNormalNarrationRunIds: (after, limit) => ids.filter(id => id > after).slice(0, limit),
    publishNormalRunNarration: id => { seen.push(id); return { ok: false, code: "narration_empty" }; },
  }, later);
  assert.deepEqual(seen, ids);
});

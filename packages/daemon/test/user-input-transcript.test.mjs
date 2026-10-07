import assert from "node:assert/strict";
import test from "node:test";

test("channel supersession hides the old question without deleting its stored answer", async t => {
  const f = await fixture(t, { surface: "channel" }); f.submit();
  const source = f.turn.item;
  f.store.commitConversationMessageEdit({
    surface: "channel_root", ownerId: f.channel.id, laneId: f.thread.id, messageId: source.id,
    expectedRevision: 1, current: source.payload, replacement: { ...source.payload, body: "Changed input" },
    sourceTurnId: f.turn.turnId, supersededTurnId: f.turn.turnId, supersededRunIds: [f.run.id],
    supersededResponseMessageIds: [], idempotencyKey: "channel-question-edit",
  }, now);
  assert.deepEqual(detail(f, "channel").userInputs, []);
  assert.equal(f.read()[1].answers[0].label, "深色", "explicit exact-item audit preserves immutable acceptance");
});

test("normal question history is not truncated by the recent 200 Turn page", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 205; i++) f.store.appendConversationUserTurn({
    threadId: f.thread.id, title: "Later " + i, userInstruction: "Later", idempotencyKey: "later-" + i,
    payload: { body: "Later", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, new Date(Date.parse(now) + i + 1000).toISOString());
  const result = detail(f, "normal");
  assert.equal(result.userInputs[0]?.requestId, f.request.requestId);
});
import { userInputTranscriptFixture as fixture, now } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { buildConversationDetail } from "../dist/features/conversations/routes.js";
import { buildTeammateDirectTranscript } from "../dist/features/teammates/direct-transcript.js";
import { listChannelConversationItems } from "../dist/features/channels/channel-conversation-api.js";
import { projectConversationUserInputs } from "../dist/features/conversations/user-input-transcript.js";

test("shared hydration chunks long history without truncation or duplicate domain reads", () => {
  const items = Array.from({ length: 1001 }, (_, i) => ({ id: "q-" + i, kind: "user_input_request" }));
  const sizes = [];
  const projection = projectConversationUserInputs({ readUserInputTranscript: input => {
    sizes.push(input.itemIds.length);
    assert.equal(input.threadId, "thread");
    return input.itemIds.map(itemId => ({ itemId, kind: "user_input_request", availability: "unavailable" }));
  } }, "thread", [...items, items[0]]);
  assert.deepEqual(sizes, [500, 500, 1]);
  assert.equal(projection.userInputs.length, 1001);
});

function detail(f, surface, options = {}) {
  if (surface === "normal") return buildConversationDetail(f.store, f.cwd, f.thread, options);
  if (surface === "private") return buildTeammateDirectTranscript(f.store, f.participantId, options);
  return listChannelConversationItems({ store: f.store, cwd: f.cwd, channel: f.channel, thread: f.thread, ...options });
}
function items(result) { return result.conversationItems ?? result.items; }

for (const surface of ["normal", "private", "channel"]) {
  test(surface + " detail uses shared read projection without republishing messages", async t => {
    const f = await fixture(t, { surface }); f.submit();
    const before = f.db.prepare("PRAGMA data_version").get().data_version;
    const result = detail(f, surface);
    assert.deepEqual(result.userInputs, f.read());
    if (surface === "channel") {
      assert.deepEqual(result.turnContextAssignments, [f.store.getEffectiveTurnContextAssignment(f.turn.turnId)]);
    }
    assert.deepEqual(items(result).filter(x => x.kind.startsWith("user_input_")).map(x => x.id), [f.request.itemId, f.receipt.answerItemId]);
    assert.ok(!(result.messages ?? []).some(m => m.content === "深色" || m.content === "选择主题\n保留换行"));
    assert.equal(f.db.prepare("PRAGMA data_version").get().data_version, before);
    assert.ok(!JSON.stringify(result.userInputs).includes("idempotencyKey"));
  });

  test(surface + " detail cannot hydrate another owner or operator-only question", async t => {
    const f = await fixture(t, { surface });
    f.db.prepare("UPDATE conversation_items SET visibility='operator',visibility_owner_id=NULL WHERE id=?").run(f.request.itemId);
    f.db.prepare("UPDATE user_input_requests SET tool_input_json='corrupt-json'").run();
    const result = detail(f, surface);
    assert.deepEqual(result.userInputs, []);
    assert.ok(!items(result).some(x => x.id === f.request.itemId));
  });

  test(surface + " reread observes delivery revision without another conversation item", async t => {
    const f = await fixture(t, { surface }); f.submit();
    const original = detail(f, surface);
    f.claim();
    const incoming = detail(f, surface);
    assert.equal(incoming.userInputs[1].delivery.status, "claimed");
    assert.equal(incoming.userInputs[1].delivery.revision, 2);
    assert.deepEqual(items(incoming).map(x => [x.id, x.revision]), items(original).map(x => [x.id, x.revision]));
  });
}

test("channel page hydrates only the selected canonical page and keeps its cursor", async t => {
  const f = await fixture(t, { surface: "channel" }); f.submit();
  const newest = detail(f, "channel", { limit: 1 });
  assert.equal(newest.userInputs.length, 1);
  assert.equal(newest.userInputs[0].kind, "user_input_answer");
  assert.equal(newest.hasMore, true);
  const older = detail(f, "channel", { limit: 1, beforeSequence: newest.nextBeforeSequence });
  assert.equal(older.userInputs.length, 1);
  assert.equal(older.userInputs[0].kind, "user_input_request");
});

test("normal and private supersession cannot restore old question bodies on a non-audit read", async t => {
  for (const surface of ["normal", "private"]) {
    const f = await fixture(t, { surface });
    const source = f.turn.item;
    f.store.commitConversationMessageEdit({
      surface: surface === "private" ? "teammate_direct" : "normal_conversation",
      ownerId: surface === "private" ? f.participantId : f.thread.id,
      laneId: f.directThread?.id ?? f.thread.id, messageId: source.id, expectedRevision: 1,
      current: source.payload, replacement: { ...source.payload, body: "Changed request" },
      sourceTurnId: f.turn.turnId, supersededTurnId: f.turn.turnId, supersededRunIds: [f.run.id],
      supersededResponseMessageIds: [], idempotencyKey: "question-edit",
    }, now);
    assert.deepEqual(detail(f, surface).userInputs, []);
    assert.equal(detail(f, surface, { includeSuperseded: true }).userInputs[0].requestId, f.request.requestId);
  }
});

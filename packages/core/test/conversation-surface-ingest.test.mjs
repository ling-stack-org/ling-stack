import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBuiltinAiTeammateId, createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-09-05T12:00:00.000Z";
const later = "2026-09-05T12:01:00.000Z";

for (const kind of ["conversation", "teammate_direct"]) {
  test(`${kind} ingest atomically creates a canonical turn, scoped item and replayable assignment`, async (t) => {
    const { store, thread } = await fixture(t, kind);
    const input = request(thread, "first");
    const first = store.appendConversationUserTurn(input, now);
    assert.equal(first.item.channelId, undefined);
    assert.equal(first.item.visibility, kind === "teammate_direct" ? "agent_private" : "thread_participants");
    assert.equal(first.item.visibilityOwnerId, kind === "teammate_direct" ? thread.teammateId : undefined);
    assert.equal(first.item.actorType, "local_user");
    assert.equal(first.item.sequence, 1);
    const turn = store.getLingTurn(first.turnId);
    assert.equal(turn.sourceItemId, first.item.id);
    assert.equal(turn.teammateId, thread.teammateId);
    assert.equal(turn.createdByActor, "local-user");
    assert.equal(store.getEffectiveTurnContextAssignment(first.turnId).segmentId, first.contextSegmentId);
    assert.equal(store.getContextSegment(first.contextSegmentId).threadId, thread.id);
    assert.deepEqual(store.appendConversationUserTurn(input, later), { ...first, idempotentReplay: true });

    const second = store.appendConversationUserTurn({
      ...request(thread, "second"), sourceTurnId: first.turnId, turnKind: "manual_followup",
    }, later);
    assert.equal(second.item.sequence, 2);
    assert.equal(second.contextSegmentId, first.contextSegmentId);
    assert.equal(store.getLingTurn(second.turnId).sourceTurnId, first.turnId);
    assert.equal(store.listLingTurns({ threadId: thread.id }).length, 2);
  });

  test(`${kind} ingest rejects changed replay identity, actor, source and payload`, async (t) => {
    const { store, thread, database } = await fixture(t, kind);
    const input = request(thread, "identity");
    const first = store.appendConversationUserTurn(input, now);
    const other = store.appendConversationUserTurn(request(thread, "other"), later);
    for (const changed of [
      { actorId: "another-user" },
      { actorType: "system" },
      { teammateId: "another-teammate" },
      { channelId: "invented-channel" },
      { turnKind: "manual_followup" },
      { sourceTurnId: other.turnId },
      { itemId: "another-item" },
      { turnId: "another-turn" },
      { payload: { ...input.payload, body: "Changed message" } },
      { payload: { ...input.payload, mentions: [{ id: "ling_agent", label: "Ling", kind: "ai_teammate" }] } },
    ]) {
      assert.throws(() => store.appendConversationUserTurn({ ...input, ...changed }, later));
    }
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM turn_context_assignments WHERE turn_id = ?").get(first.turnId).count, 1);
  });

  test(`${kind} ingest rejects foreign thread refs and channel-only dispatch without partial writes`, async (t) => {
    const { store, thread } = await fixture(t, kind);
    const foreignThread = store.createLingThread({
      kind, teammateId: thread.teammateId, title: "Other thread", objective: "Private separation",
    }, now);
    const foreign = store.appendConversationUserTurn(request(foreignThread, "foreign"), now);
    const input = request(thread, "rejected");
    for (const changed of [
      { sourceTurnId: foreign.turnId },
      { payload: { ...input.payload, replyToItemId: foreign.item.id } },
      { payload: { ...input.payload, quotedItemIds: [foreign.item.id] } },
      { dispatch: { schemaVersion: 1, requestAiReply: true } },
      { actorType: "teammate" },
    ]) {
      assert.throws(() => store.appendConversationUserTurn({ ...input, ...changed }, now));
      assert.equal(store.getConversationItem(input.itemId), undefined);
      assert.equal(store.getLingTurn(input.turnId), undefined);
      assert.equal(store.getLingThread(thread.id).nextItemSequence, 1);
    }
  });

  test(`${kind} ingest rolls back turn, item, sequence and segment on assignment failure`, async (t) => {
    const { store, thread, database } = await fixture(t, kind);
    database.exec("CREATE TRIGGER reject_test_assignment BEFORE INSERT ON turn_context_assignments BEGIN SELECT RAISE(ABORT, 'test assignment failure'); END;");
    const input = request(thread, "rollback");
    assert.throws(() => store.appendConversationUserTurn(input, now), /test assignment failure/);
    assert.equal(store.getLingTurn(input.turnId), undefined);
    assert.equal(store.getConversationItem(input.itemId), undefined);
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM context_segments WHERE thread_id = ?").get(thread.id).count, 0);
    database.exec("DROP TRIGGER reject_test_assignment;");
    assert.equal(store.appendConversationUserTurn(input, later).item.sequence, 1);
  });

  test(`${kind} archived threads allow exact read-only replay but reject new turns`, async (t) => {
    const { store, thread, database } = await fixture(t, kind);
    const input = request(thread, "before-archive");
    const result = store.appendConversationUserTurn(input, now);
    database.prepare("UPDATE ling_threads SET status = 'archived', archived_at = ? WHERE id = ?").run(later, thread.id);
    assert.deepEqual(store.appendConversationUserTurn(input, later), { ...result, idempotentReplay: true });
    assert.throws(() => store.appendConversationUserTurn(request(thread, "after-archive"), later), /thread is archived/);
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 2);
  });
}

test("private system input preserves its source actor and owner on replay", async (t) => {
  const { store, thread } = await fixture(t, "teammate_direct");
  const input = { ...request(thread, "remote"), actorType: "system", actorId: "remote-dispatch" };
  const result = store.appendConversationUserTurn(input, now);
  assert.equal(result.item.actorType, "system");
  assert.equal(result.item.actorId, "remote-dispatch");
  assert.equal(result.item.visibilityOwnerId, thread.teammateId);
  assert.equal(store.getLingTurn(result.turnId).createdByActor, "system");
  assert.equal(store.appendConversationUserTurn(input, later).idempotentReplay, true);
  assert.throws(() => store.appendConversationUserTurn({ ...input, actorType: "local_user" }, later));
});

test("replay rejects stored visibility and owner divergence instead of returning a widened item", async (t) => {
  const { store, thread, database } = await fixture(t, "teammate_direct");
  const input = request(thread, "visibility");
  store.appendConversationUserTurn(input, now);
  database.prepare("UPDATE conversation_items SET visibility = 'thread_participants', visibility_owner_id = NULL WHERE id = ?").run(input.itemId);
  assert.throws(() => store.appendConversationUserTurn(input, later), /idempotency key belongs to another input/);
  database.prepare("UPDATE conversation_items SET visibility = 'agent_private', visibility_owner_id = 'another-owner' WHERE id = ?").run(input.itemId);
  assert.throws(() => store.appendConversationUserTurn(input, later), /idempotency key belongs to another input/);
});

test("private ingest requires a real owner and rejects incompatible thread kinds", async (t) => {
  const { store } = await fixture(t, "conversation");
  for (const kind of ["teammate_direct", "task", "workflow_step"]) {
    const thread = store.createLingThread({ kind, title: kind, objective: "Must reject unsupported scope" }, now);
    assert.throws(() => store.appendConversationUserTurn(request(thread, kind), now),
      kind === "teammate_direct" ? /no teammate owner/ : /thread kind is not supported/);
    assert.equal(store.getLingThread(thread.id).nextItemSequence, 1);
  }
});

test("replay returns the latest effective assignment, including a provisional reassignment", async (t) => {
  const { store, thread } = await fixture(t, "conversation");
  const input = request(thread, "provisional");
  const first = store.appendConversationUserTurn(input, now);
  const reassigned = store.applyTurnContextAssignment({
    turnId: first.turnId,
    target: { kind: "new", state: "provisional", label: "New topic candidate" },
    status: "provisional", decisionSource: "model_policy", confidence: 0.5,
    evidenceRefs: [{ type: "conversation_item", id: first.item.id }],
    policyVersion: "continuity-v2-segmentation-v1",
  }, later);
  assert.equal(store.appendConversationUserTurn(input, later).contextSegmentId, reassigned.segment.id);
});

function request(thread, id) {
  return {
    threadId: thread.id,
    itemId: `surface-item-${id}`,
    turnId: `surface-turn-${id}`,
    teammateId: thread.teammateId,
    title: id,
    userInstruction: `Message ${id}`,
    actorId: "local-user",
    payload: { body: `Message ${id}`, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: `surface-request-${id}`,
  };
}

async function fixture(t, kind) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-surface-ingest-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    database.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const thread = store.createLingThread({
    kind,
    teammateId: kind === "teammate_direct" ? createBuiltinAiTeammateId("designer") : "ling_agent",
    title: `${kind} ingest`,
    objective: "Canonical conversation scope",
  }, now);
  return { cwd, store, database, thread };
}

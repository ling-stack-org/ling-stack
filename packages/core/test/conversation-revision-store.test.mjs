import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ConversationMessageRevisionConflictError,
  createBuiltinAiTeammateId,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";

const emptyContent = {
  mentions: [],
  attachmentIds: [],
  linkPreviewIds: [],
  fileRefs: [],
};

test("sqlite conversation revision migration is idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-conversation-revision-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
    try {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_message_revisions'").get());
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turn_supersessions'").get());
      assert.ok(database.prepare("SELECT version FROM schema_migrations WHERE version = 95 AND name = 'create_conversation_revisions'").get());
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel message edits create revisions, supersede the old turn, and replay idempotently", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-message-revision-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-07-12T01:00:00.000Z";
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const message = store.createChannelMessage({
      channelId: channel.id,
      authorType: "local-user",
      body: "Review the old implementation.",
      mentions: [{ id: createBuiltinAiTeammateId("engineer"), label: "Engineer", kind: "ai-teammate" }],
    }, now);
    const item = store.getConversationItem(message.id);
    assert.ok(item?.turnId);
    const turn = store.getLingTurn(item.turnId);
    assert.ok(turn);

    const input = {
      surface: "channel_root",
      ownerId: channel.id,
      laneId: item.threadId,
      messageId: message.id,
      expectedRevision: 1,
      current: {
        body: message.body,
        mentions: message.mentions,
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
      },
      replacement: {
        ...emptyContent,
        body: "Review and fix the current implementation.",
      },
      sourceTurnId: turn.id,
      supersededTurnId: turn.id,
      supersededRunIds: ["run_old"],
      supersededResponseMessageIds: ["channel_reply_old"],
      idempotencyKey: "edit-channel-message-1",
    };

    const committed = store.commitConversationMessageEdit(input, "2026-07-12T01:01:00.000Z");
    assert.equal(committed.idempotentReplay, false);
    assert.equal(committed.revision.revision, 2);
    assert.equal(committed.revision.body, input.replacement.body);
    assert.equal(committed.supersession.replacementStatus, "pending");
    assert.deepEqual(committed.supersession.supersededRunIds, ["run_old"]);
    assert.deepEqual(committed.supersession.supersededResponseMessageIds, ["channel_reply_old"]);
    assert.deepEqual(
      store.listConversationMessageRevisions({ surface: "channel_root", messageId: message.id }).map((revision) => [revision.revision, revision.body]),
      [
        [1, "Review the old implementation."],
        [2, "Review and fix the current implementation."],
      ],
    );
    assert.equal(store.getChannelMessage(message.id)?.body, input.replacement.body);
    assert.equal(store.getLingTurn(turn.id)?.status, "superseded");

    const replay = store.commitConversationMessageEdit(input, "2026-07-12T01:02:00.000Z");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.revision.id, committed.revision.id);
    assert.equal(replay.supersession.id, committed.supersession.id);
    assert.equal(store.listConversationMessageRevisions({ surface: "channel_root", messageId: message.id }).length, 2);

    assert.throws(
      () => store.commitConversationMessageEdit({
        ...input,
        expectedRevision: 1,
        replacement: { ...emptyContent, body: "A stale replacement." },
        idempotencyKey: "edit-channel-message-stale",
      }, "2026-07-12T01:03:00.000Z"),
      (error) => error instanceof ConversationMessageRevisionConflictError
        && error.expectedRevision === 1
        && error.actualRevision === 2,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct edits update native content and track replacement lifecycle", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-direct-message-revision-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-07-12T02:00:00.000Z";
  try {
    const teammateId = createBuiltinAiTeammateId("designer");
    const directThread = store.getOrCreateTeammateDirectThread(teammateId, now);
    const message = store.createTeammateDirectMessage({
      threadId: directThread.id,
      teammateId,
      authorType: "local-user",
      authorId: "local-user",
      body: "Inspect the draft only.",
    }, now);

    const committed = store.commitConversationMessageEdit({
      surface: "teammate_direct",
      ownerId: teammateId,
      laneId: directThread.id,
      messageId: message.id,
      expectedRevision: 1,
      current: { ...emptyContent, body: message.body },
      replacement: {
        ...emptyContent,
        body: "Inspect and update the draft.",
        attachmentIds: ["attachment_replacement"],
      },
      supersededResponseMessageIds: ["direct_reply_old"],
      idempotencyKey: "edit-direct-message-1",
    }, "2026-07-12T02:01:00.000Z");

    const updatedMessage = store.listTeammateDirectMessages({ teammateId }).find((item) => item.id === message.id);
    assert.equal(updatedMessage?.body, "Inspect and update the draft.");
    assert.deepEqual(updatedMessage?.attachmentIds, ["attachment_replacement"]);
    assert.equal(committed.supersession.replacementStatus, "pending");

    const replacementThread = store.createLingThread({
      kind: "teammate_direct",
      teammateId,
      title: "Update draft",
      objective: "Inspect and update the draft.",
    }, "2026-07-12T02:02:00.000Z");
    const replacementTurn = store.createLingTurn({
      threadId: replacementThread.id,
      kind: "manual_followup",
      title: "Update draft",
      userInstruction: "Inspect and update the draft.",
      teammateId,
    }, "2026-07-12T02:02:00.000Z");

    const started = store.updateConversationTurnSupersession(committed.supersession.id, {
      replacementTurnId: replacementTurn.id,
      replacementStatus: "started",
    }, "2026-07-12T02:02:01.000Z");
    assert.equal(started?.replacementTurnId, replacementTurn.id);
    assert.equal(started?.replacementStatus, "started");
    assert.equal(started?.failureReason, undefined);

    const failed = store.updateConversationTurnSupersession(committed.supersession.id, {
      replacementStatus: "failed",
      failureReason: "provider_unavailable",
    }, "2026-07-12T02:03:00.000Z");
    assert.equal(failed?.replacementTurnId, replacementTurn.id);
    assert.equal(failed?.replacementStatus, "failed");
    assert.equal(failed?.failureReason, "provider_unavailable");
    assert.deepEqual(
      store.listConversationTurnSupersessions({ replacementStatus: "failed" }).map((item) => item.id),
      [committed.supersession.id],
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

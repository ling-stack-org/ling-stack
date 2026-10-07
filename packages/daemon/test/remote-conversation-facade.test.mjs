import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  LING_AGENT_ID,
  createBuiltinAiTeammateId,
  createSqliteRunStore,
} from "@ling-stack/core";
import { RemoteConversationFacade } from "../dist/features/remote-access/conversation-facade.js";
import { RemoteAccessError } from "../dist/features/remote-access/errors.js";
import { RemoteProjectionOutboxWorker } from "../dist/features/remote-access/projection-outbox-worker.js";
import { RemoteDispatchWorker } from "../dist/features/remote-access/dispatch-worker.js";

function fixedClock(value = "2026-07-31T06:00:00.000Z") {
  return () => value;
}

function createFacade(store, options = {}) {
  return new RemoteConversationFacade({
    store,
    workspaceId: DEFAULT_WORKSPACE_ID,
    workspaceBindingId: "binding_mobile_v1",
    workspaceDisplayName: "Ling Workspace",
    conversationAccess: { mode: "all_in_workspace", kinds: ["channel", "conversation", "teammate_direct"] },
    policyVersion: 1,
    now: fixedClock(),
    ...options,
  });
}

test("remote facade lists and opens only normalized channel, normal, and teammate conversations", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-facade-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Mobile Channel", boundPath: cwd }, "2026-07-31T05:00:00.000Z");
    appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: LING_AGENT_ID,
      body: "Channel reply for Mobile.",
      mentions: [{ id: "local-user", label: "You", kind: "local-user" }],
    }, "2026-07-31T05:00:01.000Z");

    const conversation = store.createLingThread({
      kind: "conversation",
      teammateId: LING_AGENT_ID,
      title: "Normal Mobile Conversation",
      objective: "Read on iPhone",
    }, "2026-07-31T05:00:02.000Z");
    store.createLingTurn({
      threadId: conversation.id,
      kind: "initial_request",
      title: "Normal request",
      userInstruction: "Normal conversation message.",
    }, "2026-07-31T05:00:03.000Z");

    const teammateId = createBuiltinAiTeammateId("designer");
    const direct = store.getOrCreateTeammateDirectThread(teammateId, "2026-07-31T05:00:04.000Z");
    store.createTeammateDirectMessage({
      threadId: direct.id,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "Private teammate reply.",
    }, "2026-07-31T05:00:05.000Z");

    const facade = createFacade(store);
    const listed = facade.listConversations(DEFAULT_WORKSPACE_ID);
    assert.deepEqual(new Set(listed.conversations.map((item) => item.kind)), new Set(["channel", "conversation", "teammate_direct"]));
    assert.equal(listed.conversations.find((item) => item.conversationId === channel.id)?.mentioned, false);

    const channelSnapshot = facade.openConversation(DEFAULT_WORKSPACE_ID, channel.id);
    assert.equal(channelSnapshot.conversation.kind, "channel");
    assert.equal(channelSnapshot.messages[0]?.role, "assistant");
    assert.equal(channelSnapshot.messages[0]?.body, "Channel reply for Mobile.");
    assert.equal(Object.hasOwn(channelSnapshot.messages[0], "fileRefs"), false);

    const normalSnapshot = facade.openConversation(DEFAULT_WORKSPACE_ID, conversation.id);
    assert.equal(normalSnapshot.conversation.kind, "conversation");
    assert.equal(normalSnapshot.messages[0]?.body, "Normal conversation message.");

    const directSnapshot = facade.openConversation(DEFAULT_WORKSPACE_ID, direct.id);
    assert.equal(directSnapshot.conversation.kind, "teammate_direct");
    assert.equal(directSnapshot.messages[0]?.role, "teammate");

    assert.throws(
      () => facade.listConversations("workspace_other"),
      (error) => error instanceof RemoteAccessError && error.code === "workspace_not_allowed",
    );

    const selectedFacade = createFacade(store, {
      conversationAccess: { mode: "selected", conversationIds: [conversation.id] },
    });
    assert.deepEqual(selectedFacade.listConversations(DEFAULT_WORKSPACE_ID).conversations.map((item) => item.conversationId), [conversation.id]);
    assert.throws(
      () => selectedFacade.openConversation(DEFAULT_WORKSPACE_ID, channel.id),
      (error) => error instanceof RemoteAccessError && error.code === "conversation_not_allowed",
    );

    store.updateLingThread(conversation.id, {
      status: "archived",
      archivedAt: "2026-07-31T05:30:00.000Z",
    }, "2026-07-31T05:30:00.000Z");
    assert.equal(facade.openConversation(DEFAULT_WORKSPACE_ID, conversation.id).conversation.status, "archived");
    assert.throws(
      () => facade.sendText({
        commandId: "send_archived",
        workspaceId: DEFAULT_WORKSPACE_ID,
        conversationId: conversation.id,
        body: "Do not send.",
        issuedAt: "2026-07-31T05:59:00.000Z",
        retryUntil: "2026-08-01T05:59:00.000Z",
      }, { deviceId: "iphone_1", bodyHash: "hash_send_archived" }),
      (error) => error instanceof RemoteAccessError && error.code === "conversation_not_allowed",
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote teammate transcript hides execution control and keeps governance messages", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-private-system-purpose-"));
  const store = createSqliteRunStore(cwd);
  try {
    const teammateId = createBuiltinAiTeammateId("designer");
    const direct = store.getOrCreateTeammateDirectThread(teammateId, "2026-07-31T05:00:00.000Z");
    store.createTeammateDirectMessage({
      threadId: direct.id,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "Private teammate reply.",
    }, "2026-07-31T05:00:01.000Z");
    store.createTeammateDirectMessage({
      threadId: direct.id,
      teammateId,
      authorType: "system",
      authorId: "system",
      systemPurpose: "execution_control",
      body: "Private execution control must remain internal.",
    }, "2026-07-31T05:00:02.000Z");
    store.createTeammateDirectMessage({
      threadId: direct.id,
      teammateId,
      authorType: "system",
      authorId: "system",
      systemPurpose: "governance_notification",
      body: "Private governance notice.",
    }, "2026-07-31T05:00:03.000Z");

    const facade = createFacade(store);
    const initial = facade.openConversation(DEFAULT_WORKSPACE_ID, direct.id);
    assert.deepEqual(initial.messages.map((message) => message.body), ["Private teammate reply.", "Private governance notice."]);

    for (let index = 0; index < 101; index += 1) {
      store.createTeammateDirectMessage({
        threadId: direct.id,
        teammateId,
        authorType: "system",
        authorId: "system",
        systemPurpose: "execution_control",
        body: `Internal continuation ${index}.`,
      }, new Date(Date.parse("2026-07-31T05:01:00.000Z") + index).toISOString());
    }

    const listed = facade.listConversations(DEFAULT_WORKSPACE_ID);
    assert.equal(listed.conversations.find((item) => item.conversationId === direct.id)?.latestPreview, "Private governance notice.");
    const recent = facade.openConversation(DEFAULT_WORKSPACE_ID, direct.id);
    assert.deepEqual(recent.messages, []);
    assert.equal(recent.hasMoreOlder, true);
    assert.ok(recent.olderPageCursor);
    const older = facade.openConversation(DEFAULT_WORKSPACE_ID, direct.id, recent.olderPageCursor);
    assert.deepEqual(older.messages.map((message) => message.body), ["Private teammate reply.", "Private governance notice."]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote projections keep advancing after more than one thousand conversation activities", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-facade-large-outbox-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Large Outbox", boundPath: cwd }, "2026-07-31T05:00:00.000Z");
    for (let index = 0; index < 1_000; index += 1) {
      appendChannelItemFixture(store, {
        channelId: channel.id,
        authorType: "local-user",
        authorId: "local-user",
        body: `Filler ${index}`,
      }, new Date(Date.parse("2026-07-31T05:00:01.000Z") + index).toISOString());
    }
    const target = appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: LING_AGENT_ID,
      body: "Initial projected reply.",
      status: "pending",
    }, "2026-07-31T05:01:00.000Z");
    updateChannelItemFixture(store, target.id, {
      body: "Updated projected reply.",
    }, "2026-07-31T05:01:01.000Z");

    const latestActivitySeq = store.getLatestConversationActivitySeq({
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationKind: "channel",
      conversationId: channel.id,
    });
    const version = store.getRemoteProjectionEntityVersion({
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationKind: "channel",
      conversationId: channel.id,
      entityType: "conversation_item",
      entityId: target.id,
    });
    const snapshot = createFacade(store).openConversation(DEFAULT_WORKSPACE_ID, channel.id);
    const projected = snapshot.messages.find((message) => message.messageId === target.id);

    assert.ok(latestActivitySeq > 1_000);
    assert.equal(snapshot.conversation.activitySeq, latestActivitySeq);
    assert.equal(version.revision, 2);
    assert.equal(projected?.revision, 2);
    assert.equal(projected?.activitySeq, version.activitySeq);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("remote send is at-most-once and rejects a second command while dispatch is active", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-facade-send-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Send", boundPath: cwd }, "2026-07-31T05:00:00.000Z");
    const facade = createFacade(store);
    const command = {
      commandId: "mobile_send_command",
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationId: channel.id,
      body: "Send once from iPhone.",
      issuedAt: "2026-07-31T05:59:00.000Z",
      retryUntil: "2026-08-01T05:59:00.000Z",
    };
    const context = { deviceId: "iphone_1", bodyHash: "hash_mobile_send_command" };
    const first = facade.sendText(command, context);
    const replay = facade.sendText(command, context);
    assert.deepEqual(replay, first);
    assert.equal(listChannelItemViewsFixture(store, { channelId: channel.id }).filter((message) => message.id === first.messageId).length, 1);

    assert.throws(
      () => facade.sendText({ ...command, commandId: "second_command", body: "Do not queue this." }, {
        deviceId: "iphone_1",
        bodyHash: "hash_second_command",
      }),
      (error) => error instanceof RemoteAccessError && error.code === "conversation_busy" && error.retryable,
    );
    assert.equal(store.getRemoteCommandReceipt("second_command"), undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("facade mark-read and profile update expose the narrow Mobile fields", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-facade-profile-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Read", boundPath: cwd }, "2026-07-31T05:00:00.000Z");
    appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: LING_AGENT_ID,
      body: "Unread reply.",
    }, "2026-07-31T05:00:01.000Z");
    const facade = createFacade(store);
    const snapshot = facade.openConversation(DEFAULT_WORKSPACE_ID, channel.id);
    const marked = facade.markRead({
      commandId: "mark_read_1",
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationId: channel.id,
      throughActivitySeq: snapshot.conversation.activitySeq,
    });
    assert.equal(marked.readThroughActivitySeq, snapshot.conversation.activitySeq);
    assert.equal(facade.openConversation(DEFAULT_WORKSPACE_ID, channel.id).readState.unreadCount, 0);

    const pngHeader = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(pngHeader, 0);
    Buffer.from("IHDR", "ascii").copy(pngHeader, 12);
    pngHeader.writeUInt32BE(128, 16);
    pngHeader.writeUInt32BE(128, 20);
    const avatarDataUrl = `data:image/png;base64,${pngHeader.toString("base64")}`;
    const updated = facade.updateProfile({
      commandId: "profile_update_1",
      workspaceId: DEFAULT_WORKSPACE_ID,
      displayName: "  Mobile User  ",
      avatarDataUrl,
    });
    assert.equal(updated.displayName, "Mobile User");
    assert.equal(updated.avatarDataUrl, avatarDataUrl);
    assert.equal(Object.hasOwn(updated, "cwd"), false);

    pngHeader.writeUInt32BE(2_048, 16);
    assert.throws(
      () => facade.updateProfile({
        commandId: "profile_update_bad",
        workspaceId: DEFAULT_WORKSPACE_ID,
        avatarDataUrl: `data:image/png;base64,${pngHeader.toString("base64")}`,
      }),
      (error) => error instanceof RemoteAccessError && error.code === "profile_update_invalid",
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("projection worker acknowledges rows only after sanitized events publish", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-outbox-worker-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Outbox", boundPath: cwd }, "2026-07-31T05:00:00.000Z");
    appendChannelItemFixture(store, {
      channelId: channel.id,
      authorType: "ai-teammate",
      authorId: LING_AGENT_ID,
      body: "Publish me.",
    }, "2026-07-31T05:00:01.000Z");
    const facade = createFacade(store);
    const failedWorker = new RemoteProjectionOutboxWorker(store, facade, {
      publish() {
        throw new Error("transport offline");
      },
    }, fixedClock("2026-07-31T06:00:01.000Z"));
    await assert.rejects(() => failedWorker.drainBatch(1), /transport offline/u);
    assert.ok(store.listRemoteProjectionOutbox({ unprocessedOnly: true, limit: 100 }).length > 0);

    const published = [];
    const worker = new RemoteProjectionOutboxWorker(store, facade, {
      publish(event, source) {
        published.push({ event, source });
      },
    }, fixedClock("2026-07-31T06:00:02.000Z"));
    const result = await worker.drainUntilIdle(10);
    assert.ok(result.processed >= 2);
    assert.ok(result.published >= 2);
    assert.equal(store.listRemoteProjectionOutbox({ unprocessedOnly: true, limit: 100 }).length, 0);
    assert.ok(published.some(({ event }) => event.type === "conversation.delta"));
    assert.equal(published.some(({ event }) => JSON.stringify(event).includes("boundPath")), false);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dispatch worker retries durable intents and preserves the server-owned authority ceiling", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-dispatch-worker-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Dispatch", boundPath: cwd }, "2026-07-31T05:00:00.000Z");
    const facade = createFacade(store);
    facade.sendText({
      commandId: "dispatch_command",
      workspaceId: DEFAULT_WORKSPACE_ID,
      conversationId: channel.id,
      body: "Dispatch safely.",
      issuedAt: "2026-07-31T05:59:00.000Z",
      retryUntil: "2026-08-01T05:59:00.000Z",
    }, { deviceId: "iphone_1", bodyHash: "hash_dispatch_command" });

    let clockIndex = 0;
    const clockValues = [
      "2026-07-31T06:00:00.000Z",
      "2026-07-31T06:00:01.000Z",
      "2026-07-31T06:00:02.000Z",
      "2026-07-31T06:00:10.000Z",
      "2026-07-31T06:00:11.000Z",
    ];
    const seen = [];
    const firstWorker = new RemoteDispatchWorker({
      store,
      workerId: "remote_worker_1",
      now: () => clockValues[Math.min(clockIndex++, clockValues.length - 1)],
      retryDelayMs: 1_000,
      dispatcher: {
        dispatch(intent) {
          seen.push(intent);
          throw new Error("provider temporarily unavailable");
        },
      },
    });
    assert.deepEqual(await firstWorker.drainBatch(), { dispatched: 0, failed: 1, skipped: 0 });
    assert.equal(store.listRemoteDispatchIntents({ statuses: ["failed"] })[0]?.attemptCount, 1);

    const secondWorker = new RemoteDispatchWorker({
      store,
      workerId: "remote_worker_2",
      now: fixedClock("2026-07-31T06:00:10.000Z"),
      dispatcher: { dispatch(intent) { seen.push(intent); } },
    });
    assert.deepEqual(await secondWorker.drainBatch(), { dispatched: 1, failed: 0, skipped: 0 });
    assert.equal(store.listRemoteDispatchIntents({ statuses: ["dispatched"] })[0]?.attemptCount, 2);
    assert.ok(seen.every((intent) => intent.authority.authorityCeiling === "conversation_comment"));
    assert.ok(seen.every((intent) => intent.authority.allowToolCalls === false));
    assert.ok(seen.every((intent) => intent.authority.allowWorkflowAutoStart === false));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

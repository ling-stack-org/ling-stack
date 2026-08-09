import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ConversationItemStoreError,
  SqliteConversationItemStore,
} from "../dist/index.js";

const now = "2026-08-09T12:00:00.000Z";
const later = "2026-08-09T12:01:00.000Z";

test("ConversationItemStore allocates monotonic sequences and replays idempotent appends", () => {
  const { database, store } = createStore();
  try {
    const first = store.appendConversationItem(userInput({ idempotencyKey: "message-1" }), now);
    const replay = store.appendConversationItem(userInput({ idempotencyKey: "message-1" }), later);
    const second = store.appendConversationItem(userInput({ idempotencyKey: "message-2" }), later);
    assert.equal(first.sequence, 1);
    assert.deepEqual(replay, first);
    assert.equal(second.sequence, 2);
    assert.equal(database.prepare("SELECT next_item_sequence FROM ling_threads WHERE id = 'thread-1'").get().next_item_sequence, 3);
  } finally {
    database.close();
  }
});

test("ConversationItemStore rolls sequence allocation back after invalid input", () => {
  const { database, store } = createStore();
  try {
    assert.throws(
      () => store.appendConversationItem({
        ...userInput({ idempotencyKey: "invalid" }),
        payload: { ...userPayload(), body: "", attachmentIds: [] },
      }, now),
      (error) => error instanceof ConversationItemStoreError && error.code === "item_invalid",
    );
    const item = store.appendConversationItem(userInput({ idempotencyKey: "valid" }), later);
    assert.equal(item.sequence, 1);
  } finally {
    database.close();
  }
});

test("ConversationItemStore rolls sequence allocation back after a duplicate item id", () => {
  const { database, store } = createStore();
  try {
    const first = store.appendConversationItem({ ...userInput(), id: "item-fixed" }, now);
    assert.equal(first.sequence, 1);
    assert.throws(
      () => store.appendConversationItem({ ...userInput(), id: "item-fixed" }, later),
      (error) => error instanceof ConversationItemStoreError && error.code === "item_id_conflict",
    );
    const second = store.appendConversationItem(userInput(), later);
    assert.equal(second.sequence, 2);
  } finally {
    database.close();
  }
});

test("ConversationItemStore updates only the expected pending revision and then freezes committed content", () => {
  const { database, store } = createStore();
  try {
    const pending = store.appendConversationItem({
      channelId: "channel-1",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "assistant_message",
      status: "pending",
      actorType: "ling_agent",
      actorId: "ling-agent",
      visibility: "channel",
      payload: {
        body: "",
        format: "markdown",
        streaming: true,
        deliveryStatus: "pending",
      },
      idempotencyKey: "assistant-1",
    }, now);
    assert.throws(
      () => store.updatePendingConversationItem(pending.id, {
        expectedRevision: 1,
        payload: pending.payload,
      }, later),
      (error) => error instanceof ConversationItemStoreError && error.code === "item_revision_conflict",
    );
    const committed = store.updatePendingConversationItem(pending.id, {
      expectedRevision: 0,
      status: "committed",
      payload: {
        body: "Completed response.",
        format: "markdown",
        streaming: false,
        deliveryStatus: "ready",
      },
    }, later);
    assert.equal(committed.revision, 1);
    assert.equal(committed.status, "committed");
    assert.equal(committed.committedAt, later);
    assert.throws(
      () => store.updatePendingConversationItem(committed.id, {
        expectedRevision: 1,
        payload: committed.payload,
      }, later),
      (error) => error instanceof ConversationItemStoreError && error.code === "item_not_pending",
    );
  } finally {
    database.close();
  }
});

test("ConversationItemStore supersedes committed items once and pages with stable sequence cursors", () => {
  const { database, store } = createStore();
  try {
    const source = store.appendConversationItem(userInput({ idempotencyKey: "source" }), now);
    for (let index = 0; index < 4; index += 1) {
      store.appendConversationItem(userInput({ idempotencyKey: `tail-${index}` }), later);
    }
    const replacement = store.appendConversationItem({
      ...userInput({ idempotencyKey: "replacement" }),
      supersedesItemId: source.id,
      payload: { ...userPayload(), body: "Corrected request." },
    }, later);
    assert.equal(replacement.sequence, 6);
    assert.equal(replacement.supersedesItemId, source.id);
    assert.throws(
      () => store.appendConversationItem({
        ...userInput({ idempotencyKey: "replacement-2" }),
        supersedesItemId: source.id,
      }, later),
      (error) => error instanceof ConversationItemStoreError && error.code === "supersession_conflict",
    );

    const latest = store.listConversationItemsPage({ threadId: "thread-1", limit: 2 });
    assert.deepEqual(latest.items.map((item) => item.sequence), [5, 6]);
    assert.equal(latest.nextBeforeSequence, 5);
    const previous = store.listConversationItemsPage({
      threadId: "thread-1",
      beforeSequence: latest.nextBeforeSequence,
      limit: 2,
    });
    assert.deepEqual(previous.items.map((item) => item.sequence), [3, 4]);
  } finally {
    database.close();
  }
});

test("ConversationItemStore enforces thread, turn, channel and visibility boundaries", () => {
  const { database, store } = createStore();
  try {
    assert.throws(
      () => store.appendConversationItem({ ...userInput(), threadId: "missing" }, now),
      (error) => error instanceof ConversationItemStoreError && error.code === "thread_not_found",
    );
    database.prepare("UPDATE ling_threads SET status = 'archived' WHERE id = 'thread-2'").run();
    assert.throws(
      () => store.appendConversationItem({ ...userInput(), threadId: "thread-2", channelId: "channel-2", turnId: undefined }, now),
      (error) => error instanceof ConversationItemStoreError && error.code === "thread_archived",
    );
    assert.throws(
      () => store.appendConversationItem({ ...userInput(), turnId: "missing" }, now),
      (error) => error instanceof ConversationItemStoreError && error.code === "turn_not_found",
    );
    assert.throws(
      () => store.appendConversationItem({ ...userInput(), channelId: "channel-2" }, now),
      (error) => error instanceof ConversationItemStoreError && error.code === "channel_thread_mismatch",
    );
    assert.throws(
      () => store.appendConversationItem({ ...userInput(), turnId: "turn-other" }, now),
      (error) => error instanceof ConversationItemStoreError && error.code === "turn_thread_mismatch",
    );
    assert.throws(
      () => store.appendConversationItem({ ...userInput(), visibility: "agent_private" }, now),
      (error) => error instanceof ConversationItemStoreError && error.code === "item_invalid",
    );
    assert.throws(
      () => store.listConversationItemsPage({ threadId: "thread-1", beforeSequence: 0 }),
      RangeError,
    );
  } finally {
    database.close();
  }
});

function createStore() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE ling_threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      status TEXT NOT NULL,
      next_item_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ling_turns (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
    CREATE TABLE conversation_items (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      visibility TEXT NOT NULL,
      visibility_owner_id TEXT,
      payload_json TEXT NOT NULL,
      domain_refs_json TEXT NOT NULL,
      idempotency_key TEXT,
      revision INTEGER NOT NULL,
      supersedes_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      committed_at TEXT,
      UNIQUE(thread_id, sequence),
      UNIQUE(thread_id, idempotency_key),
      UNIQUE(supersedes_item_id)
    );
    INSERT INTO ling_threads VALUES ('thread-1', 'workspace_default', 'channel-1', 'open', 1, '${now}');
    INSERT INTO ling_threads VALUES ('thread-2', 'workspace_default', 'channel-2', 'open', 1, '${now}');
    INSERT INTO ling_turns VALUES ('turn-1', 'workspace_default', 'thread-1');
    INSERT INTO ling_turns VALUES ('turn-other', 'workspace_default', 'thread-2');
  `);
  return { database, store: new SqliteConversationItemStore({ database }) };
}

function userInput(overrides = {}) {
  return {
    channelId: "channel-1",
    threadId: "thread-1",
    turnId: "turn-1",
    kind: "user_message",
    actorType: "local_user",
    visibility: "channel",
    payload: userPayload(),
    ...overrides,
  };
}

function userPayload() {
  return {
    body: "Start the work.",
    format: "plain_text",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
  };
}

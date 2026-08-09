import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyContinuityV2StorageMigration,
  createSqliteRunStore,
  resolveRuntimePaths,
  SqliteConversationItemStore,
  SqliteConversationTurnIngestStore,
} from "../dist/index.js";

const now = "2026-08-09T14:00:00.000Z";

test("Conversation turn ingest atomically appends user item, turn and assignment with replay", async (t) => {
  const fixture = await createMigratedFixture(t);
  const items = new SqliteConversationItemStore({ database: fixture.database });
  const ingest = new SqliteConversationTurnIngestStore({ database: fixture.database }, items);
  const input = {
    itemId: "item-new-user",
    turnId: "turn-new-user",
    channelId: fixture.channelId,
    threadId: fixture.rootThreadId,
    title: "Continue",
    userInstruction: "Continue the design.",
    actorId: "local-user",
    payload: {
      body: "Continue the design.",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "channel-request-1",
  };
  const created = ingest.appendUserTurn(input, now);
  assert.equal(created.idempotentReplay, false);
  assert.equal(created.item.id, input.itemId);
  assert.equal(created.item.turnId, input.turnId);
  assert.equal(created.item.sequence, 1);
  assert.equal(fixture.database.prepare("SELECT source_item_id FROM ling_turns WHERE id = ?").get(input.turnId).source_item_id, input.itemId);
  assert.equal(fixture.database.prepare("SELECT segment_id FROM turn_context_assignments WHERE turn_id = ?").get(input.turnId).segment_id, created.contextSegmentId);

  const replay = ingest.appendUserTurn(input, "2026-08-09T14:01:00.000Z");
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.item, created.item);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM ling_turns WHERE id = ?").get(input.turnId).count, 1);
  assert.equal(fixture.database.prepare("SELECT next_item_sequence FROM ling_threads WHERE id = ?").get(input.threadId).next_item_sequence, 2);
});

test("Conversation turn ingest rolls the turn and sequence back when item validation fails", async (t) => {
  const fixture = await createMigratedFixture(t);
  const items = new SqliteConversationItemStore({ database: fixture.database });
  const ingest = new SqliteConversationTurnIngestStore({ database: fixture.database }, items);
  assert.throws(() => ingest.appendUserTurn({
    itemId: "item-invalid",
    turnId: "turn-invalid",
    channelId: fixture.channelId,
    threadId: fixture.rootThreadId,
    title: "Invalid",
    userInstruction: "Invalid",
    payload: {
      body: "",
      format: "plain_text",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
    },
    idempotencyKey: "invalid-input",
  }, now), /schema validation/);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM ling_turns WHERE id = 'turn-invalid'").get().count, 0);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM conversation_items WHERE id = 'item-invalid'").get().count, 0);
  assert.equal(fixture.database.prepare("SELECT next_item_sequence FROM ling_threads WHERE id = ?").get(fixture.rootThreadId).next_item_sequence, 1);
});

async function createMigratedFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-conversation-ingest-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Ingest", boundPath: cwd }, "2026-08-09T13:00:00.000Z");
  const rootThread = store.createLingThread({
    id: "thread-ingest-root",
    kind: "channel_discussion",
    channelId: channel.id,
    title: "Root",
    objective: "Root conversation",
  }, "2026-08-09T13:00:01.000Z");
  store.close();
  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  t.after(async () => {
    database.close();
    await rm(cwd, { recursive: true, force: true });
  });
  database.exec("PRAGMA foreign_keys = ON;");
  applyContinuityV2StorageMigration({
    database,
    appliedAt: "2026-08-09T13:30:00.000Z",
    hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
    recordMigration: (version, name) => database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)
    `).run(version, name, "2026-08-09T13:30:00.000Z"),
  });
  return { cwd, database, channelId: channel.id, rootThreadId: rootThread.id };
}

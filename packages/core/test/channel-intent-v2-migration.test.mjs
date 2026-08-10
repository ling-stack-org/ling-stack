import assert from "node:assert/strict";
import { appendLegacyChannelMessageFixture } from "./legacy-continuity-fixture.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createLegacySqliteRunStoreForMigrationTest,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";
import { CHANNEL_INTENT_V2_MIGRATION_VERSION } from "../dist/storage/sqlite/channel-intent-v2-migration.js";

test("Channel Intent v2 migration deletes v1 rows and preserves new v2 decisions on reopen", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-channel-intent-v2-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const legacy = createLegacySqliteRunStoreForMigrationTest(cwd);
  const channel = legacy.createChannel({ name: "Intent v2", boundPath: cwd }, "2026-08-10T10:00:00.000Z");
  const message = appendLegacyChannelMessageFixture(legacy, {
    channelId: channel.id,
    authorType: "local-user",
    body: "Write an article",
  }, "2026-08-10T10:01:00.000Z");
  const legacyDatabase = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  legacyDatabase.prepare(`
    INSERT INTO channel_intent_decisions (
      id, schema_version, workspace_id, channel_id, source_message_id, action,
      selected_teammate_id, selected_teammate_ids_json, proposal_id, reply_message_id,
      reply_message_ids_json, workflow_id, reason, status, created_by, error_message,
      created_at, updated_at
    ) VALUES (
      'legacy-intent', 1, 'workspace_default', ?, ?, 'single_reply',
      'ling_agent', '[]', NULL, NULL, '[]', NULL, 'legacy', 'accepted',
      'deterministic', NULL, '2026-08-10T10:01:01.000Z', '2026-08-10T10:01:01.000Z'
    )
  `).run(channel.id, message.id);
  legacyDatabase.close();
  legacy.close();

  let store = createSqliteRunStore(cwd);
  assert.deepEqual(store.listChannelIntentDecisions({ channelId: channel.id }), []);
  const sourceItem = store.getConversationItem(message.id);
  assert.ok(sourceItem?.turnId);
  const assignment = store.getEffectiveTurnContextAssignment(sourceItem.turnId);
  assert.ok(assignment);
  const decision = store.createChannelIntentDecision({
    channelId: channel.id,
    sourceItemId: sourceItem.id,
    contextProjection: projectionFor(sourceItem, assignment),
    action: "reply",
    reason: "Ordinary content reply.",
    status: "accepted",
    createdBy: "deterministic",
  }, "2026-08-10T10:02:00.000Z");
  assert.equal(decision.schemaVersion, 2);
  assert.equal(decision.action, "reply");
  assert.deepEqual(decision.selectedTeammateIds, []);
  assert.deepEqual(decision.resultItemIds, []);
  store.close();

  store = createSqliteRunStore(cwd);
  assert.equal(store.getChannelIntentDecision(decision.id)?.id, decision.id);
  store.close();

  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath, { readOnly: true });
  const columns = database.prepare("PRAGMA table_info(channel_intent_decisions)").all().map((row) => row.name);
  assert.equal(columns.includes("source_turn_id"), true);
  assert.equal(columns.includes("context_segment_id"), true);
  assert.equal(columns.includes("context_projection_version"), true);
  assert.equal(columns.includes("clarification_json"), true);
  assert.equal(columns.includes("execution_json"), true);
  assert.equal(columns.includes("source_message_id"), false);
  assert.equal(columns.includes("selected_teammate_id"), false);
  assert.equal(columns.includes("reply_message_ids_json"), false);
  assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(CHANNEL_INTENT_V2_MIGRATION_VERSION));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  database.close();
});

function projectionFor(item, assignment) {
  return {
    projectionVersion: `projection:${item.id}:${assignment.revision}`,
    sourceStateFingerprint: `source-state:${item.id}:${assignment.revision}`,
    threadId: item.threadId,
    turnId: item.turnId,
    segmentId: assignment.segmentId,
    throughItemSequence: item.sequence,
    summaryIds: [],
    sourceRefs: [
      { type: "thread", id: item.threadId },
      { type: "turn", id: item.turnId },
      { type: "conversation_item", id: item.id },
    ],
    policyVersion: "test-projector-v1",
    visibilityFingerprint: "channel_shared",
  };
}

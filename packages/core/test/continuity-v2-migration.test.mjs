import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyContinuityV2StorageMigration,
  CONTINUITY_V2_STORAGE_MIGRATION_VERSION,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";

const migrationTime = "2026-08-09T13:00:00.000Z";

test("Continuity v2 migration atomically imports root, topic and branch timelines with references", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-continuity-v2-migration-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Continuity", boundPath: cwd }, "2026-08-09T12:00:00.000Z");
  const rootThread = store.createLingThread({
    id: "thread-root",
    kind: "channel_discussion",
    channelId: channel.id,
    title: "Main branch",
    objective: "Root conversation",
  }, "2026-08-09T12:00:01.000Z");
  const branchThread = store.createLingThread({
    id: "thread-branch",
    kind: "channel_discussion",
    channelId: channel.id,
    title: "Implementation branch",
    objective: "Branch conversation",
  }, "2026-08-09T12:00:02.000Z");
  store.createChannelBranch({
    id: "branch-1",
    channelId: channel.id,
    name: "Implementation",
    rootThreadId: branchThread.id,
  }, "2026-08-09T12:00:03.000Z");

  const rootUser = store.createChannelMessage({
    id: "message-root-user",
    channelId: channel.id,
    authorType: "local-user",
    body: "Design continuity",
    mentions: [{ id: "ling_agent", label: "Ling", kind: "ai-teammate" }],
    fileRefs: [{ path: "README.md", source: "explicit_text", line: 1 }],
  }, "2026-08-09T12:01:00.000Z");
  const rootReply = store.createChannelMessage({
    id: "message-root-reply",
    channelId: channel.id,
    threadId: rootUser.id,
    kind: "ai_reply",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "Use Thread, Turn and Item.",
  }, "2026-08-09T12:01:01.000Z");
  const topicUser = store.createChannelMessage({
    id: "message-topic-user",
    channelId: channel.id,
    threadId: rootUser.id,
    authorType: "local-user",
    body: "Proceed with option B.",
  }, "2026-08-09T12:01:02.000Z");
  const topicReply = store.createChannelMessage({
    id: "message-topic-reply",
    channelId: channel.id,
    threadId: rootUser.id,
    kind: "ai_reply",
    authorType: "ai-teammate",
    authorId: "teammate_builtin_architect",
    body: "Option B is recorded.",
  }, "2026-08-09T12:01:03.000Z");
  const branchUser = store.createChannelMessage({
    id: "message-branch-user",
    channelId: channel.id,
    threadId: branchThread.id,
    authorType: "local-user",
    body: "Implement in the branch.",
  }, "2026-08-09T12:02:00.000Z");
  const branchReply = store.createChannelMessage({
    id: "message-branch-reply",
    channelId: channel.id,
    threadId: branchThread.id,
    kind: "ai_reply",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "Implementation started.",
  }, "2026-08-09T12:02:01.000Z");

  const rootTurn = store.createLingTurn({
    id: "turn-root-user",
    threadId: rootThread.id,
    kind: "initial_request",
    title: rootUser.body,
    userInstruction: rootUser.body,
    channelId: channel.id,
    sourceMessageId: rootUser.id,
  }, rootUser.createdAt);
  store.createLingTurn({
    id: "turn-topic-user-legacy-root",
    threadId: rootThread.id,
    kind: "manual_followup",
    title: topicUser.body,
    userInstruction: topicUser.body,
    channelId: channel.id,
    sourceMessageId: topicUser.id,
  }, topicUser.createdAt);
  store.createLingTurn({
    id: "turn-branch-user",
    threadId: branchThread.id,
    kind: "initial_request",
    title: branchUser.body,
    userInstruction: branchUser.body,
    channelId: channel.id,
    sourceMessageId: branchUser.id,
  }, branchUser.createdAt);
  const task = store.createTask({
    id: "task-continuity",
    channelId: channel.id,
    title: "Continuity migration",
    prompt: "Migrate the timeline.",
  }, rootUser.createdAt);
  const replyRun = store.createRun({
    id: "run-root-reply",
    cwd,
    taskId: task.id,
    channelId: channel.id,
    providerName: "openai",
    providerModel: "gpt-test",
    taskSnapshot: { id: task.id, title: task.title, prompt: task.prompt },
    providerSnapshot: { provider: "openai", model: "gpt-test" },
    requestSnapshot: {
      cwd,
      sourceMessageId: rootUser.id,
      linkedMessageId: rootReply.id,
      task: { id: task.id, title: task.title, prompt: task.prompt },
    },
    threadId: rootThread.id,
    turnId: rootTurn.id,
    createdAt: rootReply.createdAt,
  });
  store.updateChannelMessageRuntime(rootReply.id, { linkedRunId: replyRun.id }, rootReply.updatedAt);

  const attachment = store.createChannelAttachment({
    channelId: channel.id,
    messageId: rootUser.id,
    kind: "text",
    fileName: "README.md",
    contentType: "text/markdown",
    sizeBytes: 64,
    path: `${channel.id}/README.md`,
    createdAt: rootUser.createdAt,
  });
  const preview = store.createChannelLinkPreview({
    channelId: channel.id,
    messageId: rootUser.id,
    url: "https://example.com/continuity",
    normalizedUrl: "https://example.com/continuity",
    title: "Continuity",
    status: "ready",
  }, rootUser.createdAt);
  const decision = store.createChannelDecision({
    channelId: channel.id,
    sourceMessageId: rootUser.id,
    title: "Choose option B",
    decision: "Use conversation_items.",
    createdBy: "local-user",
  }, rootUser.createdAt);
  const handoff = store.createChannelHandoff({
    channelId: channel.id,
    sourceMessageId: rootUser.id,
    fromParticipantId: "local-user",
    fromParticipantLabel: "User",
    toParticipantId: "ling_agent",
    toParticipantLabel: "Ling",
    reason: "Implement continuity",
    requiredInput: "Approved design",
    expectedOutput: "Storage cutover",
    createdBy: "local-user",
  }, rootUser.createdAt);
  const proposal = store.createChannelExecutionProposal({
    channelId: channel.id,
    sourceMessageId: rootUser.id,
    proposedByTeammateId: "ling_agent",
    title: "Implement continuity",
    prompt: "Perform the storage cutover.",
    assigneeTeammateId: "ling_agent",
    requiredTools: ["write"],
    status: "draft",
  }, rootUser.createdAt);
  store.createChannelIntentDecision({
    channelId: channel.id,
    sourceMessageId: rootUser.id,
    action: "single_reply",
    selectedTeammateId: "ling_agent",
    replyMessageId: rootReply.id,
    proposalId: proposal.id,
    reason: "Ling replied.",
    status: "accepted",
    createdBy: "deterministic",
  }, rootReply.createdAt);
  store.createChannelIntentDecision({
    channelId: channel.id,
    sourceMessageId: topicUser.id,
    action: "single_reply",
    selectedTeammateId: "teammate_builtin_architect",
    replyMessageId: topicReply.id,
    reason: "Architect replied.",
    status: "accepted",
    createdBy: "deterministic",
  }, topicReply.createdAt);
  const route = store.createChannelMessageRouteDecision({
    channelId: channel.id,
    sourceMessageId: branchUser.id,
    replyMessageId: branchReply.id,
    mode: "default_teammate",
    action: "reply",
    selectedTeammateId: "ling_agent",
    reason: "Branch reply.",
    status: "accepted",
    createdBy: "deterministic",
  }, branchReply.createdAt);
  const summary = store.createChannelContextSummary({
    channelId: channel.id,
    targetType: "thread",
    targetId: rootUser.id,
    sourceMessageIds: [rootReply.id, topicUser.id],
    decisionIds: [decision.id],
    summary: "Continuity v2 option B.",
    acceptanceCriteria: ["One timeline authority"],
    openQuestions: ["Migration timing"],
    authorType: "system",
  }, "2026-08-09T12:03:00.000Z");
  const secondSummary = store.createChannelContextSummary({
    channelId: channel.id,
    targetType: "thread",
    targetId: rootUser.id,
    sourceMessageIds: [rootReply.id, topicUser.id, topicReply.id],
    summary: "Continuity v2 option B is active.",
    authorType: "system",
  }, "2026-08-09T12:03:00.500Z");
  const thirdSummary = store.createChannelContextSummary({
    channelId: channel.id,
    targetType: "thread",
    targetId: rootUser.id,
    sourceMessageIds: [rootReply.id, topicUser.id, topicReply.id],
    summary: "Continuity v2 option B is confirmed.",
    authorType: "system",
  }, "2026-08-09T12:03:00.750Z");
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    sourceHandoffId: handoff.id,
    title: "Continuity workflow",
    objective: "Cut over timeline authority.",
    createdBy: "local-user",
  }, "2026-08-09T12:03:01.000Z");
  const step = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    sourceHandoffId: handoff.id,
    contextSummaryId: summary.id,
    title: "Migrate",
    prompt: "Run migration.",
    toParticipantId: "ling_agent",
    toParticipantLabel: "Ling",
  }, "2026-08-09T12:03:02.000Z");
  store.close();

  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.prepare("UPDATE channel_context_summaries SET source_message_ids_json = ? WHERE id = ?")
    .run(JSON.stringify([rootReply.id, topicUser.id, "missing-message"]), summary.id);
  const report = migrate(database);
  assert.equal(report.legacyMessageCount, 6);
  assert.equal(report.importedItemCount, 6);
  assert.equal(report.rootThreadCount, 1);
  assert.equal(report.topicThreadCount, 1);
  assert.equal(report.branchThreadCount, 1);
  assert.equal(report.summaryCount, 3);
  assert.equal(report.invalidatedSummaryCount, 1);

  assert.deepEqual(tableNames(database, ["channel_messages", "channel_context_summaries", "conversation_items"]), ["conversation_items"]);
  const rootItem = database.prepare("SELECT thread_id, sequence, turn_id FROM conversation_items WHERE id = ?").get(rootUser.id);
  assert.equal(rootItem.thread_id, rootThread.id);
  assert.equal(rootItem.sequence, 1);
  assert.equal(rootItem.turn_id, "turn-root-user");
  const topicItems = database.prepare(`
    SELECT id, sequence FROM conversation_items WHERE thread_id = (
      SELECT id FROM ling_threads WHERE surface_kind = 'topic'
    ) ORDER BY sequence
  `).all();
  assert.deepEqual(topicItems.map((item) => [item.id, item.sequence]), [
    [rootReply.id, 1],
    [topicUser.id, 2],
    [topicReply.id, 3],
  ]);
  const topicThread = database.prepare("SELECT parent_thread_id, parent_turn_id, anchor_item_id FROM ling_threads WHERE surface_kind = 'topic'").get();
  assert.equal(topicThread.parent_thread_id, rootThread.id);
  assert.equal(topicThread.parent_turn_id, "turn-root-user");
  assert.equal(topicThread.anchor_item_id, rootUser.id);
  const movedRun = database.prepare(`
    SELECT runs.thread_id, links.turn_id
    FROM run_sessions AS runs
    INNER JOIN ling_turn_runs AS links ON links.run_id = runs.id
    WHERE runs.id = ?
  `).get(replyRun.id);
  assert.equal(movedRun.thread_id, database.prepare("SELECT id FROM ling_threads WHERE surface_kind = 'topic'").get().id);
  assert.equal(movedRun.turn_id, database.prepare("SELECT turn_id FROM conversation_items WHERE id = ?").get(rootReply.id).turn_id);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ling_turn_runs WHERE turn_id = ?").get(rootTurn.id).count, 0);
  const branch = database.prepare("SELECT parent_thread_id, parent_turn_id FROM ling_threads WHERE id = ?").get(branchThread.id);
  assert.equal(branch.parent_thread_id, rootThread.id);
  assert.ok(branch.parent_turn_id);

  assert.equal(database.prepare("SELECT item_id FROM channel_attachments WHERE id = ?").get(attachment.id).item_id, rootUser.id);
  assert.equal(database.prepare("SELECT item_id FROM channel_link_previews WHERE id = ?").get(preview.id).item_id, rootUser.id);
  assert.equal(database.prepare("SELECT source_item_id FROM channel_decisions WHERE id = ?").get(decision.id).source_item_id, rootUser.id);
  assert.equal(database.prepare("SELECT source_item_id FROM channel_handoffs WHERE id = ?").get(handoff.id).source_item_id, rootUser.id);
  assert.equal(database.prepare("SELECT source_item_id FROM channel_execution_proposals WHERE id = ?").get(proposal.id).source_item_id, rootUser.id);
  assert.equal(database.prepare("SELECT source_item_id, reply_item_id FROM channel_message_route_decisions WHERE id = ?").get(route.id).source_item_id, branchUser.id);
  assert.equal(database.prepare("SELECT context_summary_id FROM channel_workflow_steps WHERE id = ?").get(step.id).context_summary_id, summary.id);
  assert.equal(database.prepare("SELECT status FROM conversation_context_summaries WHERE id = ?").get(summary.id).status, "invalidated");
  assert.deepEqual(database.prepare(`
    SELECT id, version, status, supersedes_summary_id
    FROM conversation_context_summaries
    ORDER BY version
  `).all().map((row) => [row.id, row.version, row.status, row.supersedes_summary_id]), [
    [summary.id, 1, "invalidated", null],
    [secondSummary.id, 2, "superseded", null],
    [thirdSummary.id, 3, "active", secondSummary.id],
  ]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(hasColumn(database, "ling_turns", "source_item_id"), true);
  assert.equal(hasColumn(database, "ling_turns", "source_message_id"), false);
  assert.equal(hasColumn(database, "channel_intent_decisions", "source_item_id"), true);
  assert.equal(hasColumn(database, "channel_intent_decisions", "source_message_id"), false);
  assert.equal(migrate(database), undefined);
  database.close();
});

test("Continuity v2 migration creates distinct lineage and context turns for an empty branch", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-continuity-v2-empty-branch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Empty", boundPath: cwd }, "2026-08-09T12:00:00.000Z");
  const rootThread = store.createLingThread({
    id: "thread-empty-root",
    kind: "channel_discussion",
    channelId: channel.id,
    title: "Root",
    objective: "Empty root",
  }, "2026-08-09T12:00:01.000Z");
  const branchThread = store.createLingThread({
    id: "thread-empty-branch",
    kind: "channel_discussion",
    channelId: channel.id,
    title: "Branch",
    objective: "Empty branch",
  }, "2026-08-09T12:00:02.000Z");
  store.createChannelBranch({
    id: "branch-empty",
    channelId: channel.id,
    name: "Empty branch",
    rootThreadId: branchThread.id,
  }, "2026-08-09T12:00:03.000Z");
  store.close();

  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  const report = migrate(database);
  assert.equal(report.importedItemCount, 0);
  assert.equal(report.segmentCount, 2);
  assert.equal(report.assignmentCount, 2);
  const rootTurns = database.prepare("SELECT id FROM ling_turns WHERE thread_id = ?").all(rootThread.id);
  const branchTurns = database.prepare("SELECT id FROM ling_turns WHERE thread_id = ?").all(branchThread.id);
  assert.equal(rootTurns.length, 1);
  assert.equal(branchTurns.length, 1);
  assert.notEqual(rootTurns[0].id, branchTurns[0].id);
  assert.equal(database.prepare("SELECT parent_turn_id FROM ling_threads WHERE id = ?").get(branchThread.id).parent_turn_id, rootTurns[0].id);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("Continuity v2 migration rolls back all schema and data changes on an unrepresentable legacy message", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-continuity-v2-rollback-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Rollback", boundPath: cwd }, "2026-08-09T12:00:00.000Z");
  store.createChannelMessage({
    id: "message-too-large",
    channelId: channel.id,
    authorType: "local-user",
    body: "x".repeat(32_769),
  }, "2026-08-09T12:00:01.000Z");
  store.close();

  const database = new DatabaseSync(resolveRuntimePaths(cwd).databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  const hadSurfaceKind = hasColumn(database, "ling_threads", "surface_kind");
  assert.throws(() => migrate(database), /cannot represent legacy message without loss/);
  assert.equal(hasTable(database, "channel_messages"), true);
  assert.equal(hasTable(database, "conversation_items"), false);
  assert.equal(hasColumn(database, "ling_turns", "source_message_id"), true);
  assert.equal(hasColumn(database, "ling_threads", "surface_kind"), hadSurfaceKind);
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(CONTINUITY_V2_STORAGE_MIGRATION_VERSION), undefined);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM channel_messages").get().count, 1);
  database.close();
});

function migrate(database) {
  return applyContinuityV2StorageMigration({
    database,
    appliedAt: migrationTime,
    hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
    recordMigration: (version, name) => {
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(version, name, migrationTime);
    },
  });
}

function tableNames(database, names) {
  return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${names.map(() => "?").join(", ")})
    ORDER BY name
  `).all(...names).map((row) => row.name);
}

function hasTable(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-10-29T00:00:00.000Z";
const later = "2026-10-29T00:01:00.000Z";
const learningMigrations = [
  [184, "procedure_observation_unique_source_jobs"],
  [185, "immutable_skill_definition_revision_history"],
  [186, "bounded_learning_review_jobs_default_off"],
  [187, "optional_memory_derivative_outbox_and_generation"],
  [188, "rebuildable_scoped_memory_wiki"],
];
const learningTableGroups = [
  ["procedure_observation_jobs"],
  ["skill_definition_revision_notices", "skill_definition_revisions"],
  ["learning_review_policy", "learning_review_jobs"],
  ["memory_semantic_policy", "memory_semantic_generation", "memory_derivative_revisions", "memory_derivative_outbox"],
  ["memory_wiki_generations", "memory_wiki_human_blocks"],
];
const searchTables = [
  "memory_search_index_state", "memory_search_dirty", "memory_search_fts_v1",
  "memory_search_fts_v1_data", "memory_search_fts_v1_idx", "memory_search_fts_v1_content",
  "memory_search_fts_v1_docsize", "memory_search_fts_v1_config",
];
const learningTables = new Set([...learningTableGroups.flat(), ...searchTables]);
const channelTables = new Set(["channel_session_requests", "channel_session_diagnostics"]);
const channelTriggers = new Set(["idx_channel_sessions_activity"]);
const learningTriggers = [
  "skill_definition_history_create", "skill_definition_history_update", "skill_definition_history_notice",
  "memory_derivative_insert", "memory_derivative_update", "memory_derivative_delete",
  "memory_derivative_health_insert", "memory_derivative_health_update", "memory_derivative_health_delete",
  "memory_search_insert", "memory_search_update", "memory_search_delete",
];
const preservedTables = [
  "memory_objects", "memory_self_improving_metadata", "memory_used_events",
  "memory_review_policy", "memory_review_decisions", "memory_review_actions",
  "skill_packs", "skill_definitions", "skill_import_drafts", "skill_source_snapshots",
  "skill_source_artifacts", "skill_compiled_runtime_views", "workspace_settings",
  "channels", "tasks", "run_sessions", "artifacts",
];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ling-main178-learning-upgrade-"));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) close();
    await rm(directory, { recursive: true, force: true });
  });
  const own = handle => {
    let closed = false;
    const close = () => { if (!closed) { handle.close(); closed = true; } };
    closers.push(close);
    return { handle, close };
  };
  const sourceCwd = join(directory, "full-schema-source");
  const upgradeCwd = join(directory, "mainline178-copy");
  await mkdir(sourceCwd);
  await mkdir(upgradeCwd);
  return { sourceCwd, upgradeCwd, own };
}

function schema(database) {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
}

function rows(database, table) {
  return database.prepare(`SELECT * FROM "${table}"`).all()
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function snapshot(database, tables) {
  return Object.fromEntries(Array.from(tables, table => [table, rows(database, table)]));
}

function assertHealthy(database) {
  assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map(row => row.integrity_check), ["ok"]);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
}

function removeLearningOverlays(database) {
  for (const trigger of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_channel_session_%'").all()) {
    database.exec(`DROP TRIGGER "${trigger.name}"`);
  }
  database.exec(`DROP TABLE channel_session_requests; DROP TABLE channel_session_diagnostics;
    DROP INDEX idx_channel_sessions_activity;
    ALTER TABLE ling_threads DROP COLUMN session_activity_at;
    ALTER TABLE ling_threads DROP COLUMN session_notification_revision;
    ALTER TABLE ling_threads DROP COLUMN session_title_source;`);
  for (const trigger of learningTriggers) database.exec(`DROP TRIGGER ${trigger}`);
  // Drop referencing notices first; dropping the FTS virtual table removes its SQLite-owned shadows.
  for (const table of learningTables) {
    if (!table.startsWith("memory_search_fts_v1_")) database.exec(`DROP TABLE ${table}`);
  }
  database.exec("DELETE FROM schema_migrations WHERE version IN (179,180,181,184,185,186,187,188)");
  assert.deepEqual(schema(database).filter(row =>
    learningTables.has(row.tbl_name) || learningTriggers.includes(row.name)), []);
}

test("real mainline schema178 upgrades to188 without changing canonical settings, sources or inventing skill history", async t => {
  const f = await fixture(t);
  const original = f.own(createSqliteRunStore(f.sourceCwd));
  original.handle.updateWorkspaceSettings({ schemaVersion: 2,
    defaultAuthorizationMode: "smart", defaultWorkspaceAccessMode: "workspace_write" }, now);
  const channel = original.handle.createChannel({ name: "Historical knowledge", boundPath: f.sourceCwd }, now);
  const task = original.handle.createTask({ channelId: channel.id, title: "Receipt verification", prompt: "Compare both totals" }, now);
  const run = original.handle.createRun({ id: "main178-run", cwd: f.sourceCwd, taskId: task.id,
    providerName: "test", providerModel: "fixture", taskSnapshot: { runnerId: "pi" },
    providerSnapshot: {}, requestSnapshot: { runnerId: "pi" }, createdAt: now });
  const artifact = original.handle.createArtifact({ id: "main178-receipt-evidence", runId: run.id,
    type: "json", path: "receipt-evidence.json", createdAt: now });
  for (const [id, extra] of [
    ["historical-approved", {}],
    ["historical-candidate", { reviewState: "candidate" }],
    ["historical-disabled", { enabled: false }],
  ]) {
    original.handle.createMemoryObject({ id, scopeType: "workspace", ownerId: "workspace_default",
      title: `核验记录 ${id}`, body: "先核对原始收据，再比较两侧金额。", tags: ["核验", "receipt"],
      sourceRefs: [{ type: "artifact", id: artifact.id }], ...extra }, now);
  }
  const definition = { id: "main178-receipt-skill", name: "Receipt verification", summary: "Original receipt steps",
    roleAffinity: ["engineer"], promptFragments: ["Read the receipt and compare both totals."],
    requiredTools: ["read"], requiredProviderCapabilities: ["chat"], approvalProfile: { mode: "none" }, stateEffects: [] };
  const imported = original.handle.createSkillImportDraft({ source: "custom", sourcePath: "skills.json",
    name: "Historical pack", description: "Historical evidence", definitions: [{ definition }] }, now);
  const published = original.handle.publishSkillImportDraft(imported.id, now)[0];
  const revision = original.handle.createSkillImportDraft({ source: published.source, packId: published.packId,
    name: definition.name, description: "Confirmed correction",
    definitions: [{ definition: { ...definition, summary: "Current verified receipt steps" } }] }, later);
  original.handle.publishSkillRevisionDraft({ draftId: revision.id, skillId: definition.id,
    expectedUpdatedAt: published.updatedAt,
    expectedRevisionId: original.handle.getSkillDefinitionRevision(definition.id).id }, later);
  assert.equal(original.handle.listSkillDefinitionRevisions(definition.id).length, 2);
  original.handle.upsertSkillSourceSnapshot({ id: "main178-source", skillId: definition.id,
    sourceKind: "gstack-skill-directory", sourcePath: "skills/receipt/SKILL.md",
    upstreamName: "receipt", upstreamVersion: "1", upstreamSkillPath: "skills/receipt/SKILL.md",
    sourceChecksum: "sha256-main178-receipt", rawSkillMarkdown: "---\nname: receipt\n---\n# Verify both totals\n",
    agentMetadata: { displayName: definition.name, shortDescription: "Verify original receipts.", allowImplicitInvocation: false },
    referencedFiles: [], warnings: [], reviewStatus: "published" }, now);
  // Close the only writer before copying so the copy includes committed WAL contents.
  const sourcePath = original.handle.paths.databasePath;
  original.close();
  const source = f.own(new DatabaseSync(sourcePath, { readOnly: true }));
  const before = snapshot(source.handle, preservedTables);
  const currentDefinitions = rows(source.handle, "skill_definitions");
  const currentMemoryRows = rows(source.handle, "memory_objects");
  assert.equal(currentDefinitions.length, 1);
  assert.equal(currentMemoryRows.length, 3);
  assertHealthy(source.handle);
  source.close();
  const upgradePath = resolveRuntimePaths(f.upgradeCwd).databasePath;
  await mkdir(dirname(upgradePath), { recursive: true });
  await copyFile(sourcePath, upgradePath);
  const historical = f.own(new DatabaseSync(upgradePath));
  historical.handle.exec("PRAGMA foreign_keys=ON");
  removeLearningOverlays(historical.handle);
  const oldMarkers = rows(historical.handle, "schema_migrations");
  assert.equal(Math.max(...oldMarkers.map(row => row.version)), 178);
  assert.deepEqual(oldMarkers.filter(row => row.version >= 177).map(row => [row.version, row.name]), [
    [177, "canonicalize_workspace_permission_settings"], [178, "canonicalize_pi_runner_ids"],
  ]);
  const canonical = JSON.parse(before.workspace_settings[0].settings_json);
  assert.equal(canonical.defaultAuthorizationMode, "smart");
  assert.equal(canonical.defaultWorkspaceAccessMode, "workspace_write");
  assert.equal(canonical.defaultPermissionMode, undefined);
  assert.equal(canonical.defaultPermissionPreset, undefined);
  assert.deepEqual(snapshot(historical.handle, preservedTables), before);
  const oldSchema = schema(historical.handle);
  assertHealthy(historical.handle);
  historical.close();

  const upgraded = f.own(createSqliteRunStore(f.upgradeCwd));
  const database = f.own(new DatabaseSync(upgradePath));
  const newSchema = schema(database.handle);
  for (const group of learningTableGroups) {
    for (const table of group) assert.ok(newSchema.some(row => row.type === "table" && row.name === table), table);
  }
  for (const table of searchTables) assert.ok(newSchema.some(row => row.type === "table" && row.name === table), table);
  for (const trigger of learningTriggers) assert.ok(newSchema.some(row => row.type === "trigger" && row.name === trigger), trigger);
  const stripOverlaySchema = rows => rows.filter(row =>
    !learningTables.has(row.tbl_name) && !learningTriggers.includes(row.name)
    && !channelTables.has(row.tbl_name)
    && !channelTriggers.has(row.name)
    && !(row.type === "trigger" && row.name.startsWith("trg_channel_session_"))
    && !(row.type === "table" && row.name === "ling_threads"));
  assert.deepEqual(stripOverlaySchema(newSchema), stripOverlaySchema(oldSchema));
  assert.deepEqual(database.handle.prepare("SELECT version, name FROM schema_migrations WHERE version BETWEEN 179 AND 181 ORDER BY version").all()
    .map(row => [row.version, row.name]), [
    [179, "channel_independent_sessions"], [180, "channel_session_topic_ownership"], [181, "channel_session_topic_notifications"],
  ]);
  assert.deepEqual(database.handle.prepare("SELECT version, name FROM schema_migrations WHERE version >=184 ORDER BY version").all()
    .map(row => [row.version, row.name]), learningMigrations);
  assert.deepEqual(rows(database.handle, "schema_migrations").filter(row => row.version <= 178), oldMarkers);
  assert.deepEqual(database.handle.prepare("SELECT version, count(*) AS n FROM schema_migrations GROUP BY version HAVING count(*) != 1").all(), []);
  assert.deepEqual(snapshot(database.handle, preservedTables), before);
  const history = rows(database.handle, "skill_definition_revisions");
  assert.equal(history.length, currentDefinitions.length, "one current baseline, never reconstructed historical edits");
  for (const entry of history) {
    const current = currentDefinitions.find(skill => skill.id === entry.skill_id);
    assert.ok(current);
    assert.equal(entry.revision, 0);
    assert.equal(entry.kind, "baseline");
    assert.equal(entry.actor, "migration");
    assert.equal(entry.after_json, current.definition_json);
    assert.equal(entry.before_json, null);
    assert.equal(entry.base_revision_id, null);
    assert.equal(entry.source_job_id, null);
    assert.equal(entry.source_candidate_id, null);
    assert.equal(entry.undo_of_revision_id, null);
    assert.equal(entry.validation_status, "not_run");
  }
  assert.deepEqual(rows(database.handle, "skill_definition_revision_notices"), []);
  assert.deepEqual(rows(database.handle, "learning_review_jobs"), []);
  assert.deepEqual(upgraded.handle.getLearningReviewPolicy(), { revision: 0, mode: "off" });
  assert.deepEqual(rows(database.handle, "memory_derivative_revisions").map(row =>
    [row.memory_id, row.revision, row.content_updated_at]), currentMemoryRows.map(row => [row.id, 1, row.updated_at]));
  assert.deepEqual(rows(database.handle, "memory_derivative_outbox").map(row => row.memory_id).sort(), currentMemoryRows.map(row => row.id).sort());
  assert.equal(database.handle.prepare("SELECT count(*) AS n FROM memory_search_fts_v1").get().n, currentMemoryRows.length);
  assertHealthy(database.handle);
  const firstMarkers = rows(database.handle, "schema_migrations");
  const firstOverlays = snapshot(database.handle, learningTables);
  database.close();
  upgraded.close();

  const reopened = f.own(createSqliteRunStore(f.upgradeCwd));
  const reopenedDatabase = f.own(new DatabaseSync(upgradePath));
  assert.deepEqual(schema(reopenedDatabase.handle), newSchema);
  assert.deepEqual(rows(reopenedDatabase.handle, "schema_migrations"), firstMarkers);
  assert.deepEqual(snapshot(reopenedDatabase.handle, preservedTables), before);
  assert.deepEqual(snapshot(reopenedDatabase.handle, learningTables), firstOverlays,
    "reopening must not invent revisions, notices, derivative changes or jobs");
  assert.deepEqual(reopened.handle.getLearningReviewPolicy(), { revision: 0, mode: "off" });
  assertHealthy(reopenedDatabase.handle);
});

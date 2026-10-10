import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RUN_EVALUATION_TASK_SCHEMA_OBJECTS } from "../dist/storage/sqlite/run-evaluation-task-migration.js";
import { RUN_EVALUATION_QA_SCHEMA_OBJECTS } from "../dist/storage/sqlite/run-evaluation-qa-migration.js";
import { removeQaOverlayForLegacyFixture } from "./support/evaluation-qa-migration-fixture.mjs";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";
import {
  applyDelegationMigration,
  DELEGATION_MIGRATION_NAME,
  DELEGATION_MIGRATION_VERSION,
} from "../dist/storage/sqlite/delegation-migration.js";

const now = "2026-10-09T00:00:00.000Z";
const later = "2026-10-09T00:01:00.000Z";
const terminalStates = ["succeeded", "failed", "cancelled", "lost"];
const edges = {
  planned: ["spawning", "cancelled", "failed"],
  spawning: ["running", "failed", "cancelled", "lost"],
  running: ["waiting", "interrupting", "succeeded", "failed", "cancelled", "lost"],
  waiting: ["running", "interrupting", "succeeded", "failed", "cancelled", "lost"],
  interrupting: ["interrupted", "failed", "lost"],
  interrupted: ["resuming", "cancelled", "failed", "lost"],
  resuming: ["running", "failed", "cancelled", "lost"],
  succeeded: [], failed: [], cancelled: [], lost: [],
};
const stepColumns = [
  "id", "schema_version", "root_run_id", "parent_run_id", "parent_attempt_id", "workflow_id",
  "workflow_step_id", "parent_delegation_step_id", "child_run_id", "spawn_call_id", "objective_artifact_id",
  "required", "state", "depth", "permission_snapshot_artifact_id", "tool_allowlist_artifact_id",
  "workspace_scope_artifact_id", "provider_policy_artifact_id", "token_budget", "cost_budget_micros",
  "wall_time_budget_ms", "idempotency_key", "revision", "failure_code", "created_at", "updated_at", "completed_at",
];
const messageColumns = [
  "id", "schema_version", "delegation_step_id", "direction", "kind", "body_artifact_id", "digest", "idempotency_key", "created_at",
];
const indexes = {
  idx_delegation_steps_root_created: ["root_run_id", "created_at", "id"],
  idx_delegation_steps_root_state_created: ["root_run_id", "state", "created_at", "id"],
  idx_delegation_steps_root_parent_created: ["root_run_id", "parent_delegation_step_id", "created_at", "id"],
  idx_delegation_steps_parent_created: ["parent_run_id", "created_at", "id"],
  idx_delegation_steps_parent_state_created: ["parent_run_id", "state", "created_at", "id"],
  idx_delegation_steps_parent_delegation_created: ["parent_delegation_step_id", "created_at", "id"],
  idx_delegation_steps_state_created: ["state", "created_at", "id"],
  idx_delegation_steps_child_run: ["child_run_id"],
  idx_delegation_steps_idempotency: ["idempotency_key"],
  idx_delegation_steps_spawn_call: ["parent_attempt_id", "spawn_call_id"],
  idx_delegation_messages_step_created: ["delegation_step_id", "created_at", "id"],
  idx_delegation_messages_idempotency: ["idempotency_key"],
};
const triggers = [
  "trg_delegation_steps_identity_immutable", "trg_delegation_steps_tree_edge", "trg_delegation_steps_child_binding",
  "trg_delegation_steps_transition", "trg_delegation_steps_no_replace", "trg_delegation_steps_no_delete",
  "trg_delegation_messages_no_replace", "trg_delegation_messages_no_update", "trg_delegation_messages_no_delete",
];

/** Owns real file databases and closes every handle before removing its exact temporary directory. */
async function fileFixture(t, label = "fixture") {
  const cwd = await mkdtemp(join(tmpdir(), `ling-delegation-${label}-`));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) close();
    await rm(cwd, { recursive: true, force: true });
  });
  const own = (handle) => {
    let closed = false;
    const close = () => { if (!closed) { handle.close(); closed = true; } };
    closers.push(close);
    return { handle, close };
  };
  return { cwd, own, open: (path = join(cwd, "fixture.sqlite")) => own(new DatabaseSync(path)) };
}

/** FK-only fixture deliberately does not claim full Run/Attempt/artifact domain authenticity. */
async function fixture(t, migrated = true) {
  const f = await fileFixture(t);
  const { handle: database } = f.open();
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(138,'add_channel_execution_proposal_cas','${now}'),
      (153,'create_host_office_local_directory_v2_certificate','${now}');
    CREATE TABLE run_sessions(id TEXT PRIMARY KEY,work_unit_id TEXT,parent_run_id TEXT);
    CREATE TABLE work_unit_attempts(id TEXT PRIMARY KEY,work_unit_id TEXT,fencing_token TEXT,status TEXT);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,run_id TEXT);
    CREATE TABLE channels(id TEXT PRIMARY KEY);
    CREATE TABLE channel_workflows(id TEXT PRIMARY KEY,channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE);
    CREATE TABLE channel_workflow_steps(id TEXT PRIMARY KEY,workflow_id TEXT REFERENCES channel_workflows(id) ON DELETE CASCADE);
    INSERT INTO run_sessions VALUES('root','work-root',NULL),('parent','work-parent','root'),
      ('child','work-child','parent'),('other-child','work-other','parent'),('grandchild','work-grandchild','child'),
      ('other-root','work-other-root',NULL);
    INSERT INTO work_unit_attempts VALUES('attempt','work-parent','old-fence','running'),
      ('other-attempt','work-other','other-fence','succeeded');
    INSERT INTO artifacts VALUES('objective','parent'),('permission','parent'),('tools','parent'),
      ('workspace','parent'),('provider','parent'),('body','child'),('other-artifact','other-root');
    INSERT INTO channels VALUES('channel');
    INSERT INTO channel_workflows VALUES('workflow','channel'),('other-workflow','channel');
    INSERT INTO channel_workflow_steps VALUES('workflow-step','workflow'),('other-workflow-step','other-workflow');
  `);
  const apply = (overrides = {}) => applyDelegationMigration({ ...migrationInput(database), ...overrides });
  if (migrated) assert.equal(apply(), true);
  const step = (overrides = {}, verb = "INSERT") => {
    const row = stepRow(overrides);
    insert(database, "delegation_steps", row, verb);
    return row;
  };
  const message = (overrides = {}, verb = "INSERT") => {
    const row = {
      id: "message", schema_version: 1, delegation_step_id: "step", direction: "parent_to_child",
      kind: "instruction", body_artifact_id: "body", digest: "a".repeat(64), idempotency_key: "message:key",
      created_at: now, ...overrides,
    };
    insert(database, "delegation_messages", row, verb);
    return row;
  };
  return { ...f, database, apply, step, message };
}

function stepRow(overrides = {}) {
  return {
    id: "step", schema_version: 1, root_run_id: "root", parent_run_id: "parent", parent_attempt_id: "attempt",
    workflow_id: null, workflow_step_id: null, parent_delegation_step_id: null, child_run_id: null,
    spawn_call_id: overrides.id ? `spawn-${overrides.id}` : "spawn",
    objective_artifact_id: "objective", required: 1, state: "planned", depth: 1,
    permission_snapshot_artifact_id: "permission", tool_allowlist_artifact_id: "tools",
    workspace_scope_artifact_id: "workspace", provider_policy_artifact_id: "provider",
    token_budget: 100, cost_budget_micros: 200, wall_time_budget_ms: 300, idempotency_key: "delegation:attempt:spawn",
    revision: 0, failure_code: null, created_at: now, updated_at: now, completed_at: null, ...overrides,
  };
}

function insert(database, table, row, verb = "INSERT") {
  database.prepare(`${verb} INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
    .run(...Object.values(row));
}

function updateStep(database, changes, id = "step") {
  database.prepare(`UPDATE delegation_steps SET ${Object.keys(changes).map((key) => `${key}=?`).join(",")} WHERE id=?`)
    .run(...Object.values(changes), id);
}

function migrationInput(database) {
  return {
    database,
    hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, now),
  };
}

function schema(database) {
  return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
}

/** Only removes the row-free overlay in this test's temporary full-schema database. */
function removeDelegationOverlay(database) {
  database.exec("DROP TABLE delegation_messages; DROP TABLE delegation_steps; DELETE FROM schema_migrations WHERE version=154");
}

test("delegation migration has the release schema 154 identity", () => {
  assert.equal(DELEGATION_MIGRATION_VERSION, 154);
  assert.equal(DELEGATION_MIGRATION_NAME, "create_delegation_tree_v1");
  assert.equal(typeof applyDelegationMigration, "function");
});

test("real schema153 upgrades through154/155/156/157/158/159 preserving historical SQL/markers/rows and reopens without synthetic children", async (t) => {
  const f = await fileFixture(t, "full-schema");
  const first = f.own(createSqliteRunStore(f.cwd));
  const channel = first.handle.createChannel({ name: "Legacy", boundPath: f.cwd }, now);
  const task = first.handle.createTask({ channelId: channel.id, title: "Legacy", prompt: "preserve history" }, now);
  const run = first.handle.createRun({ id: "legacy-run", cwd: f.cwd, taskId: task.id, providerName: "test",
    providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  first.handle.createArtifact({ id: "legacy-artifact", runId: run.id, type: "json", path: "legacy.json", createdAt: now });
  const provider = first.handle.createProviderPreset({ kind: "openai-compatible", displayName: "Legacy provider",
    providerId: "fixture", model: "legacy-model", api: "openai-completions", capabilities: ["chat"], authHeader: false }, now);
  first.handle.recordProviderCheckResult(provider.id, { ok: true, code: "fixture", message: "Historical check", checkedAt: now });
  first.close();
  const path = resolveRuntimePaths(f.cwd).databasePath;
  const old = f.open(path);
  // Remove only the new row-free sidecar before reconstructing schema153.
  removeQaOverlayForLegacyFixture(old.handle);
  for (const name of RUN_EVALUATION_TASK_SCHEMA_OBJECTS.filter(name => !name.startsWith("sqlite_autoindex_"))) {
    const object = old.handle.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    if (object?.type === "trigger" || object?.type === "index") old.handle.exec(`DROP ${object.type.toUpperCase()} ${name}`);
  }
  old.handle.exec("DROP TABLE run_evaluation_task_results; DROP TABLE run_evaluation_task_attempts; DROP TABLE run_evaluation_tasks; DELETE FROM schema_migrations WHERE version=158");
  removeDelegationOverlay(old.handle);
  // Reconstruct the actual historical schema, not latest-minus-delegation.
  old.handle.exec(`ALTER TABLE mcp_authority_revisions DROP COLUMN metadata_published_revision;
    ALTER TABLE mcp_authority_revisions DROP COLUMN metadata_request_revision;
    DELETE FROM schema_migrations WHERE version=155;
    DROP TRIGGER provider_check_insert;
    DROP TRIGGER provider_check_update;
    DROP TRIGGER provider_check_delete;
    DROP TRIGGER provider_check_secret_insert;
    DROP TRIGGER provider_check_secret_update;
    DROP TRIGGER provider_check_secret_delete;
    DROP TABLE provider_check_authorities;
    DELETE FROM schema_migrations WHERE version=156;
    DROP TRIGGER channel_team_incident_provenance_insert;
    DROP TRIGGER channel_team_incident_provenance_update;
    DROP TABLE channel_team_incident_provenance;
    DROP INDEX idx_availability_candidates_time;
    DELETE FROM schema_migrations WHERE version=157;`);
  assert.equal(old.handle.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, 153);
  const oldSchema = schema(old.handle);
  const oldMarkers = old.handle.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  const oldRun = old.handle.prepare("SELECT * FROM run_sessions WHERE id='legacy-run'").get();
  const oldArtifact = old.handle.prepare("SELECT * FROM artifacts WHERE id='legacy-artifact'").get();
  const oldAuthorityColumns = old.handle.prepare("PRAGMA table_info(mcp_authority_revisions)").all();
  const oldAuthorityRows = old.handle.prepare("SELECT * FROM mcp_authority_revisions ORDER BY server_id").all();
  const oldProvider = old.handle.prepare("SELECT * FROM provider_presets WHERE id=?").get(provider.id);
  old.close();
  const reopened = f.own(createSqliteRunStore(f.cwd));
  reopened.close();
  const upgraded = f.open(path);
  const database = upgraded.handle;
  // Exclude exactly the newly owned overlays. Historical provider table/trigger
  // SQL and rows, like all other schema153 history, remain byte-for-byte checked.
  const providerOverlay = new Set(["provider_check_authorities", "provider_check_insert", "provider_check_update",
    "provider_check_delete", "provider_check_secret_insert", "provider_check_secret_update", "provider_check_secret_delete",
    "sqlite_autoindex_provider_check_authorities_1"]);
  const incidentProvenanceOverlay = new Set(["channel_team_incident_provenance", "channel_team_incident_provenance_insert",
    "channel_team_incident_provenance_update", "sqlite_autoindex_channel_team_incident_provenance_1", "idx_availability_candidates_time"]);
  const evaluationTaskOverlay = new Set([...RUN_EVALUATION_TASK_SCHEMA_OBJECTS, ...RUN_EVALUATION_QA_SCHEMA_OBJECTS]);
  assert.deepEqual(schema(database).filter((row) => !row.tbl_name.startsWith("delegation_")
    && row.name !== "mcp_authority_revisions" && !providerOverlay.has(row.name) && !incidentProvenanceOverlay.has(row.name) && !evaluationTaskOverlay.has(row.name)),
  oldSchema.filter(row => row.name !== "mcp_authority_revisions"));
  const newAuthorityColumns = database.prepare("PRAGMA table_info(mcp_authority_revisions)").all();
  assert.deepEqual(newAuthorityColumns.slice(0, oldAuthorityColumns.length), oldAuthorityColumns);
  assert.deepEqual(newAuthorityColumns.slice(oldAuthorityColumns.length).map(column => column.name),
    ["metadata_request_revision", "metadata_published_revision"]);
  assert.deepEqual(database.prepare("SELECT server_id, server_revision, tools_revision FROM mcp_authority_revisions ORDER BY server_id").all(), oldAuthorityRows);
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version NOT IN (154,155,156,157,158,159) ORDER BY version").all(), oldMarkers);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=159").get().name, "create_run_evaluation_qa_v1");
  for (const table of ["run_evaluation_qa_namespace", "run_evaluation_qa_batches", "run_evaluation_qa_enrollments", "run_evaluation_qa_requests"]) assert.equal(database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=158").get().name, "create_run_evaluation_tasks_v1");
  for (const table of ["run_evaluation_tasks", "run_evaluation_task_attempts", "run_evaluation_task_results"]) assert.equal(database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=157").get().name,
    "add_availability_incident_provenance");
  assert.equal(database.prepare("SELECT count(*) AS n FROM channel_team_incident_provenance").get().n, 0);
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=156").get().name,
    "add_provider_check_publication_authority");
  assert.deepEqual(database.prepare("SELECT * FROM provider_presets WHERE id=?").get(provider.id), oldProvider);
  assert.deepEqual({ ...database.prepare("SELECT * FROM provider_check_authorities WHERE provider_id=?").get(provider.id) }, {
    provider_id: provider.id, config_revision: 1, request_revision: 0, published_revision: 0, request_source: null,
  });
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=155").get().name,
    "add_mcp_metadata_publication_revisions");
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=138").get().name, "add_channel_execution_proposal_cas");
  assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=154").get().name, DELEGATION_MIGRATION_NAME);
  assert.deepEqual(database.prepare("SELECT * FROM run_sessions WHERE id='legacy-run'").get(), oldRun);
  assert.deepEqual(database.prepare("SELECT * FROM artifacts WHERE id='legacy-artifact'").get(), oldArtifact);
  assert.equal(database.prepare("SELECT count(*) AS n FROM run_sessions").get().n, 1);
  assert.equal(database.prepare("SELECT count(*) AS n FROM delegation_steps").get().n, 0);
  assert.equal(database.prepare("SELECT count(*) AS n FROM delegation_messages").get().n, 0);
  const after = schema(database);
  assert.equal(applyDelegationMigration({ ...migrationInput(database), recordMigration: () => assert.fail("marker must not repeat") }), false);
  assert.deepEqual(schema(database), after);
  upgraded.close();
  const twice = f.own(createSqliteRunStore(f.cwd));
  twice.close();
  const final = f.open(path).handle;
  assert.deepEqual(schema(final), after);
  assert.equal(final.prepare("SELECT count(*) AS n FROM run_sessions").get().n, 1);
  assert.deepEqual(final.prepare("PRAGMA foreign_key_check").all(), []);
});

test("154 has a distinct V1 marker and preserves the historical 139 delegation marker across public startup", async (t) => {
  const f = await fileFixture(t, "legacy-marker");
  const first = f.own(createSqliteRunStore(f.cwd));
  const path = first.handle.paths.databasePath;
  first.close();
  const old = f.open(path);
  removeDelegationOverlay(old.handle);
  old.handle.prepare("INSERT INTO schema_migrations VALUES(139,'create_delegation_tree',?)").run(now);
  const before = old.handle.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  old.close();

  const reopened = f.own(createSqliteRunStore(f.cwd));
  reopened.close();
  const upgraded = f.open(path);
  assert.deepEqual(upgraded.handle.prepare("SELECT * FROM schema_migrations WHERE version<>154 ORDER BY version").all(), before);
  assert.equal(upgraded.handle.prepare("SELECT name FROM schema_migrations WHERE version=154").get().name, "create_delegation_tree_v1");
  assert.equal(upgraded.handle.prepare("SELECT count(*) AS n FROM delegation_steps").get().n, 0);
  assert.equal(upgraded.handle.prepare("SELECT count(*) AS n FROM delegation_messages").get().n, 0);
  assert.deepEqual(upgraded.handle.prepare("PRAGMA foreign_key_check").all(), []);
  upgraded.close();
  const twice = f.own(createSqliteRunStore(f.cwd));
  twice.close();
  const final = f.open(path).handle;
  assert.deepEqual(final.prepare("SELECT * FROM schema_migrations WHERE version<>154 ORDER BY version").all(), before);
  assert.equal(final.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=154").get().n, 1);
});

for (const fault of ["ddl", "marker", "marker-no-op", "commit"]) {
  test(`154 fully rolls back SQL, guards and marker on ${fault} failure`, async (t) => {
    const f = await fixture(t, false);
    const before = schema(f.database);
    let injected = false;
    const wrapped = {
      prepare: (sql) => f.database.prepare(sql),
      exec: (sql) => {
        if (!injected && ((fault === "ddl" && sql.includes("CREATE TABLE delegation_messages"))
          || (fault === "commit" && /^\s*COMMIT\b/iu.test(sql)))) {
          injected = true;
          throw new Error(`injected ${fault} failure`);
        }
        return f.database.exec(sql);
      },
    };
    assert.throws(() => f.apply({ database: wrapped, recordMigration: (version, name) => {
      if (fault === "marker") throw new Error("injected marker failure");
      if (fault !== "marker-no-op") migrationInput(f.database).recordMigration(version, name);
    } }), /failure|postcondition/u);
    assert.equal(f.database.isTransaction, false);
    assert.deepEqual(schema(f.database), before);
    assert.equal(f.database.prepare("SELECT 1 FROM schema_migrations WHERE version=154").get(), undefined);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM run_sessions").get().n, 6);
    assert.equal(f.apply(), true, "retry works after rollback");
  });
}

test("154 refuses nested BEGIN without rolling back or committing caller-owned work", async (t) => {
  const f = await fixture(t, false);
  const before = schema(f.database);
  f.database.exec("BEGIN IMMEDIATE; INSERT INTO artifacts VALUES('caller-owned','parent')");
  assert.throws(() => f.apply({ recordMigration: () => assert.fail("nested migration must not record") }), /transaction/u);
  assert.equal(f.database.isTransaction, true);
  assert.deepEqual(schema(f.database), before);
  assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
  f.database.exec("COMMIT");
  assert.equal(f.apply(), true);
  assert.equal(f.database.prepare("SELECT id FROM artifacts WHERE id='caller-owned'").get().id, "caller-owned");
});

for (const damage of ["wrong-version-name", "name-at-other-version", "bad-table", "legacy-marker-bad-table", "missing-check", "recorded-missing-table", "bad-index", "bad-trigger", "callback-mismatch"]) {
  test(`154 fails closed on ${damage} without changing existing history`, async (t) => {
    const f = await fixture(t, false);
    let overrides = {};
    if (damage === "wrong-version-name") f.database.prepare("INSERT INTO schema_migrations VALUES(154,'wrong-owner',?)").run(now);
    if (damage === "name-at-other-version") f.database.prepare("INSERT INTO schema_migrations VALUES(155,?,?)").run(DELEGATION_MIGRATION_NAME, now);
    if (damage === "legacy-marker-bad-table") {
      f.database.prepare("INSERT INTO schema_migrations VALUES(139,'create_delegation_tree',?)").run(now);
    }
    if (["bad-table", "legacy-marker-bad-table"].includes(damage)) f.database.exec("CREATE TABLE delegation_steps(id TEXT PRIMARY KEY)");
    if (["missing-check", "recorded-missing-table", "bad-index", "bad-trigger"].includes(damage)) {
      f.apply();
      if (damage === "missing-check") {
        const sql = f.database.prepare("SELECT sql FROM sqlite_master WHERE name='delegation_steps'").get().sql;
        const weakened = sql.replace(/CHECK\(schema_version = 1\)/u, "");
        assert.notEqual(weakened, sql, "only the schema_version CHECK is removed");
        f.database.exec("DROP TABLE delegation_messages; DROP TABLE delegation_steps");
        f.database.exec(weakened);
      }
      if (damage === "recorded-missing-table") f.database.exec("DROP TABLE delegation_messages");
      if (damage === "bad-index") f.database.exec("DROP INDEX idx_delegation_steps_child_run; CREATE INDEX idx_delegation_steps_child_run ON delegation_steps(child_run_id)");
      if (damage === "bad-trigger") f.database.exec("DROP TRIGGER trg_delegation_messages_no_update; CREATE TRIGGER trg_delegation_messages_no_update BEFORE UPDATE ON delegation_messages BEGIN SELECT 1; END");
    }
    if (damage === "callback-mismatch") overrides = { hasMigration: () => true };
    const before = schema(f.database);
    const markers = f.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    assert.throws(() => f.apply(overrides), /conflict|mismatch|missing/u);
    assert.equal(f.database.isTransaction, false);
    assert.deepEqual(schema(f.database), before);
    assert.deepEqual(f.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), markers);
  });
}

test("154 repairs only missing indexes/triggers with an existing valid marker, then is idempotent", async (t) => {
  const f = await fixture(t);
  f.step(); f.message();
  const before = schema(f.database);
  const row = f.database.prepare("SELECT * FROM delegation_steps").get();
  f.database.exec("DROP INDEX idx_delegation_steps_root_created; DROP TRIGGER trg_delegation_messages_no_update");
  assert.equal(f.apply({ recordMigration: () => assert.fail("repair must preserve marker") }), true);
  assert.deepEqual(schema(f.database), before);
  assert.deepEqual(f.database.prepare("SELECT * FROM delegation_steps").get(), row);
  assert.equal(f.apply(), false);
});

for (const corruption of ["tree-edge", "foreign-key"]) {
  test(`154 does not wash ${corruption} data corruption clean during missing-trigger repair`, async (t) => {
    const f = await fixture(t);
    f.database.exec("DROP TRIGGER trg_delegation_steps_tree_edge");
    if (corruption === "tree-edge") f.step({ depth: 2 });
    else {
      f.database.exec("PRAGMA foreign_keys=OFF");
      f.step({ root_run_id: "missing-root" });
      f.database.exec("PRAGMA foreign_keys=ON");
    }
    const before = schema(f.database);
    const row = f.database.prepare("SELECT * FROM delegation_steps").get();
    assert.throws(() => f.apply(), /data postcondition/u);
    assert.equal(f.database.isTransaction, false);
    assert.deepEqual(schema(f.database), before, "failed repair must roll back its new trigger");
    assert.deepEqual(f.database.prepare("SELECT * FROM delegation_steps").get(), row);
  });
}

test("154 exposes exact columns, RESTRICT FKs, unique/partial indexes and all durable triggers", async (t) => {
  const f = await fixture(t);
  const integerColumns = new Set(["schema_version", "required", "depth", "token_budget", "cost_budget_micros", "wall_time_budget_ms", "revision"]);
  const nullableStepColumns = new Set(["workflow_id", "workflow_step_id", "parent_delegation_step_id", "child_run_id",
    "token_budget", "cost_budget_micros", "wall_time_budget_ms", "failure_code", "completed_at"]);
  for (const [table, expected] of [["delegation_steps", stepColumns], ["delegation_messages", messageColumns]]) {
    const columns = f.database.prepare(`PRAGMA table_xinfo(${table})`).all();
    assert.deepEqual(columns.map((row) => row.name), expected);
    for (const [position, column] of columns.entries()) {
      assert.deepEqual([column.cid, column.type, column.notnull, column.pk, column.dflt_value, column.hidden],
        [position, integerColumns.has(column.name) ? "INTEGER" : "TEXT",
          table === "delegation_steps" && nullableStepColumns.has(column.name) ? 0 : 1,
          column.name === "id" ? 1 : 0, null, 0], `${table}.${column.name}`);
    }
  }
  const expectedStepFks = [
    ["root_run_id", "run_sessions"], ["parent_run_id", "run_sessions"], ["child_run_id", "run_sessions"],
    ["parent_attempt_id", "work_unit_attempts"], ["workflow_id", "channel_workflows"],
    ["workflow_step_id", "channel_workflow_steps"], ["parent_delegation_step_id", "delegation_steps"],
    ...["objective_artifact_id", "permission_snapshot_artifact_id", "tool_allowlist_artifact_id", "workspace_scope_artifact_id", "provider_policy_artifact_id"].map((column) => [column, "artifacts"]),
  ];
  for (const [table, expected] of [["delegation_steps", expectedStepFks], ["delegation_messages", [["delegation_step_id", "delegation_steps"], ["body_artifact_id", "artifacts"]]]]) {
    const keys = f.database.prepare(`PRAGMA foreign_key_list(${table})`).all();
    assert.deepEqual(keys.map((key) => [key.from, key.table]).sort(), expected.sort());
    for (const key of keys) assert.deepEqual([key.to, key.on_update, key.on_delete, key.match, key.seq], ["id", "NO ACTION", "RESTRICT", "NONE", 0]);
  }
  const indexRows = ["delegation_steps", "delegation_messages"].flatMap((table) => f.database.prepare(`PRAGMA index_list(${table})`).all()).filter((row) => row.origin === "c");
  assert.deepEqual(indexRows.map((row) => row.name).sort(), Object.keys(indexes).sort());
  for (const row of indexRows) {
    assert.deepEqual(f.database.prepare(`PRAGMA index_info(${row.name})`).all().map((key) => key.name), indexes[row.name]);
    assert.equal(row.unique, row.name.endsWith("idempotency") || row.name.endsWith("child_run")
      || row.name.endsWith("spawn_call") ? 1 : 0);
    assert.equal(row.partial, row.name.endsWith("child_run") ? 1 : 0);
  }
  assert.match(f.database.prepare("SELECT sql FROM sqlite_master WHERE name='idx_delegation_steps_child_run'").get().sql, /WHERE child_run_id IS NOT NULL/u);
  assert.deepEqual(f.database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('delegation_steps','delegation_messages')").all().map((row) => row.name).sort(), triggers.sort());
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("planned→spawning→running permits exactly one child binding and interrupt/resume/terminal progression", async (t) => {
  const f = await fixture(t); f.step();
  updateStep(f.database, { state: "spawning", revision: 1, updated_at: later });
  updateStep(f.database, { state: "running", child_run_id: "child", revision: 2 });
  for (const [index, state] of ["waiting", "running", "interrupting", "interrupted", "resuming", "running", "succeeded"].entries()) {
    updateStep(f.database, { state, revision: index + 3, completed_at: state === "succeeded" ? later : null });
  }
  assert.equal(f.database.prepare("SELECT state FROM delegation_steps").get().state, "succeeded");
  assert.throws(() => updateStep(f.database, { revision: 10 }), /transition/u);
  assert.throws(() => f.database.exec("DELETE FROM delegation_steps"), /durable/u);
});

test("every declared state edge succeeds and every undeclared different-state edge is rejected", async (t) => {
  const f = await fixture(t);
  let sequence = 0;
  for (const from of Object.keys(edges)) for (const to of Object.keys(edges)) {
    if (from === to) continue;
    const id = `edge-${sequence++}`;
    const child = `child-${id}`;
    f.database.prepare("INSERT INTO run_sessions VALUES(?,?,?)").run(child, "work-fixture", "parent");
    const initiallyBound = !["planned", "spawning"].includes(from);
    f.step({ id, idempotency_key: id, state: from, child_run_id: initiallyBound ? child : null,
      completed_at: terminalStates.includes(from) ? now : null });
    const changes = { state: to, revision: 1, child_run_id: initiallyBound || to === "running" ? child : null,
      completed_at: terminalStates.includes(to) ? later : null };
    if (edges[from].includes(to)) {
      updateStep(f.database, changes, id);
      assert.equal(f.database.prepare("SELECT state FROM delegation_steps WHERE id=?").get(id).state, to);
    } else assert.throws(() => updateStep(f.database, changes, id), /transition|bound|CHECK/u, `${from}→${to}`);
  }
});

test("revision increments are strict but SQL is not the future Attempt-fenced compare-and-swap Store", async (t) => {
  const f = await fixture(t); f.step();
  for (const revision of [0, 2, -1, 0.5, 9007199254740992]) assert.throws(() => updateStep(f.database, { state: "spawning", revision }), /transition|CHECK/u);
  updateStep(f.database, { state: "spawning", revision: 1 });
  assert.throws(() => updateStep(f.database, { state: "running", child_run_id: "child", revision: 1 }), /transition|bound/u);
  updateStep(f.database, { state: "running", child_run_id: "child", revision: 2 });
  for (const changes of [{ child_run_id: "other-child" }, { child_run_id: null }]) {
    assert.throws(() => updateStep(f.database, { ...changes, revision: 3 }), /bound/u);
  }
  f.step({ id: "other-step", idempotency_key: "other-key", state: "spawning" });
  assert.throws(() => updateStep(f.database, { state: "running", child_run_id: "child", revision: 1 }, "other-step"), /bound/u);
  f.step({ id: "planned-other", idempotency_key: "planned-other" });
  assert.throws(() => updateStep(f.database, { state: "spawning", child_run_id: "other-child", revision: 1 }, "planned-other"), /bound/u);
});

test("lineage, idempotency, policy artifacts and budget identities are immutable", async (t) => {
  const f = await fixture(t); f.step({ workflow_id: "workflow", workflow_step_id: "workflow-step" });
  const changes = {
    id: "changed", schema_version: 2, root_run_id: "other-root", parent_run_id: "child", parent_attempt_id: "other-attempt",
    workflow_id: "other-workflow", workflow_step_id: "other-workflow-step", parent_delegation_step_id: "changed",
    spawn_call_id: "changed", objective_artifact_id: "other-artifact", required: 0, depth: 2,
    permission_snapshot_artifact_id: "other-artifact", tool_allowlist_artifact_id: "other-artifact",
    workspace_scope_artifact_id: "other-artifact", provider_policy_artifact_id: "other-artifact",
    token_budget: 101, cost_budget_micros: 201, wall_time_budget_ms: 301, idempotency_key: "changed", created_at: later,
  };
  const before = f.database.prepare("SELECT * FROM delegation_steps").get();
  for (const [column, value] of Object.entries(changes)) assert.throws(() => updateStep(f.database, { [column]: value, revision: 1 }), /immutable/u, column);
  assert.deepEqual(f.database.prepare("SELECT * FROM delegation_steps").get(), before);
});

test("one parent Attempt spawn call cannot become two delegations under different caller keys", async (t) => {
  const f = await fixture(t); f.step();
  const before = f.database.prepare("SELECT * FROM delegation_steps").all();
  for (const verb of ["INSERT", "INSERT OR REPLACE"]) {
    assert.throws(() => f.step({ id: "duplicate-call", idempotency_key: "different-caller-key", spawn_call_id: "spawn" }, verb),
      /spawn|replaced|UNIQUE/u);
    assert.deepEqual(f.database.prepare("SELECT * FROM delegation_steps").all(), before);
  }
  f.step({ id: "different-attempt", idempotency_key: "different-attempt-key",
    parent_attempt_id: "other-attempt", spawn_call_id: "spawn" });
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM delegation_steps").get().n, 2,
    "the same call ID in a different Attempt is a distinct structural identity");
});

test("tree edges reject self references, wrong roots/parents and depth gaps; valid existing-parent edges extend depth", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ parent_delegation_step_id: "step" }, { state: "running", child_run_id: "parent" },
    { state: "running", child_run_id: "root" }, { depth: 2 }, { depth: 0 }, { depth: 1.5 }, { depth: 9007199254740992 }]) {
    assert.throws(() => f.step(patch), /CHECK|tree edge/u);
  }
  f.step({ state: "running", child_run_id: "child" });
  const nested = { id: "nested", idempotency_key: "nested", parent_delegation_step_id: "step", parent_run_id: "child", depth: 2 };
  for (const patch of [{ depth: 1 }, { depth: 3 }, { root_run_id: "other-root" }, { parent_run_id: "parent" }, { parent_delegation_step_id: "missing" }]) {
    assert.throws(() => f.step({ ...nested, ...patch }), /tree edge/u);
  }
  f.step({ ...nested, state: "running", child_run_id: "grandchild" });
  assert.throws(() => updateStep(f.database, { parent_delegation_step_id: "nested", depth: 3, revision: 1 }), /immutable/u);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("SQL validates identity existence, not Attempt ownership/current fence, capability subsets or artifact content", async (t) => {
  const f = await fixture(t);
  const row = f.step({ parent_attempt_id: "other-attempt", workflow_id: "workflow", workflow_step_id: "other-workflow-step",
    permission_snapshot_artifact_id: "other-artifact" });
  assert.equal(row.parent_attempt_id, "other-attempt");
  for (const column of ["root_run_id", "parent_run_id", "parent_attempt_id", "workflow_id", "workflow_step_id",
    "objective_artifact_id", "permission_snapshot_artifact_id", "tool_allowlist_artifact_id", "workspace_scope_artifact_id", "provider_policy_artifact_id"]) {
    assert.throws(() => f.step({ id: "missing-fk", idempotency_key: "missing-fk", workflow_id: "workflow", [column]: "missing" }), /FOREIGN KEY/u, column);
  }
  assert.throws(() => f.step({ id: "missing-child", idempotency_key: "missing-child", state: "running", child_run_id: "missing" }), /FOREIGN KEY/u);
});

for (const target of ["channel", "workflow", "workflow-step"]) {
  test(`referenced ${target} cleanup is refused atomically and preserves workflow/step/delegation history`, async (t) => {
    const f = await fixture(t); f.step({ workflow_id: "workflow", workflow_step_id: "workflow-step" });
    const tables = ["channels", "channel_workflows", "channel_workflow_steps", "delegation_steps"];
    const before = tables.map((table) => f.database.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const table = target === "channel" ? "channels" : target === "workflow" ? "channel_workflows" : "channel_workflow_steps";
    assert.throws(() => f.database.prepare(`DELETE FROM ${table} WHERE id=?`).run(target), /FOREIGN KEY/u);
    assert.deepEqual(tables.map((name) => f.database.prepare(`SELECT * FROM ${name} ORDER BY id`).all()), before);
  });
}

test("safe integer budget/revision, required booleans, terminal completion and failure enums are enforced", async (t) => {
  const f = await fixture(t);
  for (const column of ["token_budget", "cost_budget_micros", "wall_time_budget_ms", "revision"]) {
    for (const value of [-1, 0.5, 9007199254740992, "not-an-integer"]) assert.throws(() => f.step({ [column]: value }), /CHECK/u, `${column}=${value}`);
  }
  for (const value of [-1, 2, 0.5, "yes"]) assert.throws(() => f.step({ required: value }), /CHECK/u);
  for (const state of terminalStates) {
    assert.throws(() => f.step({ state, child_run_id: state === "succeeded" ? "child" : null }), /CHECK/u);
  }
  for (const patch of [{ completed_at: now }, { state: "succeeded", child_run_id: "child", completed_at: now, failure_code: "delegation.child_lost" },
    { failure_code: "unknown" }, { state: "unknown" }, { schema_version: 2 }, { workflow_step_id: "workflow-step" }]) assert.throws(() => f.step(patch), /CHECK/u);
  f.step({ token_budget: Number.MAX_SAFE_INTEGER, cost_budget_micros: 0, wall_time_budget_ms: null, revision: Number.MAX_SAFE_INTEGER, required: 0 });
  f.step({ id: "nullable-budgets", idempotency_key: "nullable-budgets", token_budget: null, cost_budget_micros: null, wall_time_budget_ms: null });
  for (const [index, failure] of ["delegation.capability_escalation", "delegation.budget_exhausted", "delegation.depth_exceeded", "delegation.cycle_detected", "delegation.child_lost", "delegation.required_child_failed"].entries()) {
    f.step({ id: `failure-${index}`, idempotency_key: `failure-${index}`, state: "failed", completed_at: now, failure_code: failure });
  }
});

for (const recursive of [0, 1]) {
  test(`step INSERT OR REPLACE cannot evict id/idempotency/child identities with recursive_triggers=${recursive}`, async (t) => {
    const f = await fixture(t); f.database.exec(`PRAGMA recursive_triggers=${recursive}`);
    f.step({ state: "running", child_run_id: "child" });
    const before = f.database.prepare("SELECT * FROM delegation_steps").all();
    for (const patch of [{ idempotency_key: "other", child_run_id: "other-child" },
      { id: "other", child_run_id: "other-child" }, { id: "other", idempotency_key: "other", child_run_id: "child" },
      { id: "other", idempotency_key: "other", child_run_id: "other-child", spawn_call_id: "spawn" }]) {
      assert.throws(() => f.step({ state: "running", child_run_id: "child", ...patch }, "INSERT OR REPLACE"), /replaced/u);
    }
    assert.deepEqual(f.database.prepare("SELECT * FROM delegation_steps").all(), before);
    f.step({ id: "spawning-step", idempotency_key: "spawning-step", state: "spawning" });
    const twoSteps = f.database.prepare("SELECT * FROM delegation_steps ORDER BY id").all();
    assert.throws(() => f.database.exec("UPDATE OR REPLACE delegation_steps SET state='running',child_run_id='child',revision=1 WHERE id='spawning-step'"), /bound/u);
    assert.deepEqual(f.database.prepare("SELECT * FROM delegation_steps ORDER BY id").all(), twoSteps,
      "UPDATE OR REPLACE must not evict the previously bound child owner");
  });
  test(`messages remain append-only across UPDATE/DELETE/REPLACE with recursive_triggers=${recursive}`, async (t) => {
    const f = await fixture(t); f.database.exec(`PRAGMA recursive_triggers=${recursive}`); f.step(); f.message();
    const before = f.database.prepare("SELECT * FROM delegation_messages").all();
    for (const sql of ["UPDATE delegation_messages SET kind='control'", "UPDATE OR REPLACE delegation_messages SET id='changed'", "DELETE FROM delegation_messages"]) {
      assert.throws(() => f.database.exec(sql), /append-only/u);
    }
    assert.throws(() => f.message({}, "INSERT OR REPLACE"), /append-only/u);
    assert.throws(() => f.message({ id: "other" }, "INSERT OR REPLACE"), /append-only/u);
    assert.deepEqual(f.database.prepare("SELECT * FROM delegation_messages").all(), before);
  });
}

test("message direction/kind/digest/FKs are checked while immutable history may append after terminal", async (t) => {
  const f = await fixture(t); f.step({ state: "failed", completed_at: now });
  for (const direction of ["parent_to_child", "child_to_parent"]) for (const kind of ["instruction", "progress", "result", "control"]) {
    f.message({ id: `${direction}:${kind}`, idempotency_key: `${direction}:${kind}`, direction, kind });
  }
  for (const patch of [{ direction: "unknown" }, { kind: "unknown" }, { schema_version: 2 }, { digest: "a".repeat(63) },
    { digest: "a".repeat(65) }, { digest: "A".repeat(64) }, { digest: "g".repeat(64) }, { digest: `${"a".repeat(63)}\0` }]) {
    assert.throws(() => f.message(patch), /CHECK/u);
  }
  for (const patch of [{ delegation_step_id: "missing" }, { body_artifact_id: "missing" }]) assert.throws(() => f.message(patch), /FOREIGN KEY/u);
  assert.throws(() => f.database.exec("DELETE FROM artifacts WHERE id='body'"), /FOREIGN KEY/u);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM delegation_messages").get().n, 8);
  assert.deepEqual(f.database.prepare("PRAGMA foreign_key_check").all(), []);
});

// Deliberate coverage boundary: these are migration/SQLite tests, not Delegation Store tests.
// Full ancestor-Run cycle detection, artifact payload authenticity, capability/provider/sandbox
// subsets, root-budget reservation, live Attempt-fence + expectedRevision CAS, atomic child-Run
// creation, authenticated human control, and runtime execution must be tested in the future Store.

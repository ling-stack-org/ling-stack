import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { createSqliteWorkflowIntegrationCoordinatorStore } from "../dist/index.js";
import { applyWorkflowMergeApprovalMigration, WORKFLOW_MERGE_APPROVAL_MIGRATION_VERSION }
  from "../dist/storage/sqlite/workflow-merge-approval-migration.js";
import { workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";
import { now, resultTables, workflowIsolationResultsFixture } from "./support/workflow-isolation-results-fixture.mjs";

const table = "workflow_merge_approval_requests";
const migrationName = "workflow_merge_approval_basis";
const triggers = ["trg_workflow_merge_approval_immutable", "trg_workflow_merge_approval_retained"];
const evidenceTables = [...resultTables, "workflow_integration_effect_links", "workflow_integration_receipt_links",
  "artifacts", "harness_artifact_pins", "harness_artifact_pin_events"];
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const rows = (db, name) => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
const snapshot = db => ({ schema: schema(db), markers: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
  requests: db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? rows(db, table) : [] });
const evidenceSnapshot = db => Object.fromEntries(evidenceTables.map(name => [name, rows(db, name)]));
const has = db => version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-02T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowMergeApprovalMigration({ database: db,
  hasMigration: has(db), recordMigration: record(db), ...extra });
const value = result => {
  assert.ok(["created", "updated", "duplicate"].includes(result.status), JSON.stringify(result));
  return result.value;
};

async function predecessor(t, { terminal = false } = {}) {
  const f = terminal ? await workflowIsolationResultsFixture(t)
    : await workflowIsolationFixture(t, { create: false, pin: false });
  const db = f.store.database;
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  db.exec(`DROP TABLE ${table}`);
  db.prepare("DELETE FROM schema_migrations WHERE version=207").run();
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=206").get().name,
    "workflow_integration_coordinator_evidence");
  assert.equal(schema(db).some(row => row.tbl_name === table), false);
  assert.equal(has(db)(207), false);
  return f;
}

// Populate206 through the real coordinator APIs, not invented evidence-link rows.
function seedCoordinatorEvidence(f) {
  f.resultIntent(); f.resultReceipt();
  f.store.updateChannelWorkflowStep(f.plan.workflowStepId, { status: "succeeded" }, now());
  const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(f.store);
  const authority = coordinator.assertAuthority({ roundId: f.roundId, generation: f.plan.generation, now: now() });
  assert.equal(authority.status, "authorized", JSON.stringify(authority));
  value(coordinator.advanceRound({ roundId: f.roundId, generation: f.plan.generation,
    expectedRevision: f.round().revision, authorityDigest: authority.authorityDigest,
    from: f.round().phase, to: "collecting", receiptIds: [], now: now() }));
  const after = f.gitIdentity(true, f.inputs.integration), before = { ...after, exists: false, headCommit: null };
  delete before.tree; delete before.cleanStateDigest;
  const scope = { roundId: f.roundId, stepId: "integration", generation: f.plan.generation,
    worktreeId: f.inputs.integration.worktreeId, executionRoot: f.inputs.integration.executionRoot,
    branchRef: f.inputs.integration.branchRef, baseCommit: f.inputs.baseCommit,
    worktreeRoot: dirname(f.inputs.integration.executionRoot), repository: f.scope.repository };
  const receipt = { worktreeId: scope.worktreeId, executionRoot: scope.executionRoot, branchRef: scope.branchRef,
    baseCommit: f.inputs.baseCommit, commonDir: f.inputs.repositoryIdentity.commonDir, rootDevice: "1", rootInode: "31" };
  const payload = { schemaVersion: 1, kind: "workflow_integration_coordinator_effect", roundId: f.roundId,
    generation: f.plan.generation, authorityDigest: authority.authorityDigest, effectKey: "worktree:create",
    effectKind: "integration_create", before, after, effect: { kind: "workflow_integration_worktree", scope } };
  const artifact = f.sealed("migration206-effect", payload);
  const intent = value(coordinator.recordIntent({ roundId: f.roundId, generation: f.plan.generation,
    expectedRevision: f.round().revision, authorityDigest: authority.authorityDigest, effectKey: payload.effectKey,
    kind: payload.effectKind, before, after, payloadArtifactId: artifact.id, now: now() }));
  const observation = f.sealed("migration206-receipt", { schemaVersion: 1,
    kind: "workflow_integration_coordinator_receipt", intentId: intent.intentId, effectKey: intent.effectKey,
    outcome: "confirmed", observed: after, evidence: { scope, receipt } });
  value(coordinator.recordReceipt({ intentId: intent.intentId, expectedRevision: f.round().revision,
    authorityDigest: authority.authorityDigest, outcome: "confirmed", observed: after,
    artifactId: observation.id, now: now() }));
  return authority.authorityDigest;
}

function rejectUnchanged(f, pattern, extra = {}, { reopen = false } = {}) {
  const db = f.store.database, before = snapshot(db), data = f.snapshotIsolation();
  assert.throws(() => migrate(db, extra), pattern);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(f.snapshotIsolation(), data);
  if (reopen) {
    assert.throws(() => f.reopenIsolation(), pattern);
    assert.deepEqual(snapshot(f.peer.database), before);
    assert.deepEqual(f.snapshotIsolation(), data);
  }
}

test("fresh207 installs the independent request table, exact keys and retained triggers; repeat and reopen are idempotent", async t => {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  assert.equal(WORKFLOW_MERGE_APPROVAL_MIGRATION_VERSION, 207);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=207 OR name=?")
    .all(migrationName).map(row => ({ ...row })), [{ version: 207, name: migrationName }]);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name")
    .all(table).map(row => row.name), triggers);
  const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  assert.ok(keys.some(row => row.table === "approval_requests" && row.from === "approval_id" && row.to === "id"));
  const roundKeys = keys.filter(row => row.table === "workflow_integration_generations").sort((a, b) => a.seq - b.seq);
  assert.deepEqual(roundKeys.map(row => [row.from, row.to]), [["round_id", "round_id"], ["generation", "generation"]]);
  assert.equal(roundKeys[0].id, roundKeys[1].id, "round and generation must be one composite foreign key");
  const uniqueKeys = db.prepare(`PRAGMA index_list(${table})`).all().filter(row => row.unique === 1)
    .map(row => db.prepare(`PRAGMA index_info('${row.name}')`).all().map(column => column.name));
  for (const columns of [["request_id"], ["approval_id"], ["round_id", "generation"]])
    assert.ok(uniqueKeys.some(key => JSON.stringify(key) === JSON.stringify(columns)), JSON.stringify(columns));
  const before = snapshot(db), data = f.snapshotIsolation();
  migrate(db); migrate(db);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(f.snapshotIsolation(), data);
  f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), before);
  assert.deepEqual(f.snapshotIsolation(), data);
});

test("actual206 upgrade preserves terminal results, sealed artifacts and populated coordinator intent/receipt links", async t => {
  const f = await predecessor(t, { terminal: true }), db = f.store.database;
  const authorityDigest = seedCoordinatorEvidence(f);
  for (const name of ["workflow_integration_effect_links", "workflow_integration_receipt_links", ...resultTables])
    assert.ok(rows(db, name).length > 0, `${name} must contain real predecessor data`);
  const before = snapshot(db), data = f.snapshotIsolation(), evidence = evidenceSnapshot(db);
  migrate(db);
  assert.deepEqual(schema(db).filter(row => row.tbl_name !== table), before.schema);
  assert.deepEqual(snapshot(db).markers.filter(row => row.version !== 207), before.markers);
  assert.deepEqual(f.snapshotIsolation(), data);
  assert.deepEqual(evidenceSnapshot(db), evidence);
  const installed = snapshot(db);
  migrate(db); f.reopenIsolation();
  assert.deepEqual(snapshot(f.store.database), installed);
  assert.deepEqual(f.snapshotIsolation(), data);
  assert.deepEqual(evidenceSnapshot(f.store.database), evidence);
  const authority = createSqliteWorkflowIntegrationCoordinatorStore(f.store)
    .assertAuthority({ roundId: f.roundId, generation: f.plan.generation, now: now() });
  assert.equal(authority.status, "authorized", JSON.stringify(authority));
  assert.equal(authority.authorityDigest, authorityDigest);
});

const rollbackFailures = {
  "throw-before-marker": /migration207-before-marker/,
  "throw-after-marker": /migration207-after-marker/,
  "missing-marker": /migration_postcondition/,
  "wrong-marker": /migration_marker_conflict/,
  "missing-trigger-after-marker": /migration_schema_missing/,
  "foreign-index-after-marker": /migration_unexpected_object/,
  "deferred-commit-fk": /FOREIGN KEY/,
};
for (const [failure, pattern] of Object.entries(rollbackFailures)) {
  test(`migration207 rolls back all DDL, marker and data on ${failure}`, async t => {
    const f = await predecessor(t), db = f.store.database;
    f.create(); f.persistPin();
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration207_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec(`CREATE TRIGGER migration207_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=207
        BEGIN INSERT INTO migration207_fault VALUES('missing-workflow'); END`);
    }
    const before = snapshot(db), data = f.snapshotIsolation();
    let reachedMarker = false;
    assert.throws(() => migrate(db, { recordMigration: (version, name) => {
      reachedMarker = true;
      assert.equal(version, 207); assert.equal(name, migrationName);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table));
      if (failure === "throw-before-marker") throw new Error("migration207-before-marker");
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign207" : name);
      if (failure === "throw-after-marker") throw new Error("migration207-after-marker");
      if (failure === "missing-trigger-after-marker") db.exec(`DROP TRIGGER ${triggers[0]}`);
      if (failure === "foreign-index-after-marker") db.exec(`CREATE INDEX foreign207_index ON ${table}(authority_digest)`);
    } }), pattern);
    assert.equal(reachedMarker, true, "failure must occur after the new DDL was executed");
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(f.snapshotIsolation(), data);
    if (failure === "deferred-commit-fk") {
      assert.deepEqual(rows(db, "migration207_fault"), []);
      db.exec("DROP TRIGGER migration207_fault_on_marker");
    }
    migrate(db);
    assert.equal(has(db)(207), true, "a fully rolled-back attempt remains safely retryable");
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
  });
}

for (const finish of ["COMMIT", "ROLLBACK"]) {
  test(`migration207 cannot adopt, commit or roll back a caller transaction before its ${finish}`, async t => {
    const f = await predecessor(t), db = f.store.database;
    const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
      const before = snapshot(db);
      assert.throws(() => migrate(db), /transaction/i);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(snapshot(db), before);
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
      assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original, "caller data must still be uncommitted");
      db.exec(finish);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    assert.equal(db.isTransaction, false);
    assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, finish === "COMMIT" ? "caller-wip" : original);
    assert.equal(has(db)(207), false);
    migrate(db);
    assert.equal(has(db)(207), true);
  });
}

test("idempotent207 inspection does not commit or swallow an existing caller transaction", async t => {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    const before = snapshot(db);
    migrate(db);
    assert.equal(db.isTransaction, true);
    assert.deepEqual(snapshot(db), before);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
    assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original);
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
  assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, original);
});

for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-moved",
  "marker-duplicate", "callback-denies-marker", "callback-invents-marker"]) {
  test(`migration207 rejects ${corruption} without rewriting persisted state`, async t => {
    const f = corruption === "callback-invents-marker" ? await predecessor(t)
      : await workflowIsolationFixture(t, { create: false, pin: false });
    const db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=206").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign206' WHERE version=206").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign207' WHERE version=207").run();
    if (corruption === "marker-moved") db.prepare("UPDATE schema_migrations SET version=999207 WHERE version=207").run();
    if (corruption === "marker-duplicate") record(db)(999207, migrationName);
    const extra = corruption === "callback-denies-marker" ? { hasMigration: () => false }
      : corruption === "callback-invents-marker" ? { hasMigration: () => true } : {};
    rejectUnchanged(f, /migration_predecessor_missing|migration_marker_conflict/, extra,
      { reopen: ["marker-renamed", "marker-moved", "marker-duplicate"].includes(corruption) });
  });
}

for (const name of [table, ...triggers]) {
  test(`marker207 cannot hide missing ${name}, including constructor reopen`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    db.exec(`DROP ${type.toUpperCase()} ${name}`);
    rejectUnchanged(f, /migration_schema_missing/, {}, { reopen: true });
  });
}

const schemaCorruptions = {
  "generation-check": sql => sql.replace(" CHECK(typeof(generation)='integer' AND generation>0)", ""),
  "json-check": sql => sql.replace(" CHECK(json_valid(payload_json))", ""),
  "approval-foreign-key": sql => sql.replace(" REFERENCES approval_requests(id)", ""),
  "round-generation-foreign-key": sql => sql.replace(
    "    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),\n", ""),
  "round-generation-unique": sql => sql.replace(",\n    UNIQUE(round_id,generation)", ""),
  "approval-unique": sql => sql.replace("approval_id TEXT NOT NULL UNIQUE", "approval_id TEXT NOT NULL"),
  "unexpected-column": sql => sql.replace("created_at TEXT NOT NULL,", "created_at TEXT NOT NULL, foreign_column TEXT,"),
};
for (const [corruption, change] of Object.entries(schemaCorruptions)) {
  test(`migration207 rejects damaged ${corruption} instead of repairing the request schema`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql;
    const changed = change(original);
    assert.notEqual(changed, original, "the corruption must actually change the schema");
    const retainedTriggers = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table);
    db.exec(`DROP TABLE ${table}`); db.exec(changed);
    for (const trigger of retainedTriggers) db.exec(trigger.sql);
    rejectUnchanged(f, /migration_schema_conflict/, {}, { reopen: true });
  });
}

test("migration207 rejects a view occupying the request-table name", async t => {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  db.exec(`DROP TABLE ${table}`);
  db.exec(`CREATE VIEW ${table} AS SELECT 'foreign-request' AS request_id`);
  rejectUnchanged(f, /migration_schema_conflict/, {}, { reopen: true });
});

for (const [name, operation] of [[triggers[0], "UPDATE"], [triggers[1], "DELETE"]]) {
  test(`migration207 rejects a no-op replacement for ${name}`, async t => {
    const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
    db.exec(`DROP TRIGGER ${name}`);
    db.exec(`CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT 1; END`);
    rejectUnchanged(f, /migration_schema_conflict/, {}, { reopen: true });
  });
}

for (const marked of [true, false]) {
  for (const object of ["index", "trigger"]) {
    test(`migration207 rejects an unknown ${object} on ${marked ? "marked" : "unmarked"} request schema`, async t => {
      const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
      if (!marked) db.prepare("DELETE FROM schema_migrations WHERE version=207").run();
      if (object === "index") db.exec(`CREATE INDEX foreign207_index ON ${table}(authority_digest)`);
      else db.exec(`CREATE TRIGGER foreign207_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1; END`);
      rejectUnchanged(f, /migration_unexpected_object/, {}, { reopen: true });
    });
  }
}

test("migration207 fails closed on orphan request rows even when schema and marker are exact", async t => {
  const f = await workflowIsolationFixture(t, { create: false, pin: false }), db = f.store.database;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 0);
    db.prepare(`INSERT INTO ${table}(request_id,round_id,generation,approval_id,authority_digest,basis_fingerprint,
      payload_json,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("orphan-request", "missing-round", 1, "missing-approval", "authority", "basis", "{}", "request", f.at(0));
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.ok(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length > 0);
  rejectUnchanged(f, /migration_fk_conflict/, {}, { reopen: true });
});

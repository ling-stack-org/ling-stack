import assert from "node:assert/strict";
import test from "node:test";
import { dirname } from "node:path";
import { createSqliteWorkflowIntegrationCoordinatorStore, workflowIsolationCanonicalJson as json,
  workflowIsolationDigest as digest } from "../dist/index.js";
import { workflowMergeApprovalFingerprint } from "../dist/workflow-merge-approval.js";
import { applyWorkflowMergeApplyMigration, WORKFLOW_MERGE_APPLY_MIGRATION_VERSION }
  from "../dist/storage/sqlite/workflow-merge-apply-migration.js";
import { workflowIsolationFixture } from "./support/workflow-isolation-fixture.mjs";
import { now, resultTables, workflowIsolationResultsFixture } from "./support/workflow-isolation-results-fixture.mjs";
import { workflowMigrationPredecessorFixture } from "./support/workflow-migration-predecessor-fixture.mjs";

const table = "workflow_merge_apply_permits";
const migrationName = "workflow_merge_apply_permits";
const triggers = ["trg_workflow_merge_apply_permit_immutable", "trg_workflow_merge_apply_permit_retained"];
const columns = ["permit_id", "approval_id", "request_id", "round_id", "generation", "authority_digest",
  "basis_fingerprint", "owner_token", "lease_id", "intent_id", "permit_digest", "created_at", "expires_at"];
const evidenceTables = ["workflow_merge_approval_requests", ...resultTables, "workflow_integration_effect_links",
  "workflow_integration_receipt_links", "artifacts", "harness_artifact_pins", "harness_artifact_pin_events"];
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const rows = (db, name) => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
const exists = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const snapshot = db => ({ schema: schema(db), markers: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
  permits: exists(db) ? rows(db, table) : [] });
const evidenceSnapshot = db => Object.fromEntries(evidenceTables.map(name => [name, rows(db, name)]));
const dataSnapshot = f => ({ isolation: f.snapshotIsolation(), evidence: evidenceSnapshot(f.peer.database) });
const has = db => version => Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
const record = db => (version, name) => db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)")
  .run(version, name, "2026-11-02T00:00:00.000Z");
const migrate = (db, extra = {}) => applyWorkflowMergeApplyMigration({ database: db,
  hasMigration: has(db), recordMigration: record(db), ...extra });
const value = result => {
  assert.ok(["created", "updated", "duplicate"].includes(result.status), JSON.stringify(result));
  return result.value;
};
const insertPermit = (f, changes = {}) => {
  const row = { ...f.permitRow, ...changes };
  return f.store.database.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
    .run(...columns.map(column => row[column]));
};
const reopen = f => {
  f.reopenIsolation();
  migrate(f.store.database);
};

async function fixture(t, { predecessor = false, terminal = false } = {}) {
  const f = terminal ? await workflowIsolationResultsFixture(t)
    : await workflowIsolationFixture(t, { create: false, pin: false });
  const db = f.store.database;
  if (predecessor) {
    f.assertFullUpgrade = workflowMigrationPredecessorFixture(f, 208);
    assert.equal(schema(db).some(row => row.tbl_name === table), false);
    assert.equal(has(db)(208), false);
  } else migrate(db);
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version=207").get().name,
    "workflow_merge_approval_basis");
  return f;
}

// Real predecessor evidence; only the final request/permit overlay rows are storage-level fixtures, not issued capabilities.
function seedParents(f) {
  const db = f.store.database;
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
  const effect = { schemaVersion: 1, kind: "workflow_integration_coordinator_effect", roundId: f.roundId,
    generation: f.plan.generation, authorityDigest: authority.authorityDigest, effectKey: "worktree:create",
    effectKind: "integration_create", before, after, effect: { kind: "workflow_integration_worktree", scope } };
  const artifact = f.sealed("migration208-effect", effect);
  const intent = value(coordinator.recordIntent({ roundId: f.roundId, generation: f.plan.generation,
    expectedRevision: f.round().revision, authorityDigest: authority.authorityDigest, effectKey: effect.effectKey,
    kind: effect.effectKind, before, after, payloadArtifactId: artifact.id, now: now() }));
  const observation = f.sealed("migration208-receipt", { schemaVersion: 1,
    kind: "workflow_integration_coordinator_receipt", intentId: intent.intentId, effectKey: intent.effectKey,
    outcome: "confirmed", observed: after, evidence: { scope, receipt } });
  value(coordinator.recordReceipt({ intentId: intent.intentId, expectedRevision: f.round().revision,
    authorityDigest: authority.authorityDigest, outcome: "confirmed", observed: after,
    artifactId: observation.id, now: now() }));
  const basis = { type: "workflow_merge", schemaVersion: 1, workflowId: f.plan.workflowId,
    workflowStepId: f.plan.workflowStepId, roundId: f.roundId, generation: f.plan.generation,
    authorityDigest: authority.authorityDigest, inputsDigest: f.round().inputsDigest,
    candidate: { commit: f.packet.commit, tree: f.packet.tree, packetDigest: digest("candidate", "wgp1_"),
      validationDigest: digest("verification", "wgp1_"), branchResultDigests: [],
      resultRef: `refs/ling/workflow/candidates/${f.roundId}/1-${f.inputs.integration.worktreeId}/candidate` },
    target: f.inputs.target, repositoryIdentity: f.inputs.repositoryIdentity, graphFingerprint: f.inputs.graphFingerprint,
    safetyFingerprint: f.inputs.safetyFingerprint, templatePins: f.inputs.templatePins,
    targetSnapshot: f.scope.repository, expiresAt: f.at(120) };
  const payload = { ...basis, fingerprint: workflowMergeApprovalFingerprint(basis) };
  const approval = f.store.createApprovalRequest({ workflowStepId: f.plan.workflowStepId, channelId: f.channel.id,
    actionType: "workflow_merge", risk: "high", title: "Migration208 parent approval", description: "Storage constraint fixture",
    payload, expiresAt: payload.expiresAt }, now());
  f.store.approveApprovalRequest(approval.id, { decisionKind: "approve_once", resolvedBy: "local-user" }, now());
  const request = { requestId: digest({ roundId: f.roundId, generation: f.plan.generation,
    fingerprint: payload.fingerprint }, "wmr1_"), approvalId: approval.id, payload, createdAt: now() };
  db.prepare(`INSERT INTO workflow_merge_approval_requests(request_id,round_id,generation,approval_id,
    authority_digest,basis_fingerprint,payload_json,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(request.requestId, f.roundId, f.plan.generation, approval.id, authority.authorityDigest,
      payload.fingerprint, json(payload), digest(request), request.createdAt);
  const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workspace",
    resourceKey: "migration208-target", ownerType: "system", ownerId: "migration208-host", acquiredAt: now(), expiresAt: f.at(100) });
  assert.ok(lease);
  f.permitRow = { permit_id: "migration208-permit", approval_id: approval.id, request_id: request.requestId,
    round_id: f.roundId, generation: f.plan.generation, authority_digest: authority.authorityDigest,
    basis_fingerprint: payload.fingerprint, owner_token: "migration208-owner", lease_id: lease.id,
    intent_id: intent.intentId, permit_digest: digest("migration208-permit"), created_at: now(), expires_at: f.at(100) };
}

function rejectUnchanged(f, pattern, extra = {}, { reopened = true } = {}) {
  const db = f.store.database, before = snapshot(db), data = dataSnapshot(f);
  assert.throws(() => migrate(db, extra), pattern);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(dataSnapshot(f), data);
  if (reopened) {
    assert.throws(() => reopen(f), pattern);
    assert.deepEqual(snapshot(f.peer.database), before);
    assert.deepEqual(dataSnapshot(f), data);
  }
}

test("fresh208 installs exact permit columns, unique keys, composite and immutable-parent foreign keys; repeat and reopen are idempotent", async t => {
  const f = await fixture(t), db = f.store.database;
  assert.equal(WORKFLOW_MERGE_APPLY_MIGRATION_VERSION, 208);
  assert.deepEqual(db.prepare("SELECT version,name FROM schema_migrations WHERE version=208 OR name=?")
    .all(migrationName).map(row => ({ ...row })), [{ version: 208, name: migrationName }]);
  assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name), columns);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name")
    .all(table).map(row => row.name), triggers);
  const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  assert.equal(keys.length, 6);
  for (const [from, parent, to] of [["approval_id", "workflow_merge_approval_requests", "approval_id"],
    ["request_id", "workflow_merge_approval_requests", "request_id"], ["lease_id", "resource_leases", "id"],
    ["intent_id", "workflow_integration_effect_links", "intent_id"]])
    assert.ok(keys.some(row => row.from === from && row.table === parent && row.to === to), from);
  const roundKeys = keys.filter(row => row.table === "workflow_integration_generations").sort((a, b) => a.seq - b.seq);
  assert.deepEqual(roundKeys.map(row => [row.from, row.to]), [["round_id", "round_id"], ["generation", "generation"]]);
  assert.equal(roundKeys[0].id, roundKeys[1].id);
  assert.ok(keys.every(row => row.on_update === "NO ACTION" && row.on_delete === "NO ACTION"));
  const uniqueKeys = db.prepare(`PRAGMA index_list(${table})`).all().filter(row => row.unique === 1)
    .map(row => db.prepare(`PRAGMA index_info('${row.name}')`).all().map(column => column.name));
  for (const key of [["permit_id"], ["approval_id"], ["owner_token"], ["lease_id"], ["intent_id"], ["round_id", "generation"]])
    assert.ok(uniqueKeys.some(columns => json(columns) === json(key)), json(key));
  const before = snapshot(db), data = dataSnapshot(f);
  migrate(db); migrate(db); reopen(f);
  assert.deepEqual(snapshot(f.store.database), before);
  assert.deepEqual(dataSnapshot(f), data);
});

test("actual207 upgrade preserves approval consent, immutable request, terminal evidence, lease and coordinator links", async t => {
  const f = await fixture(t, { predecessor: true, terminal: true }), db = f.store.database;
  seedParents(f);
  for (const name of ["workflow_merge_approval_requests", "workflow_integration_effect_links", "workflow_integration_receipt_links", ...resultTables])
    assert.ok(rows(db, name).length > 0, `${name} must contain real predecessor data`);
  assert.equal(f.store.getApprovalRequest(f.permitRow.approval_id).status, "approved");
  const before = snapshot(db), data = dataSnapshot(f);
  migrate(db);
  assert.deepEqual(schema(db).filter(row => row.tbl_name !== table), before.schema);
  assert.deepEqual(snapshot(db).markers.filter(row => row.version !== 208), before.markers);
  assert.deepEqual(dataSnapshot(f), data);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, 208);
  insertPermit(f);
  const installed = snapshot(db);
  migrate(db); assert.deepEqual(snapshot(db), installed);
  reopen(f);
  f.assertFullUpgrade(f.store.database, installed);
  assert.deepEqual(snapshot(f.store.database).permits, installed.permits);
  assert.deepEqual(dataSnapshot(f), data);
  assert.deepEqual(rows(f.store.database, table).map(row => ({ ...row })), [f.permitRow]);
});

test("permit rows reject all updates and deletion, retain their unique identity, and survive reopen", async t => {
  const f = await fixture(t, { terminal: true }), db = f.store.database;
  seedParents(f); insertPermit(f);
  const before = snapshot(db), data = dataSnapshot(f);
  for (const column of columns)
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${column}=${column} WHERE permit_id=?`).run(f.permitRow.permit_id), /workflow_merge\.permit_immutable/);
  assert.throws(() => db.prepare(`UPDATE ${table} SET owner_token='successor'`).run(), /workflow_merge\.permit_immutable/);
  assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /workflow_merge\.permit_retained/);
  assert.throws(() => insertPermit(f), /UNIQUE/);
  assert.deepEqual(snapshot(db), before);
  assert.deepEqual(dataSnapshot(f), data);
  reopen(f);
  assert.deepEqual(snapshot(f.store.database), before);
});

test("permit insertion requires existing approval request, lease, intent and the exact round-generation pair", async t => {
  const f = await fixture(t, { terminal: true }), db = f.store.database;
  seedParents(f);
  const before = snapshot(db), data = dataSnapshot(f);
  for (const changes of [{ approval_id: "missing-approval" }, { request_id: "missing-request" },
    { lease_id: "missing-lease" }, { intent_id: "missing-intent" }, { round_id: "missing-round" }, { generation: 2 }]) {
    assert.throws(() => insertPermit(f, changes), /FOREIGN KEY/, json(changes));
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(dataSnapshot(f), data);
  }
  insertPermit(f);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
});

test("permit generation and owner checks and all NOT NULL columns are enforced on insertion", async t => {
  const f = await fixture(t, { terminal: true }), db = f.store.database;
  seedParents(f);
  const before = snapshot(db);
  for (const changes of [{ generation: 0 }, { generation: -1 }, { generation: 1.5 }, { generation: "invalid" },
    { owner_token: "" }, ...columns.map(column => ({ [column]: null }))]) {
    assert.throws(() => insertPermit(f, changes), /CHECK|NOT NULL/, json(changes));
    assert.deepEqual(snapshot(db), before);
  }
  insertPermit(f);
});

const rollbackFailures = {
  "throw-before-marker": /migration208-before-marker/,
  "throw-after-marker": /migration208-after-marker/,
  "missing-marker": /migration_postcondition/,
  "wrong-marker": /migration_marker_conflict/,
  "missing-trigger-after-marker": /migration_schema_missing/,
  "foreign-index-after-marker": /migration_unexpected_object/,
  "immediate-permit-fk": /FOREIGN KEY/,
  "deferred-commit-fk": /FOREIGN KEY/,
};
for (const [failure, pattern] of Object.entries(rollbackFailures)) {
  test(`migration208 rolls back DDL, marker and predecessor writes on ${failure}`, async t => {
    const f = await fixture(t, { predecessor: true, terminal: true }), db = f.store.database;
    seedParents(f);
    if (failure === "deferred-commit-fk") {
      db.exec("CREATE TABLE migration208_fault (id TEXT REFERENCES channel_workflows(id) DEFERRABLE INITIALLY DEFERRED)");
      db.exec(`CREATE TRIGGER migration208_fault_on_marker AFTER INSERT ON schema_migrations WHEN NEW.version=208
        BEGIN INSERT INTO migration208_fault VALUES('missing-workflow'); END`);
    }
    const before = snapshot(db), data = dataSnapshot(f);
    let reachedMarker = false;
    assert.throws(() => migrate(db, { recordMigration: (version, name) => {
      reachedMarker = true;
      assert.equal(version, 208); assert.equal(name, migrationName);
      assert.ok(exists(db));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=?").get(table).n, 2);
      db.prepare("UPDATE channel_workflows SET title='migration208-wip' WHERE id=?").run(f.plan.workflowId);
      if (failure === "throw-before-marker") throw new Error("migration208-before-marker");
      if (failure === "missing-marker") return;
      record(db)(version, failure === "wrong-marker" ? "foreign208" : name);
      if (failure === "throw-after-marker") { insertPermit(f); throw new Error("migration208-after-marker"); }
      if (failure === "missing-trigger-after-marker") db.exec(`DROP TRIGGER ${triggers[0]}`);
      if (failure === "foreign-index-after-marker") db.exec(`CREATE INDEX foreign208_index ON ${table}(authority_digest)`);
      if (failure === "immediate-permit-fk") insertPermit(f, { intent_id: "missing-intent" });
    } }), pattern);
    assert.equal(reachedMarker, true, "the new DDL must have completed before this fault");
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(dataSnapshot(f), data);
    if (failure === "deferred-commit-fk") {
      assert.deepEqual(rows(db, "migration208_fault"), []);
      db.exec("DROP TRIGGER migration208_fault_on_marker");
    }
    migrate(db);
    assert.equal(has(db)(208), true, "a fully rolled-back attempt remains safely retryable");
    insertPermit(f);
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_check(${table})`).all(), []);
  });
}

for (const trigger of triggers) {
  test(`migration208 rolls back partial DDL if creation of ${trigger} fails`, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    const before = snapshot(db), data = dataSnapshot(f), exec = db.exec.bind(db);
    let failed = false, reachedMarker = false;
    const fault = t.mock.method(db, "exec", sql => {
      if (sql.startsWith(`CREATE TRIGGER ${trigger}`)) {
        failed = true;
        assert.ok(exists(db), "the table must already exist inside the owned transaction");
        db.prepare("UPDATE channel_workflows SET title='ddl-wip' WHERE id=?").run(f.plan.workflowId);
        throw new Error("migration208-ddl-fault");
      }
      return exec(sql);
    });
    try {
      assert.throws(() => migrate(db, { recordMigration: () => { reachedMarker = true; } }), /migration208-ddl-fault/);
    } finally { fault.mock.restore(); }
    assert.equal(failed, true);
    assert.equal(reachedMarker, false);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(dataSnapshot(f), data);
    migrate(db);
    assert.equal(has(db)(208), true);
  });
}

for (const finish of ["COMMIT", "ROLLBACK"]) {
  test(`pending208 cannot adopt, commit or roll back a caller transaction before its ${finish}`, async t => {
    const f = await fixture(t, { predecessor: true }), db = f.store.database;
    const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
      const before = snapshot(db);
      assert.throws(() => migrate(db), /transaction/i);
      assert.equal(db.isTransaction, true);
      assert.deepEqual(snapshot(db), before);
      assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
      assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original, "caller writes must remain uncommitted");
      db.exec(finish);
    } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, finish === "COMMIT" ? "caller-wip" : original);
    assert.equal(has(db)(208), false);
    migrate(db);
    assert.equal(has(db)(208), true);
  });
}

test("installed208 inspection neither commits nor swallows the caller transaction", async t => {
  const f = await fixture(t), db = f.store.database;
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

test("corrupt208 inspection also leaves the caller transaction and uncommitted data intact", async t => {
  const f = await fixture(t), db = f.store.database;
  const original = f.store.getChannelWorkflow(f.plan.workflowId).title;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE channel_workflows SET title='caller-wip' WHERE id=?").run(f.plan.workflowId);
    db.prepare("UPDATE schema_migrations SET name='foreign208' WHERE version=208").run();
    const before = snapshot(db);
    assert.throws(() => migrate(db), /migration_marker_conflict/);
    assert.equal(db.isTransaction, true);
    assert.deepEqual(snapshot(db), before);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, "caller-wip");
    assert.equal(f.peer.getChannelWorkflow(f.plan.workflowId).title, original);
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); }
  migrate(db);
  assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).title, original);
});

for (const corruption of ["predecessor-missing", "predecessor-renamed", "marker-renamed", "marker-moved",
  "marker-duplicate", "callback-denies-marker", "callback-invents-marker"]) {
  test(`migration208 rejects ${corruption} without rewriting durable state`, async t => {
    const f = await fixture(t, { predecessor: corruption === "callback-invents-marker" }), db = f.store.database;
    if (corruption === "predecessor-missing") db.prepare("DELETE FROM schema_migrations WHERE version=207").run();
    if (corruption === "predecessor-renamed") db.prepare("UPDATE schema_migrations SET name='foreign207' WHERE version=207").run();
    if (corruption === "marker-renamed") db.prepare("UPDATE schema_migrations SET name='foreign208' WHERE version=208").run();
    if (corruption === "marker-moved") db.prepare("UPDATE schema_migrations SET version=999208 WHERE version=208").run();
    if (corruption === "marker-duplicate") record(db)(999208, migrationName);
    const extra = corruption === "callback-denies-marker" ? { hasMigration: () => false }
      : corruption === "callback-invents-marker" ? { hasMigration: () => true } : {};
    rejectUnchanged(f, /migration_predecessor_missing|migration_marker_conflict/, extra,
      { reopened: !corruption.startsWith("callback-") && !corruption.startsWith("predecessor-") });
  });
}

for (const name of [table, ...triggers]) {
  test(`marker208 cannot hide missing ${name}, including reopened inspection`, async t => {
    const f = await fixture(t), db = f.store.database;
    const { type } = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name);
    db.exec(`DROP ${type.toUpperCase()} ${name}`);
    rejectUnchanged(f, /migration_schema_missing/);
  });
}

const schemaCorruptions = {
  "generation-check": sql => sql.replace(" CHECK(typeof(generation)='integer' AND generation>0)", ""),
  "owner-token-check": sql => sql.replace(" CHECK(length(owner_token)>0)", ""),
  "approval-foreign-key": sql => sql.replace(" REFERENCES workflow_merge_approval_requests(approval_id)", ""),
  "request-foreign-key": sql => sql.replace(" REFERENCES workflow_merge_approval_requests(request_id)", ""),
  "lease-foreign-key": sql => sql.replace(" REFERENCES resource_leases(id)", ""),
  "intent-foreign-key": sql => sql.replace(" REFERENCES workflow_integration_effect_links(intent_id)", ""),
  "round-generation-foreign-key": sql => sql.replace(
    "    FOREIGN KEY(round_id,generation) REFERENCES workflow_integration_generations(round_id,generation),\n", ""),
  "round-generation-unique": sql => sql.replace(",\n    UNIQUE(round_id,generation)", ""),
  ...Object.fromEntries(["approval_id", "owner_token", "lease_id", "intent_id"].map(column => [
    `${column}-unique`, sql => sql.replace(`${column} TEXT NOT NULL UNIQUE`, `${column} TEXT NOT NULL`)])),
  "permit-primary-key": sql => sql.replace("permit_id TEXT NOT NULL PRIMARY KEY", "permit_id TEXT NOT NULL"),
  "unexpected-column": sql => sql.replace("created_at TEXT NOT NULL,", "created_at TEXT NOT NULL, foreign_column TEXT,"),
};
for (const [corruption, change] of Object.entries(schemaCorruptions)) {
  test(`migration208 rejects damaged ${corruption} instead of repairing the permit schema`, async t => {
    const f = await fixture(t), db = f.store.database;
    const original = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table).sql;
    const changed = change(original);
    assert.notEqual(changed, original, "the corruption must actually alter the schema");
    const savedTriggers = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? ORDER BY name").all(table);
    db.exec(`DROP TABLE ${table}`); db.exec(changed);
    for (const trigger of savedTriggers) db.exec(trigger.sql);
    rejectUnchanged(f, /migration_schema_conflict/);
  });
}

test("migration208 rejects a view occupying the permit-table name", async t => {
  const f = await fixture(t), db = f.store.database;
  db.exec(`DROP TABLE ${table}`);
  db.exec(`CREATE VIEW ${table} AS SELECT 'foreign-permit' AS permit_id`);
  rejectUnchanged(f, /migration_schema_conflict/);
});

for (const [name, operation] of [[triggers[0], "UPDATE"], [triggers[1], "DELETE"]]) {
  test(`migration208 rejects a no-op replacement for ${name}`, async t => {
    const f = await fixture(t), db = f.store.database;
    db.exec(`DROP TRIGGER ${name}`);
    db.exec(`CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT 1; END`);
    rejectUnchanged(f, /migration_schema_conflict/);
  });
}

for (const marked of [true, false]) {
  for (const object of ["index", "trigger"]) {
    test(`migration208 rejects an unknown ${object} on ${marked ? "marked" : "unmarked"} permit schema`, async t => {
      const f = await fixture(t), db = f.store.database;
      if (!marked) db.prepare("DELETE FROM schema_migrations WHERE version=208").run();
      if (object === "index") db.exec(`CREATE INDEX foreign208_index ON ${table}(authority_digest)`);
      else db.exec(`CREATE TRIGGER foreign208_trigger BEFORE INSERT ON ${table} BEGIN SELECT 1; END`);
      rejectUnchanged(f, /migration_unexpected_object/);
    });
  }
}

test("migration208 fails closed on orphan permit rows despite exact schema and marker, including reopen", async t => {
  const f = await fixture(t), db = f.store.database;
  f.permitRow = { permit_id: "orphan-permit", approval_id: "missing-approval", request_id: "missing-request",
    round_id: "missing-round", generation: 1, authority_digest: "authority", basis_fingerprint: "basis",
    owner_token: "orphan-owner", lease_id: "missing-lease", intent_id: "missing-intent", permit_digest: "permit",
    created_at: f.at(0), expires_at: f.at(100) };
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 0);
    insertPermit(f);
  } finally { db.exec("PRAGMA foreign_keys=ON"); }
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(db.prepare(`PRAGMA foreign_key_check(${table})`).all().length, 5);
  rejectUnchanged(f, /migration_fk_conflict/);
});

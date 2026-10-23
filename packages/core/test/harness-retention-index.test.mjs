import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyHarnessRetentionIndexMigration, HARNESS_RETENTION_INDEX_MIGRATION_VERSION } from "../dist/storage/sqlite/harness-retention-index-migration.js";
import { SqliteHarnessArtifactRetentionStore } from "../dist/storage/sqlite/harness-artifact-retention-store.js";

const now = "2026-10-22T00:00:00.000Z";
const migrationName = "create_harness_retention_due_cursor_index_v2";
const indexName = "idx_harness_retention_due_v2";

function fixture(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  // Only the retention/index contract is represented here, not RunStore startup
  // or a real artifact producer. The public-store integration suite covers those.
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,sealed_payload_json TEXT,content_sha256 TEXT);
    CREATE TABLE harness_artifact_retention(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
      content_sha256 TEXT,retain_until TEXT,enrolled_at TEXT,pruned_at TEXT);
    CREATE TABLE harness_artifact_pins(artifact_id TEXT REFERENCES artifacts(id),holder TEXT,reason TEXT,created_at TEXT,released_at TEXT,
      PRIMARY KEY(artifact_id,holder));
    CREATE TABLE harness_artifact_pin_events(artifact_id TEXT REFERENCES artifacts(id),holder TEXT,event TEXT,reason TEXT,created_at TEXT);
    CREATE TABLE harness_artifact_gc_receipts(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),content_sha256 TEXT,body_bytes INTEGER,pruned_at TEXT);
  `);
  const input = {
    database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(version, name, now),
  };
  const retention = new SqliteHarnessArtifactRetentionStore({ database });
  return {
    database, input, retention,
    enroll(artifactId, retainUntil = now) {
      const body = JSON.stringify({ safe: true });
      database.prepare("INSERT INTO artifacts VALUES (?,?,?)")
        .run(artifactId, body, createHash("sha256").update(body).digest("hex"));
      retention.enrollHarnessArtifactRetention({ artifactId, retainUntil, now });
    },
  };
}

test("retention index migration is additive and idempotent with an exact durable marker", t => {
  const f = fixture(t);
  f.enroll("evidence");
  const before = f.database.prepare("SELECT * FROM artifacts").all();
  assert.equal(applyHarnessRetentionIndexMigration(f.input), true);
  assert.equal(applyHarnessRetentionIndexMigration(f.input), false);
  assert.equal(f.database.prepare("SELECT name FROM schema_migrations WHERE version=?")
    .get(HARNESS_RETENTION_INDEX_MIGRATION_VERSION).name, migrationName);
  assert.deepEqual(f.database.prepare("SELECT * FROM artifacts").all(), before);
});

test("retention index and marker roll back together when recording the migration fails", t => {
  const f = fixture(t);
  assert.throws(() => applyHarnessRetentionIndexMigration({ ...f.input, recordMigration() { throw new Error("record_fault"); } }), /record_fault/);
  assert.equal(f.database.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(indexName), undefined);
  assert.equal(f.input.hasMigration(HARNESS_RETENTION_INDEX_MIGRATION_VERSION), false);
  assert.equal(applyHarnessRetentionIndexMigration(f.input), true);
});

for (const kind of ["wrong_version", "wrong_name", "missing_index", "wrong_index"]) {
  test(`retention index refuses ${kind} without rewriting the existing schema`, t => {
    const f = fixture(t);
    if (kind === "wrong_version") f.input.recordMigration(HARNESS_RETENTION_INDEX_MIGRATION_VERSION + 1, migrationName);
    if (kind === "wrong_name") f.input.recordMigration(HARNESS_RETENTION_INDEX_MIGRATION_VERSION, "wrong");
    if (kind === "missing_index") f.input.recordMigration(HARNESS_RETENTION_INDEX_MIGRATION_VERSION, migrationName);
    if (kind === "wrong_index") f.database.exec(`CREATE INDEX ${indexName} ON harness_artifact_retention(artifact_id)`);
    const before = f.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
    const markers = f.database.prepare("SELECT * FROM schema_migrations").all();
    assert.throws(() => applyHarnessRetentionIndexMigration(f.input), /harness_retention_index_migration_(marker_conflict|schema_missing|schema_conflict)/);
    assert.deepEqual(f.database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all(), before);
    assert.deepEqual(f.database.prepare("SELECT * FROM schema_migrations").all(), markers);
  });
}

for (const artifactId of ["a".repeat(1024), "读".repeat(1024), 'quote"slash\\line\n'.repeat(50), "\u0001".repeat(1024)]) {
  test(`retention cursor round-trips a valid ${Buffer.byteLength(artifactId)}-byte artifact identity`, t => {
    const f = fixture(t);
    applyHarnessRetentionIndexMigration(f.input);
    f.enroll(artifactId);
    f.enroll("next", "2026-10-22T00:01:00.000Z");
    const first = f.retention.collectHarnessArtifactBodies({ now: "2026-10-22T00:01:00.000Z", limit: 1 });
    assert.deepEqual(first.prunedArtifactIds, [artifactId]);
    assert.equal(typeof first.nextCursor, "string");
    const second = f.retention.collectHarnessArtifactBodies({ now: "2026-10-22T00:01:00.000Z", after: first.nextCursor, limit: 1 });
    assert.deepEqual(second.prunedArtifactIds, ["next"]);
    assert.equal(second.nextCursor, undefined);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM harness_artifact_gc_receipts").get().n, 2);
  });
}

test("retention rejects malformed or noncanonical cursors before changing any artifact", t => {
  const f = fixture(t);
  applyHarnessRetentionIndexMigration(f.input);
  f.enroll("evidence");
  const canonical = Buffer.from(JSON.stringify([now, "evidence"])).toString("base64url");
  const token = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const before = f.database.prepare("SELECT * FROM artifacts").all();
  for (const after of [null, 1, {}, "", "x".repeat(16 * 1024 + 1), "not-a-cursor", `${canonical}=`,
    `${canonical}\n`, token([]), token([now, "a", "extra"]), token(["not-a-date", "a"]),
    token([now, "a".repeat(1025)]), token([now, "nul\0id"]),
    Buffer.from(JSON.stringify([now, "evidence"], null, 2)).toString("base64url")]) {
    assert.throws(() => f.retention.collectHarnessArtifactBodies({ now, after }),
      { name: "TypeError", message: "artifact_retention_cursor_invalid" });
    assert.deepEqual(f.database.prepare("SELECT * FROM artifacts").all(), before);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM harness_artifact_gc_receipts").get().n, 0);
  }
});

test("later retention pages seek past a pinned prefix using both indexed cursor columns", t => {
  const f = fixture(t);
  applyHarnessRetentionIndexMigration(f.input);
  for (const id of ["a", "b", "c"]) f.enroll(id);
  f.retention.pinHarnessArtifact({ artifactId: "a", holder: "recovery", reason: "recovery", now });
  const prepare = f.database.prepare.bind(f.database);
  const queries = [];
  f.database.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT artifact_id,retain_until FROM harness_artifact_retention")) return statement;
    return { all(...args) { queries.push({ sql, args }); return statement.all(...args); } };
  };
  const first = f.retention.collectHarnessArtifactBodies({ now, limit: 1 });
  assert.deepEqual(first.prunedArtifactIds, []);
  assert.equal(first.examined, 1);
  const second = f.retention.collectHarnessArtifactBodies({ now, after: first.nextCursor, limit: 1 });
  assert.deepEqual(second.prunedArtifactIds, ["b"]);
  const query = queries.at(-1);
  const plan = prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args).map(row => row.detail).join("\n");
  assert.match(plan, /idx_harness_retention_due_v2/);
  assert.match(plan, /\(retain_until,artifact_id\)>\(\?,\?\)/,
    "A later page must seek past the composite cursor, not rescan all old pinned rows");
  assert.notEqual(prepare("SELECT sealed_payload_json FROM artifacts WHERE id='a'").get().sealed_payload_json, null);
});

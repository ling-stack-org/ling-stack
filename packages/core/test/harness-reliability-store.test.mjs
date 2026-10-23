import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyHarnessReliabilityMigration } from "../dist/storage/sqlite/harness-reliability-migration.js";
import { applyHarnessRetentionIndexMigration, HARNESS_RETENTION_INDEX_MIGRATION_VERSION } from "../dist/storage/sqlite/harness-retention-index-migration.js";
import { SqliteHarnessProjectionCheckpointStore } from "../dist/storage/sqlite/harness-projection-checkpoint-store.js";
import { SqliteHarnessArtifactRetentionStore } from "../dist/storage/sqlite/harness-artifact-retention-store.js";

const now = "2026-10-19T00:00:00.000Z";
const later = "2026-10-19T00:01:00.000Z";
const domains = ["continuation", "tool_execution", "evaluation", "delegation"];

// This small on-disk source corpus isolates the derived stores. Public RunStore/producer wiring
// is exercised by the separate integration tests, not represented by this fixture as verified.
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-harness-reliability-"));
  const path = join(cwd, "fixture.sqlite");
  const f = { cwd, path, database: new DatabaseSync(path) };
  f.database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
    CREATE TABLE artifacts(id TEXT PRIMARY KEY,sealed_payload_json TEXT,content_sha256 TEXT);
    CREATE TABLE runner_continuations(id TEXT PRIMARY KEY,run_id TEXT,work_unit_id TEXT,state TEXT,revision INTEGER,updated_at TEXT,private_json TEXT);
    CREATE TABLE harness_tool_executions(id TEXT PRIMARY KEY,run_id TEXT,work_unit_id TEXT,state TEXT,revision INTEGER,updated_at TEXT);
    CREATE TABLE run_evaluations(id TEXT PRIMARY KEY,run_id TEXT,root_run_id TEXT,state TEXT,revision INTEGER,updated_at TEXT);
    CREATE TABLE delegation_steps(id TEXT PRIMARY KEY,parent_run_id TEXT,root_run_id TEXT,state TEXT,revision INTEGER,updated_at TEXT);
    CREATE TABLE harness_tool_execution_artifacts(id TEXT);
    CREATE TABLE run_evaluation_grades(id TEXT);
    CREATE TABLE run_evaluation_tasks(id TEXT);
    CREATE TABLE run_evaluation_task_attempts(id TEXT);
    CREATE TABLE run_evaluation_task_results(id TEXT);
    CREATE TABLE run_evaluation_qa_namespace(id TEXT);
    CREATE TABLE run_evaluation_qa_batches(id TEXT);
    CREATE TABLE run_evaluation_qa_enrollments(id TEXT);
    CREATE TABLE run_evaluation_qa_requests(id TEXT);
    CREATE TABLE run_evaluation_human_intents(id TEXT);
    CREATE TABLE run_evaluation_human_events(id TEXT);
    CREATE TABLE run_evaluation_human_heads(id TEXT);
    CREATE TABLE delegation_messages(id TEXT);
  `);
  f.apply = () => {
    const input = { database: f.database,
      hasMigration: version => Boolean(f.database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
      recordMigration: (version, name) => f.database.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)").run(version, name, now),
    };
    const reliabilityApplied = applyHarnessReliabilityMigration(input);
    const retentionApplied = applyHarnessRetentionIndexMigration(input);
    return reliabilityApplied || retentionApplied;
  };
  f.apply();
  f.reopen = () => {
    f.database.close(); f.database = new DatabaseSync(path); f.database.exec("PRAGMA foreign_keys=ON");
    f.projection = new SqliteHarnessProjectionCheckpointStore({ database: f.database });
    f.retention = new SqliteHarnessArtifactRetentionStore({ database: f.database });
  };
  f.projection = new SqliteHarnessProjectionCheckpointStore({ database: f.database });
  f.retention = new SqliteHarnessArtifactRetentionStore({ database: f.database });
  f.body = (id, payload = { safe: true }) => {
    const json = JSON.stringify(payload);
    const digest = createHash("sha256").update(json).digest("hex");
    f.database.prepare("INSERT INTO artifacts VALUES (?,?,?)").run(id, json, digest);
    return digest;
  };
  f.continuation = id => f.database.prepare("INSERT INTO runner_continuations VALUES (?, 'run','unit','prepared',0,?,?)")
    .run(id, now, "{invalid-private-json-never-read");
  t.after(async () => { f.database.close(); await rm(cwd, { recursive: true, force: true }); });
  return f;
}

test("all four domains rebuild metadata only; interrupted pages resume on a real SQLite reopen", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 503; index += 1) f.continuation(`row-${String(index).padStart(4, "0")}`);
  f.database.prepare("INSERT INTO harness_tool_executions VALUES ('tool','run','unit','unknown_outcome',4,?)").run(now);
  f.database.prepare("INSERT INTO run_evaluations VALUES ('eval','run','root','completed',5,?)").run(now);
  f.database.prepare("INSERT INTO delegation_steps VALUES ('child','parent','root','waiting',2,?)").run(now);
  const first = f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now, limit: 200 });
  assert.equal(first.state, "rebuilding"); assert.equal(first.rowCount, 200);
  assert.throws(() => f.projection.queryHarnessProjection({ domain: "continuation", generation: first.generation }), { code: "projection.not_current" });
  f.reopen();
  let checkpoint;
  do { checkpoint = f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now, limit: 200 }); } while (checkpoint.state !== "ready");
  assert.equal(checkpoint.generation, first.generation); assert.equal(checkpoint.rowCount, 503);
  const received = []; let cursor;
  do {
    const page = f.projection.queryHarnessProjection({ domain: "continuation", generation: checkpoint.generation, after: cursor, limit: 137 });
    received.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(received.length, 503); assert.equal(JSON.stringify(received).includes("private"), false);
  for (const domain of domains.slice(1)) {
    const ready = f.projection.reconcileHarnessProjectionPage({ domain, now });
    assert.equal(ready.state, "ready"); assert.equal(ready.rowCount, 1);
  }
  assert.equal(f.apply(), false);
});

test("authority epoch invalidates a ready or partially built generation, including task/grade/message mutations", async t => {
  const f = await fixture(t);
  f.continuation("a"); f.continuation("b");
  const first = f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now, limit: 1 });
  f.database.prepare("UPDATE runner_continuations SET revision=1 WHERE id='a'").run();
  const rebuilt = f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now, limit: 500 });
  assert.equal(rebuilt.generation, first.generation + 1); assert.equal(rebuilt.rowCount, 2);
  f.continuation("c");
  assert.throws(() => f.projection.queryHarnessProjection({ domain: "continuation", generation: rebuilt.generation }), { code: "projection.not_current" });
  for (const [domain, table] of [["evaluation", "run_evaluation_grades"], ["evaluation", "run_evaluation_task_results"], ["delegation", "delegation_messages"]]) {
    const ready = f.projection.reconcileHarnessProjectionPage({ domain, now });
    f.database.prepare(`INSERT INTO ${table} VALUES (?)`).run(`${table}-1`);
    assert.equal(f.projection.getHarnessProjectionCheckpoint(domain).sourceEpoch, ready.sourceEpoch + 1);
    assert.equal(f.projection.getHarnessProjectionCheckpoint(domain).state, "stale");
  }
});

test("QA and human evaluation authority invalidate ready and rebuilding evaluation projections", async t => {
  const f = await fixture(t);
  f.database.prepare("INSERT INTO run_evaluations VALUES ('eval-a','run','root','completed',1,?)").run(now);
  f.database.prepare("INSERT INTO run_evaluations VALUES ('eval-b','run','root','completed',1,?)").run(now);
  const first = f.projection.reconcileHarnessProjectionPage({ domain: "evaluation", now, limit: 1 });
  assert.equal(first.state, "rebuilding");
  f.database.prepare("INSERT INTO run_evaluation_qa_namespace VALUES ('namespace')").run();
  const rebuilt = f.projection.reconcileHarnessProjectionPage({ domain: "evaluation", now, limit: 500 });
  assert.equal(rebuilt.state, "ready");
  assert.equal(rebuilt.generation, first.generation + 1);
  for (const table of [
    "run_evaluation_qa_batches",
    "run_evaluation_qa_enrollments",
    "run_evaluation_qa_requests",
    "run_evaluation_human_intents",
    "run_evaluation_human_events",
    "run_evaluation_human_heads",
  ]) {
    const ready = f.projection.getHarnessProjectionCheckpoint("evaluation");
    f.database.prepare(`INSERT INTO ${table} VALUES (?)`).run(`${table}-row`);
    const stale = f.projection.getHarnessProjectionCheckpoint("evaluation");
    assert.equal(stale.sourceEpoch, ready.sourceEpoch + 1, table);
    assert.equal(stale.state, "stale", table);
    assert.equal(f.projection.reconcileHarnessProjectionPage({ domain: "evaluation", now }).state, "ready", table);
  }
});

test("projection corruption and SQLite write faults never publish partial success and can be rebuilt", async t => {
  const f = await fixture(t); f.continuation("a");
  const ready = f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now });
  f.database.prepare("DELETE FROM harness_projection_rows WHERE domain='continuation'").run();
  assert.equal(f.projection.getHarnessProjectionCheckpoint("continuation").state, "failed");
  assert.throws(() => f.projection.queryHarnessProjection({ domain: "continuation", generation: ready.generation }), { code: "projection.not_current" });
  f.database.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON harness_projection_rows BEGIN SELECT RAISE(ABORT,'injected projection fault'); END");
  assert.throws(() => f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now }), /injected projection fault/);
  assert.equal(f.projection.getHarnessProjectionCheckpoint("continuation").state, "failed");
  f.database.exec("DROP TRIGGER reject_projection");
  const repaired = f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now });
  assert.equal(repaired.state, "ready"); assert.equal(repaired.rowCount, 1);
});

test("missing epoch trigger forces stale rebuild; altered trigger SQL refuses schema drift", async t => {
  const f = await fixture(t); f.projection.reconcileHarnessProjectionPage({ domain: "continuation", now });
  f.database.exec("DROP TRIGGER trg_harness_epoch_runner_continuations_insert");
  f.continuation("a");
  assert.equal(f.apply(), true);
  assert.equal(f.projection.getHarnessProjectionCheckpoint("continuation").state, "stale");
  f.database.exec("DROP TRIGGER trg_harness_epoch_runner_continuations_insert; CREATE TRIGGER trg_harness_epoch_runner_continuations_insert AFTER INSERT ON runner_continuations BEGIN SELECT 1; END");
  assert.throws(f.apply, /harness_reliability_schema_drift/);
});

test("durable pins/audit holds survive reopen and GC preserves artifact identity, digest and immutable audit", async t => {
  const f = await fixture(t); const digest = f.body("cache");
  f.retention.enrollHarnessArtifactRetention({ artifactId: "cache", retainUntil: now, now });
  f.retention.pinHarnessArtifact({ artifactId: "cache", holder: "case-review", reason: "audit_hold", now });
  f.reopen();
  assert.deepEqual(f.retention.collectHarnessArtifactBodies({ now: later }).prunedArtifactIds, []);
  f.retention.releaseHarnessArtifactPin({ artifactId: "cache", holder: "case-review", now: later });
  assert.deepEqual(f.retention.collectHarnessArtifactBodies({ now: later }).prunedArtifactIds, ["cache"]);
  assert.deepEqual({ ...f.database.prepare("SELECT * FROM artifacts WHERE id='cache'").get() }, { id: "cache", sealed_payload_json: null, content_sha256: digest });
  assert.equal(f.retention.getHarnessArtifactRetention("cache").prunedAt, later);
  assert.throws(() => f.retention.pinHarnessArtifact({ artifactId: "cache", holder: "too-late", reason: "recovery", now: later }), { code: "artifact.body_unavailable" });
  assert.throws(() => f.database.prepare("UPDATE artifacts SET sealed_payload_json='{}' WHERE id='cache'").run(), /immutable/);
  assert.throws(() => f.database.exec("DELETE FROM harness_artifact_gc_receipts"), /immutable/);
  assert.throws(() => f.database.exec("DELETE FROM harness_artifact_pin_events"), /immutable/);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM harness_artifact_pin_events").get().count, 2);
});

test("GC is opt-in and conservatively protects even newly added authority foreign keys", async t => {
  const f = await fixture(t); f.body("not-enrolled"); f.body("authority"); f.body("cold");
  for (const artifactId of ["authority", "cold"]) f.retention.enrollHarnessArtifactRetention({ artifactId, retainUntil: now, now });
  f.database.exec("CREATE TABLE future_child_authority(id TEXT PRIMARY KEY,policy_artifact_id TEXT REFERENCES artifacts(id))");
  f.database.prepare("INSERT INTO future_child_authority VALUES ('child','authority')").run();
  assert.deepEqual(f.retention.collectHarnessArtifactBodies({ now: later }).prunedArtifactIds, ["cold"]);
  assert.notEqual(f.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id='authority'").get().sealed_payload_json, null);
  assert.notEqual(f.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id='not-enrolled'").get().sealed_payload_json, null);
});

test("deadline-first retention cursor uses migration 179 and never scans future rows into a due page", async t => {
  const f = await fixture(t);
  assert.ok(f.database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(HARNESS_RETENTION_INDEX_MIGRATION_VERSION));
  for (const [artifactId, retainUntil] of [["due-b", now], ["future-a", "2026-10-20T00:00:00.000Z"], ["due-a", now],
    ["future-b", "2026-10-21T00:00:00.000Z"], ["due-c", later]]) {
    f.body(artifactId); f.retention.enrollHarnessArtifactRetention({ artifactId, retainUntil, now });
  }
  const plan = f.database.prepare(`EXPLAIN QUERY PLAN SELECT artifact_id,retain_until FROM harness_artifact_retention
    WHERE pruned_at IS NULL AND retain_until<=? ORDER BY retain_until,artifact_id LIMIT ?`).all(later, 2);
  assert.match(plan.map(row => row.detail).join("\n"), /idx_harness_retention_due_v2/);
  const first = f.retention.collectHarnessArtifactBodies({ now: later, limit: 2 });
  assert.deepEqual(first.prunedArtifactIds, ["due-a", "due-b"]); assert.equal(first.examined, 2); assert.ok(first.nextCursor);
  const second = f.retention.collectHarnessArtifactBodies({ now: later, limit: 2, after: first.nextCursor });
  assert.deepEqual(second.prunedArtifactIds, ["due-c"]); assert.equal(second.nextCursor, undefined);
  assert.notEqual(f.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id='future-a'").get().sealed_payload_json, null);
  assert.throws(() => f.retention.collectHarnessArtifactBodies({ now: later, after: "not-a-cursor" }), /artifact_retention_cursor_invalid/);
});

test("GC failure rolls body, retention state and receipt back together", async t => {
  const f = await fixture(t); f.body("cold"); f.retention.enrollHarnessArtifactRetention({ artifactId: "cold", retainUntil: now, now });
  f.database.exec("CREATE TRIGGER reject_prune BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'injected prune failure'); END");
  assert.throws(() => f.retention.collectHarnessArtifactBodies({ now: later }), /injected prune failure/);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM harness_artifact_gc_receipts").get().count, 0);
  assert.equal(f.retention.getHarnessArtifactRetention("cold").prunedAt, undefined);
  assert.notEqual(f.database.prepare("SELECT sealed_payload_json FROM artifacts WHERE id='cold'").get().sealed_payload_json, null);
});

test("pins from another SQLite connection win before GC; pruned bodies cannot acquire a later pin", async t => {
  const f = await fixture(t); f.body("cold"); f.retention.enrollHarnessArtifactRetention({ artifactId: "cold", retainUntil: now, now });
  const other = new DatabaseSync(f.path); t.after(() => other.close());
  const retention = new SqliteHarnessArtifactRetentionStore({ database: other });
  retention.pinHarnessArtifact({ artifactId: "cold", holder: "other-worker", reason: "recovery", now });
  assert.deepEqual(f.retention.collectHarnessArtifactBodies({ now: later }).prunedArtifactIds, []);
  retention.releaseHarnessArtifactPin({ artifactId: "cold", holder: "other-worker", now: later });
  f.retention.collectHarnessArtifactBodies({ now: later });
  assert.throws(() => retention.pinHarnessArtifact({ artifactId: "cold", holder: "new-worker", reason: "recovery", now: later }), { code: "artifact.body_unavailable" });
});

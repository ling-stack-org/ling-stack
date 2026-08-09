import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CONTINUITY_V2_RECOVERY_MANIFEST_NAME,
  ContinuityMigrationRecoveryError,
  assertSqliteDatabaseIntegrity,
  createContinuityMigrationRecoveryPoint,
  restoreContinuityMigrationRecoveryPoint,
  verifyContinuityMigrationRecoveryPoint,
} from "../dist/index.js";

const now = "2026-08-09T12:00:00.000Z";

test("Continuity recovery snapshot includes committed WAL data and refuses overwrite", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-continuity-recovery-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const databasePath = join(cwd, "ling-stack.sqlite");
  const recoveryDirectory = join(cwd, "recovery", "continuity-v2");
  const database = createLegacyDatabase(databasePath);
  t.after(() => database.isOpen && database.close());
  database.prepare("INSERT INTO channel_messages (id, body) VALUES (?, ?)").run("message-1", "private body must not enter manifest");
  assert.ok((await stat(`${databasePath}-wal`)).size > 0);

  const recovery = createContinuityMigrationRecoveryPoint({
    database,
    databasePath,
    recoveryDirectory,
    createdAt: now,
  });

  assert.equal(recovery.manifest.sourceSchemaVersion, 109);
  assert.deepEqual(recovery.manifest.legacyCounts, {
    channelMessages: 1,
    channelContextSummaries: 1,
    lingThreads: 1,
    lingTurns: 1,
  });
  const snapshot = new DatabaseSync(recovery.manifest.snapshotPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare("SELECT body FROM channel_messages WHERE id = ?").get("message-1").body, "private body must not enter manifest");
  } finally {
    snapshot.close();
  }
  const manifestText = await readFile(recovery.manifestPath, "utf8");
  assert.doesNotMatch(manifestText, /private body/);
  assert.throws(
    () => createContinuityMigrationRecoveryPoint({ database, databasePath, recoveryDirectory, createdAt: now }),
    (error) => error instanceof ContinuityMigrationRecoveryError && error.code === "recovery_point_exists",
  );
});

test("Continuity recovery aborts on failed source integrity and rejects a damaged snapshot", async (t) => {
  assert.throws(
    () => assertSqliteDatabaseIntegrity(
      { prepare: () => ({ all: () => [{ integrity_check: "row 7 missing" }] }) },
      "source_integrity_failed",
      "source database",
    ),
    (error) => error instanceof ContinuityMigrationRecoveryError && error.code === "source_integrity_failed",
  );

  const cwd = await mkdtemp(join(tmpdir(), "ling-continuity-damaged-snapshot-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const databasePath = join(cwd, "ling-stack.sqlite");
  const recoveryDirectory = join(cwd, "recovery", "continuity-v2");
  const database = createLegacyDatabase(databasePath);
  const recovery = createContinuityMigrationRecoveryPoint({ database, databasePath, recoveryDirectory, createdAt: now });
  database.close();
  await writeFile(recovery.manifest.snapshotPath, "not sqlite", "utf8");

  assert.throws(
    () => verifyContinuityMigrationRecoveryPoint(recovery.manifestPath, databasePath),
    (error) => error instanceof ContinuityMigrationRecoveryError && error.code === "snapshot_validation_failed",
  );
});

test("Continuity recovery drill preserves the failed database and restores the legacy snapshot", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-continuity-restore-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const databasePath = join(cwd, "ling-stack.sqlite");
  const recoveryDirectory = join(cwd, "recovery", "continuity-v2");
  let database = createLegacyDatabase(databasePath);
  database.prepare("INSERT INTO channel_messages (id, body) VALUES (?, ?)").run("message-1", "before migration");
  const recovery = createContinuityMigrationRecoveryPoint({ database, databasePath, recoveryDirectory, createdAt: now });
  database.close();

  database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE channel_messages; CREATE TABLE conversation_items (id TEXT PRIMARY KEY);");
  database.prepare("INSERT INTO conversation_items (id) VALUES (?)").run("item-after-migration");
  database.close();

  const failedDatabasePath = join(cwd, "ling-stack.failed.sqlite");
  const result = restoreContinuityMigrationRecoveryPoint({
    databasePath,
    manifestPath: join(recoveryDirectory, CONTINUITY_V2_RECOVERY_MANIFEST_NAME),
    failedDatabasePath,
  });
  assert.equal(result.failedDatabasePath, failedDatabasePath);

  const restored = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(restored.prepare("SELECT body FROM channel_messages WHERE id = ?").get("message-1").body, "before migration");
    assert.equal(tableExists(restored, "conversation_items"), false);
  } finally {
    restored.close();
  }
  const failed = new DatabaseSync(failedDatabasePath, { readOnly: true });
  try {
    assert.equal(failed.prepare("SELECT id FROM conversation_items").get().id, "item-after-migration");
    assert.equal(tableExists(failed, "channel_messages"), false);
  } finally {
    failed.close();
  }
  assert.doesNotThrow(() => verifyContinuityMigrationRecoveryPoint(recovery.manifestPath, databasePath));
});

function createLegacyDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations (version, name, applied_at) VALUES (109, 'legacy-head', '${now}');
    CREATE TABLE channel_messages (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE channel_context_summaries (id TEXT PRIMARY KEY);
    CREATE TABLE ling_threads (id TEXT PRIMARY KEY);
    CREATE TABLE ling_turns (id TEXT PRIMARY KEY);
    INSERT INTO channel_context_summaries (id) VALUES ('summary-1');
    INSERT INTO ling_threads (id) VALUES ('thread-1');
    INSERT INTO ling_turns (id) VALUES ('turn-1');
  `);
  return database;
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

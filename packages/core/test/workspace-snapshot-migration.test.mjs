import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyWorkspaceSnapshotMigration,
  WORKSPACE_SNAPSHOT_MIGRATION_VERSION,
} from "../dist/storage/sqlite/workspace-snapshot-migration.js";

test("workspace snapshot migration upgrades legacy constraints across reopen and is idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-workspace-snapshot-migration-"));
  const databasePath = resolve(cwd, "legacy.sqlite");
  let database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE workspace_snapshot_manifests (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, cwd TEXT NOT NULL, canonical_root TEXT NOT NULL,
        format_version INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL CHECK(state IN ('capturing', 'sealed', 'snapshot_unverified', 'expired', 'corrupt', 'deleted')),
        fingerprint TEXT NOT NULL, provenance_watermark TEXT NOT NULL, entry_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL, created_at TEXT NOT NULL, sealed_at TEXT, expires_at TEXT, failure_reason TEXT
      );
      CREATE TABLE workspace_snapshot_entries (
        id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('file', 'directory')), mode INTEGER, size_bytes INTEGER NOT NULL,
        sha256 TEXT, blob_sha256 TEXT, UNIQUE(manifest_id, relative_path)
      );
      CREATE TABLE workspace_snapshot_blobs (
        sha256 TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, content_type TEXT NOT NULL,
        created_at TEXT NOT NULL, ref_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE workspace_snapshot_restore_anchors (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL, target_turn_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL, baseline_snapshot_id TEXT NOT NULL, baseline_fingerprint TEXT NOT NULL,
        baseline_provenance_watermark TEXT NOT NULL, expected_workspace_fingerprint TEXT NOT NULL,
        expected_provenance_watermark TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT
      );
      CREATE TABLE workspace_snapshot_restore_requests (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, workspace_id TEXT NOT NULL, anchor_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL, expected_workspace_fingerprint TEXT NOT NULL,
        expected_provenance_watermark TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('requested', 'validating', 'prepared', 'applying', 'committed', 'recovery_required', 'conflict', 'failed', 'expired')),
        fencing_epoch INTEGER NOT NULL DEFAULT 0, journal_entry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      );
      CREATE TABLE workspace_snapshot_restore_confirmations (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, anchor_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed', 'denied', 'expired')),
        created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE workspace_snapshot_restore_journal (
        id TEXT PRIMARY KEY, restore_request_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        relative_path TEXT NOT NULL, expected_before_sha256 TEXT, expected_after_sha256 TEXT,
        rollback_blob_sha256 TEXT, target_blob_sha256 TEXT,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('file', 'directory')),
        state TEXT NOT NULL CHECK(state IN ('pending', 'applied', 'rolled_back', 'conflict', 'failed')),
        updated_at TEXT NOT NULL, UNIQUE(restore_request_id, sequence), UNIQUE(restore_request_id, relative_path)
      );
      CREATE TABLE workspace_snapshot_fences (workspace_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0, owner_request_id TEXT, updated_at TEXT NOT NULL);
    `);

    database.prepare(`INSERT INTO workspace_snapshot_manifests (id, workspace_id, cwd, canonical_root, state, fingerprint, provenance_watermark, entry_count, total_bytes, created_at) VALUES ('legacy-manifest', 'workspace_default', '/tmp', '/tmp', 'sealed', ?, 'workspace_default:0', 0, 0, '2026-08-26T00:00:00.000Z')`).run("a".repeat(64));
    database.close();
    database = new DatabaseSync(databasePath);
    const input = {
      database,
      hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
      hasTable: (name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)),
      recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(version, name, "2026-08-26T00:00:00.000Z"),
    };

    assert.equal(applyWorkspaceSnapshotMigration(input), true);
    const manifestSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshot_manifests'").get().sql;
    const entrySql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshot_entries'").get().sql;
    const journalSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshot_restore_journal'").get().sql;
    const requestSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_snapshot_restore_requests'").get().sql;
    assert.match(manifestSql, /'committed'/u);
    assert.match(entrySql, /'symlink'/u);
    assert.match(journalSql, /'symlink'/u);
    assert.match(requestSql, /'fenced'/u);
    assert.match(requestSql, /'staged'/u);
    assert.match(requestSql, /'committing'/u);
    assert.match(requestSql, /'verifying'/u);
    assert.doesNotMatch(requestSql, /'prepared'/u);
    assert.doesNotMatch(requestSql, /'applying'/u);
    assert.equal(database.prepare("SELECT state FROM workspace_snapshot_manifests WHERE id = 'legacy-manifest'").get().state, "sealed");
    database.prepare(`INSERT INTO workspace_snapshot_restore_anchors (id, workspace_id, thread_id, target_turn_id, checkpoint_id, baseline_snapshot_id, baseline_fingerprint, baseline_provenance_watermark, expected_workspace_fingerprint, expected_provenance_watermark, created_at) VALUES ('legacy-anchor', 'workspace_default', 'thread', 'turn', 'checkpoint', 'legacy-manifest', ?, 'workspace_default:0', ?, 'workspace_default:0', '2026-08-26T00:00:00.000Z')`).run("a".repeat(64), "b".repeat(64));
    database.prepare(`INSERT INTO workspace_snapshot_restore_requests (id, idempotency_key, workspace_id, anchor_id, snapshot_id, expected_workspace_fingerprint, expected_provenance_watermark, state, created_at, updated_at) VALUES ('new-request', 'k', 'workspace_default', 'legacy-anchor', 'legacy-manifest', ?, 'workspace_default:0', 'fenced', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')`).run("b".repeat(64));
    database.close();
    database = new DatabaseSync(databasePath);
    const reopenedInput = {
      database,
      hasMigration: (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)),
      hasTable: (name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)),
      recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(version, name, "2026-08-26T00:00:00.000Z"),
    };
    assert.equal(applyWorkspaceSnapshotMigration(reopenedInput), false);
    assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(WORKSPACE_SNAPSHOT_MIGRATION_VERSION));
    assert.equal(database.prepare("SELECT state FROM workspace_snapshot_restore_requests WHERE id = 'new-request'").get().state, "fenced");
  } finally {
    try { database.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});

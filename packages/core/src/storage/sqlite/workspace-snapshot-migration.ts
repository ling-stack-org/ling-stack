import type { DatabaseSync } from "node:sqlite";

export const WORKSPACE_SNAPSHOT_MIGRATION_VERSION = 125;
export const WORKSPACE_SNAPSHOT_MIGRATION_NAME = "create_workspace_snapshot_restore";

export interface WorkspaceSnapshotMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable: (tableName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyWorkspaceSnapshotMigration(input: WorkspaceSnapshotMigrationInput): boolean {
  const complete = input.hasTable("workspace_snapshot_manifests")
    && input.hasTable("workspace_snapshot_entries")
    && input.hasTable("workspace_snapshot_blobs")
    && input.hasTable("workspace_snapshot_restore_anchors")
    && input.hasTable("workspace_snapshot_restore_requests")
    && input.hasTable("workspace_snapshot_restore_confirmations")
    && input.hasTable("workspace_snapshot_restore_journal")
    && input.hasTable("workspace_snapshot_fences")
    && hasColumn(input.database, "workspace_snapshot_manifests", "manifest_sha256")
    && hasColumn(input.database, "workspace_snapshot_entries", "managed")
    && hasColumn(input.database, "workspace_snapshot_entries", "symlink_target")
    && hasColumn(input.database, "workspace_snapshot_restore_journal", "target_symlink_target")
    && hasColumn(input.database, "workspace_snapshot_restore_journal", "rollback_mode")
    && hasNullableAnchorLineage(input.database)
    && tableSql(input.database, "workspace_snapshot_manifests").includes("'committed'")
    && tableSql(input.database, "workspace_snapshot_entries").includes("'symlink'")
    && tableSql(input.database, "workspace_snapshot_restore_journal").includes("'symlink'")
    && tableSql(input.database, "workspace_snapshot_restore_requests").includes("'fenced'")
    && tableSql(input.database, "workspace_snapshot_restore_requests").includes("'staged'")
    && tableSql(input.database, "workspace_snapshot_restore_requests").includes("'committing'")
    && tableSql(input.database, "workspace_snapshot_restore_requests").includes("'verifying'")
    && !tableSql(input.database, "workspace_snapshot_restore_requests").includes("'prepared'")
    && !tableSql(input.database, "workspace_snapshot_restore_requests").includes("'applying'");
  if (complete && input.hasMigration(WORKSPACE_SNAPSHOT_MIGRATION_VERSION)) return false;

  input.database.exec(`
    CREATE TABLE IF NOT EXISTS workspace_snapshot_manifests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      canonical_root TEXT NOT NULL,
      format_version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL CHECK(state IN ('capturing', 'committed', 'sealed', 'snapshot_unverified', 'expired', 'corrupt', 'deleted')),
      fingerprint TEXT NOT NULL,
      provenance_watermark TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      sealed_at TEXT,
      expires_at TEXT,
      failure_reason TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      capture_cwd TEXT,
      capture_kind TEXT,
      source_turn_id TEXT,
      source_run_id TEXT,
      source_checkpoint_id TEXT,
      exclusion_policy_sha256 TEXT,
      managed_entry_count INTEGER,
      excluded_entry_count INTEGER,
      managed_bytes INTEGER,
      workspace_fingerprint_sha256 TEXT,
      manifest_sha256 TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshot_manifests_workspace_created
      ON workspace_snapshot_manifests(workspace_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS workspace_snapshot_entries (
      id TEXT PRIMARY KEY,
      manifest_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file', 'directory', 'symlink')),
      managed INTEGER NOT NULL DEFAULT 1 CHECK(managed IN (0, 1)),
      exclusion_reason TEXT,
      symlink_target TEXT,
      mode INTEGER,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT,
      blob_sha256 TEXT,
      FOREIGN KEY(manifest_id) REFERENCES workspace_snapshot_manifests(id) ON DELETE CASCADE,
      UNIQUE(manifest_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshot_entries_manifest
      ON workspace_snapshot_entries(manifest_id, relative_path);

    CREATE TABLE IF NOT EXISTS workspace_snapshot_blobs (
      sha256 TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      created_at TEXT NOT NULL,
      ref_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workspace_snapshot_restore_anchors (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      thread_id TEXT,
      target_turn_id TEXT,
      checkpoint_id TEXT,
      baseline_snapshot_id TEXT NOT NULL,
      baseline_fingerprint TEXT NOT NULL,
      baseline_provenance_watermark TEXT NOT NULL,
      expected_workspace_fingerprint TEXT NOT NULL,
      expected_provenance_watermark TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(target_turn_id) REFERENCES ling_turns(id) ON DELETE RESTRICT,
      FOREIGN KEY(checkpoint_id) REFERENCES compaction_checkpoints(id) ON DELETE RESTRICT,
      FOREIGN KEY(baseline_snapshot_id) REFERENCES workspace_snapshot_manifests(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshot_anchors_target
      ON workspace_snapshot_restore_anchors(workspace_id, thread_id, target_turn_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_snapshot_restore_requests (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      anchor_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      expected_workspace_fingerprint TEXT NOT NULL,
      expected_provenance_watermark TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('requested', 'validating', 'fenced', 'staged', 'committing', 'verifying', 'committed', 'recovery_required', 'conflict', 'failed', 'expired')),
      fencing_epoch INTEGER NOT NULL DEFAULT 0,
      journal_entry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      confirmation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(anchor_id) REFERENCES workspace_snapshot_restore_anchors(id) ON DELETE RESTRICT,
      FOREIGN KEY(snapshot_id) REFERENCES workspace_snapshot_manifests(id) ON DELETE RESTRICT,
      UNIQUE(workspace_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS workspace_snapshot_restore_confirmations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      anchor_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'confirmed', 'denied', 'expired')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(anchor_id) REFERENCES workspace_snapshot_restore_anchors(id) ON DELETE RESTRICT,
      FOREIGN KEY(snapshot_id) REFERENCES workspace_snapshot_manifests(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshot_confirmations_target
      ON workspace_snapshot_restore_confirmations(workspace_id, anchor_id, snapshot_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_snapshot_restore_requests_workspace
      ON workspace_snapshot_restore_requests(workspace_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS workspace_snapshot_restore_journal (
      id TEXT PRIMARY KEY,
      restore_request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      expected_before_sha256 TEXT,
      expected_after_sha256 TEXT,
      rollback_blob_sha256 TEXT,
      rollback_symlink_target TEXT,
      target_blob_sha256 TEXT,
      target_symlink_target TEXT,
      rollback_mode INTEGER,
      target_mode INTEGER,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('file', 'directory', 'symlink')),
      target_exists INTEGER NOT NULL DEFAULT 1 CHECK(target_exists IN (0, 1)),
      state TEXT NOT NULL CHECK(state IN ('pending', 'applied', 'rolled_back', 'conflict', 'failed')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(restore_request_id) REFERENCES workspace_snapshot_restore_requests(id) ON DELETE CASCADE,
      UNIQUE(restore_request_id, sequence),
      UNIQUE(restore_request_id, relative_path)
    );

    CREATE TABLE IF NOT EXISTS workspace_snapshot_fences (
      workspace_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL DEFAULT 0,
      owner_request_id TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  if (!hasColumn(input.database, "workspace_snapshot_restore_journal", "target_exists")) {
    input.database.exec("ALTER TABLE workspace_snapshot_restore_journal ADD COLUMN target_exists INTEGER NOT NULL DEFAULT 1 CHECK(target_exists IN (0, 1));");
  }
  if (!hasColumn(input.database, "workspace_snapshot_restore_requests", "confirmation_id")) {
    input.database.exec("ALTER TABLE workspace_snapshot_restore_requests ADD COLUMN confirmation_id TEXT;");
  }
  const manifestColumns: ReadonlyArray<readonly [string, string]> = [
    ["schema_version", "INTEGER NOT NULL DEFAULT 1"],
    ["capture_cwd", "TEXT"],
    ["capture_kind", "TEXT"],
    ["source_turn_id", "TEXT"],
    ["source_run_id", "TEXT"],
    ["source_checkpoint_id", "TEXT"],
    ["exclusion_policy_sha256", "TEXT"],
    ["managed_entry_count", "INTEGER"],
    ["excluded_entry_count", "INTEGER"],
    ["managed_bytes", "INTEGER"],
    ["workspace_fingerprint_sha256", "TEXT"],
    ["manifest_sha256", "TEXT"],
  ];
  for (const [column, definition] of manifestColumns) {
    if (!hasColumn(input.database, "workspace_snapshot_manifests", column)) {
      input.database.exec(`ALTER TABLE workspace_snapshot_manifests ADD COLUMN ${column} ${definition};`);
    }
  }
  const entryColumns: ReadonlyArray<readonly [string, string]> = [
    ["managed", "INTEGER NOT NULL DEFAULT 1 CHECK(managed IN (0, 1))"],
    ["exclusion_reason", "TEXT"],
    ["symlink_target", "TEXT"],
  ];
  for (const [column, definition] of entryColumns) {
    if (!hasColumn(input.database, "workspace_snapshot_entries", column)) {
      input.database.exec(`ALTER TABLE workspace_snapshot_entries ADD COLUMN ${column} ${definition};`);
    }
  }
  const journalColumns: ReadonlyArray<readonly [string, string]> = [
    ["rollback_symlink_target", "TEXT"],
    ["target_symlink_target", "TEXT"],
    ["rollback_mode", "INTEGER"],
    ["target_mode", "INTEGER"],
  ];
  for (const [column, definition] of journalColumns) {
    if (!hasColumn(input.database, "workspace_snapshot_restore_journal", column)) {
      input.database.exec(`ALTER TABLE workspace_snapshot_restore_journal ADD COLUMN ${column} ${definition};`);
    }
  }
  ensureManifestConstraint(input.database);
  ensureSymlinkEntryConstraint(input.database);
  ensureSymlinkJournalConstraint(input.database);
  ensureRestoreRequestConstraint(input.database);
  ensureAnchorLineageNullable(input.database);
  input.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_snapshot_restore_confirmation_once ON workspace_snapshot_restore_requests(confirmation_id) WHERE confirmation_id IS NOT NULL;");
  if (!input.hasMigration(WORKSPACE_SNAPSHOT_MIGRATION_VERSION)) {
    input.recordMigration(WORKSPACE_SNAPSHOT_MIGRATION_VERSION, WORKSPACE_SNAPSHOT_MIGRATION_NAME);
  }
  return true;
}

function hasColumn(database: DatabaseSync, tableName: string, columnName: string): boolean {
  return (database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>).some((row) => row.name === columnName);
}

function hasNullableAnchorLineage(database: DatabaseSync): boolean {
  const columns = database.prepare("PRAGMA table_info(workspace_snapshot_restore_anchors)").all() as Array<Record<string, unknown>>;
  return ["thread_id", "target_turn_id", "checkpoint_id"].every((name) => columns.some((column) => column.name === name && Number(column.notnull) === 0));
}

function tableSql(database: DatabaseSync, tableName: string): string {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" ? row.sql : "";
}

function ensureSymlinkEntryConstraint(database: DatabaseSync): void {
  if (tableSql(database, "workspace_snapshot_entries").includes("'symlink'")) return;
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS idx_workspace_snapshot_entries_manifest;
    CREATE TABLE workspace_snapshot_entries_next (
      id TEXT PRIMARY KEY,
      manifest_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('file', 'directory', 'symlink')),
      managed INTEGER NOT NULL DEFAULT 1 CHECK(managed IN (0, 1)),
      exclusion_reason TEXT,
      symlink_target TEXT,
      mode INTEGER,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT,
      blob_sha256 TEXT,
      FOREIGN KEY(manifest_id) REFERENCES workspace_snapshot_manifests(id) ON DELETE CASCADE,
      UNIQUE(manifest_id, relative_path)
    );
    INSERT INTO workspace_snapshot_entries_next (
      id, manifest_id, relative_path, kind, managed, exclusion_reason, symlink_target,
      mode, size_bytes, sha256, blob_sha256
    ) SELECT id, manifest_id, relative_path, kind, managed, exclusion_reason, symlink_target,
      mode, size_bytes, sha256, blob_sha256 FROM workspace_snapshot_entries;
    DROP TABLE workspace_snapshot_entries;
    ALTER TABLE workspace_snapshot_entries_next RENAME TO workspace_snapshot_entries;
    CREATE INDEX idx_workspace_snapshot_entries_manifest ON workspace_snapshot_entries(manifest_id, relative_path);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureManifestConstraint(database: DatabaseSync): void {
  if (tableSql(database, "workspace_snapshot_manifests").includes("'committed'")) return;
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE workspace_snapshot_manifests_next (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      canonical_root TEXT NOT NULL,
      format_version INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL CHECK(state IN ('capturing', 'committed', 'sealed', 'snapshot_unverified', 'expired', 'corrupt', 'deleted')),
      fingerprint TEXT NOT NULL,
      provenance_watermark TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      sealed_at TEXT,
      expires_at TEXT,
      failure_reason TEXT,
      schema_version INTEGER NOT NULL DEFAULT 1,
      capture_cwd TEXT,
      capture_kind TEXT,
      source_turn_id TEXT,
      source_run_id TEXT,
      source_checkpoint_id TEXT,
      exclusion_policy_sha256 TEXT,
      managed_entry_count INTEGER,
      excluded_entry_count INTEGER,
      managed_bytes INTEGER,
      workspace_fingerprint_sha256 TEXT,
      manifest_sha256 TEXT
    );
    INSERT INTO workspace_snapshot_manifests_next SELECT id, workspace_id, cwd, canonical_root, format_version, state,
      fingerprint, provenance_watermark, entry_count, total_bytes, created_at, sealed_at, expires_at, failure_reason,
      schema_version, capture_cwd, capture_kind, source_turn_id, source_run_id, source_checkpoint_id,
      exclusion_policy_sha256, managed_entry_count, excluded_entry_count, managed_bytes, workspace_fingerprint_sha256, manifest_sha256
      FROM workspace_snapshot_manifests;
    DROP TABLE workspace_snapshot_manifests;
    ALTER TABLE workspace_snapshot_manifests_next RENAME TO workspace_snapshot_manifests;
    CREATE INDEX idx_workspace_snapshot_manifests_workspace_created ON workspace_snapshot_manifests(workspace_id, created_at DESC, id DESC);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureSymlinkJournalConstraint(database: DatabaseSync): void {
  if (tableSql(database, "workspace_snapshot_restore_journal").includes("'symlink'")) return;
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE workspace_snapshot_restore_journal_next (
      id TEXT PRIMARY KEY,
      restore_request_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      relative_path TEXT NOT NULL,
      expected_before_sha256 TEXT,
      expected_after_sha256 TEXT,
      rollback_blob_sha256 TEXT,
      rollback_symlink_target TEXT,
      target_blob_sha256 TEXT,
      target_symlink_target TEXT,
      rollback_mode INTEGER,
      target_mode INTEGER,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('file', 'directory', 'symlink')),
      target_exists INTEGER NOT NULL DEFAULT 1 CHECK(target_exists IN (0, 1)),
      state TEXT NOT NULL CHECK(state IN ('pending', 'applied', 'rolled_back', 'conflict', 'failed')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(restore_request_id) REFERENCES workspace_snapshot_restore_requests(id) ON DELETE CASCADE,
      UNIQUE(restore_request_id, sequence),
      UNIQUE(restore_request_id, relative_path)
    );
    INSERT INTO workspace_snapshot_restore_journal_next (
      id, restore_request_id, sequence, relative_path, expected_before_sha256,
      expected_after_sha256, rollback_blob_sha256, rollback_symlink_target,
      target_blob_sha256, target_symlink_target, rollback_mode, target_mode,
      target_kind, target_exists, state, updated_at
    ) SELECT id, restore_request_id, sequence, relative_path, expected_before_sha256,
      expected_after_sha256, rollback_blob_sha256, rollback_symlink_target,
      target_blob_sha256, target_symlink_target, rollback_mode, target_mode,
      target_kind, target_exists, state, updated_at
      FROM workspace_snapshot_restore_journal;
    DROP TABLE workspace_snapshot_restore_journal;
    ALTER TABLE workspace_snapshot_restore_journal_next RENAME TO workspace_snapshot_restore_journal;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureRestoreRequestConstraint(database: DatabaseSync): void {
  const sql = tableSql(database, "workspace_snapshot_restore_requests");
  if (sql.includes("'fenced'") && sql.includes("'staged'") && sql.includes("'committing'") && sql.includes("'verifying'") && !sql.includes("'prepared'") && !sql.includes("'applying'")) return;
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    DROP INDEX IF EXISTS idx_workspace_snapshot_restore_requests_workspace;
    DROP INDEX IF EXISTS idx_workspace_snapshot_restore_confirmation_once;
    CREATE TABLE workspace_snapshot_restore_requests_next (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      anchor_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      expected_workspace_fingerprint TEXT NOT NULL,
      expected_provenance_watermark TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('requested', 'validating', 'fenced', 'staged', 'committing', 'verifying', 'committed', 'recovery_required', 'conflict', 'failed', 'expired')),
      fencing_epoch INTEGER NOT NULL DEFAULT 0,
      journal_entry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      confirmation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(anchor_id) REFERENCES workspace_snapshot_restore_anchors(id) ON DELETE RESTRICT,
      FOREIGN KEY(snapshot_id) REFERENCES workspace_snapshot_manifests(id) ON DELETE RESTRICT,
      UNIQUE(workspace_id, idempotency_key)
    );
    INSERT INTO workspace_snapshot_restore_requests_next (
      id, idempotency_key, workspace_id, anchor_id, snapshot_id,
      expected_workspace_fingerprint, expected_provenance_watermark, state,
      fencing_epoch, journal_entry_count, last_error, confirmation_id, created_at, updated_at
    ) SELECT id, idempotency_key, workspace_id, anchor_id, snapshot_id,
      expected_workspace_fingerprint, expected_provenance_watermark, state,
      fencing_epoch, journal_entry_count, last_error, confirmation_id, created_at, updated_at
      FROM workspace_snapshot_restore_requests;
    DROP TABLE workspace_snapshot_restore_requests;
    ALTER TABLE workspace_snapshot_restore_requests_next RENAME TO workspace_snapshot_restore_requests;
    CREATE INDEX idx_workspace_snapshot_restore_requests_workspace
      ON workspace_snapshot_restore_requests(workspace_id, updated_at DESC, id DESC);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureAnchorLineageNullable(database: DatabaseSync): void {
  if (hasNullableAnchorLineage(database)) return;
  const referencesAvailable = ["ling_threads", "ling_turns", "compaction_checkpoints", "workspace_snapshot_manifests"].every((tableName) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)));
  const foreignKeys = referencesAvailable ? `,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(target_turn_id) REFERENCES ling_turns(id) ON DELETE RESTRICT,
      FOREIGN KEY(checkpoint_id) REFERENCES compaction_checkpoints(id) ON DELETE RESTRICT,
      FOREIGN KEY(baseline_snapshot_id) REFERENCES workspace_snapshot_manifests(id) ON DELETE RESTRICT` : "";
  database.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE workspace_snapshot_restore_anchors_next (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      thread_id TEXT,
      target_turn_id TEXT,
      checkpoint_id TEXT,
      baseline_snapshot_id TEXT NOT NULL,
      baseline_fingerprint TEXT NOT NULL,
      baseline_provenance_watermark TEXT NOT NULL,
      expected_workspace_fingerprint TEXT NOT NULL,
      expected_provenance_watermark TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT${foreignKeys}
    );
    INSERT INTO workspace_snapshot_restore_anchors_next (
      id, workspace_id, thread_id, target_turn_id, checkpoint_id,
      baseline_snapshot_id, baseline_fingerprint, baseline_provenance_watermark,
      expected_workspace_fingerprint, expected_provenance_watermark, created_at, expires_at
    ) SELECT id, workspace_id, thread_id, target_turn_id, checkpoint_id,
      baseline_snapshot_id, baseline_fingerprint, baseline_provenance_watermark,
      expected_workspace_fingerprint, expected_provenance_watermark, created_at, expires_at
      FROM workspace_snapshot_restore_anchors;
    DROP TABLE workspace_snapshot_restore_anchors;
    ALTER TABLE workspace_snapshot_restore_anchors_next RENAME TO workspace_snapshot_restore_anchors;
    CREATE INDEX idx_workspace_snapshot_anchors_target
      ON workspace_snapshot_restore_anchors(workspace_id, thread_id, target_turn_id, created_at DESC);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

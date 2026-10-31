import type { SqliteRunStoreMigrationContext } from "./migrations.js";

const version = 190;
const name = "conversation_empty_fork_boundary";
const columns = "id, workspace_id, thread_id, segment_id, projection_version, through_item_sequence, summary_ids_json, source_refs_json, policy_version, created_at, snapshot_use, payload_version, source_item_id, payload_json, payload_fingerprint";
const indexDefinitions = [
  "CREATE INDEX idx_conversation_context_snapshots_thread_created ON conversation_context_snapshots(thread_id, created_at)",
  "CREATE UNIQUE INDEX idx_conversation_accepted_input_source_use ON conversation_context_snapshots(workspace_id, source_item_id, snapshot_use) WHERE source_item_id IS NOT NULL",
];
const normalize = (sql: string) => sql.replace(/[\s";]/gu, "").toLowerCase();
const emptyCheck = "CHECK(segment_id IS NOT NULL OR (snapshot_use = 'fork_context' AND through_item_sequence = 0 AND summary_ids_json = '[]'))";

/** Preserve snapshots and accepted-input payloads; only empty fork origins may lack a segment. */
export function applyConversationEmptyForkMigration(context: SqliteRunStoreMigrationContext): void {
  const db = context.database;
  const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
  if (markers.some(row => row.version !== version || row.name !== name) || markers.length > 1
    || Boolean(markers.length) !== context.hasMigration(version)) {
    throw new Error("conversation_empty_fork_migration_marker_conflict");
  }
  const actualColumns = db.prepare("PRAGMA table_info(conversation_context_snapshots)").all();
  const expectedColumns = columns.split(", ");
  if (actualColumns.length !== expectedColumns.length || actualColumns.some(row => !expectedColumns.includes(String(row.name)))) {
    throw new Error("conversation_empty_fork_migration_source_schema_conflict");
  }
  const segment = actualColumns.find(row => row.name === "segment_id");
  const indexes = db.prepare("SELECT name,sql,type FROM sqlite_master WHERE tbl_name='conversation_context_snapshots' AND sql IS NOT NULL AND type <> 'table'").all();
  if (indexes.length !== indexDefinitions.length || indexes.some(row => row.type !== "index"
    || !indexDefinitions.some(sql => normalize(sql) === normalize(String(row.sql))))) {
    throw new Error("conversation_empty_fork_migration_indexes_conflict");
  }
  if (markers.length) {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_context_snapshots'").get();
    if (!segment || segment.notnull !== 0 || !normalize(String(table?.sql)).includes(normalize(emptyCheck))) {
      throw new Error("conversation_empty_fork_migration_schema_conflict");
    }
    return;
  }
  if (!segment || segment.notnull !== 1) throw new Error("conversation_empty_fork_migration_source_conflict");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE conversation_context_snapshots_v190 (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      segment_id TEXT, projection_version TEXT NOT NULL, through_item_sequence INTEGER NOT NULL,
      summary_ids_json TEXT NOT NULL, source_refs_json TEXT NOT NULL, policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL, snapshot_use TEXT NOT NULL DEFAULT 'fork_context',
      payload_version INTEGER, source_item_id TEXT, payload_json TEXT, payload_fingerprint TEXT,
      ${emptyCheck},
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES ling_threads(id) ON DELETE CASCADE,
      FOREIGN KEY(segment_id) REFERENCES context_segments(id) ON DELETE CASCADE
    )`);
    db.exec(`INSERT INTO conversation_context_snapshots_v190 (${columns}) SELECT ${columns} FROM conversation_context_snapshots`);
    db.exec("DROP TABLE conversation_context_snapshots");
    db.exec("ALTER TABLE conversation_context_snapshots_v190 RENAME TO conversation_context_snapshots");
    for (const sql of indexDefinitions) db.exec(sql);
    if (db.prepare("PRAGMA foreign_key_check(conversation_context_snapshots)").all().length) {
      throw new Error("conversation_empty_fork_migration_foreign_key_conflict");
    }
    context.recordMigration(version, name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

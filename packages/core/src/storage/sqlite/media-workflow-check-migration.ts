import type { DatabaseSync } from "node:sqlite";

export const MEDIA_WORKFLOW_CHECK_MIGRATION_VERSION = 162;
const MIGRATION_NAME = "add_media_workflow_connection_check_authority";
const SCHEMA = [
  { name: "media_workflow_connection_check_authorities", type: "table", sql: `CREATE TABLE media_workflow_connection_check_authorities (
    connection_id TEXT PRIMARY KEY,
    config_revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(config_revision)='integer' AND config_revision BETWEEN 1 AND 9007199254740991),
    request_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(request_revision)='integer' AND request_revision BETWEEN 0 AND 9007199254740991),
    published_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(published_revision)='integer' AND published_revision BETWEEN 0 AND request_revision)
  )` },
  { name: "media_workflow_check_insert", type: "trigger", sql: `CREATE TRIGGER media_workflow_check_insert AFTER INSERT ON media_workflow_connections BEGIN
    INSERT INTO media_workflow_connection_check_authorities(connection_id) VALUES (NEW.id)
      ON CONFLICT(connection_id) DO UPDATE SET config_revision=config_revision+1;
  END` },
  { name: "media_workflow_check_update", type: "trigger", sql: `CREATE TRIGGER media_workflow_check_update
    AFTER UPDATE OF id, workspace_id, name, adapter_kind, base_url, auth_mode, secret_ref, network_policy, protocol_variant, created_at
    ON media_workflow_connections BEGIN
    UPDATE media_workflow_connection_check_authorities SET config_revision=config_revision+1 WHERE connection_id=OLD.id;
    INSERT INTO media_workflow_connection_check_authorities(connection_id) SELECT NEW.id WHERE NEW.id != OLD.id
      ON CONFLICT(connection_id) DO UPDATE SET config_revision=config_revision+1;
    UPDATE media_workflow_connections SET status=CASE WHEN NEW.status='disabled' THEN 'disabled' ELSE 'unchecked' END,
      health_json=NULL WHERE id=NEW.id;
  END` },
  { name: "media_workflow_check_delete", type: "trigger", sql: `CREATE TRIGGER media_workflow_check_delete AFTER DELETE ON media_workflow_connections BEGIN
    UPDATE media_workflow_connection_check_authorities SET config_revision=config_revision+1 WHERE connection_id=OLD.id;
  END` },
] as const;

/** Keep tombstones and reject ambiguous history instead of resetting authority. */
export function applyMediaWorkflowCheckMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const markers = database.prepare("SELECT version, name FROM schema_migrations WHERE version=? OR name=?")
    .all(MEDIA_WORKFLOW_CHECK_MIGRATION_VERSION, MIGRATION_NAME);
  const objects = database.prepare(`SELECT name, type, sql FROM sqlite_master WHERE name IN (${SCHEMA.map(() => "?").join(",")})`)
    .all(...SCHEMA.map(object => object.name));
  const marked = input.hasMigration(MEDIA_WORKFLOW_CHECK_MIGRATION_VERSION);
  if (markers.some(row => row.version !== MEDIA_WORKFLOW_CHECK_MIGRATION_VERSION || row.name !== MIGRATION_NAME)
    || markers.length > 1 || marked !== (markers.length === 1)
    || (marked ? objects.length !== SCHEMA.length || SCHEMA.some(expected => {
      const actual = objects.find(object => object.name === expected.name);
      return !actual || actual.type !== expected.type || canonicalSql(String(actual.sql)) !== canonicalSql(expected.sql);
    }) : objects.length !== 0)) {
    throw new Error("Media workflow check migration conflicts with existing history.");
  }
  if (marked) return;
  database.exec("SAVEPOINT media_workflow_check_migration");
  try {
    for (const object of SCHEMA) database.exec(object.sql);
    database.exec("INSERT INTO media_workflow_connection_check_authorities(connection_id) SELECT id FROM media_workflow_connections");
    input.recordMigration(MEDIA_WORKFLOW_CHECK_MIGRATION_VERSION, MIGRATION_NAME);
    database.exec("RELEASE media_workflow_check_migration");
  } catch (error) {
    database.exec("ROLLBACK TO media_workflow_check_migration");
    database.exec("RELEASE media_workflow_check_migration");
    throw error;
  }
}

function canonicalSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

import type { DatabaseSync } from "node:sqlite";

export const PROVIDER_CHECK_MIGRATION_VERSION = 156;
const MIGRATION_NAME = "add_provider_check_publication_authority";
const SCHEMA = providerCheckSchema();

/** Tombstones survive deletion; triggers also protect direct SQLite configuration writes. */
export function applyProviderCheckMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const markers = database.prepare("SELECT version, name FROM schema_migrations WHERE version = ? OR name = ?")
    .all(PROVIDER_CHECK_MIGRATION_VERSION, MIGRATION_NAME);
  const objects = database.prepare(`SELECT name, type, sql FROM sqlite_master WHERE name IN (${SCHEMA.map(() => "?").join(",")})`)
    .all(...SCHEMA.map(object => object.name));
  const marked = input.hasMigration(PROVIDER_CHECK_MIGRATION_VERSION);
  if (markers.some(row => row.version !== PROVIDER_CHECK_MIGRATION_VERSION || row.name !== MIGRATION_NAME)
    || markers.length > 1 || marked !== (markers.length === 1)
    || (marked ? objects.length !== SCHEMA.length || SCHEMA.some(expected => {
      const actual = objects.find(object => object.name === expected.name);
      return !actual || actual.type !== expected.type || canonicalSql(String(actual.sql)) !== canonicalSql(expected.sql);
    }) : objects.length !== 0)) {
    throw new Error("Provider check migration conflicts with existing history.");
  }
  if (marked) return;
  database.exec("SAVEPOINT provider_check_migration");
  try {
    for (const object of SCHEMA) database.exec(object.sql);
    database.exec("INSERT INTO provider_check_authorities(provider_id) SELECT id FROM provider_presets");
    input.recordMigration(PROVIDER_CHECK_MIGRATION_VERSION, MIGRATION_NAME);
    database.exec("RELEASE provider_check_migration");
  } catch (error) {
    database.exec("ROLLBACK TO provider_check_migration");
    database.exec("RELEASE provider_check_migration");
    throw error;
  }
}

function providerCheckSchema(): readonly { readonly name: string; readonly type: "table" | "trigger"; readonly sql: string }[] {
  const objects: { name: string; type: "table" | "trigger"; sql: string }[] = [
    { name: "provider_check_authorities", type: "table", sql: `CREATE TABLE provider_check_authorities (
      provider_id TEXT PRIMARY KEY,
      config_revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(config_revision)='integer' AND config_revision BETWEEN 1 AND 9007199254740991),
      request_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(request_revision)='integer' AND request_revision BETWEEN 0 AND 9007199254740991),
      published_revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(published_revision)='integer' AND published_revision BETWEEN 0 AND request_revision),
      request_source TEXT CHECK(request_source IN ('manual', 'startup', 'model_import'))
    )` },
    { name: "provider_check_insert", type: "trigger", sql: `CREATE TRIGGER provider_check_insert AFTER INSERT ON provider_presets BEGIN
        INSERT INTO provider_check_authorities(provider_id) VALUES (NEW.id)
          ON CONFLICT(provider_id) DO UPDATE SET config_revision=config_revision+1;
      END` },
    { name: "provider_check_update", type: "trigger", sql: `CREATE TRIGGER provider_check_update AFTER UPDATE OF id, kind, display_name, provider_id, model, api,
        provider_transport, base_url, api_key_ref, headers_json, secret_header_refs_json, auth_header,
        reasoning, thinking_modes_json, input_json, context_window, max_tokens, compat_json,
        capabilities_json, enabled, created_at, updated_at ON provider_presets BEGIN
        UPDATE provider_check_authorities SET config_revision=config_revision+1 WHERE provider_id=OLD.id;
        INSERT INTO provider_check_authorities(provider_id) SELECT NEW.id WHERE NEW.id != OLD.id
          ON CONFLICT(provider_id) DO UPDATE SET config_revision=config_revision+1;
        UPDATE provider_presets SET last_check_json=NULL WHERE id=NEW.id;
      END` },
    { name: "provider_check_delete", type: "trigger", sql: `CREATE TRIGGER provider_check_delete AFTER DELETE ON provider_presets BEGIN
        UPDATE provider_check_authorities SET config_revision=config_revision+1 WHERE provider_id=OLD.id;
      END` },
  ];
  for (const [suffix, operation, rows] of [["insert", "INSERT", ["NEW"]], ["update", "UPDATE", ["OLD", "NEW"]], ["delete", "DELETE", ["OLD"]]] as const) {
    const predicate = rows.map(row => `(api_key_ref = 'local:' || ${row}.provider_id OR EXISTS (
      SELECT 1 FROM json_each(secret_header_refs_json) WHERE value = 'local:' || ${row}.provider_id))`).join(" OR ");
    objects.push({ name: `provider_check_secret_${suffix}`, type: "trigger",
      sql: `CREATE TRIGGER provider_check_secret_${suffix} AFTER ${operation} ON provider_secrets BEGIN
        UPDATE provider_check_authorities SET config_revision=config_revision+1
          WHERE provider_id IN (SELECT id FROM provider_presets WHERE ${predicate});
        UPDATE provider_presets SET last_check_json=NULL WHERE ${predicate};
      END` });
  }
  return objects;
}

function canonicalSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

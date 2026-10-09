import type { DatabaseSync } from "node:sqlite";

export const AVAILABILITY_INCIDENT_PROVENANCE_MIGRATION_VERSION = 157;
const MIGRATION_NAME = "add_availability_incident_provenance";
const TABLE = "channel_team_incident_provenance";
const SCHEMA: readonly { readonly name: string; readonly type: "table" | "trigger" | "index"; readonly sql: string }[] = [
  { name: TABLE, type: "table", sql: `CREATE TABLE ${TABLE} (
    incident_id TEXT PRIMARY KEY REFERENCES channel_team_incidents(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK(provenance IN ('generic', 'provider_runtime')),
    source_json TEXT,
    CHECK((provenance = 'generic' AND source_json IS NULL)
      OR (provenance = 'provider_runtime' AND source_json IS NOT NULL AND json_valid(source_json)))
  )` },
  ...(["INSERT", "UPDATE"] as const).map(operation => ({
    name: `channel_team_incident_provenance_${operation.toLowerCase()}`,
    type: "trigger" as const,
    sql: `CREATE TRIGGER channel_team_incident_provenance_${operation.toLowerCase()} BEFORE ${operation} ON ${TABLE} BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM channel_team_incidents WHERE id = NEW.incident_id
        AND workspace_id = NEW.workspace_id AND incident_type = 'availability')
        THEN RAISE(ABORT, 'availability incident provenance owner mismatch') END;
    END`,
  })),
  { name: "idx_availability_candidates_time", type: "index", sql: `CREATE INDEX idx_availability_candidates_time
    ON channel_team_incidents(workspace_id, incident_type, observed_at DESC)` },
];

/** Add only a private sidecar; absent historical provenance stays unclassified, with no backfill. */
export function applyAvailabilityIncidentProvenanceMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const markers = database.prepare("SELECT version, name FROM schema_migrations WHERE version = ? OR name = ?")
    .all(AVAILABILITY_INCIDENT_PROVENANCE_MIGRATION_VERSION, MIGRATION_NAME);
  const objects = database.prepare(`SELECT name, type, sql FROM sqlite_master WHERE name IN (${SCHEMA.map(() => "?").join(",")})`)
    .all(...SCHEMA.map(object => object.name));
  const marked = input.hasMigration(AVAILABILITY_INCIDENT_PROVENANCE_MIGRATION_VERSION);
  if (markers.some(row => row.version !== AVAILABILITY_INCIDENT_PROVENANCE_MIGRATION_VERSION || row.name !== MIGRATION_NAME)
    || markers.length > 1 || marked !== (markers.length === 1)
    || (marked ? objects.length !== SCHEMA.length || SCHEMA.some(expected => {
      const actual = objects.find(object => object.name === expected.name);
      return !actual || actual.type !== expected.type || canonicalSql(String(actual.sql)) !== canonicalSql(expected.sql);
    }) : objects.length !== 0)) throw new Error("Availability incident provenance migration conflicts with existing history.");
  if (marked) return;
  database.exec("SAVEPOINT availability_incident_provenance_migration");
  try {
    for (const object of SCHEMA) database.exec(object.sql);
    input.recordMigration(AVAILABILITY_INCIDENT_PROVENANCE_MIGRATION_VERSION, MIGRATION_NAME);
    database.exec("RELEASE availability_incident_provenance_migration");
  } catch (error) {
    database.exec("ROLLBACK TO availability_incident_provenance_migration");
    database.exec("RELEASE availability_incident_provenance_migration");
    throw error;
  }
}

function canonicalSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

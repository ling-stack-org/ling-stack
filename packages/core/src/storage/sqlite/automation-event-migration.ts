import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const AUTOMATION_EVENT_MIGRATION_VERSION = 221;
const name = "create_automation_event_ingress_and_delivery";
const definitions = [
  ["automation_event_sources", `CREATE TABLE automation_event_sources (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, source_json TEXT NOT NULL)`],
  ["automation_events", `CREATE TABLE automation_events (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES automation_event_sources(id), external_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL, received_at TEXT NOT NULL, envelope_json TEXT NOT NULL,
    UNIQUE(source_id,external_id))`],
  ["automation_event_dispatches", `CREATE TABLE automation_event_dispatches (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES automation_events(id),
    source_id TEXT NOT NULL REFERENCES automation_event_sources(id), source_revision INTEGER NOT NULL,
    automation_id TEXT NOT NULL REFERENCES automation_definitions(id), definition_digest TEXT NOT NULL,
    destinations_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','dispatching','linked','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT, automation_run_id TEXT, error TEXT,
    delivery_enqueued INTEGER NOT NULL DEFAULT 0,
    UNIQUE(event_id,automation_id))`],
  ["automation_deliveries", `CREATE TABLE automation_deliveries (
    id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL REFERENCES automation_event_dispatches(id),
    run_id TEXT NOT NULL REFERENCES run_sessions(id), destination_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','sending','delivered','unknown','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, lease_token TEXT, receipt TEXT,
    updated_at TEXT NOT NULL, UNIQUE(dispatch_id,destination_id))`],
  ["automation_delivery_receipts", `CREATE TABLE automation_delivery_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL REFERENCES automation_deliveries(id),
    status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`],
  ["idx_automation_event_pending", "CREATE INDEX idx_automation_event_pending ON automation_event_dispatches(status,lease_until)"],
  ["idx_automation_event_rate", "CREATE INDEX idx_automation_event_rate ON automation_events(source_id,received_at)"],
  ["idx_automation_delivery_pending", "CREATE INDEX idx_automation_delivery_pending ON automation_deliveries(status,available_at)"],
] as const;
const normalize = (sql: string) => sql.trim().replace(/;$/, "").replace(/\s+/g, " ");

export function applyAutomationEventMigration(input: { database: DatabaseSync; hasMigration(version: number): boolean;
  recordMigration(version: number, name: string): void }): void {
  const db = input.database;
  const inspect = () => {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(AUTOMATION_EVENT_MIGRATION_VERSION, name);
    if (markers.length > 1 || markers.some(row => row.version !== AUTOMATION_EVENT_MIGRATION_VERSION || row.name !== name)) throw new Error("automation_event_migration_marker_conflict");
    for (const [id, sql] of definitions) {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(id);
      if (row && (typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql))) throw new Error("automation_event_migration_schema_conflict");
      if (markers.length && !row) throw new Error("automation_event_migration_schema_missing");
    }
    return markers.length > 0;
  };
  if (inspect()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const [id, sql] of definitions) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(id)) db.exec(sql);
      input.recordMigration(AUTOMATION_EVENT_MIGRATION_VERSION, name);
    }
    if (!inspect()) throw new Error("automation_event_migration_postcondition");
    db.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}

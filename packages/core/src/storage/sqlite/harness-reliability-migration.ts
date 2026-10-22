import type { DatabaseSync } from "node:sqlite";
import { HARNESS_PROJECTION_DOMAINS } from "../../harness/reliability.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { HARNESS_PROJECTION_EMPTY_DIGEST, harnessProjectionSources } from "./harness-reliability-schema.js";

export const HARNESS_RELIABILITY_MIGRATION_VERSION = 177;
export const HARNESS_RELIABILITY_MIGRATION_NAME = "create_harness_reliability_checkpoints_and_retention";

interface MigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}
interface Definition { readonly name: string; readonly sql: string }
const max = "9007199254740990";
const definitions: readonly Definition[] = [{
  name: "harness_projection_checkpoints",
  sql: `CREATE TABLE harness_projection_checkpoints (
    domain TEXT PRIMARY KEY NOT NULL CHECK(domain IN ('continuation','tool_execution','evaluation','delegation')),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND ${max}),
    source_epoch INTEGER NOT NULL CHECK(typeof(source_epoch)='integer' AND source_epoch BETWEEN 0 AND ${max}),
    built_epoch INTEGER NOT NULL CHECK(typeof(built_epoch)='integer' AND built_epoch BETWEEN 0 AND ${max}),
    state TEXT NOT NULL CHECK(state IN ('stale','rebuilding','ready','failed')),
    row_count INTEGER NOT NULL CHECK(typeof(row_count)='integer' AND row_count BETWEEN 0 AND ${max}),
    digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
    cursor TEXT,
    failure_code TEXT,
    updated_at TEXT NOT NULL
  )`,
}, {
  name: "harness_projection_rows",
  sql: `CREATE TABLE harness_projection_rows (
    domain TEXT NOT NULL REFERENCES harness_projection_checkpoints(domain) ON DELETE RESTRICT,
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND ${max}),
    source_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB))<16384),
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY(domain,generation,source_id)
  )`,
}, {
  name: "harness_artifact_retention",
  sql: `CREATE TABLE harness_artifact_retention (
    artifact_id TEXT PRIMARY KEY NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    retain_until TEXT NOT NULL,
    enrolled_at TEXT NOT NULL,
    pruned_at TEXT
  )`,
}, {
  name: "harness_artifact_pins",
  sql: `CREATE TABLE harness_artifact_pins (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    holder TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('recovery','audit_hold')),
    created_at TEXT NOT NULL,
    released_at TEXT,
    PRIMARY KEY(artifact_id,holder)
  )`,
}, {
  name: "harness_artifact_pin_events",
  sql: `CREATE TABLE harness_artifact_pin_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    holder TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('pin','release')),
    reason TEXT NOT NULL CHECK(reason IN ('recovery','audit_hold')),
    created_at TEXT NOT NULL
  )`,
}, {
  name: "harness_artifact_gc_receipts",
  sql: `CREATE TABLE harness_artifact_gc_receipts (
    artifact_id TEXT PRIMARY KEY NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
    content_sha256 TEXT NOT NULL,
    body_bytes INTEGER NOT NULL CHECK(typeof(body_bytes)='integer' AND body_bytes>=0),
    pruned_at TEXT NOT NULL
  )`,
}, {
  name: "idx_harness_retention_due",
  sql: "CREATE INDEX idx_harness_retention_due ON harness_artifact_retention(artifact_id,retain_until) WHERE pruned_at IS NULL",
}, ...HARNESS_PROJECTION_DOMAINS.flatMap(domain => {
  const source = harnessProjectionSources[domain];
  return [source.table, ...source.extraEpochTables].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => {
    const name = `trg_harness_epoch_${table}_${event.toLowerCase()}`;
    return { name, sql: `CREATE TRIGGER ${name} AFTER ${event} ON ${table} BEGIN
      UPDATE harness_projection_checkpoints SET source_epoch=source_epoch+1,
        state=CASE WHEN state='ready' THEN 'stale' ELSE state END WHERE domain='${domain}';
    END` };
  }));
}), ...["INSERT", "UPDATE", "DELETE"].map(event => {
  const name = `trg_harness_projection_integrity_${event.toLowerCase()}`;
  const refs = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"];
  return { name, sql: `CREATE TRIGGER ${name} AFTER ${event} ON harness_projection_rows BEGIN
    ${refs.map(ref => `UPDATE harness_projection_checkpoints SET state='failed',
      failure_code='projection.rows_changed' WHERE domain=${ref}.domain AND state='ready';`).join("\n")}
  END` };
}), {
  name: "trg_harness_gc_receipts_no_update",
  sql: "CREATE TRIGGER trg_harness_gc_receipts_no_update BEFORE UPDATE ON harness_artifact_gc_receipts BEGIN SELECT RAISE(ABORT,'harness GC receipt is immutable'); END",
}, {
  name: "trg_harness_gc_receipts_no_delete",
  sql: "CREATE TRIGGER trg_harness_gc_receipts_no_delete BEFORE DELETE ON harness_artifact_gc_receipts BEGIN SELECT RAISE(ABORT,'harness GC receipt is immutable'); END",
}, ...["UPDATE", "DELETE"].map(event => ({
  name: `trg_harness_pin_events_no_${event.toLowerCase()}`,
  sql: `CREATE TRIGGER trg_harness_pin_events_no_${event.toLowerCase()} BEFORE ${event} ON harness_artifact_pin_events
    BEGIN SELECT RAISE(ABORT,'harness pin audit is immutable'); END`,
})), {
  name: "trg_harness_pruned_artifact_no_rehydrate",
  sql: `CREATE TRIGGER trg_harness_pruned_artifact_no_rehydrate BEFORE UPDATE ON artifacts
    WHEN EXISTS(SELECT 1 FROM harness_artifact_gc_receipts WHERE artifact_id=OLD.id)
      AND (NEW.sealed_payload_json IS NOT NULL OR NEW.content_sha256 IS NOT OLD.content_sha256)
    BEGIN SELECT RAISE(ABORT,'pruned artifact identity is immutable'); END`,
}];

/** Additive only; repairs missing derived triggers without rewriting any authority row. */
export function applyHarnessReliabilityMigration(input: MigrationInput): boolean {
  const found = new Map(input.database.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'harness_%' OR name LIKE 'trg_harness_%' OR name LIKE 'idx_harness_%'")
    .all().map(row => [String(row.name), String(row.sql)]));
  for (const definition of definitions) {
    const sql = found.get(definition.name);
    if (sql !== undefined && normalize(sql) !== normalize(definition.sql)) {
      throw new Error(`harness_reliability_schema_drift:${definition.name}`);
    }
  }
  if (input.hasMigration(HARNESS_RELIABILITY_MIGRATION_VERSION) && definitions.every(definition => found.has(definition.name))) return false;
  input.database.exec("BEGIN IMMEDIATE");
  try {
    for (const definition of definitions) if (!found.has(definition.name)) input.database.exec(definition.sql);
    for (const domain of HARNESS_PROJECTION_DOMAINS) {
      input.database.prepare(`INSERT OR IGNORE INTO harness_projection_checkpoints
        (domain,generation,source_epoch,built_epoch,state,row_count,digest,updated_at)
        VALUES (?,0,0,0,'stale',0,?,'1970-01-01T00:00:00.000Z')`).run(domain, HARNESS_PROJECTION_EMPTY_DIGEST);
    }
    // A previously missing trigger may have missed arbitrary mutations. Never trust its old watermark.
    input.database.exec("UPDATE harness_projection_checkpoints SET state='stale',failure_code=NULL");
    input.recordMigration(HARNESS_RELIABILITY_MIGRATION_VERSION, HARNESS_RELIABILITY_MIGRATION_NAME);
    input.database.exec("COMMIT");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function normalize(sql: string): string { return sql.replace(/\s+/g, " ").trim().replace(/;$/, ""); }

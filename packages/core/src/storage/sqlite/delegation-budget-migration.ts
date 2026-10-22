import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

// Native execution occupies 169–175. Never change migration 154's contract.
export const DELEGATION_BUDGET_MIGRATION_VERSION = 176;
export const DELEGATION_BUDGET_MIGRATION_NAME = "durable_delegation_budget_authority_v1";

interface Definition { readonly type: "table" | "index" | "trigger"; readonly name: string; readonly table: string; readonly sql: string }
const safe = (column: string): string => `${column} INTEGER CHECK(${column} IS NULL OR (typeof(${column})='integer' AND ${column} BETWEEN 0 AND 9007199254740991))`;
const id = (column: string, nullable = false): string => `${column} TEXT ${nullable ? "" : "NOT NULL"} CHECK(${nullable ? `${column} IS NULL OR ` : ""}(length(${column})>0 AND instr(${column},char(0))=0))`;
const digest = (column: string, nullable = false): string => `${column} TEXT ${nullable ? "" : "NOT NULL"} CHECK(${nullable ? `${column} IS NULL OR ` : ""}(length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*'))`;
const timestamp = (column: string, nullable = false): string => `${column} TEXT ${nullable ? "" : "NOT NULL"} CHECK(${nullable ? `${column} IS NULL OR ` : ""}(strftime('%Y-%m-%dT%H:%M:%fZ',${column}) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',${column})=${column}))`;

const rootTable = `CREATE TABLE delegation_root_budgets (
  ${id("root_run_id")} PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  ${id("authority_artifact_id")} UNIQUE,
  ${digest("authority_digest")},
  ${id("price_artifact_id", true)},
  ${digest("price_digest", true)},
  ${safe("token_budget")},
  ${safe("cost_budget_micros")},
  ${timestamp("deadline_at")},
  ${timestamp("frozen_at")},
  ${timestamp("created_at")},
  CHECK(deadline_at>frozen_at AND created_at=frozen_at),
  CHECK((price_artifact_id IS NULL)=(price_digest IS NULL)),
  CHECK(cost_budget_micros IS NULL OR price_artifact_id IS NOT NULL),
  FOREIGN KEY(root_run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(authority_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT,
  FOREIGN KEY(price_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
)`;

const reservationTable = `CREATE TABLE delegation_budget_reservations (
  ${id("id")} PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  ${id("root_run_id")},
  ${id("delegation_step_id")} UNIQUE,
  ${id("parent_reservation_id", true)},
  ${id("child_run_id")} UNIQUE,
  ${digest("request_digest")},
  ${safe("token_reserved")},
  ${safe("cost_reserved_micros")},
  ${timestamp("deadline_at")},
  state TEXT NOT NULL CHECK(state IN ('reserved','settled','released','unresolved')),
  ${safe("settled_token_usage")},
  ${safe("settled_cost_micros")},
  ${digest("settlement_digest", true)},
  failure_code TEXT CHECK(failure_code IS NULL OR failure_code='delegation.usage_unknown'),
  ${id("idempotency_key")} UNIQUE,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  ${timestamp("created_at")},
  ${timestamp("updated_at")},
  ${timestamp("settled_at", true)},
  CHECK(updated_at>=created_at AND deadline_at>created_at),
  CHECK((state IN ('settled','released'))=(settled_at IS NOT NULL)),
  CHECK((state IN ('settled','released'))=(settlement_digest IS NOT NULL)),
  CHECK(state<>'settled' OR settled_token_usage IS NOT NULL),
  CHECK(state IN ('settled','released') OR (settled_token_usage IS NULL AND settled_cost_micros IS NULL)),
  CHECK(state<>'released' OR (settled_token_usage=0 AND settled_cost_micros=0)),
  CHECK((state='unresolved')=(failure_code IS NOT NULL)),
  FOREIGN KEY(root_run_id) REFERENCES delegation_root_budgets(root_run_id) ON DELETE RESTRICT,
  FOREIGN KEY(delegation_step_id) REFERENCES delegation_steps(id) ON DELETE RESTRICT,
  FOREIGN KEY(parent_reservation_id) REFERENCES delegation_budget_reservations(id) ON DELETE RESTRICT,
  FOREIGN KEY(child_run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT
)`;

const chargeTable = `CREATE TABLE delegation_budget_charges (
  ${id("id")} PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  ${id("root_run_id")},
  ${id("reservation_id", true)},
  ${id("run_id")},
  ${id("attempt_id")},
  ${id("invocation_id")},
  ${digest("request_digest")},
  ${id("price_artifact_id", true)},
  ${digest("price_digest", true)},
  ${safe("reserved_tokens")},
  ${safe("reserved_cost_micros")},
  ${safe("input_tokens")},
  ${safe("cached_input_tokens")},
  ${safe("output_tokens")},
  ${safe("actual_cost_micros")},
  state TEXT NOT NULL CHECK(state IN ('reserved','measured','cancelled_before_dispatch','unresolved')),
  ${id("idempotency_key")} UNIQUE,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
  ${timestamp("created_at")},
  ${timestamp("updated_at")},
  ${timestamp("settled_at", true)},
  UNIQUE(run_id,attempt_id,invocation_id),
  CHECK(updated_at>=created_at),
  CHECK((price_artifact_id IS NULL)=(price_digest IS NULL)),
  CHECK(reserved_cost_micros IS NULL OR price_artifact_id IS NOT NULL),
  CHECK((state IN ('measured','cancelled_before_dispatch'))=(settled_at IS NOT NULL)),
  CHECK((state='measured')=(input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
  CHECK(state='measured' OR actual_cost_micros IS NULL),
  CHECK(state='measured' OR (input_tokens IS NULL AND cached_input_tokens IS NULL AND output_tokens IS NULL)),
  CHECK(state<>'measured' OR (cached_input_tokens<=input_tokens AND input_tokens+output_tokens<=9007199254740991)),
  CHECK(state<>'measured' OR (price_artifact_id IS NULL)=(actual_cost_micros IS NULL)),
  FOREIGN KEY(root_run_id) REFERENCES delegation_root_budgets(root_run_id) ON DELETE RESTRICT,
  FOREIGN KEY(reservation_id) REFERENCES delegation_budget_reservations(id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE RESTRICT,
  FOREIGN KEY(price_artifact_id) REFERENCES artifacts(id) ON DELETE RESTRICT
)`;

const tables = [
  { name: "delegation_root_budgets", sql: rootTable },
  { name: "delegation_budget_reservations", sql: reservationTable },
  { name: "delegation_budget_charges", sql: chargeTable },
] as const;

const definitions: Definition[] = tables.map(entry => ({ type: "table", table: entry.name, ...entry }));
function trigger(table: string, suffix: string, body: string): void {
  const name = `trg_${table}_${suffix}`;
  definitions.push({ type: "trigger", name, table, sql: `CREATE TRIGGER ${name} ${body}` });
}
for (const { name } of tables) {
  trigger(name, "no_delete", `BEFORE DELETE ON ${name} BEGIN SELECT RAISE(ABORT,'delegation budget facts are durable'); END`);
  const identity = name === "delegation_root_budgets" ? "root_run_id" : "id";
  trigger(name, "no_replace", `BEFORE INSERT ON ${name} WHEN EXISTS(SELECT 1 FROM ${name} WHERE ${identity}=NEW.${identity}${name === "delegation_root_budgets" ? "" : " OR idempotency_key=NEW.idempotency_key"}) BEGIN SELECT RAISE(ABORT,'delegation budget facts cannot be replaced'); END`);
}
trigger("delegation_root_budgets", "no_update", "BEFORE UPDATE ON delegation_root_budgets BEGIN SELECT RAISE(ABORT,'delegation root budget is immutable'); END");
for (const [table, identityFields, terminal] of [
  ["delegation_budget_reservations", ["id", "schema_version", "root_run_id", "delegation_step_id", "parent_reservation_id", "child_run_id", "request_digest", "token_reserved", "cost_reserved_micros", "deadline_at", "idempotency_key", "created_at"], "'settled','released'"],
  ["delegation_budget_charges", ["id", "schema_version", "root_run_id", "reservation_id", "run_id", "attempt_id", "invocation_id", "request_digest", "price_artifact_id", "price_digest", "reserved_tokens", "reserved_cost_micros", "idempotency_key", "created_at"], "'measured','cancelled_before_dispatch'"],
] as const) {
  trigger(table, "update_guard", `BEFORE UPDATE ON ${table} WHEN OLD.state IN (${terminal}) OR NEW.revision IS NOT OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR ${identityFields.map(field => `OLD.${field} IS NOT NEW.${field}`).join(" OR ")} BEGIN SELECT RAISE(ABORT,'delegation budget update identity or state is invalid'); END`);
}
trigger("delegation_budget_reservations", "lineage", `BEFORE INSERT ON delegation_budget_reservations WHEN NOT EXISTS(
  SELECT 1 FROM delegation_steps s JOIN run_sessions child ON child.id=NEW.child_run_id
  JOIN delegation_root_budgets root ON root.root_run_id=NEW.root_run_id
  WHERE s.id=NEW.delegation_step_id AND s.root_run_id=NEW.root_run_id
    AND s.state='spawning' AND s.child_run_id IS NULL AND child.parent_run_id=s.parent_run_id
    AND NEW.deadline_at<=root.deadline_at
    AND ((NEW.parent_reservation_id IS NULL AND s.parent_delegation_step_id IS NULL)
      OR EXISTS(SELECT 1 FROM delegation_budget_reservations p WHERE p.id=NEW.parent_reservation_id
        AND p.root_run_id=NEW.root_run_id AND p.delegation_step_id=s.parent_delegation_step_id
        AND p.child_run_id=s.parent_run_id AND p.state='reserved' AND NEW.deadline_at<=p.deadline_at))
) BEGIN SELECT RAISE(ABORT,'delegation reservation lineage is invalid'); END`);
trigger("delegation_budget_charges", "lineage", `BEFORE INSERT ON delegation_budget_charges WHEN NOT EXISTS(
  SELECT 1 FROM run_sessions r JOIN work_unit_attempts a ON a.work_unit_id=r.work_unit_id
  WHERE r.id=NEW.run_id AND a.id=NEW.attempt_id
    AND ((NEW.reservation_id IS NULL AND NEW.run_id=NEW.root_run_id)
      OR EXISTS(SELECT 1 FROM delegation_budget_reservations p WHERE p.id=NEW.reservation_id
        AND p.root_run_id=NEW.root_run_id AND p.child_run_id=NEW.run_id AND p.state='reserved'))
) BEGIN SELECT RAISE(ABORT,'delegation charge lineage is invalid'); END`);
for (const [name, table, columns] of [
  ["idx_delegation_reservations_root_parent", "delegation_budget_reservations", "root_run_id,parent_reservation_id"],
  ["idx_delegation_charges_root_allocation", "delegation_budget_charges", "root_run_id,reservation_id"],
] as const) definitions.push({ type: "index", name, table, sql: `CREATE INDEX ${name} ON ${table}(${columns})` });

export const DELEGATION_BUDGET_SCHEMA_OBJECTS = Object.freeze(definitions.map(({ name }) => name));

export function applyDelegationBudgetMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): boolean {
  const db = input.database;
  const recorded = marker(db);
  if (recorded !== input.hasMigration(DELEGATION_BUDGET_MIGRATION_VERSION)) throw new Error("delegation.budget_migration_marker_conflict");
  const missing = inspect(db, recorded);
  if (recorded && !missing.length) { assertData(db); return false; }
  // A rejected nested BEGIN never permits this migration to roll back its caller.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = marker(db);
    for (const entry of inspect(db, current)) db.exec(entry.sql);
    assertData(db);
    if (!current) input.recordMigration(DELEGATION_BUDGET_MIGRATION_VERSION, DELEGATION_BUDGET_MIGRATION_NAME);
    if (!marker(db) || !input.hasMigration(DELEGATION_BUDGET_MIGRATION_VERSION) || inspect(db, true).length) throw new Error("delegation.budget_migration_postcondition");
    db.exec("COMMIT");
    return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}

function marker(db: DatabaseSync): boolean {
  const rows = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
    .all(DELEGATION_BUDGET_MIGRATION_VERSION, DELEGATION_BUDGET_MIGRATION_NAME);
  if (rows.length > 1 || rows.some(row => row.version !== DELEGATION_BUDGET_MIGRATION_VERSION || row.name !== DELEGATION_BUDGET_MIGRATION_NAME)) throw new Error("delegation.budget_migration_marker_conflict");
  return rows.length === 1;
}
function normalize(sql: string): string {
  return sql.trim().replace(/;$/u, "").replace(/'[^']*(?:''[^']*)*'|\s+/gu, token => token.startsWith("'") ? token : " ");
}
function inspect(db: DatabaseSync, recorded: boolean): Definition[] {
  const missing: Definition[] = [];
  for (const entry of definitions) {
    const rows = db.prepare("SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?").all(entry.name);
    if (!rows.length) {
      if (recorded && entry.type === "table") throw new Error(`delegation.budget_migration_table_missing:${entry.name}`);
      missing.push(entry);
    } else if (rows.length !== 1 || rows[0].type !== entry.type || rows[0].tbl_name !== entry.table
      || typeof rows[0].sql !== "string" || normalize(rows[0].sql) !== normalize(entry.sql)) {
      throw new Error(`delegation.budget_migration_schema_conflict:${entry.name}`);
    }
  }
  return missing;
}
function assertData(db: DatabaseSync): void {
  for (const { name } of tables) {
    if (db.prepare(`PRAGMA foreign_key_check(${name})`).all().length) throw new Error(`delegation.budget_migration_foreign_key:${name}`);
  }
}

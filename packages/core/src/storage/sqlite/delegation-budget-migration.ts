import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { mapDelegationRootBudget, mapDelegationBudgetReservation, mapDelegationBudgetCharge } from "./delegation-budget-rows.js";

// Both main work-summary and the E6 ledger historically used176. Append a
// canonical marker without deleting or rewriting either branch's old history.
export const DELEGATION_BUDGET_MIGRATION_VERSION = 189;
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
  if (recorded.canonical !== input.hasMigration(DELEGATION_BUDGET_MIGRATION_VERSION)) throw new Error("delegation.budget_migration_marker_conflict");
  const missing = inspect(db, recorded.canonical || recorded.legacy);
  if (recorded.canonical && !missing.length) { assertData(db); return false; }
  // A rejected nested BEGIN never permits this migration to roll back its caller.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = marker(db);
    for (const entry of inspect(db, current.canonical || current.legacy)) db.exec(entry.sql);
    assertData(db);
    if (!current.canonical) input.recordMigration(DELEGATION_BUDGET_MIGRATION_VERSION, DELEGATION_BUDGET_MIGRATION_NAME);
    if (!marker(db).canonical || !input.hasMigration(DELEGATION_BUDGET_MIGRATION_VERSION) || inspect(db, true).length) throw new Error("delegation.budget_migration_postcondition");
    db.exec("COMMIT");
    return true;
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}

function marker(db: DatabaseSync): { readonly canonical: boolean; readonly legacy: boolean } {
  const rows = db.prepare("SELECT version,name FROM schema_migrations WHERE version=176 OR version=? OR name=?")
    .all(DELEGATION_BUDGET_MIGRATION_VERSION, DELEGATION_BUDGET_MIGRATION_NAME);
  let canonical = false, legacy = false;
  for (const row of rows) {
    if (row.version === DELEGATION_BUDGET_MIGRATION_VERSION && row.name === DELEGATION_BUDGET_MIGRATION_NAME) canonical = true;
    else if (row.version === 176 && row.name === DELEGATION_BUDGET_MIGRATION_NAME) legacy = true;
    else if (row.version !== 176 || row.name !== "create_work_summary_pull_requests") throw new Error("delegation.budget_migration_marker_conflict");
  }
  return { canonical, legacy };
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
  const parsers = [mapDelegationRootBudget, mapDelegationBudgetReservation, mapDelegationBudgetCharge] as const;
  for (const [index, { name }] of tables.entries()) {
    if (db.prepare(`PRAGMA foreign_key_check(${name})`).all().length) throw new Error(`delegation.budget_migration_foreign_key:${name}`);
    const integrity = db.prepare(`PRAGMA integrity_check(${name})`).all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error(`delegation.budget_migration_integrity:${name}`);
    // Reuse the runtime readers, including stricter timestamp/settlement rules.
    // Stream rows so opening a large historical ledger does not materialize it.
    for (const row of db.prepare(`SELECT * FROM ${name}`).iterate()) {
      try { parsers[index]!(row); }
      catch (cause) { throw new Error(`delegation.budget_migration_integrity:${name}`, { cause }); }
    }
  }
  const within = (value: string, limit: string): string => `(${limit} IS NULL OR (${value} IS NOT NULL AND ${value}<=${limit}))`;
  const lineageChecks = [
    ["root", `SELECT 1 FROM delegation_root_budgets b WHERE NOT EXISTS (
      SELECT 1 FROM run_sessions r JOIN artifacts a ON a.id=b.authority_artifact_id
      WHERE r.id=b.root_run_id AND r.parent_run_id IS NULL AND a.run_id=b.root_run_id
        AND (b.price_artifact_id IS NULL OR EXISTS (
          SELECT 1 FROM artifacts p WHERE p.id=b.price_artifact_id AND p.run_id=b.root_run_id))) LIMIT 1`],
    ["reservation", `SELECT 1 FROM delegation_budget_reservations b WHERE NOT EXISTS (
      SELECT 1 FROM delegation_steps s JOIN run_sessions child ON child.id=b.child_run_id
      JOIN delegation_root_budgets root ON root.root_run_id=b.root_run_id
      WHERE s.id=b.delegation_step_id AND s.root_run_id=b.root_run_id
        AND child.parent_run_id=s.parent_run_id AND (s.child_run_id IS NULL OR s.child_run_id=b.child_run_id)
        AND b.token_reserved IS s.token_budget AND b.cost_reserved_micros IS s.cost_budget_micros
        AND b.created_at>=root.frozen_at AND b.deadline_at<=root.deadline_at
        AND ${within("b.token_reserved", "root.token_budget")} AND ${within("b.cost_reserved_micros", "root.cost_budget_micros")}
        AND (b.cost_reserved_micros IS NULL OR root.price_artifact_id IS NOT NULL)
        AND ((b.parent_reservation_id IS NULL AND s.parent_delegation_step_id IS NULL AND s.parent_run_id=b.root_run_id AND s.depth=1)
          OR EXISTS (SELECT 1 FROM delegation_budget_reservations p
            JOIN delegation_steps ps ON ps.id=p.delegation_step_id
            WHERE p.id=b.parent_reservation_id AND p.id<>b.id AND p.root_run_id=b.root_run_id
              AND p.delegation_step_id=s.parent_delegation_step_id AND p.child_run_id=s.parent_run_id
              AND s.depth=ps.depth+1 AND b.deadline_at<=p.deadline_at
              AND ${within("b.token_reserved", "p.token_reserved")} AND ${within("b.cost_reserved_micros", "p.cost_reserved_micros")}))) LIMIT 1`],
    ["charge", `SELECT 1 FROM delegation_budget_charges c WHERE NOT EXISTS (
      SELECT 1 FROM run_sessions r JOIN work_unit_attempts a ON a.work_unit_id=r.work_unit_id
      JOIN delegation_root_budgets root ON root.root_run_id=c.root_run_id
      WHERE r.id=c.run_id AND a.id=c.attempt_id
        AND c.created_at>=root.frozen_at AND c.created_at<root.deadline_at
        AND (c.price_artifact_id IS NULL OR (c.price_artifact_id=root.price_artifact_id AND c.price_digest=root.price_digest))
        AND ((c.reservation_id IS NULL AND c.run_id=c.root_run_id
            AND ${within("c.reserved_tokens", "root.token_budget")} AND ${within("c.reserved_cost_micros", "root.cost_budget_micros")})
          OR EXISTS (SELECT 1 FROM delegation_budget_reservations p WHERE p.id=c.reservation_id
            AND p.root_run_id=c.root_run_id AND p.child_run_id=c.run_id AND c.created_at<p.deadline_at
            AND ${within("c.reserved_tokens", "p.token_reserved")} AND ${within("c.reserved_cost_micros", "p.cost_reserved_micros")}))) LIMIT 1`],
  ] as const;
  // Only persistent relationships: a legitimate historical step/parent may now
  // be terminal, and an unclaimed child still has a NULL step binding.
  for (const [kind, sql] of lineageChecks) {
    if (db.prepare(sql).get()) throw new Error(`delegation.budget_migration_lineage:${kind}`);
  }
}

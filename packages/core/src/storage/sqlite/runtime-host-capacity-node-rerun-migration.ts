import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { applyRuntimeHostCapacityContinuationMigration } from "./runtime-host-capacity-continuation-migration.js";
import { applyNodeRerunTargetMigration, NODE_RERUN_TARGET_MIGRATION_VERSION } from "./node-rerun-target-migration.js";
import { runtimeHostCapacityNodeRerunIntentDefinition,
  RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_NAME } from "./runtime-host-capacity-migration.js";

export { RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_NAME };

const table = "runtime_host_capacity_intents", replacement = "runtime_host_capacity_intents_rerun_upgrade";

/** Preserve capacity history and incoming foreign keys while admitting a distinct, fully bound rerun owner. */
export function applyRuntimeHostCapacityNodeRerunMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    for (const [version, name] of [[220, "runtime_host_capacity_continuations"], [NODE_RERUN_TARGET_MIGRATION_VERSION, "node_rerun_targets"]] as const) {
      const markers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name);
      if (markers.length !== 1 || markers[0]!.version !== version || markers[0]!.name !== name || !input.hasMigration(version))
        throw new Error("runtime_host_capacity_node_rerun.migration_predecessor_missing");
    }
    // Installed predecessor inspectors validate their tables without manufacturing missing migration history.
    applyRuntimeHostCapacityContinuationMigration(input);
    applyNodeRerunTargetMigration(input);
    if (database.prepare(`SELECT name FROM main.sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT name FROM temp.sqlite_master WHERE name=? COLLATE NOCASE`).all(replacement, replacement).length)
      throw new Error("runtime_host_capacity_node_rerun.migration_unexpected_object");
    return input.hasMigration(RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_VERSION);
  };
  if (inspect()) return;
  if (database.isTransaction) throw new Error("runtime_host_capacity_node_rerun.migration_nested_transaction");
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get()!.foreign_keys;
  database.exec("PRAGMA foreign_keys=OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!inspect()) {
        database.exec(runtimeHostCapacityNodeRerunIntentDefinition.replace(`"${table}"`, replacement));
        database.exec(`INSERT INTO ${replacement} SELECT * FROM main.${table}`);
        database.exec(`DROP TABLE main.${table}`);
        database.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
        input.recordMigration(RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_NODE_RERUN_MIGRATION_NAME);
      }
      if (!inspect()) throw new Error("runtime_host_capacity_node_rerun.migration_postcondition");
      database.exec("COMMIT");
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  } finally {
    database.exec(`PRAGMA foreign_keys=${foreignKeys === 1 ? "ON" : "OFF"}`);
  }
}

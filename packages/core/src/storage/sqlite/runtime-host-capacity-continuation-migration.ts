import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { applyRuntimeHostCapacityMigration, runtimeHostCapacityContinuationIntentDefinition,
  RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME } from "./runtime-host-capacity-migration.js";
import { applyRuntimeDelegationSpawnAdmissionMigration, RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION,
  RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_NAME } from "./runtime-delegation-spawn-admission-migration.js";

export { RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME };

const table = "runtime_host_capacity_intents", replacement = "runtime_host_capacity_intents_upgrade";

export function applyRuntimeHostCapacityContinuationMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const { database } = input;
  const inspect = () => {
    const predecessors = database.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION, RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_NAME);
    if (predecessors.length !== 1
      || predecessors.some(row => row.version !== RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION
        || row.name !== RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_NAME)
      || !input.hasMigration(RUNTIME_DELEGATION_SPAWN_ADMISSION_MIGRATION_VERSION)) {
      throw new Error("runtime_host_capacity_continuations.migration_predecessor_missing");
    }
    // The predecessor inspectors require their real markers, so they cannot install missing history here.
    const hostMarkers = database.prepare("SELECT version,name FROM schema_migrations WHERE version=218 OR name=?")
      .all("runtime_host_capacity");
    if (hostMarkers.length !== 1 || hostMarkers[0]!.version !== 218 || hostMarkers[0]!.name !== "runtime_host_capacity"
      || !input.hasMigration(218)) throw new Error("runtime_host_capacity_continuations.migration_predecessor_missing");
    applyRuntimeHostCapacityMigration(input);
    applyRuntimeDelegationSpawnAdmissionMigration(input);
    if (database.prepare(`SELECT name FROM main.sqlite_master WHERE name=? COLLATE NOCASE
      UNION ALL SELECT name FROM temp.sqlite_master WHERE name=? COLLATE NOCASE`).all(replacement, replacement).length) {
      throw new Error("runtime_host_capacity_continuations.migration_unexpected_object");
    }
    return input.hasMigration(RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION);
  };
  if (inspect()) return;
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get()!.foreign_keys;
  // The parent is rebuilt without renaming it first, preserving references from release and delegation rows.
  database.exec("PRAGMA foreign_keys=OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!inspect()) {
        database.exec(runtimeHostCapacityContinuationIntentDefinition.replace(`"${table}"`, replacement));
        database.exec(`INSERT INTO ${replacement} SELECT * FROM main.${table}`);
        database.exec(`DROP TABLE main.${table}`);
        database.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
        input.recordMigration(RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_VERSION, RUNTIME_HOST_CAPACITY_CONTINUATION_MIGRATION_NAME);
      }
      if (!inspect()) throw new Error("runtime_host_capacity_continuations.migration_postcondition");
      database.exec("COMMIT");
    } catch (error) {
      rollbackOwnedSqliteTransaction(database);
      throw error;
    }
  } finally {
    database.exec(`PRAGMA foreign_keys=${foreignKeys === 1 ? "ON" : "OFF"}`);
  }
}

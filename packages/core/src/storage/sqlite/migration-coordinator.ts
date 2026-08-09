import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATION_LOCK_DATABASE_NAME = "sqlite-run-store-migrations.sqlite";
const MIGRATION_LOCK_TIMEOUT_MS = 60_000;

/**
 * Serializes every workspace schema migration across daemon processes.
 *
 * The coordinator uses a separate SQLite database so the lock can remain held
 * while the workspace database runs `VACUUM INTO` and transactional migrations.
 * SQLite releases the transaction automatically when a crashed process closes,
 * so no stale lock-file recovery protocol is required.
 */
export function withSqliteRunStoreMigrationLock<T>(
  workspaceRootDir: string,
  operation: () => T,
): T {
  const recoveryDirectory = join(resolve(workspaceRootDir), "recovery");
  mkdirSync(recoveryDirectory, { recursive: true });
  const coordinator = new DatabaseSync(join(recoveryDirectory, MIGRATION_LOCK_DATABASE_NAME));
  try {
    coordinator.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS};`);
    coordinator.exec("BEGIN EXCLUSIVE;");
    try {
      const result = operation();
      coordinator.exec("COMMIT;");
      return result;
    } catch (error) {
      coordinator.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    coordinator.close();
  }
}

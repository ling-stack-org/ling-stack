import type { DatabaseSync } from "node:sqlite";

// Only snapshots or explicit read windows opened by this module may be nested. Never adopt an unrelated
// caller-owned transaction or let a nested reader commit/roll back its parent.
const activeReadSnapshots = new WeakSet<DatabaseSync>();

/** A synchronous read-only window inside a caller-owned transaction; never commits it. */
export function readSqliteWithinTransaction<T>(database: DatabaseSync, read: () => T): T {
  if (Object.prototype.toString.call(read) === "[object AsyncFunction]") {
    throw new TypeError("SQLite snapshot callback must be synchronous");
  }
  const queryOnly = database.prepare("PRAGMA query_only").get()?.query_only === 1;
  const alreadyReading = activeReadSnapshots.has(database);
  try {
    database.exec("PRAGMA query_only=ON");
    activeReadSnapshots.add(database);
    const result = read();
    if (result && (typeof result === "object" || typeof result === "function") &&
      typeof Reflect.get(result, "then") === "function") {
      // The callback is required to be synchronous. Attach a rejection handler
      // before throwing so a returned Promise.reject cannot escape as an
      // unhandled rejection after the transaction has already rolled back.
      if (typeof Reflect.get(result, "catch") === "function") {
        void Promise.resolve(result as unknown as PromiseLike<unknown>).catch(() => undefined);
      }
      throw new TypeError("SQLite snapshot callback must be synchronous");
    }
    return result;
  } finally {
    if (!alreadyReading) activeReadSnapshots.delete(database);
    database.exec(queryOnly ? "PRAGMA query_only=ON" : "PRAGMA query_only=OFF");
  }
}

/** Run a synchronous, read-only SQLite snapshot without crossing an await. */
export function readSqliteSnapshot<T>(database: DatabaseSync, read: () => T): T {
  if (Object.prototype.toString.call(read) === "[object AsyncFunction]") {
    throw new TypeError("SQLite snapshot callback must be synchronous");
  }
  if (activeReadSnapshots.has(database)) return readSqliteWithinTransaction(database, read);
  const queryOnly = database.prepare("PRAGMA query_only").get()?.query_only === 1;
  let began = false;
  try {
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN DEFERRED");
    began = true;
    activeReadSnapshots.add(database);
    const result = read();
    if (result && (typeof result === "object" || typeof result === "function") &&
      typeof Reflect.get(result, "then") === "function") {
      if (typeof Reflect.get(result, "catch") === "function") {
        void Promise.resolve(result as unknown as PromiseLike<unknown>).catch(() => undefined);
      }
      throw new TypeError("SQLite snapshot callback must be synchronous");
    }
    database.exec("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) database.exec("ROLLBACK");
    throw error;
  } finally {
    activeReadSnapshots.delete(database);
    database.exec(queryOnly ? "PRAGMA query_only=ON" : "PRAGMA query_only=OFF");
  }
}

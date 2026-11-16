import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

/** Inspect the real connection for persistence and transaction boundary assertions. */
export function testDatabase(store: object): DatabaseSync {
  const database: unknown = Reflect.get(store, "database");
  assert.ok(database instanceof DatabaseSync, "fixture must own a real SQLite connection");
  return database;
}

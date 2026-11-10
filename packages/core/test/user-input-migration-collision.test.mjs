import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyUserInputMigration } from "../dist/storage/sqlite/user-input-migration.js";
import { applyUserInputWaitMigration } from "../dist/storage/sqlite/user-input-wait-migration.js";
import { applyUserInputDeliveryMigration } from "../dist/storage/sqlite/user-input-delivery-migration.js";

// Regression: databases from an abandoned WIP checkpoint recorded versions 131/132 under
// unrelated migration names ("native_host_terminal_lifecycle"/"native_openclaw_session_identity")
// without the user_input tables ever being created. Version-only guards then skipped 131/132 and
// migration 133 crashed with "no such table: user_input_deliveries" on daemon startup.
function collidedDatabase(t) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(
    "CREATE TABLE migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);" +
      "INSERT INTO migrations VALUES (131,'native_host_terminal_lifecycle');" +
      "INSERT INTO migrations VALUES (132,'native_openclaw_session_identity');",
  );
  const context = {
    database,
    hasMigration: (version) => !!database.prepare("SELECT 1 FROM migrations WHERE version=?").get(version),
    hasColumn: (tableName, columnName) =>
      database.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName),
    hasTable: (tableName) =>
      !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName),
    recordMigration: (version, name) =>
      database.prepare("INSERT OR IGNORE INTO migrations(version,name) VALUES (?,?)").run(version, name),
  };
  return { database, context };
}

test("WIP-checkpoint version collision still builds the full user input schema", (t) => {
  const { database, context } = collidedDatabase(t);
  applyUserInputMigration(context);
  applyUserInputWaitMigration(context);
  applyUserInputDeliveryMigration(context);

  const requestColumns = database.prepare("PRAGMA table_info(user_input_requests)").all().map((row) => row.name);
  for (const column of ["wait_status", "wait_revision", "wait_checkpoint_json", "wait_checkpoint_fingerprint"]) {
    assert.ok(requestColumns.includes(column), `user_input_requests.${column}`);
  }
  const deliveryColumns = database.prepare("PRAGMA table_info(user_input_deliveries)").all().map((row) => row.name);
  for (const column of ["status_revision", "attempt_count", "updated_at", "claim_token", "retry_at", "last_error_code"]) {
    assert.ok(deliveryColumns.includes(column), `user_input_deliveries.${column}`);
  }
  assert.ok(database.prepare("SELECT 1 FROM migrations WHERE version=133").get());
});

test("fully migrated database is left untouched on a second pass", (t) => {
  const { database, context } = collidedDatabase(t);
  applyUserInputMigration(context);
  applyUserInputWaitMigration(context);
  applyUserInputDeliveryMigration(context);
  database.exec("CREATE TABLE ling_threads(id TEXT PRIMARY KEY);"
    + "CREATE TABLE conversation_items(id TEXT PRIMARY KEY);"
    + "INSERT INTO ling_threads VALUES ('t');"
    + "INSERT INTO conversation_items VALUES ('item')");
  database.exec(
    "INSERT INTO user_input_requests (request_id,workspace_id,thread_id,request_version,status_revision,status," +
      "source_run_id,source_attempt_id,tool_call_id,idempotency_key,input_fingerprint,source_json,source_fingerprint," +
      "tool_input_json,item_id,created_at,updated_at) VALUES " +
      "('r1','w','t',1,1,'pending','run','attempt','call','idem','fp','{}','sfp','{}','item','2026-09-07T00:00:00.000Z','2026-09-07T00:00:00.000Z')",
  );
  // Second pass must be a no-op: no duplicate-column errors, row preserved.
  applyUserInputMigration(context);
  applyUserInputWaitMigration(context);
  applyUserInputDeliveryMigration(context);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM user_input_requests").get().n, 1);
});

test("fresh database without any markers migrates normally", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("CREATE TABLE migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL)");
  const context = {
    database,
    hasMigration: (version) => !!database.prepare("SELECT 1 FROM migrations WHERE version=?").get(version),
    hasColumn: (tableName, columnName) =>
      database.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName),
    hasTable: (tableName) =>
      !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName),
    recordMigration: (version, name) =>
      database.prepare("INSERT OR IGNORE INTO migrations(version,name) VALUES (?,?)").run(version, name),
  };
  applyUserInputMigration(context);
  applyUserInputWaitMigration(context);
  applyUserInputDeliveryMigration(context);
  assert.ok(context.hasColumn("user_input_requests", "wait_status"));
  assert.ok(context.hasColumn("user_input_deliveries", "claim_token"));
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM migrations").get().n, 3);
});

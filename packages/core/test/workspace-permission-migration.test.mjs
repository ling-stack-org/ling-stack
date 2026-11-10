import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyWorkspacePermissionMigration,
  WORKSPACE_PERMISSION_MIGRATION_VERSION,
} from "../dist/storage/sqlite/workspace-permission-migration.js";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE workspace_settings (
      workspace_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return database;
}

function input(database, overrides = {}) {
  return {
    database,
    hasMigration: version => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)),
    hasTable: table => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)),
    recordMigration: (version, name) => database.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(version, name, "2026-10-28T00:00:00.000Z"),
    ...overrides,
  };
}

test("177 adds canonical permission fields while preserving legacy settings", () => {
  const database = fixture();
  try {
    database.prepare("INSERT INTO workspace_settings VALUES (?,?,?,?)").run(
      "workspace_default",
      JSON.stringify({ schemaVersion: 1, theme: "dark", defaultPermissionMode: "ask_everything", defaultPermissionPreset: "read_only" }),
      "2026-10-28T00:00:00.000Z",
      "2026-10-28T00:00:00.000Z",
    );
    assert.equal(applyWorkspacePermissionMigration(input(database)), true);
    const row = database.prepare("SELECT settings_json FROM workspace_settings WHERE workspace_id='workspace_default'").get();
    assert.deepEqual(JSON.parse(row.settings_json), {
      schemaVersion: 1,
      theme: "dark",
      defaultPermissionMode: "ask_everything",
      defaultPermissionPreset: "read_only",
      defaultAuthorizationMode: "ask",
      defaultWorkspaceAccessMode: "read_only",
    });
    assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=?").get(WORKSPACE_PERMISSION_MIGRATION_VERSION).name,
      "canonicalize_workspace_permission_settings");
  } finally {
    database.close();
  }
});

test("177 prefers existing canonical values and is idempotent", () => {
  const database = fixture();
  try {
    database.prepare("INSERT INTO workspace_settings VALUES (?,?,?,?)").run(
      "workspace_default",
      JSON.stringify({ defaultPermissionMode: "ask_everything", defaultPermissionPreset: "read_only", defaultAuthorizationMode: "always", defaultWorkspaceAccessMode: "full_access" }),
      "now",
      "now",
    );
    assert.equal(applyWorkspacePermissionMigration(input(database)), true);
    const first = database.prepare("SELECT settings_json FROM workspace_settings").get().settings_json;
    assert.equal(applyWorkspacePermissionMigration(input(database)), false);
    assert.equal(database.prepare("SELECT settings_json FROM workspace_settings").get().settings_json, first);
    assert.deepEqual(JSON.parse(first), {
      defaultPermissionMode: "ask_everything",
      defaultPermissionPreset: "read_only",
      defaultAuthorizationMode: "always",
      defaultWorkspaceAccessMode: "full_access",
    });
  } finally {
    database.close();
  }
});

test("177 does not let a corrupt legacy projection block complete canonical values", () => {
  const database = fixture();
  try {
    database.prepare("INSERT INTO workspace_settings VALUES (?,?,?,?)").run(
      "workspace_default",
      JSON.stringify({
        defaultAuthorizationMode: "always",
        defaultWorkspaceAccessMode: "full_access",
        defaultPermissionMode: "not-a-mode",
        defaultPermissionPreset: { corrupt: true },
      }),
      "now",
      "now",
    );
    assert.equal(applyWorkspacePermissionMigration(input(database)), true);
    assert.deepEqual(JSON.parse(database.prepare("SELECT settings_json FROM workspace_settings").get().settings_json), {
      defaultAuthorizationMode: "always",
      defaultWorkspaceAccessMode: "full_access",
      defaultPermissionMode: "not-a-mode",
      defaultPermissionPreset: { corrupt: true },
    });
  } finally {
    database.close();
  }
});

test("177 rolls back malformed settings and does not record the marker", () => {
  const database = fixture();
  try {
    database.prepare("INSERT INTO workspace_settings VALUES (?,?,?,?)").run("workspace_default", "{invalid", "now", "now");
    assert.throws(() => applyWorkspacePermissionMigration(input(database)), /workspace_permission_migration_invalid_json:workspace_default/u);
    assert.equal(database.prepare("SELECT count(*) AS count FROM schema_migrations WHERE version=?").get(WORKSPACE_PERMISSION_MIGRATION_VERSION).count, 0);
    assert.equal(database.prepare("SELECT settings_json FROM workspace_settings").get().settings_json, "{invalid");
  } finally {
    database.close();
  }
});

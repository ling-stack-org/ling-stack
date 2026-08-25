import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const workspaceId = "workspace_default";
const pluginId = "built-in:chrome";
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const now = "2026-08-17T00:00:00.000Z";

test("Chrome browser credential store persists hashes, rotates atomically, and revokes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-stack-chrome-credential-"));
  const store = createSqliteRunStore(cwd);
  try {
    const first = store.upsertChromeBrowserCredential({
      workspaceId,
      pluginId,
      extensionId,
      credentialHash: "A".repeat(64),
    }, now);
    assert.equal(first.credentialHash, "a".repeat(64));
    assert.equal(first.revokedAt, undefined);

    const rotatedAt = "2026-08-17T00:05:00.000Z";
    const rotated = store.upsertChromeBrowserCredential({
      workspaceId,
      pluginId,
      extensionId,
      credentialHash: "b".repeat(64),
    }, rotatedAt);
    assert.equal(rotated.createdAt, now);
    assert.equal(rotated.updatedAt, rotatedAt);
    assert.equal(rotated.credentialHash, "b".repeat(64));
    assert.equal(store.listChromeBrowserCredentials(workspaceId, pluginId).length, 1);

    const revokedAt = "2026-08-17T00:10:00.000Z";
    assert.equal(store.revokeChromeBrowserCredentials(workspaceId, pluginId, revokedAt), 1);
    assert.equal(store.getChromeBrowserCredential(workspaceId, pluginId, extensionId)?.revokedAt, revokedAt);
    assert.equal(store.revokeChromeBrowserCredentials(workspaceId, pluginId, revokedAt), 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Chrome browser credential migration stores no raw-token column and validates SHA-256", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-stack-chrome-schema-"));
  const store = createSqliteRunStore(cwd);
  try {
    assert.throws(() => store.upsertChromeBrowserCredential({
      workspaceId,
      pluginId,
      extensionId,
      credentialHash: "raw-secret-is-not-a-hash",
    }, now), /SHA-256 hex digest/);
    const database = new DatabaseSync(store.paths.databasePath, { readOnly: true });
    try {
      const columns = database.prepare("PRAGMA table_info(chrome_browser_credentials)").all();
      assert.deepEqual(columns.map((column) => column.name), [
        "workspace_id",
        "plugin_id",
        "extension_id",
        "credential_hash",
        "created_at",
        "updated_at",
        "revoked_at",
      ]);
      assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version = 113").get()?.name, "create_chrome_browser_credentials");
    } finally {
      database.close();
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("system Chrome binding preserves the protected Ling Agent client boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-stack-chrome-binding-"));
  const store = createSqliteRunStore(cwd);
  try {
    store.createMcpServer({
      id: "mcp_chrome_browser",
      displayName: "Chrome browser",
      enabled: false,
      transport: { type: "streamable-http", url: "http://127.0.0.1:1/internal", headers: {}, secretHeaderRefs: {} },
    }, now);
    assert.throws(() => store.replaceTeammateMcpBindings("ling_agent", [], now), /protected/);
    const enabled = store.upsertLingAgentChromeBrowserBinding(true, now);
    assert.equal(enabled.teammateId, "ling_agent");
    assert.equal(enabled.serverId, "mcp_chrome_browser");
    assert.equal(enabled.mode, "all_current_tools");
    assert.deepEqual(enabled.selectedToolNames, []);
    assert.deepEqual(enabled.approvalOverrides, {});
    assert.equal(enabled.enabled, true);
    assert.equal(store.upsertLingAgentChromeBrowserBinding(false, "2026-08-17T00:01:00.000Z").enabled, false);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

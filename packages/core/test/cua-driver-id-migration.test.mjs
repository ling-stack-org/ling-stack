import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/storage/sqlite-run-store.js";

const now = "2026-11-21T00:00:00.000Z";

test("migrates legacy Cua Driver rows to the official plugin id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-driver-id-migration-"));
  let store = createSqliteRunStore(cwd);
  const databasePath = store.paths.databasePath;
  store.close();

  const database = new DatabaseSync(databasePath);
  database.exec(`
    INSERT INTO managed_plugins (
      id, source_kind, version, enabled, disabled_reason, descriptor_json, created_at, updated_at
    ) VALUES (
      'trusted-local:cua-driver', 'trusted-local-preset', '0.1.0', 1, NULL,
      '{"id":"trusted-local:cua-driver","displayName":"Cua Driver","version":"0.1.0","sourceKind":"trusted-local-preset","contributions":[]}',
      '${now}', '${now}'
    );
    INSERT INTO managed_plugin_contributions (
      plugin_id, contribution_kind, contribution_id, linked_resource_id, enabled, created_at, updated_at
    ) VALUES ('trusted-local:cua-driver', 'mcp-server', 'mcp:cua-driver', 'mcp_cua_driver', 1, '${now}', '${now}');
    INSERT INTO managed_plugin_health_snapshots (
      plugin_id, status_json, checked_at, expires_at, created_at, updated_at
    ) VALUES ('trusted-local:cua-driver', '{"pluginId":"trusted-local:cua-driver","status":"ready"}', '${now}', '${now}', '${now}', '${now}');
    INSERT INTO managed_plugin_events (
      id, plugin_id, type, actor, message, data_json, created_at
    ) VALUES ('legacy-cua-event', 'trusted-local:cua-driver', 'enabled', 'local-user', 'enabled', NULL, '${now}');
    INSERT INTO managed_plugin_packages (
      plugin_id, source_kind, version, status, cache_ref, package_hash, manifest_json,
      installed_at, updated_at, uninstalled_at, artifact_id, platform, arch, source_url,
      catalog_version, previous_version
    ) VALUES (
      'trusted-local:cua-driver', 'trusted-local-preset', '0.1.0', 'installed', 'trusted-local/cua-driver/0.1.0/test', NULL,
      '{"id":"trusted-local:cua-driver"}', '${now}', '${now}', NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO cua_driver_activation_state (
      plugin_id, requested_enabled, requested_revision, activation_epoch, updated_at
    ) VALUES ('trusted-local:cua-driver', 1, 3, 4, '${now}');
    INSERT INTO managed_plugin_runtime_snapshots (
      id, run_id, cwd, plugin_ids_json, capabilities_json, policy_overlays_json, created_at
    ) VALUES ('legacy-cua-snapshot', NULL, '${cwd}',
      '["trusted-local:cua-driver"]', '[{"pluginId":"trusted-local:cua-driver"}]', '[]', '${now}');
  `);
  database.close();

  store = createSqliteRunStore(cwd);
  try {
    const migrated = store.getManagedPlugin("official:cua-driver");
    assert.ok(migrated);
    assert.equal(migrated.enabled, true);
    assert.equal(store.getManagedPlugin("trusted-local:cua-driver"), undefined);
    assert.equal(store.getCuaDriverActivationState("official:cua-driver")?.requestedEnabled, true);
    assert.equal(store.getCuaDriverActivationState("official:cua-driver")?.requestedRevision, 3);
    assert.equal(store.listManagedPluginContributions("official:cua-driver")[0]?.linkedResourceId, "mcp_cua_driver");
    assert.equal(store.getManagedPluginHealthSnapshot("official:cua-driver")?.status, "ready");
    assert.equal(store.listManagedPluginEvents({ pluginId: "official:cua-driver" }).length, 1);
    assert.equal(store.getManagedPluginPackage("official:cua-driver")?.status, "installed");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("sqlite persists managed plugin state, linked contributions, health, and redacted events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-store-"));
  const store = createSqliteRunStore(cwd);
  const descriptor = {
    id: "trusted-local:cua-driver",
    displayName: "Cua Driver",
    version: "1.0.0",
    sourceKind: "trusted-local-preset",
    trustSummary: "Trusted local preset.",
    contributions: [
      {
        kind: "mcp-server",
        id: "mcp_cua_driver",
        label: "Cua Driver MCP",
        capabilities: ["mcp:stdio"],
        sideEffectLevel: "external",
        defaultApproval: "ask",
      },
    ],
  };
  try {
    const plugin = store.upsertManagedPlugin(
      {
        id: descriptor.id,
        sourceKind: descriptor.sourceKind,
        version: descriptor.version,
        enabled: true,
        descriptor,
      },
      "2026-06-06T00:00:00.000Z",
    );
    assert.equal(plugin.id, descriptor.id);
    assert.equal(plugin.enabled, true);

    const contributions = store.replaceManagedPluginContributions(
      descriptor.id,
      [
        {
          contributionKind: "mcp-server",
          contributionId: "mcp_cua_driver",
          linkedResourceId: "mcp_cua_driver",
          enabled: true,
        },
      ],
      "2026-06-06T00:01:00.000Z",
    );
    assert.deepEqual(contributions.map((item) => [item.contributionKind, item.linkedResourceId, item.enabled]), [
      ["mcp-server", "mcp_cua_driver", true],
    ]);

    const health = store.upsertManagedPluginHealthSnapshot(
      {
        pluginId: descriptor.id,
        checkedAt: "2026-06-06T00:02:00.000Z",
        expiresAt: "2026-06-06T00:07:00.000Z",
        status: "ready",
        message: "Connected.",
        details: { mcpServerId: "mcp_cua_driver" },
      },
      "2026-06-06T00:02:00.000Z",
    );
    assert.equal(health.status, "ready");
    assert.equal(store.getManagedPluginHealthSnapshot(descriptor.id, "2026-06-06T00:08:00.000Z")?.status, "expired");

    store.appendManagedPluginEvent(
      {
        id: "plugin_event_test",
        pluginId: descriptor.id,
        type: "preset_applied",
        actor: "local-user",
        message: "Preset applied.",
        data: { token: "secret-token", apiKey: "secret-key", safe: "ok" },
      },
      "2026-06-06T00:03:00.000Z",
    );
    const events = store.listManagedPluginEvents({ pluginId: descriptor.id });
    assert.equal(events.length, 1);
    assert.equal(JSON.stringify(events).includes("secret-token"), false);
    assert.match(JSON.stringify(events), /\[REDACTED\]/);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getManagedPlugin(descriptor.id)?.displayName, undefined);
      assert.equal(reopened.getManagedPlugin(descriptor.id)?.descriptor.displayName, "Cua Driver");
      assert.deepEqual(reopened.listManagedPluginContributions(descriptor.id).map((item) => item.linkedResourceId), ["mcp_cua_driver"]);
      assert.equal(reopened.getManagedPluginHealthSnapshot(descriptor.id)?.status, "ready");
      assert.equal(reopened.listManagedPluginEvents({ pluginId: descriptor.id })[0].type, "preset_applied");
    } finally {
      reopened.close();
    }
  } finally {
    if (store.database?.isOpen) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite persists managed plugin package records and runtime snapshots", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-package-store-"));
  const store = createSqliteRunStore(cwd);
  try {
    store.upsertManagedPlugin(
      {
        id: "bundled:cua-driver",
        sourceKind: "bundled",
        version: "0.1.0",
        enabled: false,
        descriptor: {
          id: "bundled:cua-driver",
          displayName: "Cua Driver",
          version: "0.1.0",
          sourceKind: "bundled",
          trustSummary: "Bundled package shell.",
          contributions: [],
        },
      },
      "2026-06-06T00:09:00.000Z",
    );
    const installed = store.upsertManagedPluginPackage(
      {
        pluginId: "bundled:cua-driver",
        sourceKind: "bundled",
        version: "0.1.0",
        status: "installed",
        cacheRef: "bundled/cua-driver/0.1.0/hash123",
        packageHash: "hash123",
        manifestJson: JSON.stringify({ id: "bundled:cua-driver" }),
      },
      "2026-06-06T00:10:00.000Z",
    );
    assert.equal(installed.status, "installed");
    assert.equal(installed.installedAt, "2026-06-06T00:10:00.000Z");
    assert.equal(store.listManagedPluginPackages({ status: "installed" }).length, 1);

    const uninstalled = store.markManagedPluginPackageUninstalled("bundled:cua-driver", "2026-06-06T00:11:00.000Z");
    assert.equal(uninstalled?.status, "uninstalled");
    assert.equal(uninstalled?.uninstalledAt, "2026-06-06T00:11:00.000Z");
    assert.equal(store.listManagedPluginPackages({ status: "installed" }).length, 0);

    store.appendManagedPluginEvent(
      {
        id: "plugin_event_package_test",
        pluginId: "bundled:cua-driver",
        type: "installed",
        actor: "local-user",
        message: "Plugin package installed.",
        data: {
          cachePath: "/Users/example/.ling-stack/plugins/cache/bundled/cua-driver",
          token: "secret-token",
          cacheRef: "bundled/cua-driver/0.1.0/hash123",
        },
      },
      "2026-06-06T00:12:00.000Z",
    );
    const eventJson = JSON.stringify(store.listManagedPluginEvents({ pluginId: "bundled:cua-driver" }));
    assert.equal(eventJson.includes("secret-token"), false);
    assert.equal(eventJson.includes("/Users/example"), false);
    assert.match(eventJson, /\[REDACTED\]/);

    const snapshot = store.createManagedPluginRuntimeSnapshot({
      id: "plugin_runtime_snapshot_test",
      runId: "run_plugin_runtime_test",
      cwd,
      capabilities: [
        {
          pluginId: "bundled:cua-driver",
          status: "injectable",
          package: {
            pluginId: "bundled:cua-driver",
            sourceKind: "bundled",
            version: "0.1.0",
            status: "installed",
            cacheRef: "bundled/cua-driver/0.1.0/hash123",
            packageHash: "hash123",
            installedAt: "2026-06-06T00:10:00.000Z",
            updatedAt: "2026-06-06T00:10:00.000Z",
          },
          mcpServers: [{ kind: "mcp-server", id: "mcp_cua_driver", present: true, enabled: true }],
          skillPacks: [],
          apps: [],
          hooks: [],
          policyOverlays: [
            {
              id: "bundled:cua-driver:mcp_cua_driver:list_windows",
              pluginId: "bundled:cua-driver",
              contributionId: "mcp_cua_driver",
              targetKind: "mcp-tool",
              targetId: "mcp_cua_driver:list_windows",
              defaultApproval: "allow",
              sideEffectLevel: "read",
              reason: "Read-only Cua Driver inspection tool.",
            },
          ],
          blockers: [],
        },
      ],
      policyOverlays: [
        {
          id: "bundled:cua-driver:mcp_cua_driver:list_windows",
          pluginId: "bundled:cua-driver",
          contributionId: "mcp_cua_driver",
          targetKind: "mcp-tool",
          targetId: "mcp_cua_driver:list_windows",
          defaultApproval: "allow",
          sideEffectLevel: "read",
          reason: "Read-only Cua Driver inspection tool.",
        },
      ],
      createdAt: "2026-06-06T00:13:00.000Z",
    });
    assert.deepEqual(snapshot.pluginIds, ["bundled:cua-driver"]);
    assert.equal(store.getManagedPluginRuntimeSnapshot("plugin_runtime_snapshot_test")?.runId, "run_plugin_runtime_test");
    assert.equal(store.getManagedPluginRuntimeSnapshotForRun("run_plugin_runtime_test")?.capabilities[0]?.pluginId, "bundled:cua-driver");

    const selectedButBlocked = store.createManagedPluginRuntimeSnapshot({
      id: "plugin_runtime_snapshot_selected_blocked",
      runId: "run_plugin_runtime_selected_blocked",
      cwd,
      pluginIds: ["trusted-local:cua-driver"],
      capabilities: [],
      policyOverlays: [],
      createdAt: "2026-06-06T00:14:00.000Z",
    });
    assert.deepEqual(selectedButBlocked.pluginIds, ["trusted-local:cua-driver"]);
    assert.deepEqual(selectedButBlocked.capabilities, []);
    assert.deepEqual(
      store.getManagedPluginRuntimeSnapshotForRun("run_plugin_runtime_selected_blocked"),
      selectedButBlocked,
    );

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getManagedPluginPackage("bundled:cua-driver")?.status, "uninstalled");
      assert.equal(reopened.getManagedPluginRuntimeSnapshotForRun("run_plugin_runtime_test")?.policyOverlays[0]?.defaultApproval, "allow");
    } finally {
      reopened.close();
    }
  } finally {
    if (store.database?.isOpen) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

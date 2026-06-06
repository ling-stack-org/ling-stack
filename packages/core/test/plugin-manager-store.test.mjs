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

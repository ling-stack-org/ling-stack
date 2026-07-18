import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const pluginId = "trusted-local:cua-driver";
const serverId = "mcp_cua_driver";
const descriptor = {
  id: pluginId,
  displayName: "Cua Driver",
  version: "0.8.3",
  sourceKind: "trusted-local-preset",
  trustSummary: "Desktop-owned embedded provider.",
  contributions: [{
    kind: "mcp-server",
    id: serverId,
    label: "Cua Driver MCP",
    capabilities: ["mcp:stdio"],
    sideEffectLevel: "external",
    defaultApproval: "ask",
  }],
};

const now = "2026-07-18T00:00:00.000Z";
const readyStatus = (status = "ready") => ({
  serverId,
  checkedAt: now,
  expiresAt: "2026-07-18T01:00:00.000Z",
  status,
  protocolVersion: "2025-06-18",
  toolCount: status === "ready" ? 1 : 0,
  missingSecretRefs: [],
  authStatus: { kind: "not_required", refs: [], missingRefs: [] },
});
const health = (status = "ready") => ({
  pluginId,
  checkedAt: now,
  expiresAt: "2026-07-18T01:00:00.000Z",
  status,
  details: { providerState: status === "ready" ? "ready" : "desktop_unavailable" },
});
const tool = {
  rawName: "list_windows",
  displayName: "List windows",
  description: "List visible windows.",
  inputSchema: { type: "object" },
  callableNamespace: "cua_driver",
  callableName: "list_windows",
  sideEffectLevel: "read",
  defaultApproval: "allow",
};

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "ling-stack-cua-activation-"));
  const store = createSqliteRunStore(cwd);
  store.upsertManagedPlugin({ id: pluginId, sourceKind: descriptor.sourceKind, version: descriptor.version, enabled: false, descriptor }, now);
  store.replaceManagedPluginContributions(pluginId, [{ contributionKind: "mcp-server", contributionId: serverId, linkedResourceId: serverId, enabled: false }], now);
  store.createMcpServer({ id: serverId, displayName: "Cua Driver", enabled: false, transport: { type: "stdio", command: "/private/cua-driver", args: [], env: {}, secretEnvRefs: {} } }, now);
  store.ensureCuaDriverActivationState(pluginId, now);
  return { cwd, store };
}

function projection(store) {
  return {
    state: store.getCuaDriverActivationState(pluginId),
    plugin: store.getManagedPlugin(pluginId),
    contribution: store.listManagedPluginContributions(pluginId),
    server: store.getMcpServer(serverId),
    tools: store.listMcpTools({ serverId }),
    status: store.getMcpStatusSnapshot(serverId),
    health: store.getManagedPluginHealthSnapshot(pluginId),
  };
}

function commit(store, overrides = {}) {
  return store.commitCuaDriverActivation({
    pluginId,
    mcpServerId: serverId,
    now,
    expected: { requestedRevision: 0, activationEpoch: 0 },
    requestedEnabled: false,
    requestedRevision: 0,
    activationEpoch: 0,
    effectiveEnabled: false,
    pluginEnabled: false,
    contributionEnabled: false,
    mcpServerEnabled: false,
    tools: [],
    statusSnapshot: readyStatus("disabled"),
    healthSnapshot: health("disabled"),
    ...overrides,
  });
}

test("activation CAS keeps requested intent separate from effective tools and fences late results", async () => {
  const { cwd, store } = await fixture();
  try {
    assert.deepEqual(store.getCuaDriverActivationState(pluginId), { pluginId, requestedEnabled: false, requestedRevision: 0, activationEpoch: 0, updatedAt: now });
    const requested = commit(store, { requestedEnabled: true, requestedRevision: 1 });
    assert.equal(requested.committed, true);
    assert.equal(requested.state.requestedEnabled, true);
    assert.equal(store.getManagedPlugin(pluginId)?.enabled, false);
    assert.equal(store.listMcpTools({ serverId }).length, 0);

    const ready = store.commitCuaDriverActivation({
      pluginId,
      mcpServerId: serverId,
      now,
      expected: { requestedRevision: 1, activationEpoch: 0 },
      requestedEnabled: true,
      requestedRevision: 1,
      activationEpoch: 0,
      effectiveEnabled: true,
      pluginEnabled: true,
      contributionEnabled: true,
      mcpServerEnabled: true,
      tools: [tool],
      statusSnapshot: readyStatus(),
      healthSnapshot: health(),
    });
    assert.equal(ready.committed, true);
    assert.equal(store.getManagedPlugin(pluginId)?.enabled, true);
    assert.equal(store.getMcpServer(serverId)?.enabled, true);
    assert.equal(store.listMcpTools({ serverId }).length, 1);

    const disabled = store.commitCuaDriverActivation({
      pluginId,
      mcpServerId: serverId,
      now,
      expected: { requestedRevision: 1, activationEpoch: 0 },
      requestedEnabled: false,
      requestedRevision: 2,
      activationEpoch: 0,
      effectiveEnabled: false,
      pluginEnabled: false,
      contributionEnabled: false,
      mcpServerEnabled: false,
      tools: [],
      statusSnapshot: readyStatus("disabled"),
      healthSnapshot: health("disabled"),
    });
    assert.equal(disabled.committed, true);
    const late = store.commitCuaDriverActivation({
      pluginId,
      mcpServerId: serverId,
      now,
      expected: { requestedRevision: 1, activationEpoch: 0 },
      requestedEnabled: true,
      requestedRevision: 1,
      activationEpoch: 0,
      effectiveEnabled: true,
      pluginEnabled: true,
      contributionEnabled: true,
      mcpServerEnabled: true,
      tools: [tool],
      statusSnapshot: readyStatus(),
      healthSnapshot: health(),
    });
    assert.equal(late.committed, false);
    assert.equal(store.getCuaDriverActivationState(pluginId)?.requestedRevision, 2);
    assert.equal(store.listMcpTools({ serverId }).length, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("activation transaction rolls back after every projection write", async () => {
  const { cwd, store } = await fixture();
  try {
    commit(store, { requestedEnabled: true, requestedRevision: 1 });
    const before = projection(store);
    for (const crashAfter of ["after_tools", "after_status", "after_plugin", "after_contribution", "after_mcp", "after_health", "after_event", "after_fence"]) {
      assert.throws(() => store.commitCuaDriverActivation({
        pluginId,
        mcpServerId: serverId,
        now,
        expected: { requestedRevision: 1, activationEpoch: 0 },
        requestedEnabled: true,
        requestedRevision: 1,
        activationEpoch: 1,
        effectiveEnabled: true,
        pluginEnabled: true,
        contributionEnabled: true,
        mcpServerEnabled: true,
        tools: [tool],
        statusSnapshot: readyStatus(),
        healthSnapshot: health(),
        event: { type: "checked", message: "injected" },
        crashAfter,
      }), new RegExp(`cua_driver_activation_crash_injected:${crashAfter}`));
      assert.deepEqual(projection(store), before, `rollback failed at ${crashAfter}`);
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("two SQLite connections allow only one matching activation fence", async () => {
  const { cwd, store } = await fixture();
  const second = createSqliteRunStore(cwd);
  try {
    second.ensureCuaDriverActivationState(pluginId, now);
    const first = commit(store, { requestedEnabled: true, requestedRevision: 1 });
    assert.equal(first.committed, true);
    const racedDisable = second.commitCuaDriverActivation({
      pluginId,
      mcpServerId: serverId,
      now,
      expected: { requestedRevision: 0, activationEpoch: 0 },
      requestedEnabled: false,
      requestedRevision: 1,
      activationEpoch: 0,
      effectiveEnabled: false,
      pluginEnabled: false,
      contributionEnabled: false,
      mcpServerEnabled: false,
      tools: [],
      statusSnapshot: readyStatus("disabled"),
      healthSnapshot: health("disabled"),
    });
    assert.equal(racedDisable.committed, false);
    assert.equal(second.getCuaDriverActivationState(pluginId)?.requestedEnabled, true);
  } finally {
    second.close();
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";

const cuaPluginId = "trusted-local:cua-driver";

test("daemon exposes managed plugin catalog with built-ins and trusted local presets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-catalog-"));
  const daemon = await startDaemonForTest();
  try {
    const catalog = await getJson(`${daemon.url}/plugins?cwd=${encodeURIComponent(cwd)}`);
    const ids = new Set(catalog.plugins.map((plugin) => plugin.id));

    assert.equal(ids.has("runner:pi"), true);
    assert.equal(ids.has("tool:read"), true);
    assert.equal(ids.has(cuaPluginId), true);

    const cua = catalog.plugins.find((plugin) => plugin.id === cuaPluginId);
    assert.equal(cua.sourceKind, "trusted-local-preset");
    assert.equal(cua.actions.canApplyPreset, process.platform === "darwin");
    assert.equal(JSON.stringify(catalog).includes("secret-token"), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon applies cua-driver preset idempotently without teammate authorization", { skip: process.platform !== "darwin" }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-apply-"));
  const command = join(cwd, "cua-driver");
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${cwd}${originalPath ? `:${originalPath}` : ""}`;
  const broker = new FakePluginMcpBroker();
  const daemon = await startDaemonForTest(broker);
  try {
    const preApplyCheck = await postJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(preApplyCheck.health.status, "ready");
    assert.equal(JSON.stringify(preApplyCheck).includes(command), false);
    assert.deepEqual(preApplyCheck.health.details, { binaryFound: true });

    const missing = await requestJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/apply-preset?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: { options: { command: join(cwd, "missing-cua-driver") } },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, "plugin_binary_not_found");
    assert.equal(missing.json.plugin.id, cuaPluginId);
    assert.equal(JSON.stringify(missing.json).includes(join(cwd, "missing-cua-driver")), false);
    assert.deepEqual(missing.json.health.details, { errorCode: "plugin_binary_not_found" });

    const applied = await postJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/apply-preset?cwd=${encodeURIComponent(cwd)}`, {
      options: { command },
    });
    assert.equal(applied.plugin.id, cuaPluginId);
    assert.equal(applied.plugin.status, "enabled");
    assert.equal(applied.linkedMcpServer.id, "mcp_cua_driver");
    assert.equal(applied.linkedMcpServer.enabled, true);
    assert.equal(applied.statusSnapshot.status, "ready");
    assert.deepEqual(applied.tools.map((tool) => [tool.rawName, tool.sideEffectLevel, tool.defaultApproval]), [
      ["check_permissions", "read", "allow"],
      ["click", "external", "ask"],
      ["list_windows", "read", "allow"],
    ]);

    const appliedAgain = await postJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/apply-preset?cwd=${encodeURIComponent(cwd)}`, {
      options: { command },
    });
    assert.equal(appliedAgain.linkedMcpServer.id, "mcp_cua_driver");
    assert.equal(broker.checks.length, 2);

    const tools = await getJson(`${daemon.url}/mcp/tools?cwd=${encodeURIComponent(cwd)}&serverId=mcp_cua_driver`);
    assert.deepEqual(tools.tools.map((tool) => [tool.rawName, tool.defaultApproval]), [
      ["check_permissions", "allow"],
      ["click", "ask"],
      ["list_windows", "allow"],
    ]);

    const teammateBindings = await getJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/mcp?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(teammateBindings.bindings, []);

    const disabled = await postJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/disable?cwd=${encodeURIComponent(cwd)}`, {
      reason: "pause desktop control",
    });
    assert.equal(disabled.plugin.status, "disabled");
    assert.equal(disabled.plugin.disabledReason, "pause desktop control");
    assert.equal(disabled.plugin.linkedResources[0].enabled, false);
    assert.equal((await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`)).servers[0].enabled, false);

    const enabled = await postJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/enable?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(enabled.plugin.status, "enabled");
    assert.equal(enabled.plugin.linkedResources[0].enabled, true);

    const checked = await postJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/check?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(checked.health.status, "ready");
    assert.equal(broker.checks.length, 3);
    assert.ok(checked.plugin.events.some((event) => event.type === "preset_applied"));
  } finally {
    await daemon.close();
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

class FakePluginMcpBroker {
  constructor() {
    this.checks = [];
  }

  async checkServer(server, options) {
    const now = options.now();
    this.checks.push({ server });
    return {
      statusSnapshot: {
        serverId: server.id,
        status: server.enabled ? "ready" : "disabled",
        authStatus: {
          kind: "not_required",
          refs: [],
          missingRefs: [],
        },
        missingSecretRefs: [],
        message: server.enabled ? "Connected" : "MCP server is disabled.",
        checkedAt: now,
        expiresAt: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
      },
    };
  }

  async listTools(server, options) {
    const now = options.now();
    return {
      statusSnapshot: {
        serverId: server.id,
        status: server.enabled ? "ready" : "disabled",
        authStatus: {
          kind: "not_required",
          refs: [],
          missingRefs: [],
        },
        missingSecretRefs: [],
        message: "3 tools discovered",
        checkedAt: now,
        expiresAt: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
        toolCount: 3,
      },
      tools: [
        {
          rawName: "check_permissions",
          displayName: "Check permissions",
          inputSchema: { type: "object" },
          callableNamespace: server.id,
          callableName: "check_permissions",
          sideEffectLevel: "external",
          defaultApproval: "ask",
          enabled: true,
        },
        {
          rawName: "click",
          displayName: "Click",
          inputSchema: { type: "object" },
          callableNamespace: server.id,
          callableName: "click",
          sideEffectLevel: "external",
          defaultApproval: "allow",
          enabled: true,
        },
        {
          rawName: "list_windows",
          displayName: "List windows",
          inputSchema: { type: "object" },
          callableNamespace: server.id,
          callableName: "list_windows",
          sideEffectLevel: "external",
          defaultApproval: "ask",
          enabled: true,
        },
      ],
    };
  }

  async callTool() {
    throw new Error("callTool is not used in plugin manager tests");
  }
}

async function startDaemonForTest(mcpBroker) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, {
    secretResolver: createCompositeSecretResolver({ env: { MCP_AUTHORIZATION: "Bearer secret-token" } }),
    ...(mcpBroker ? { mcpBroker } : {}),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json();
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

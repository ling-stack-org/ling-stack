import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { loadPluginPackageFromRoot } from "../dist/features/plugins/manifest.js";

const cuaPluginId = "trusted-local:cua-driver";
const bundledCuaPluginId = "bundled:cua-driver";

test("daemon exposes managed plugin catalog with built-ins and trusted local presets", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-catalog-"));
  const daemon = await startDaemonForTest();
  try {
    const catalog = await getJson(`${daemon.url}/plugins?cwd=${encodeURIComponent(cwd)}`);
    const ids = new Set(catalog.plugins.map((plugin) => plugin.id));

    assert.equal(ids.has("runner:pi"), true);
    assert.equal(ids.has("tool:read"), true);
    assert.equal(ids.has(cuaPluginId), true);
    assert.equal(ids.has(bundledCuaPluginId), true);

    const cua = catalog.plugins.find((plugin) => plugin.id === cuaPluginId);
    assert.equal(cua.sourceKind, "trusted-local-preset");
    assert.equal(cua.actions.canApplyPreset, process.platform === "darwin");
    const bundledCua = catalog.plugins.find((plugin) => plugin.id === bundledCuaPluginId);
    assert.equal(bundledCua.sourceKind, "bundled");
    assert.equal(bundledCua.actions.canApplyPreset, false);
    assert.deepEqual(bundledCua.contributions.map((contribution) => contribution.kind), ["mcp-server"]);
    assert.equal(JSON.stringify(catalog).includes("secret-token"), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon exposes bundled plugin sources packages and side-effect-free validation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-package-"));
  const daemon = await startDaemonForTest();
  try {
    const sources = await getJson(`${daemon.url}/plugins/sources?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(sources.sources.length, 1);
    assert.equal(sources.sources[0].sourceKind, "bundled");
    assert.equal(sources.sources[0].pluginCount >= 1, true);
    assert.equal("packageRoot" in sources.sources[0], false);
    assert.equal(JSON.stringify(sources.sources).includes(cwd), false);

    const detail = await getJson(`${daemon.url}/plugins/packages/${encodeURIComponent(bundledCuaPluginId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.package.id, bundledCuaPluginId);
    assert.equal(detail.package.manifest.id, bundledCuaPluginId);
    assert.equal(detail.validation.ok, true);
    assert.equal(detail.validation.compiledDescriptor.id, bundledCuaPluginId);
    assert.equal(JSON.stringify(detail).includes("CuaDriver.app"), false);

    const validation = await postJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/validate-package?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(validation.validation.ok, true);
    assert.equal(validation.plugin.id, bundledCuaPluginId);

    const servers = await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(servers.servers, []);
    const teammateBindings = await getJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/mcp?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(teammateBindings.bindings, []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon installs bundled cua package cache and previews runtime injection", { skip: process.platform !== "darwin" }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-install-"));
  const command = join(cwd, "cua-driver");
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  await chmod(command, 0o755);
  const broker = new FakePluginMcpBroker();
  const daemon = await startDaemonForTest(broker, new SnapshotRunner());
  try {
    const initial = await getJson(`${daemon.url}/plugins?cwd=${encodeURIComponent(cwd)}`);
    const initialBundled = initial.plugins.find((plugin) => plugin.id === bundledCuaPluginId);
    assert.equal(initialBundled.actions.canInstall, true);
    assert.equal(initialBundled.actions.canApplyPreset, false);
    assert.equal(initialBundled.package, undefined);
    assert.equal(initialBundled.runtimePreview.status, "disabled");
    assert.equal(initialBundled.runtimePreview.blockers.includes("Plugin package is not installed."), true);

    const installed = await postJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/install?cwd=${encodeURIComponent(cwd)}`, {
      options: { command },
    });
    assert.equal(installed.plugin.id, bundledCuaPluginId);
    assert.equal(installed.plugin.status, "disabled");
    assert.equal(installed.package.status, "installed");
    assert.equal(installed.package.cacheRef.startsWith("bundled/cua-driver/0.1.0/"), true);
    assert.equal(typeof installed.package.packageHash, "string");
    assert.equal(JSON.stringify(installed).includes(command), false);
    assert.equal(existsSync(join(cwd, ".ling-stack", "plugins", "cache", installed.package.cacheRef)), true);
    assert.equal((await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`)).servers[0]?.enabled, false);
    assert.deepEqual((await getJson(`${daemon.url}/teammates/${encodeURIComponent("teammate_builtin_engineer")}/mcp?cwd=${encodeURIComponent(cwd)}`)).bindings, []);

    const installedAgain = await postJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/install?cwd=${encodeURIComponent(cwd)}`, {
      options: { command },
    });
    assert.equal(installedAgain.package.cacheRef, installed.package.cacheRef);

    const disabledPreview = await getJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/runtime-preview?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(disabledPreview.preview.status, "disabled");
    assert.equal(disabledPreview.preview.blockers.includes("Plugin is disabled."), true);

    await postJson(`${daemon.url}/plugins/${encodeURIComponent(cuaPluginId)}/apply-preset?cwd=${encodeURIComponent(cwd)}`, {
      options: { command },
    });
    await postJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/enable?cwd=${encodeURIComponent(cwd)}`, {});
    await postJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/check?cwd=${encodeURIComponent(cwd)}`, {});

    const preview = await getJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/runtime-preview?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(preview.preview.status, "injectable");
    assert.deepEqual(preview.preview.mcpServers.map((server) => [server.id, server.enabled]), [["mcp_cua_driver", true]]);
    const overlayByTarget = new Map(preview.preview.policyOverlays.map((overlay) => [overlay.targetId, overlay.defaultApproval]));
    assert.equal(overlayByTarget.get("mcp_cua_driver:check_permissions"), "allow");
    assert.equal(overlayByTarget.get("mcp_cua_driver:list_windows"), "allow");
    assert.equal(overlayByTarget.get("mcp_cua_driver:click"), "ask");

    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_plugin_runtime_snapshot"));
    assert.ok(runId);
    const run = await getJson(`${daemon.url}/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(run.requestSnapshot.managedPluginRuntime.pluginIds, [bundledCuaPluginId]);
    assert.equal(run.requestSnapshot.managedPluginRuntime.capabilities[0].status, "injectable");
    assert.equal(run.requestSnapshot.managedPluginRuntime.policyOverlays.some((overlay) =>
      overlay.targetId === "mcp_cua_driver:click" && overlay.defaultApproval === "ask"
    ), true);

    const uninstalled = await postJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/uninstall?cwd=${encodeURIComponent(cwd)}`, {
      reason: "test cleanup",
    });
    assert.equal(uninstalled.plugin.status, "disabled");
    assert.equal(uninstalled.package.status, "uninstalled");
    assert.equal((await getJson(`${daemon.url}/mcp/servers?cwd=${encodeURIComponent(cwd)}`)).servers[0]?.enabled, false);
    const blockedPreview = await getJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/runtime-preview?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(blockedPreview.preview.status, "disabled");
    assert.equal(blockedPreview.preview.blockers.includes("Plugin package is not installed."), true);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon rejects bundled cua install without leaking command paths", { skip: process.platform !== "darwin" }, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-install-missing-"));
  const daemon = await startDaemonForTest();
  try {
    const missingCommand = join(cwd, "missing-cua-driver");
    const missing = await requestJson(`${daemon.url}/plugins/${encodeURIComponent(bundledCuaPluginId)}/install?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST",
      body: { options: { command: missingCommand } },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, "plugin_binary_not_found");
    assert.equal(JSON.stringify(missing.json).includes(missingCommand), false);
    const catalog = await getJson(`${daemon.url}/plugins?cwd=${encodeURIComponent(cwd)}`);
    const bundled = catalog.plugins.find((plugin) => plugin.id === bundledCuaPluginId);
    assert.equal(bundled.package, undefined);
    assert.equal(bundled.health.status, "failed");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon rejects invalid plugin package contribution paths with redacted diagnostics", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-plugin-invalid-"));
  const packageRoot = join(cwd, "plugin");
  const outside = join(cwd, "outside");
  await mkdir(join(packageRoot, ".ling-plugin"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "mcp-server.json"), "{}\n");
  await symlink(join(outside, "mcp-server.json"), join(packageRoot, "escape.json"));
  await writeFile(
    join(packageRoot, ".ling-plugin", "plugin.json"),
    JSON.stringify({
      id: "bundled:invalid-path",
      displayName: "Invalid Path",
      version: "0.1.0",
      lingInterfaceVersion: "1",
      sourceKind: "bundled",
      trustLevel: "internal",
      trustSummary: "Invalid package for testing.",
      contributions: [
        { kind: "mcp-server", id: "mcp:absolute", path: "/tmp/server.json" },
        { kind: "skill-pack", id: "skill:traversal", path: "../skills" },
        { kind: "provider", id: "provider:escape", path: "./escape.json" },
      ],
    }),
  );
  try {
    const result = loadPluginPackageFromRoot(packageRoot);
    assert.equal(result.validation.ok, false);
    assert.equal(result.validation.errors.length >= 3, true);
    assert.equal(JSON.stringify(result.validation).includes(packageRoot), false);
    assert.equal(JSON.stringify(result.validation).includes(outside), false);
  } finally {
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

class SnapshotRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push({ cwd: options.cwd, taskId: options.task.id });
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

async function startDaemonForTest(mcpBroker, runner) {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 }, {
    secretResolver: createCompositeSecretResolver({ env: { MCP_AUTHORIZATION: "Bearer secret-token" } }),
    ...(mcpBroker ? { mcpBroker } : {}),
    ...(runner ? { runner } : {}),
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Run with plugin runtime snapshot.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["read"],
    thinkingLevel: "off",
  };
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const events = parseSseText(await response.text());
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

function parseSseText(text) {
  const events = [];
  for (const block of text.trim().split(/\n\n+/)) {
    if (!block.trim()) {
      continue;
    }
    let event = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0 || dataLines.join("").trim().length === 0) {
      continue;
    }
    events.push({ event, data: JSON.parse(dataLines.join("\n")) });
  }
  return events;
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

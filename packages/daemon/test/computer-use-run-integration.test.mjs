import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";
import {
  createCapturedStoreFactory,
  seedManagedCuaProvider,
} from "./computer-use-test-fixtures.mjs";

const DESKTOP_BRIDGE_TOKEN = "desktop-computer-use-integration-token";
const COMPUTER_USE_ROUTE_TOKEN = "computer-use-route-integration-token";
const SUPPORTED_DESKTOP_PLATFORM = process.platform === "darwin" || process.platform === "win32";

test("cua-driver MCP results publish a private preview and Stop waits for the linked run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-run-"));
  const runner = new BlockingComputerUseRunner();
  const mcpBroker = new FakeCuaDriverBroker();
  const { capture, storeFactory } = createCapturedStoreFactory();
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      runner,
      mcpBroker,
      desktopBridgeToken: DESKTOP_BRIDGE_TOKEN,
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      storeFactory,
    },
  );
  let runBodyPromise;
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.ok(capture.store);
    const { server } = seedManagedCuaProvider(capture.store, {
      tools: [screenshotTool()],
    });
    await putJson(`${baseUrl}/teammates/teammate_builtin_engineer/mcp?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [
        {
          serverId: server.id,
          mode: "selected",
          selectedToolNames: ["screenshot"],
          enabled: true,
        },
      ],
    });

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        teammateId: "teammate_builtin_engineer",
        task: {
          id: "task_computer_use_integration",
          title: "Inspect browser window",
          prompt: "Use the authorized browser window.",
        },
        provider: { provider: "static-chat", model: "static-model" },
        tools: ["read"],
      }),
    });
    if (!runResponse.ok) {
      assert.fail(`${runResponse.status} ${runResponse.statusText}: ${await runResponse.text()}`);
    }
    runBodyPromise = runResponse.text();

    const projection = await waitForProjection(baseUrl, cwd);
    assert.equal(projection.status, "running");
    assert.equal(projection.target.displayName, "Research Browser");
    assert.equal(projection.preview.revision, 1);
    assert.equal(JSON.stringify(projection).includes("7788"), false);

    const source = await fetch(
      `${baseUrl}/computer-use/sessions/${encodeURIComponent(projection.sessionId)}/source?cwd=${encodeURIComponent(cwd)}`,
      { headers: { "X-Ling-Desktop-Bridge-Token": DESKTOP_BRIDGE_TOKEN } },
    );
    if (!source.ok) {
      assert.fail(`${source.status} ${source.statusText}: ${await source.text()}`);
    }
    const descriptor = await source.json();
    assert.equal(descriptor.target.processId, 4321);
    assert.equal(descriptor.target.nativeWindowId, "7788");

    const stopped = await postJson(
      `${baseUrl}/computer-use/sessions/${encodeURIComponent(projection.sessionId)}/stop?cwd=${encodeURIComponent(cwd)}`,
      { reason: "operator_requested" },
      { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    );
    assert.equal(stopped.accepted, true);
    assert.equal(stopped.acknowledged, true);
    assert.equal(stopped.reason, "run_cancelled");
    assert.equal(stopped.projection.status, "cancelled");
    assert.equal(runner.abortObserved, true);

    await runBodyPromise;
    const run = await getJson(`${baseUrl}/runs/${encodeURIComponent(projection.runId)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(run.status, "cancelled");
    assert.equal(daemon.computerUsePreviews.get(cwd, projection.sessionId)?.status, "cancelled");

    const revokedSource = await fetch(
      `${baseUrl}/computer-use/sessions/${encodeURIComponent(projection.sessionId)}/source?cwd=${encodeURIComponent(cwd)}`,
      { headers: { "X-Ling-Desktop-Bridge-Token": DESKTOP_BRIDGE_TOKEN } },
    );
    assert.equal(revokedSource.status, 404);
    const audits = daemon.computerUsePreviews.listStopAudits(cwd, projection.sessionId);
    assert.equal(audits.at(-1)?.acknowledged, true);
  } finally {
    await daemon.stop().catch(() => undefined);
    await runBodyPromise?.catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bundled current lease enters the run snapshot and Computer Use projection without package cache", {
  skip: !SUPPORTED_DESKTOP_PLATFORM,
}, async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-bundled-run-"));
  const runner = new CompletingComputerUseRunner("list_windows", { pid: 4321 });
  const { capture, storeFactory } = createCapturedStoreFactory();
  const daemon = createDaemonServer(
    bundledConfig(cwd),
    {
      runner,
      desktopBridgeToken: DESKTOP_BRIDGE_TOKEN,
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      storeFactory,
      cuaDriverLeaseClientFactory: bundledLeaseClientFactory(),
    },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.ok(capture.store);

    const enable = await fetch(
      `${baseUrl}/plugins/${encodeURIComponent("trusted-local:cua-driver")}/enable?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(enable.status, 409);
    assert.equal((await enable.json()).error, "cua_desktop_lease_unavailable");

    const handshake = await fetch(`${baseUrl}/computer-use/desktop-bridge/handshake`, {
      headers: { "X-Ling-Desktop-Bridge-Token": DESKTOP_BRIDGE_TOKEN },
    });
    assert.equal(handshake.status, 200);
    const authority = await handshake.json();
    const published = await fetch(
      `${baseUrl}/desktop/capabilities/cua-driver/lease?cwd=${encodeURIComponent(cwd)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Ling-Desktop-Bridge-Token": DESKTOP_BRIDGE_TOKEN,
        },
        body: JSON.stringify(bundledLease(authority, cwd)),
      },
    );
    assert.equal(published.status, 200, await published.text());
    await waitForCondition(() =>
      capture.store.getMcpServer("mcp_cua_driver")?.enabled === true
      && capture.store.listMcpTools({ serverId: "mcp_cua_driver", enabled: true }).length === 1
    );

    await putJson(`${baseUrl}/teammates/teammate_builtin_engineer/mcp?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [{
        serverId: "mcp_cua_driver",
        mode: "selected",
        selectedToolNames: ["list_windows"],
        enabled: true,
      }],
    });
    const taskId = "task_computer_use_bundled_run";
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(runBody(cwd, taskId)),
    });
    if (!response.ok) {
      assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
    }
    await response.text();
    assert.equal(runner.callCompleted, true);

    const run = capture.store.listRuns({ limit: 20 }).find((candidate) => candidate.taskId === taskId);
    assert.ok(run);
    assert.deepEqual(run.requestSnapshot.managedPluginRuntime.pluginIds, ["trusted-local:cua-driver"]);
    const capability = run.requestSnapshot.managedPluginRuntime.capabilities.find(
      (candidate) => candidate.pluginId === "trusted-local:cua-driver",
    );
    assert.equal(capability?.status, "injectable");
    assert.equal(capability?.package, undefined);
    assert.deepEqual(
      run.requestSnapshot.mcpToolAccess.servers.map((candidate) => candidate.serverId),
      ["mcp_cua_driver"],
    );
    assert.deepEqual(
      run.requestSnapshot.mcpToolAccess.servers[0].tools.map((tool) => tool.rawName),
      ["list_windows"],
    );

    const projection = await waitForProjectionMatching(
      baseUrl,
      cwd,
      (candidate) => candidate.status === "succeeded",
    );
    assert.equal(projection.target.displayName, "Research Browser");
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cua-driver approval lifecycle is projected from authorized MCP and run events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-computer-use-approval-"));
  const runner = new ApprovalComputerUseRunner();
  const mcpBroker = new ApprovalCuaDriverBroker();
  const { capture, storeFactory } = createCapturedStoreFactory();
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      runner,
      mcpBroker,
      desktopBridgeToken: DESKTOP_BRIDGE_TOKEN,
      computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      storeFactory,
    },
  );
  let runBodyPromise;
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.ok(capture.store);
    const { server } = seedManagedCuaProvider(capture.store, {
      tools: [approvalTool()],
    });
    await putJson(`${baseUrl}/teammates/teammate_builtin_engineer/mcp?cwd=${encodeURIComponent(cwd)}`, {
      bindings: [
        {
          serverId: server.id,
          mode: "selected",
          selectedToolNames: ["future_authorized_action"],
          enabled: true,
        },
      ],
    });

    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        teammateId: "teammate_builtin_engineer",
        task: {
          id: "task_computer_use_approval",
          title: "Operate approved window",
          prompt: "Wait for approval, then use the authorized window.",
        },
        provider: { provider: "static-chat", model: "static-model" },
        tools: ["read"],
      }),
    });
    if (!runResponse.ok) {
      assert.fail(`${runResponse.status} ${runResponse.statusText}: ${await runResponse.text()}`);
    }
    runBodyPromise = runResponse.text();

    const waiting = await waitForProjectionMatching(
      baseUrl,
      cwd,
      (projection) => projection.status === "waiting_for_approval",
    );
    assert.equal(waiting.preview, undefined);
    assert.equal(waiting.approvalRequired.summary.length > 0, true);
    const approvalList = await getJson(
      `${baseUrl}/approvals?cwd=${encodeURIComponent(cwd)}&runId=${encodeURIComponent(waiting.runId)}&status=pending`,
    );
    assert.equal(approvalList.approvals.length, 1);
    assert.equal(waiting.approvalRequired.approvalId, approvalList.approvals[0].id);

    await postJson(
      `${baseUrl}/approvals/${encodeURIComponent(approvalList.approvals[0].id)}/approve?cwd=${encodeURIComponent(cwd)}`,
      { reason: "approved for integration test" },
    );
    await mcpBroker.started;
    const runningWithoutPreview = await waitForProjectionMatching(
      baseUrl,
      cwd,
      (projection) => projection.status === "running" && projection.preview === undefined,
    );
    assert.equal(runningWithoutPreview.approvalRequired, undefined);

    mcpBroker.releaseResult();
    const runningWithPreview = await waitForProjectionMatching(
      baseUrl,
      cwd,
      (projection) => projection.status === "running" && projection.preview?.revision === 1,
    );
    assert.equal(runningWithPreview.target.displayName, "Approved future window");

    const stopped = await postJson(
      `${baseUrl}/computer-use/sessions/${encodeURIComponent(runningWithPreview.sessionId)}/stop?cwd=${encodeURIComponent(cwd)}`,
      { reason: "operator_requested" },
      { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    );
    assert.equal(stopped.acknowledged, true);
    await runBodyPromise;

    const events = await getJson(
      `${baseUrl}/computer-use/events?cwd=${encodeURIComponent(cwd)}&afterSeq=0`,
      { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    );
    const statuses = events.events.map((event) => event.projection?.status);
    assert.equal(statuses.includes("starting"), true);
    assert.equal(statuses.includes("waiting_for_approval"), true);
    assert.equal(statuses.includes("running"), true);
    assert.equal(statuses.includes("cancelled"), true);
    assert.equal(statuses.includes("paused"), false, "approval and Stop must never be relabeled as paused");
  } finally {
    mcpBroker.releaseResult();
    await daemon.stop().catch(() => undefined);
    await runBodyPromise?.catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "unlinked", seedOptions: { linked: false } },
  { name: "unhealthy", seedOptions: { pluginHealthStatus: "failed" } },
]) {
  test(`same-id ${scenario.name} Cua MCP server cannot publish a Computer Use projection`, async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), `ling-stack-computer-use-${scenario.name}-`));
    const runner = new CompletingComputerUseRunner();
    const mcpBroker = new FakeCuaDriverBroker();
    const { capture, storeFactory } = createCapturedStoreFactory();
    const daemon = createDaemonServer(
      { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
      {
        runner,
        mcpBroker,
        storeFactory,
        computerUseRouteToken: COMPUTER_USE_ROUTE_TOKEN,
      },
    );
    await daemon.start();
    try {
      const address = daemon.server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      assert.ok(capture.store);
      const { server } = seedManagedCuaProvider(capture.store, {
        ...scenario.seedOptions,
        tools: [screenshotTool()],
      });
      await putJson(`${baseUrl}/teammates/teammate_builtin_engineer/mcp?cwd=${encodeURIComponent(cwd)}`, {
        bindings: [{
          serverId: server.id,
          mode: "selected",
          selectedToolNames: ["screenshot"],
          enabled: true,
        }],
      });

      const response = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runBody(cwd, `task_computer_use_${scenario.name}`)),
      });
      if (!response.ok) {
        assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
      }
      await response.text();
      assert.equal(runner.callCompleted, true);
      const listed = await getJson(
        `${baseUrl}/computer-use/sessions?cwd=${encodeURIComponent(cwd)}`,
        { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
      );
      assert.deepEqual(listed.projections, []);
    } finally {
      await daemon.stop().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

class FakeCuaDriverBroker {
  async checkServer(server, options) {
    const checkedAt = options.now?.() ?? new Date().toISOString();
    return {
      statusSnapshot: readyStatus(server.id, checkedAt, 1),
    };
  }

  async listTools(server, options) {
    const checkedAt = options.now?.() ?? new Date().toISOString();
    return {
      statusSnapshot: readyStatus(server.id, checkedAt, 1),
      tools: [screenshotTool()],
    };
  }

  async callTool(_server, _options, toolName, input) {
    return cuaToolResult(toolName, input);
  }
}

class BlockingComputerUseRunner {
  abortObserved = false;

  async runTask(options) {
    const tool = options.mcpTools?.find((candidate) => candidate.rawName === "screenshot");
    assert.ok(tool);
    assert.ok(options.onMcpToolCall);
    await options.onMcpToolCall({
      toolCallId: "cua_driver_screenshot_1",
      registeredName: tool.registeredName,
      serverId: tool.serverId,
      rawName: tool.rawName,
      input: {},
      task: options.task,
      cwd: options.cwd,
      defaultApproval: tool.defaultApproval,
    });
    return this.waitForAbort(options);
  }

  async waitForAbort(options) {
    await new Promise((resolvePromise, rejectPromise) => {
      const abort = () => {
        this.abortObserved = true;
        const error = new Error("Computer Use run aborted");
        error.name = "AbortError";
        rejectPromise(error);
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    throw new Error("Blocking Computer Use runner unexpectedly resumed");
  }
}

class ApprovalCuaDriverBroker extends FakeCuaDriverBroker {
  constructor() {
    super();
    this.started = new Promise((resolvePromise) => {
      this.resolveStarted = resolvePromise;
    });
    this.resultGate = new Promise((resolvePromise) => {
      this.resolveResult = resolvePromise;
    });
  }

  async listTools(server, options) {
    const checkedAt = options.now?.() ?? new Date().toISOString();
    return {
      statusSnapshot: readyStatus(server.id, checkedAt, 1),
      tools: [approvalTool()],
    };
  }

  async callTool(_server, _options, toolName) {
    assert.equal(toolName, "future_authorized_action");
    this.resolveStarted();
    await this.resultGate;
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      details: {
        pid: 9876,
        window_id: 8765,
        title: "Approved future window",
        bounds: { width: 1000, height: 700 },
      },
    };
  }

  releaseResult() {
    this.resolveResult();
  }
}

class CompletingComputerUseRunner {
  callCompleted = false;

  constructor(toolName = "screenshot", input = {}) {
    this.toolName = toolName;
    this.input = input;
  }

  async runTask(options) {
    const tool = options.mcpTools?.find((candidate) => candidate.rawName === this.toolName);
    assert.ok(tool);
    assert.ok(options.onMcpToolCall);
    await options.onMcpToolCall({
      toolCallId: "cua_driver_ineligible_screenshot",
      registeredName: tool.registeredName,
      serverId: tool.serverId,
      rawName: tool.rawName,
      input: this.input,
      task: options.task,
      cwd: options.cwd,
      defaultApproval: tool.defaultApproval,
    });
    this.callCompleted = true;
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

function screenshotTool() {
  return {
    rawName: "screenshot",
    displayName: "Screenshot",
    description: "Capture the authorized application window.",
    inputSchema: { type: "object", properties: {} },
    callableNamespace: "mcp_cua_driver",
    callableName: "screenshot",
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
  };
}

function approvalTool() {
  return {
    rawName: "future_authorized_action",
    displayName: "Future authorized action",
    description: "Operate an explicitly authorized application window.",
    inputSchema: { type: "object", properties: {} },
    callableNamespace: "mcp_cua_driver",
    callableName: "future_authorized_action",
    sideEffectLevel: "write",
    defaultApproval: "ask",
    enabled: true,
  };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    teammateId: "teammate_builtin_engineer",
    task: {
      id: taskId,
      title: taskId,
      prompt: "Use the authorized browser window.",
    },
    provider: { provider: "static-chat", model: "static-model" },
    tools: ["read"],
  };
}

function bundledConfig(cwd) {
  return {
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd: cwd,
    cuaDriver: {
      bundledEmbedded: {
        darwin: process.platform === "darwin",
        win32: process.platform === "win32",
      },
      packagedProvider: {
        darwin: process.platform === "darwin",
        win32: process.platform === "win32",
      },
    },
  };
}

function bundledLeaseClientFactory() {
  return {
    async connect() {
      return {
        async check(server, checkedAt) {
          return { statusSnapshot: readyStatus(server.id, checkedAt, 0) };
        },
        async checkHealth(server, checkedAt) {
          return { statusSnapshot: readyStatus(server.id, checkedAt, 0) };
        },
        async listTools(server, checkedAt) {
          return {
            statusSnapshot: readyStatus(server.id, checkedAt, 1),
            tools: [listWindowsTool()],
          };
        },
        async callTool(_server, toolName, input) {
          return cuaToolResult(toolName, input);
        },
        async close() {},
      };
    },
  };
}

function bundledLease(authority, cwd) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-computer-use-integration",
    desktopInstanceEpoch: authority.desktopInstanceEpoch,
    bridgeConnectionId: authority.bridgeConnectionId,
    generation: 1,
    daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
    workspaceCwd: cwd,
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lockDigest: "a".repeat(64),
    providerSealDigest: "b".repeat(64),
    ...(process.platform === "win32" ? { providerCatalogDigest: "c".repeat(64) } : {}),
    platform: process.platform,
    architecture: process.arch === "x64" ? "x86_64" : "arm64",
    integrityCoverage: "standard",
  };
}

function cuaToolResult(toolName, input) {
  if (toolName === "list_windows") {
    assert.deepEqual(input, { pid: 4321 });
    return {
      content: [],
      details: {
        structuredContent: {
          windows: [{
            pid: 4321,
            window_id: "7788",
            title: "Research Browser",
            bounds: { width: 1200, height: 800 },
          }],
        },
      },
    };
  }
  assert.equal(toolName, "screenshot");
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    details: {
      pid: 4321,
      bundle_id: "com.example.browser",
      window_id: 7788,
      title: "Research Browser",
      bounds: { width: 1200, height: 800 },
    },
  };
}

function listWindowsTool() {
  return {
    ...screenshotTool(),
    rawName: "list_windows",
    displayName: "List windows",
    callableName: "list_windows",
  };
}

class ApprovalComputerUseRunner extends BlockingComputerUseRunner {
  async runTask(options) {
    const tool = options.mcpTools?.find((candidate) => candidate.rawName === "future_authorized_action");
    assert.ok(tool);
    assert.ok(options.onApprovalRequired);
    assert.ok(options.onMcpToolCall);
    const decision = await options.onApprovalRequired({
      toolCallId: "cua_driver_approval_1",
      toolName: tool.registeredName,
      input: {},
      task: options.task,
      cwd: options.cwd,
      defaultApproval: tool.defaultApproval,
    });
    assert.equal(decision.approved, true);
    await options.onMcpToolCall({
      toolCallId: "cua_driver_approval_1",
      registeredName: tool.registeredName,
      serverId: "forged_runner_server",
      rawName: "forged_runner_tool",
      input: {},
      task: options.task,
      cwd: options.cwd,
      defaultApproval: tool.defaultApproval,
    });
    return super.waitForAbort(options);
  }
}

function readyStatus(serverId, checkedAt, toolCount) {
  return {
    serverId,
    status: "ready",
    authStatus: { kind: "configured", refs: [], missingRefs: [] },
    missingSecretRefs: [],
    message: "Connected",
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 5 * 60 * 1000).toISOString(),
    toolCount,
  };
}

async function waitForProjection(baseUrl, cwd) {
  return waitForProjectionMatching(baseUrl, cwd, () => true);
}

async function waitForCondition(predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.fail("Timed out waiting for bundled Cua Driver readiness.");
}

async function waitForProjectionMatching(baseUrl, cwd, predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const listed = await getJson(
      `${baseUrl}/computer-use/sessions?cwd=${encodeURIComponent(cwd)}`,
      { "X-Ling-Computer-Use-Token": COMPUTER_USE_ROUTE_TOKEN },
    );
    if (listed.projections[0] && predicate(listed.projections[0])) {
      return listed.projections[0];
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.fail("Timed out waiting for the matching Computer Use projection.");
}

async function getJson(url, extraHeaders = {}) {
  const response = await fetch(url, { headers: extraHeaders });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

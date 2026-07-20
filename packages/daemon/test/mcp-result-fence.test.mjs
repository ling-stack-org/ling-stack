import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDefaultMcpBroker } from "../dist/features/mcp/broker.js";
import {
  assertMcpResultAuthorityCurrent,
  captureMcpResultAuthority,
} from "../dist/features/mcp/result-authority.js";
import { createCuaDriverDescriptor } from "../dist/features/plugins/presets.js";
import { createMcpToolCallHandler } from "../dist/features/runs/mcp.js";

const fixtureTool = {
  rawName: "read_fixture",
  displayName: "Read fixture",
  inputSchema: { type: "object" },
  callableNamespace: "mcp_fixture",
  callableName: "read_fixture",
  sideEffectLevel: "read",
  defaultApproval: "allow",
  enabled: true,
};
const previewTool = {
  ...fixtureTool,
  rawName: "list_windows",
  displayName: "List windows",
  callableName: "list_windows",
};

test("default MCP broker fences a tool result after the production transport returns", async () => {
  const fixture = await startMcpHttpFixture();
  const broker = createDefaultMcpBroker();
  const staleError = new Error("fixture result is stale");
  let fenceCalls = 0;
  try {
    await assert.rejects(
      broker.callTool(
        fixture.server,
        {
          secretResolver: { resolve: () => ({ configured: false }) },
          assertResultCurrent() {
            fenceCalls += 1;
            assert.equal(fixture.toolCalls, 1);
            assert.equal(fixture.toolResponseFinished, true);
            throw staleError;
          },
        },
        "read_fixture",
        {},
      ),
      (error) => {
        assert.equal(error, staleError);
        return true;
      },
    );
    assert.equal(fenceCalls, 1);
  } finally {
    await fixture.close();
  }
});

test("default MCP broker discards a transport result after caller cancellation", async () => {
  const controller = new AbortController();
  const abortReason = new Error("default broker caller cancelled");
  const fixture = await startMcpHttpFixture({
    onToolResponseFinished: () => controller.abort(abortReason),
  });
  const broker = createDefaultMcpBroker();
  try {
    await assert.rejects(
      broker.callTool(
        fixture.server,
        {
          secretResolver: { resolve: () => ({ configured: false }) },
          signal: controller.signal,
        },
        "read_fixture",
        {},
      ),
      (error) => error === abortReason
        || (error instanceof Error && error.message.includes(abortReason.message)),
    );
    assert.equal(fixture.toolCalls, 1);
    assert.equal(fixture.toolResponseFinished, true);
  } finally {
    await fixture.close();
  }
});

test("MCP call forwards cancellation/workspace and accepts a current result", async () => {
  const fixture = await handlerFixture();
  const controller = new AbortController();
  const observed = [];
  try {
    const handler = createMcpToolCallHandler(
      fixture.store,
      fixture.secretResolver,
      {
        async checkServer() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        async callTool(_server, options) {
          observed.push(options);
          options.assertResultCurrent();
          return { content: [{ type: "text", text: "current" }] };
        },
      },
      [fixture.definition],
    );
    const result = await handler(request(controller.signal));
    assert.deepEqual(result.content, [{ type: "text", text: "current" }]);
    assert.equal(observed[0].workspaceCwd, fixture.cwd);
    assert.equal(observed[0].signal, controller.signal);
  } finally {
    await fixture.close();
  }
});

test("MCP handler rejects an already-cancelled request before dispatch", async () => {
  const fixture = await handlerFixture();
  const controller = new AbortController();
  const abortReason = new Error("run cancelled before MCP dispatch");
  controller.abort(abortReason);
  let brokerCalls = 0;
  let startCalls = 0;
  try {
    const handler = createMcpToolCallHandler(
      fixture.store,
      fixture.secretResolver,
      {
        async checkServer() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        async callTool() {
          brokerCalls += 1;
          return { content: [{ type: "text", text: "must not run" }] };
        },
      },
      [fixture.definition],
      { onStart: () => { startCalls += 1; } },
    );
    await assert.rejects(handler(request(controller.signal)), (error) => error === abortReason);
    assert.equal(brokerCalls, 0);
    assert.equal(startCalls, 0);
  } finally {
    await fixture.close();
  }
});

test("MCP consumer discards a custom-broker success after caller cancellation", async () => {
  const fixture = await handlerFixture();
  const controller = new AbortController();
  const abortReason = new Error("run cancelled");
  let onResultCalls = 0;
  try {
    const handler = createMcpToolCallHandler(
      fixture.store,
      fixture.secretResolver,
      {
        async checkServer() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        async callTool() {
          controller.abort(abortReason);
          return { content: [{ type: "text", text: "must not escape" }] };
        },
      },
      [fixture.definition],
      { onResult: () => { onResultCalls += 1; } },
    );

    await assert.rejects(handler(request(controller.signal)), (error) => error === abortReason);
    assert.equal(onResultCalls, 0);
  } finally {
    await fixture.close();
  }
});

for (const [name, mutate, message] of [
  [
    "server disabled",
    (store, now) => store.updateMcpServer("mcp_fixture", { enabled: false }, now),
    /mcp_result_authority_stale/,
  ],
  [
    "tool removed",
    (store, now) => store.replaceMcpServerTools("mcp_fixture", [], now),
    /mcp_result_authority_stale/,
  ],
  [
    "tool disabled after dispatch",
    (store, now) => store.updateMcpServer("mcp_fixture", { disabledTools: ["read_fixture"] }, now),
    /mcp_result_authority_stale/,
  ],
]) {
  test(`MCP result is discarded when ${name}`, async () => {
    const fixture = await handlerFixture();
    let onResultCalls = 0;
    try {
      const handler = createMcpToolCallHandler(
        fixture.store,
        fixture.secretResolver,
        {
          async checkServer() { throw new Error("not used"); },
          async listTools() { throw new Error("not used"); },
          async callTool(_server, options) {
            mutate(fixture.store, new Date().toISOString());
            options.assertResultCurrent();
            return { content: [{ type: "text", text: "must not escape" }] };
          },
        },
        [fixture.definition],
        { onResult: () => { onResultCalls += 1; } },
      );
      await assert.rejects(handler(request()), message);
      assert.equal(onResultCalls, 0);
    } finally {
      await fixture.close();
    }
  });
}

test("generic MCP result is discarded after a disable and re-enable ABA", async () => {
  const fixture = await handlerFixture();
  let onResultCalls = 0;
  try {
    const handler = createMcpToolCallHandler(
      fixture.store,
      fixture.secretResolver,
      {
        async checkServer() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        async callTool() {
          const authorityTime = fixture.store.getMcpServer("mcp_fixture").updatedAt;
          fixture.store.updateMcpServer("mcp_fixture", { enabled: false }, authorityTime);
          fixture.store.updateMcpServer("mcp_fixture", { enabled: true }, authorityTime);
          fixture.store.replaceMcpServerTools("mcp_fixture", [], authorityTime);
          fixture.store.replaceMcpServerTools("mcp_fixture", [fixtureTool], authorityTime);
          assert.equal(fixture.store.getMcpServer("mcp_fixture").updatedAt, authorityTime);
          assert.equal(
            fixture.store.listMcpTools({ serverId: "mcp_fixture" })[0].updatedAt,
            authorityTime,
          );
          return { content: [{ type: "text", text: "must not escape" }] };
        },
      },
      [fixture.definition],
      { onResult: () => { onResultCalls += 1; } },
    );
    await assert.rejects(handler(request()), /mcp_result_authority_stale/);
    assert.equal(onResultCalls, 0);
  } finally {
    await fixture.close();
  }
});

test("bundled MCP result is discarded after an activation epoch ABA", async () => {
  const fixture = await bundledHandlerFixture();
  let onResultCalls = 0;
  try {
    const handler = createMcpToolCallHandler(
      fixture.store,
      fixture.secretResolver,
      {
        async checkServer() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        async callTool() {
          const beforeDisable = fixture.store.getCuaDriverActivationState("trusted-local:cua-driver");
          const disabled = fixture.store.commitCuaDriverActivation({
            pluginId: "trusted-local:cua-driver",
            mcpServerId: "mcp_cua_driver",
            now: fixture.authorityTime,
            expected: {
              requestedRevision: beforeDisable.requestedRevision,
              activationEpoch: beforeDisable.activationEpoch,
            },
            requestedEnabled: false,
            requestedRevision: beforeDisable.requestedRevision + 1,
            activationEpoch: beforeDisable.activationEpoch + 1,
            effectiveEnabled: false,
            pluginEnabled: false,
            contributionEnabled: false,
            mcpServerEnabled: false,
            tools: [],
            statusSnapshot: null,
            healthSnapshot: null,
          });
          assert.equal(disabled.committed, true);
          const reenabled = fixture.store.commitCuaDriverActivation({
            pluginId: "trusted-local:cua-driver",
            mcpServerId: "mcp_cua_driver",
            now: fixture.authorityTime,
            expected: {
              requestedRevision: disabled.state.requestedRevision,
              activationEpoch: disabled.state.activationEpoch,
            },
            requestedEnabled: true,
            requestedRevision: disabled.state.requestedRevision + 1,
            activationEpoch: disabled.state.activationEpoch + 1,
            effectiveEnabled: true,
            pluginEnabled: true,
            contributionEnabled: true,
            mcpServerEnabled: true,
            tools: [fixtureTool],
            statusSnapshot: readyStatus("mcp_cua_driver", fixture.authorityTime),
            healthSnapshot: readyHealth(fixture.authorityTime),
            disabledReason: null,
          });
          assert.equal(reenabled.committed, true);
          assert.equal(fixture.store.getMcpServer("mcp_cua_driver").updatedAt, fixture.authorityTime);
          assert.equal(
            fixture.store.listMcpTools({ serverId: "mcp_cua_driver" })[0].updatedAt,
            fixture.authorityTime,
          );
          return { content: [{ type: "text", text: "must not escape" }] };
        },
      },
      [fixture.definition],
      { onResult: () => { onResultCalls += 1; } },
    );
    await assert.rejects(handler(request(undefined, "mcp_cua_driver")), /mcp_result_authority_stale/);
    assert.equal(onResultCalls, 0);
  } finally {
    await fixture.close();
  }
});

test("Computer Use preview provider result is stale after provider disable and re-enable", async () => {
  const fixture = await handlerFixture({ serverId: "mcp_cua_driver" });
  try {
    const baselineTime = fixture.store.getMcpServer("mcp_cua_driver").updatedAt;
    fixture.store.replaceMcpServerTools("mcp_cua_driver", [previewTool], baselineTime);
    const captured = captureMcpResultAuthority(fixture.store, "mcp_cua_driver", "list_windows");
    fixture.store.updateMcpServer("mcp_cua_driver", { enabled: false }, "2026-07-21T00:01:01.000Z");
    fixture.store.updateMcpServer("mcp_cua_driver", { enabled: true }, "2026-07-21T00:01:02.000Z");
    fixture.store.replaceMcpServerTools("mcp_cua_driver", [], "2026-07-21T00:01:03.000Z");
    fixture.store.replaceMcpServerTools("mcp_cua_driver", [previewTool], "2026-07-21T00:01:04.000Z");
    assert.throws(
      () => assertMcpResultAuthorityCurrent(fixture.store, captured.authority),
      /mcp_result_authority_stale/,
    );
  } finally {
    await fixture.close();
  }
});

async function handlerFixture(options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-mcp-result-fence-"));
  const store = createSqliteRunStore(cwd);
  const now = new Date().toISOString();
  const serverId = options.serverId ?? "mcp_fixture";
  store.createMcpServer({
    id: serverId,
    displayName: "Fixture MCP",
    transport: {
      type: "stdio",
      command: "/fixture/mcp",
      args: [],
      env: {},
      secretEnvRefs: {},
    },
    enabled: true,
    required: false,
    startupTimeoutSec: 30,
    toolTimeoutSec: 30,
  }, now);
  store.replaceMcpServerTools(serverId, [fixtureTool], now);
  return {
    cwd,
    store,
    secretResolver: { resolve: () => ({ configured: false }) },
    definition: {
      registeredName: "mcp_fixture_read_fixture",
      serverId,
      rawName: "read_fixture",
      displayName: "Read fixture",
      inputSchema: { type: "object" },
      sideEffectLevel: "read",
      defaultApproval: "allow",
    },
    async close() {
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function bundledHandlerFixture() {
  const fixture = await handlerFixture({ serverId: "mcp_cua_driver" });
  const descriptor = createCuaDriverDescriptor();
  const authorityTime = fixture.store.getMcpServer("mcp_cua_driver").updatedAt;
  fixture.store.upsertManagedPlugin({
    id: descriptor.id,
    sourceKind: descriptor.sourceKind,
    version: descriptor.version,
    enabled: false,
    descriptor,
  }, authorityTime);
  fixture.store.replaceManagedPluginContributions(descriptor.id, [{
    contributionKind: "mcp-server",
    contributionId: "mcp_cua_driver",
    linkedResourceId: "mcp_cua_driver",
    enabled: false,
  }], authorityTime);
  const state = fixture.store.ensureCuaDriverActivationState(descriptor.id, authorityTime);
  const ready = fixture.store.commitCuaDriverActivation({
    pluginId: descriptor.id,
    mcpServerId: "mcp_cua_driver",
    now: authorityTime,
    expected: {
      requestedRevision: state.requestedRevision,
      activationEpoch: state.activationEpoch,
    },
    requestedEnabled: true,
    requestedRevision: state.requestedRevision + 1,
    activationEpoch: state.activationEpoch + 1,
    effectiveEnabled: true,
    pluginEnabled: true,
    contributionEnabled: true,
    mcpServerEnabled: true,
    tools: [fixtureTool],
    statusSnapshot: readyStatus("mcp_cua_driver", authorityTime),
    healthSnapshot: readyHealth(authorityTime),
    disabledReason: null,
  });
  assert.equal(ready.committed, true);
  return { ...fixture, authorityTime };
}

function request(signal, serverId = "mcp_fixture") {
  return {
    toolCallId: "tool_fixture",
    registeredName: "mcp_fixture_read_fixture",
    serverId,
    rawName: "read_fixture",
    input: {},
    task: { id: "task_fixture", title: "Fixture", prompt: "Fixture" },
    cwd: "/tmp/fixture",
    defaultApproval: "allow",
    signal,
  };
}

function readyStatus(serverId, now) {
  return {
    serverId,
    checkedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "ready",
    toolCount: 1,
    missingSecretRefs: [],
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
  };
}

function readyHealth(now) {
  return {
    pluginId: "trusted-local:cua-driver",
    checkedAt: now,
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "ready",
  };
}

async function startMcpHttpFixture(options = {}) {
  let toolCalls = 0;
  let toolResponseFinished = false;
  const liveServers = new Set();

  const httpServer = createServer(async (request, response) => {
    const sdkServer = new SdkMcpServer({ name: "ling-default-broker-fixture", version: "1.0.0" });
    sdkServer.registerTool("read_fixture", {}, async () => {
      toolCalls += 1;
      return { content: [{ type: "text", text: "must be fenced" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    liveServers.add(sdkServer);
    response.once("finish", () => {
      if (toolCalls > 0) {
        toolResponseFinished = true;
        options.onToolResponseFinished?.();
      }
    });
    response.once("close", () => {
      liveServers.delete(sdkServer);
      void sdkServer.close();
    });
    try {
      await sdkServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      }
    }
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const now = new Date().toISOString();

  return {
    get toolCalls() { return toolCalls; },
    get toolResponseFinished() { return toolResponseFinished; },
    server: {
      id: "mcp_default_fence",
      workspaceId: "workspace_fixture",
      displayName: "Default broker fence fixture",
      transport: {
        type: "streamable-http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: {},
        secretHeaderRefs: {},
      },
      enabled: true,
      required: false,
      status: { kind: "unknown" },
      startupTimeoutSec: 5,
      toolTimeoutSec: 5,
      disabledTools: [],
      createdAt: now,
      updatedAt: now,
    },
    async close() {
      await Promise.all([...liveServers].map((server) => server.close()));
      await new Promise((resolveClose, rejectClose) => {
        httpServer.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  };
}

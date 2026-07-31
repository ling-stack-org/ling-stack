import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import {
  BundledCuaDriverActivationError,
  BundledCuaDriverActivationService,
  CuaDriverClientPool,
  CuaDriverLeaseRegistry,
  DefaultCuaDriverLeaseMcpClientFactory,
  createCuaDriverLeaseProxyHeaders,
  deriveCuaDriverLeaseProxyToken,
} from "../dist/index.js";

const pluginId = "trusted-local:cua-driver";
const serverId = "mcp_cua_driver";
const bridgeToken = "bridge-token-golden-0123456789";
const digest = "a".repeat(64);
const now = "2026-07-18T00:00:00.000Z";

const descriptor = {
  id: pluginId,
  displayName: "Cua Driver",
  version: "1.0.0",
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

function lease(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-golden",
    desktopInstanceEpoch: 7,
    bridgeConnectionId: "bridge-golden",
    generation: 11,
    daemonAuthorityEpoch: "authority-golden",
    workspaceCwd: "/Users/test/Ling Workspace",
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: "2026-07-18T00:01:00.000Z",
    lockDigest: digest,
    providerSealDigest: "b".repeat(64),
    providerCatalogDigest: "c".repeat(64),
    platform: "darwin",
    architecture: "arm64",
    ...overrides,
  };
}

function availability(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-golden",
    desktopInstanceEpoch: 7,
    bridgeConnectionId: "bridge-golden",
    daemonAuthorityEpoch: "authority-golden",
    workspaceCwd: "/Users/test/Ling Workspace",
    generation: 11,
    sequence: 4,
    platform: "darwin",
    providerState: "permission_required",
    reason: "darwin_accessibility_permission_required",
    limitations: [],
    ...overrides,
  };
}

test("lease proxy token and headers retain Desktop golden parity", () => {
  const current = lease();
  assert.equal(
    deriveCuaDriverLeaseProxyToken(current, bridgeToken),
    "d7pmUbSzK4AvREldLubF0gYnJdVJADo250Om05p9gyQ",
  );
  assert.deepEqual(createCuaDriverLeaseProxyHeaders(current, bridgeToken), {
    Authorization: "Bearer d7pmUbSzK4AvREldLubF0gYnJdVJADo250Om05p9gyQ",
    "x-ling-cua-driver-generation": "11",
    "x-ling-cua-driver-workspace-sha256": "sH0gnMOFdnwCvsGMtFRu6RFeLwIGhHH4rGAYSIL6bM0",
    "x-ling-cua-driver-authority-epoch": "authority-golden",
    "x-ling-cua-driver-instance-epoch": "7",
    "x-ling-cua-driver-bridge-connection": "bridge-golden",
  });

  for (const changed of [
    { daemonAuthorityEpoch: "authority-other" },
    { bridgeConnectionId: "bridge-other" },
    { desktopInstanceEpoch: 8 },
    { generation: 12 },
    { workspaceCwd: "/Users/test/Other Workspace" },
  ]) {
    assert.notEqual(
      deriveCuaDriverLeaseProxyToken(lease(changed), bridgeToken),
      deriveCuaDriverLeaseProxyToken(current, bridgeToken),
    );
  }
  assert.notEqual(
    deriveCuaDriverLeaseProxyToken(current, `${bridgeToken}-other`),
    deriveCuaDriverLeaseProxyToken(current, bridgeToken),
  );
});

test("lease renewal reuses the generation client because expiry is not proxy identity", async () => {
  const initial = lease({ expiresAt: "2026-07-18T00:00:30.000Z" });
  const renewed = lease({ expiresAt: "2026-07-18T00:01:30.000Z" });
  assert.equal(
    deriveCuaDriverLeaseProxyToken(initial, bridgeToken),
    deriveCuaDriverLeaseProxyToken(renewed, bridgeToken),
    "renewing authority must not rotate the generation-scoped proxy credential",
  );
  assert.deepEqual(
    createCuaDriverLeaseProxyHeaders(initial, bridgeToken),
    createCuaDriverLeaseProxyHeaders(renewed, bridgeToken),
    "Desktop validates generation context, while the daemon registry owns lease expiry",
  );

  let connects = 0;
  const client = { close() {} };
  const pool = new CuaDriverClientPool({
    factory: {
      async connect() {
        connects += 1;
        return client;
      },
    },
  });
  try {
    const first = await pool.acquire(initial);
    first.release();
    const afterRenewal = await pool.acquire(renewed);
    afterRenewal.release();

    assert.equal(afterRenewal.client, first.client);
    assert.equal(connects, 1);
    assert.equal(pool.size, 1);
  } finally {
    await pool.closeAll();
  }
});

test("lease proxy boundaries reject missing secrets and invalid authority tuples", () => {
  assert.throws(
    () => new DefaultCuaDriverLeaseMcpClientFactory({ bridgeToken: "   " }),
    /cua_driver_desktop_bridge_token_missing/,
  );
  assert.throws(
    () => createCuaDriverLeaseProxyHeaders(lease(), "   "),
    /cua_driver_desktop_bridge_token_missing/,
  );
  assert.throws(
    () => createCuaDriverLeaseProxyHeaders(lease({ generation: 0 }), bridgeToken),
    /cua_driver_proxy_context_invalid/,
  );
  assert.throws(
    () => new DefaultCuaDriverLeaseMcpClientFactory({
      bridgeToken,
      initializeTimeoutMs: 0,
    }),
    /cua_driver_lease_client_timeout_invalid/,
  );
});

test("lease MCP client initializes once and supports pooled check/list/call/close", async () => {
  const calls = [];
  let closeCalls = 0;
  let capturedHeaders;
  const sdkClient = {
    async connect(transport, options) {
      calls.push(["connect", transport, options]);
    },
    async ping(options) {
      calls.push(["ping", options]);
      return {};
    },
    getServerVersion() {
      return { name: "cua-driver", version: "0.8.3" };
    },
    async listTools(params, options) {
      calls.push(["listTools", params, options]);
      return {
        tools: [{
          name: "list_windows",
          description: "List windows.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        }],
      };
    },
    async callTool(request, _schema, options) {
      calls.push(["callTool", request, options]);
      if (request.name === "health_report") {
        return {
          content: [{ type: "text", text: "text is not the health authority" }],
          structuredContent: healthReport(),
          isError: false,
        };
      }
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    async close() {
      closeCalls += 1;
    },
  };
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => sdkClient,
    createTransport: (_lease, headers) => {
      capturedHeaders = headers;
      return { fixture: true };
    },
  });
  const client = await factory.connect(lease(), new AbortController().signal);
  await client.initialize();
  const server = activationServer();
  const checked = await client.check(server, now);
  const health = await client.checkHealth(server, now);
  const listed = await client.listTools(server, now);
  const called = await client.callTool(server, "list_windows", { includeHidden: false });

  assert.equal(calls.filter(([kind]) => kind === "connect").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "ping").length, 0);
  assert.equal(checked.statusSnapshot.status, "ready");
  assert.deepEqual(checked.statusSnapshot.serverInfo, { name: "cua-driver", version: "0.8.3" });
  assert.equal(health.statusSnapshot.status, "ready");
  assert.deepEqual(
    calls.find(([kind, request]) => kind === "callTool" && request.name === "health_report")?.[1],
    { name: "health_report", arguments: { skip: ["bundle_identity"] } },
  );
  assert.equal(listed.statusSnapshot.status, "ready");
  assert.deepEqual(listed.tools.map((tool) => [tool.rawName, tool.sideEffectLevel, tool.defaultApproval]), [
    ["list_windows", "read", "allow"],
  ]);
  assert.deepEqual(called.content, [{ type: "text", text: "ok" }]);
  assert.equal(capturedHeaders.Authorization, "Bearer d7pmUbSzK4AvREldLubF0gYnJdVJADo250Om05p9gyQ");
  await Promise.all([client.close(), client.close()]);
  assert.equal(closeCalls, 1);
  await assert.rejects(client.initialize(), /cua_driver_lease_client_closed/);
  await assert.rejects(client.check(server, now), /cua_driver_lease_client_closed/);
});

test("lease MCP initialization rejects missing or mismatched server identity before health", async (t) => {
  const cases = [
    ["missing serverInfo", undefined, "cua_embedded_protocol_mismatch"],
    ["wrong server name", { name: "other-driver", version: "0.8.3" }, "cua_embedded_protocol_mismatch"],
    ["wrong server version", { name: "cua-driver", version: "0.8.2" }, "cua_bundled_version_mismatch"],
  ];

  for (const [name, serverInfo, expectedError] of cases) {
    await t.test(name, async () => {
      let closeCalls = 0;
      let healthCalls = 0;
      const factory = new DefaultCuaDriverLeaseMcpClientFactory({
        bridgeToken,
        createClient: () => ({
          async connect() {},
          async ping() {},
          getServerVersion: () => serverInfo,
          async listTools() { return { tools: [] }; },
          async callTool(request) {
            if (request.name === "health_report") {
              healthCalls += 1;
              return {
                content: [],
                structuredContent: healthReport(),
                isError: false,
              };
            }
            return { content: [] };
          },
          async close() { closeCalls += 1; },
        }),
        createTransport: () => ({ fixture: true }),
      });

      await assert.rejects(
        factory.connect(lease(), new AbortController().signal),
        new RegExp(expectedError),
      );
      assert.equal(healthCalls, 0, "a valid health_report must not override initialize identity");
      assert.equal(closeCalls, 1);
    });
  }
});

test("lease MCP factory closes its SDK client when initialization fails", async () => {
  let closeCalls = 0;
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => ({
      async connect() { throw new Error("initialize failed"); },
      async ping() {},
      getServerVersion: () => undefined,
      async listTools() { return { tools: [] }; },
      async callTool() { return { content: [] }; },
      async close() { closeCalls += 1; },
    }),
    createTransport: () => ({ fixture: true }),
  });

  await assert.rejects(
    factory.connect(lease(), new AbortController().signal),
    /initialize failed/,
  );
  assert.equal(closeCalls, 1);
});

test("pooled lease client closes once when initialization completes after bounded shutdown", async () => {
  const connectGate = deferred();
  let closeCalls = 0;
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => ({
      async connect() { await connectGate.promise; },
      async ping() {},
      getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
      async listTools() { return { tools: [] }; },
      async callTool() { return { content: [] }; },
      async close() { closeCalls += 1; },
    }),
    createTransport: () => ({ fixture: true }),
  });
  const pool = new CuaDriverClientPool({ factory, closeTimeoutMs: 10 });
  const acquiring = pool.acquire(lease());
  await new Promise((resolve) => setImmediate(resolve));

  await pool.closeAll();
  connectGate.resolve();

  await assert.rejects(acquiring, /cua_driver_lease_client_stale/);
  await waitFor(() => closeCalls === 1);
  assert.equal(pool.size, 0);
  assert.equal(closeCalls, 1);
});

test("lease MCP check does not require the optional ping method from Cua Driver 0.8.3", async () => {
  let pingCalls = 0;
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => ({
      async connect() {},
      async ping() {
        pingCalls += 1;
        throw new Error("Cua Driver 0.8.3 does not implement ping");
      },
      getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
      async listTools() { return { tools: [] }; },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    createTransport: () => ({ fixture: true }),
  });
  const client = await factory.connect(lease(), new AbortController().signal);

  const checked = await client.check(activationServer(), now);

  assert.equal(checked.statusSnapshot.status, "ready");
  assert.equal(checked.statusSnapshot.errorCode, undefined);
  assert.equal(pingCalls, 0);
  await client.close();
});

test("lease MCP listTools follows every SDK cursor without raw transport fallback", async () => {
  const requests = [];
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => ({
      async connect() {},
      async ping() {},
      getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
      async listTools(params) {
        requests.push(params);
        return params?.cursor === "page-2"
          ? {
              tools: [{
                name: "get_window_state",
                description: "Get window state.",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              }],
            }
          : {
              tools: [{
                name: "list_windows",
                description: "List windows.",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true },
              }],
              nextCursor: "page-2",
            };
      },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    createTransport: () => ({ fixture: true }),
  });
  const client = await factory.connect(lease(), new AbortController().signal);

  const result = await client.listTools(activationServer(), now);

  assert.equal(result.statusSnapshot.status, "ready");
  assert.equal(result.statusSnapshot.toolCount, 2);
  assert.deepEqual(result.tools.map((tool) => tool.rawName), ["list_windows", "get_window_state"]);
  assert.deepEqual(requests, [undefined, { cursor: "page-2" }]);
  await client.close();
});

test("lease MCP listTools rejects cursor cycles and returns no partial tools", async () => {
  const requests = [];
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => ({
      async connect() {},
      async ping() {},
      getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
      async listTools(params) {
        requests.push(params);
        return {
          tools: [{ name: `tool_${requests.length}`, inputSchema: { type: "object" } }],
          nextCursor: params?.cursor === "page-2" ? "page-1" : "page-2",
        };
      },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    createTransport: () => ({ fixture: true }),
  });
  const client = await factory.connect(lease(), new AbortController().signal);

  const result = await client.listTools(activationServer(), now);

  assert.equal(result.statusSnapshot.status, "failed");
  assert.equal(result.statusSnapshot.errorCode, "cua_driver_tool_sync_failed");
  assert.match(result.statusSnapshot.message, /cua_driver_tool_cursor_repeated/);
  assert.deepEqual(result.tools, []);
  assert.deepEqual(requests, [undefined, { cursor: "page-2" }, { cursor: "page-1" }]);
  await client.close();
});

test("lease MCP listTools rejects page and tool-count overflow", async (t) => {
  const cases = [
    {
      name: "page limit",
      page() {
        return { tools: [], nextCursor: `page-${this.calls}` };
      },
      expected: /cua_driver_tool_page_limit_exceeded/,
    },
    {
      name: "tool count limit",
      page() {
        return {
          tools: Array.from({ length: 4_097 }, (_, index) => ({
            name: `tool_${index}`,
            inputSchema: { type: "object" },
          })),
        };
      },
      expected: /cua_driver_tool_count_limit_exceeded/,
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      fixture.calls = 0;
      const factory = new DefaultCuaDriverLeaseMcpClientFactory({
        bridgeToken,
        createClient: () => ({
          async connect() {},
          async ping() {},
          getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
          async listTools() {
            fixture.calls += 1;
            return fixture.page();
          },
          async callTool() { return { content: [] }; },
          async close() {},
        }),
        createTransport: () => ({ fixture: true }),
      });
      const client = await factory.connect(lease(), new AbortController().signal);
      const result = await client.listTools(activationServer(), now);
      assert.equal(result.statusSnapshot.status, "failed");
      assert.match(result.statusSnapshot.message, fixture.expected);
      assert.deepEqual(result.tools, []);
      await client.close();
    });
  }
});

test("lease MCP listTools enforces one total deadline across every page", async () => {
  const observedTimeouts = [];
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => ({
      async connect() {},
      async ping() {},
      getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
      async listTools(_params, options) {
        observedTimeouts.push(options.timeout);
        if (observedTimeouts.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          return { tools: [], nextCursor: "page-2" };
        }
        await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
      async callTool() { return { content: [] }; },
      async close() {},
    }),
    createTransport: () => ({ fixture: true }),
  });
  const client = await factory.connect(lease(), new AbortController().signal);
  const server = { ...activationServer(), toolTimeoutSec: 1 };
  const keepAlive = setTimeout(() => {}, 2_000);

  const result = await client.listTools(server, now).finally(() => clearTimeout(keepAlive));

  assert.equal(result.statusSnapshot.status, "failed");
  assert.equal(result.statusSnapshot.errorCode, "cua_driver_tool_sync_failed");
  assert.equal(observedTimeouts.length, 2);
  assert.ok(observedTimeouts[0] <= 1_000 && observedTimeouts[0] > 0);
  assert.ok(observedTimeouts[1] < 500 && observedTimeouts[1] > 0);
  await client.close();
});

test("lease MCP health gate accepts only the structured schema-v1 core report", async (t) => {
  const cases = [
    [
      "text-only report",
      {
        content: [{ type: "text", text: JSON.stringify(healthReport()) }],
        isError: false,
      },
      "cua_driver_health_report_incompatible",
    ],
    [
      "malformed schema",
      { content: [], structuredContent: healthReport({ schema_version: 2 }), isError: false },
      "cua_driver_health_report_incompatible",
    ],
    [
      "missing core check",
      {
        content: [],
        structuredContent: healthReport({
          checks: healthReport().checks.filter((check) => check.name !== "binary_version"),
        }),
        isError: false,
      },
      "cua_driver_health_report_incompatible",
    ],
    [
      "failed core check",
      {
        content: [],
        structuredContent: healthReport({
          checks: healthReport().checks.map((check) => (
            check.name === "platform_supported" ? { ...check, status: "fail" } : check
          )),
        }),
        isError: false,
      },
      "cua_driver_health_report_incompatible",
    ],
    [
      "bundle identity was not skipped",
      {
        content: [],
        structuredContent: healthReport({
          checks: healthReport().checks.map((check) => (
            check.name === "bundle_identity" ? { ...check, status: "pass" } : check
          )),
        }),
        isError: false,
      },
      "cua_driver_health_report_incompatible",
    ],
    [
      "tool error",
      { content: [], structuredContent: healthReport(), isError: true },
      "cua_driver_health_report_failed",
    ],
    [
      "non-object result",
      null,
      "cua_driver_health_report_incompatible",
    ],
    [
      "malformed isError marker",
      { content: [], structuredContent: healthReport(), isError: "false" },
      "cua_driver_health_report_incompatible",
    ],
    [
      "provider version mismatch",
      { content: [], structuredContent: healthReport({ driver_version: "0.8.2" }), isError: false },
      "cua_driver_health_report_incompatible",
    ],
    [
      "platform mismatch",
      { content: [], structuredContent: healthReport({ platform: "win32" }), isError: false },
      "cua_driver_health_report_incompatible",
    ],
    [
      "overall health is not ok",
      { content: [], structuredContent: healthReport({ overall: "degraded" }), isError: false },
      "cua_driver_health_report_incompatible",
    ],
    [
      "checks is not an array",
      { content: [], structuredContent: healthReport({ checks: null }), isError: false },
      "cua_driver_health_report_incompatible",
    ],
    [
      "duplicate check name",
      {
        content: [],
        structuredContent: healthReport({
          checks: [...healthReport().checks, { name: "binary_version", status: "pass" }],
        }),
        isError: false,
      },
      "cua_driver_health_report_incompatible",
    ],
    [
      "malformed check",
      {
        content: [],
        structuredContent: healthReport({
          checks: [...healthReport().checks, { name: "extra" }],
        }),
        isError: false,
      },
      "cua_driver_health_report_incompatible",
    ],
  ];

  for (const [name, callResult, expectedErrorCode] of cases) {
    await t.test(name, async () => {
      const calls = [];
      const factory = new DefaultCuaDriverLeaseMcpClientFactory({
        bridgeToken,
        createClient: () => ({
          async connect() {},
          async ping() {},
          getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
          async listTools() { throw new Error("health failure must not list tools"); },
          async callTool(request) {
            calls.push(request);
            return callResult;
          },
          async close() {},
        }),
        createTransport: () => ({ fixture: true }),
      });
      const client = await factory.connect(lease(), new AbortController().signal);
      const result = await client.checkHealth(activationServer(), now);

      assert.equal(result.statusSnapshot.status, "failed");
      assert.equal(result.statusSnapshot.errorCode, expectedErrorCode);
      assert.deepEqual(calls, [{
        name: "health_report",
        arguments: { skip: ["bundle_identity"] },
      }]);
      await client.close();
    });
  }
});

test("lease MCP health gate maps transport failures without accepting text fallback", async () => {
  const factory = new DefaultCuaDriverLeaseMcpClientFactory({
    bridgeToken,
    createClient: () => ({
      async connect() {},
      async ping() {},
      getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
      async listTools() { throw new Error("health failure must not list tools"); },
      async callTool() { throw new Error("health transport failed"); },
      async close() {},
    }),
    createTransport: () => ({ fixture: true }),
  });
  const client = await factory.connect(lease(), new AbortController().signal);

  const result = await client.checkHealth(activationServer(), now);

  assert.equal(result.statusSnapshot.status, "failed");
  assert.equal(result.statusSnapshot.errorCode, "cua_driver_health_report_failed");
  await client.close();
});

test("bundled listTools fails closed without the broker raw HTTP fallback", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("raw fallback must not run");
  };
  try {
    const factory = new DefaultCuaDriverLeaseMcpClientFactory({
      bridgeToken,
      createClient: () => ({
        async connect() {},
        async ping() {},
        getServerVersion: () => ({ name: "cua-driver", version: "0.8.3" }),
        async listTools() { throw new Error("sdk list failed"); },
        async callTool() { throw new Error("not used"); },
        async close() {},
      }),
      createTransport: () => ({ fixture: true }),
    });
    const client = await factory.connect(lease(), new AbortController().signal);
    const result = await client.listTools(activationServer(), now);
    assert.equal(result.statusSnapshot.status, "failed");
    assert.equal(result.statusSnapshot.errorCode, "cua_driver_tool_sync_failed");
    assert.match(result.statusSnapshot.message, /sdk list failed/);
    assert.deepEqual(result.tools, []);
    assert.equal(fetchCalls, 0);
    await client.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bundled activation uses only the lease client and startup reset retains intent fail-closed", async () => {
  const fixture = await activationFixture();
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const result = await fixture.service.enable({
      store: fixture.store,
      descriptor,
      now,
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.committed, true);
    assert.equal(fixture.connects.length, 1);
    assert.deepEqual(fixture.phaseCalls, ["check", "health", "listTools"]);
    assert.equal(fixture.connects[0].endpoint, lease().endpoint);
    assert.deepEqual(fixture.store.getCuaDriverActivationState(pluginId), {
      pluginId,
      requestedEnabled: true,
      requestedRevision: 1,
      activationEpoch: 1,
      updatedAt: now,
    });
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, true);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, true);
    const readyDetails = fixture.store.getManagedPluginHealthSnapshot(pluginId).details;
    assert.equal(readyDetails.providerState, "ready");
    assert.equal(readyDetails.platform, "darwin");
    assert.equal(readyDetails.providerVersion, "0.8.3");
    assert.equal(readyDetails.providerDistributionRevision, "ling.1");
    assert.equal(readyDetails.providerSealDigest, "b".repeat(64));
    assert.equal(readyDetails.providerCatalogDigest, "c".repeat(64));
    assert.equal(readyDetails.integrityCoverage, undefined);
    assert.equal(readyDetails.limitations, undefined);
    assert.deepEqual(fixture.store.listMcpTools({ serverId }).map((tool) => tool.rawName), ["list_windows"]);
    assert.equal(
      fixture.store.getMcpServer(serverId).transport.command,
      "/persisted-command-must-never-run",
      "bundled activation must neither read nor rewrite the persisted external command",
    );

    const resetAt = "2026-07-18T00:00:10.000Z";
    const reset = fixture.service.resetForDaemonStart({
      store: fixture.store,
      descriptor,
      now: resetAt,
    });
    assert.deepEqual(reset, {
      committed: true,
      requestedEnabled: true,
      requestedRevision: 1,
      activationEpoch: 2,
    });
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
    assert.equal(fixture.store.getMcpStatusSnapshot(serverId).status, "failed");
    assert.equal(
      fixture.store.getManagedPluginHealthSnapshot(pluginId)?.details?.providerState,
      "desktop_unavailable",
    );
  } finally {
    await fixture.close();
  }
});

test("Desktop availability projects exact recoverable state without granting tools", async (t) => {
  const cases = [
    ["included", "cua_desktop_provider_included"],
    ["permission_required", "cua_embedded_permission_required"],
    ["interactive_session_required", "cua_windows_interactive_session_required"],
    ["platform_unavailable", "cua_embedded_platform_unavailable"],
    ["incompatible", "cua_embedded_protocol_mismatch"],
    ["corrupt", "cua_embedded_artifact_invalid"],
    ["desktop_unavailable", "cua_desktop_lease_unavailable"],
  ];
  for (const [providerState, errorCode] of cases) {
    await t.test(providerState, async () => {
      const fixture = await activationFixture();
      try {
        const enabled = await fixture.service.enable({ store: fixture.store, descriptor, now });
        assert.equal(enabled.statusCode, 202);
        assert.equal(enabled.error, "cua_desktop_lease_unavailable");

        const projected = fixture.service.projectDesktopAvailability({
          store: fixture.store,
          descriptor,
          now: "2026-07-18T00:00:02.000Z",
          availability: availability({ providerState }),
        });

        assert.equal(projected.committed, true);
        assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
        assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
        assert.deepEqual(fixture.store.listMcpTools({ serverId }), []);
        const health = fixture.store.getManagedPluginHealthSnapshot(pluginId);
        assert.equal(health.details.providerState, providerState);
        assert.equal(health.details.errorCode, errorCode);
        assert.equal(health.details.desktopGeneration, 11);
        assert.equal(health.details.desktopSequence, 4);
        assert.equal(fixture.store.getMcpStatusSnapshot(serverId).errorCode, errorCode);
      } finally {
        await fixture.close();
      }
    });
  }
});

test("Win32 Desktop availability retains only the governed integrity metadata", async () => {
  const fixture = await activationFixture();
  try {
    await fixture.service.enable({ store: fixture.store, descriptor, now });
    const projected = fixture.service.projectDesktopAvailability({
      store: fixture.store,
      descriptor,
      now: "2026-07-18T00:00:02.000Z",
      availability: availability({
        platform: "win32",
        providerState: "interactive_session_required",
        reason: "windows_interactive_session_required",
        integrityCoverage: "standard",
        limitations: ["elevated_pixel_input", "uwp_send_input"],
      }),
    });

    assert.equal(projected.committed, true);
    const details = fixture.store.getManagedPluginHealthSnapshot(pluginId).details;
    assert.equal(details.platform, "win32");
    assert.equal(details.integrityCoverage, "standard");
    assert.deepEqual(details.limitations, ["elevated_pixel_input", "uwp_send_input"]);
    assert.equal(details.reason, "windows_interactive_session_required");
  } finally {
    await fixture.close();
  }
});

test("Desktop availability cannot turn a disabled user intent into an effective provider", async () => {
  const fixture = await activationFixture();
  try {
    const projected = fixture.service.projectDesktopAvailability({
      store: fixture.store,
      descriptor,
      now: "2026-07-18T00:00:02.000Z",
      availability: availability({
        providerState: "corrupt",
        reason: "provider_seal_mismatch",
      }),
    });

    assert.equal(projected.committed, true);
    assert.equal(projected.requestedEnabled, false);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.deepEqual(fixture.store.listMcpTools({ serverId }), []);
    const health = fixture.store.getManagedPluginHealthSnapshot(pluginId);
    assert.equal(health.status, "disabled");
    assert.equal(health.details.providerState, "included");
    assert.equal(health.details.errorCode, undefined);
    assert.equal(health.details.reason, undefined);
  } finally {
    await fixture.close();
  }
});

test("enable without a lease reuses the latest authenticated Desktop repair state", async () => {
  const fixture = await activationFixture({
    desktopAvailability: availability({ providerState: "permission_required" }),
  });
  try {
    const result = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(result.statusCode, 202);
    assert.equal(result.error, "cua_embedded_permission_required");
    assert.equal(result.health.details.providerState, "permission_required");
    assert.equal(result.health.details.errorCode, "cua_embedded_permission_required");
    assert.equal(fixture.store.getMcpStatusSnapshot(serverId).errorCode, "cua_embedded_permission_required");
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.deepEqual(fixture.store.listMcpTools({ serverId }), []);
  } finally {
    await fixture.close();
  }
});

test("a current Desktop permission wait bypasses MCP checks even when a lease exists", async () => {
  const fixture = await activationFixture({
    desktopAvailability: availability({ providerState: "permission_required" }),
  });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);

    const result = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(result.statusCode, 202);
    assert.equal(result.error, "cua_embedded_permission_required");
    assert.equal(result.health.details.providerState, "permission_required");
    assert.equal(result.health.details.errorCode, "cua_embedded_permission_required");
    assert.equal(fixture.connects.length, 0, "permission repair state must not open a gated MCP session");
    assert.equal(fixture.checkCalls, 0);
    assert.equal(fixture.healthCalls, 0);
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.deepEqual(fixture.store.listMcpTools({ serverId }), []);
  } finally {
    await fixture.close();
  }
});

test("bundled activation filters updater tools and overrides every provider-supplied approval hint", async () => {
  const fixture = await activationFixture({
    tools: [
      toolInput(),
      toolInput({ rawName: "check_for_update", callableName: "check_for_update" }),
      toolInput({ rawName: "install_ffmpeg", callableName: "install_ffmpeg" }),
      toolInput({ rawName: "click", callableName: "click" }),
      toolInput({ rawName: "replay_trajectory", callableName: "replay_trajectory" }),
    ],
  });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);

    const result = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(
      result.tools.map((tool) => [tool.rawName, tool.sideEffectLevel, tool.defaultApproval]),
      [
        ["click", "external", "ask"],
        ["list_windows", "read", "allow"],
        ["replay_trajectory", "external", "deny"],
      ],
    );
    assert.deepEqual(
      fixture.store.listMcpTools({ serverId }).map((tool) => tool.rawName),
      ["click", "list_windows", "replay_trajectory"],
    );
  } finally {
    await fixture.close();
  }
});

test("bundled activation rejects an unreviewed future tool before catalog publication", async () => {
  const fixture = await activationFixture({
    tools: [toolInput({ rawName: "future_mutating_tool", callableName: "future_mutating_tool" })],
  });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);

    const result = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(result.statusCode, 400);
    assert.equal(result.error, "cua_embedded_protocol_mismatch");
    assert.match(result.message, /future_mutating_tool/);
    assert.deepEqual(fixture.store.listMcpTools({ serverId }), []);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.equal(
      fixture.store.getManagedPluginHealthSnapshot(pluginId)?.details?.providerState,
      "incompatible",
    );
  } finally {
    await fixture.close();
  }
});

test("duplicate enables share one generation client without the stale attempt closing the winner", async () => {
  const checkGate = deferred();
  const fixture = await activationFixture({ checkGate });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const first = fixture.service.enable({ store: fixture.store, descriptor, now });
    await waitFor(() => fixture.checkCalls === 1);

    const second = fixture.service.enable({
      store: fixture.store,
      descriptor,
      now: "2026-07-18T00:00:01.000Z",
    });
    await waitFor(() => fixture.checkCalls === 2);
    checkGate.resolve();

    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.statusCode), [409, 200]);
    assert.equal(results[0].error, "cua_driver_activation_stale");
    assert.equal(results[1].health.status, "ready");
    assert.equal(fixture.connects.length, 1);
    assert.equal(fixture.pool.size, 1);
    assert.equal(fixture.closes, 0);
    assert.deepEqual(fixture.store.getCuaDriverActivationState(pluginId), {
      pluginId,
      requestedEnabled: true,
      requestedRevision: 1,
      activationEpoch: 2,
      updatedAt: "2026-07-18T00:00:01.000Z",
    });
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, true);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, true);
    assert.deepEqual(fixture.store.listMcpTools({ serverId }).map((tool) => tool.rawName), ["list_windows"]);
  } finally {
    await fixture.close();
  }
});

test("clean bundled workspace creates an inert logical server without command or PATH resolution", async () => {
  const fixture = await activationFixture({ clean: true });
  try {
    assert.equal(await fixture.service.reconcileRequestedIntent({
      store: fixture.store,
      descriptor,
      now,
    }), undefined);
    const result = await fixture.service.check({ store: fixture.store, descriptor, now });
    const logicalServer = fixture.store.getMcpServer(serverId);

    assert.equal(result.statusCode, 200);
    assert.equal(result.health.status, "disabled");
    assert.equal(fixture.connects.length, 0);
    assert.equal(logicalServer.transport.type, "streamable-http");
    assert.equal(logicalServer.transport.url, "http://127.0.0.1/.ling/cua-driver-bundled-lease");
    assert.equal(logicalServer.enabled, false);
    assert.deepEqual(fixture.store.getCuaDriverActivationState(pluginId), {
      pluginId,
      requestedEnabled: false,
      requestedRevision: 0,
      activationEpoch: 1,
      updatedAt: now,
    });
  } finally {
    await fixture.close();
  }
});

test("bundled activation rejects a descriptor outside the fixed plugin identity", async () => {
  const fixture = await activationFixture();
  try {
    await assert.rejects(
      fixture.service.check({
        store: fixture.store,
        descriptor: { ...descriptor, id: "trusted-local:not-cua-driver" },
        now,
      }),
      (error) => error instanceof BundledCuaDriverActivationError
        && error.activationCode === "plugin_identity_invalid",
    );
    assert.equal(fixture.connects.length, 0);
  } finally {
    await fixture.close();
  }
});

test("activation returns stale before protocol work when its begin CAS loses", async () => {
  const fixture = await activationFixture();
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const staleStore = interceptActivationCommits(fixture.store, ({ state }) => ({
      committed: false,
      state,
    }));

    const result = await fixture.service.enable({ store: staleStore, descriptor, now });

    assert.equal(result.statusCode, 409);
    assert.equal(result.committed, false);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.equal(fixture.connects.length, 0);
    assert.deepEqual(fixture.phaseCalls, []);
  } finally {
    await fixture.close();
  }
});

test("disabled check returns stale when its reset CAS loses", async () => {
  const fixture = await activationFixture();
  try {
    const staleStore = interceptActivationCommits(fixture.store, ({ state }) => ({
      committed: false,
      state,
    }));

    const result = await fixture.service.check({ store: staleStore, descriptor, now });

    assert.equal(result.statusCode, 409);
    assert.equal(result.committed, false);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.equal(fixture.connects.length, 0);
  } finally {
    await fixture.close();
  }
});

test("enable retains intent without a lease and reconcile activates after lease publication", async () => {
  const fixture = await activationFixture();
  try {
    const waiting = await fixture.service.enable({ store: fixture.store, descriptor, now });
    assert.equal(waiting.statusCode, 202);
    assert.equal(waiting.error, "cua_desktop_lease_unavailable");
    assert.equal(fixture.store.getCuaDriverActivationState(pluginId).requestedEnabled, true);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);

    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const ready = await fixture.service.reconcileRequestedIntent({
      store: fixture.store,
      descriptor,
      now: "2026-07-18T00:00:05.000Z",
    });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.committed, true);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, true);
    assert.equal(fixture.store.getCuaDriverActivationState(pluginId).activationEpoch, 2);
  } finally {
    await fixture.close();
  }
});

test("non-ready pooled client is closed and removed before retry", async () => {
  const fixture = await activationFixture({ failList: true });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const failed = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(failed.statusCode, 400);
    assert.equal(failed.error, "cua_driver_tool_sync_failed");
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.closes, 1);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("non-ready check closes the client and never reaches health or listTools", async () => {
  const fixture = await activationFixture({ failCheck: true });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);

    const failed = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(failed.statusCode, 400);
    assert.equal(failed.error, "cua_driver_check_failed");
    assert.deepEqual(fixture.phaseCalls, ["check"]);
    assert.equal(fixture.healthCalls, 0);
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.closes, 1);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
  } finally {
    await fixture.close();
  }
});

test("unexpected check exception maps to client failure and closes the pooled client", async () => {
  const fixture = await activationFixture({ throwCheck: true });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);

    const failed = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(failed.statusCode, 400);
    assert.equal(failed.error, "cua_desktop_lease_client_failed");
    assert.match(failed.message, /unexpected check failure/);
    assert.equal(fixture.healthCalls, 0);
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.closes, 1);
  } finally {
    await fixture.close();
  }
});

test("health failure closes the pooled client without listing or publishing tools", async () => {
  const fixture = await activationFixture({ failHealth: true });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const failed = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(failed.statusCode, 400);
    assert.equal(failed.error, "cua_driver_health_report_failed");
    assert.equal(fixture.healthCalls, 1);
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("health incompatibility remains fail-closed and projects an incompatible provider", async () => {
  const fixture = await activationFixture({
    healthErrorCode: "cua_driver_health_report_incompatible",
  });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const failed = await fixture.service.enable({ store: fixture.store, descriptor, now });

    assert.equal(failed.statusCode, 400);
    assert.equal(failed.error, "cua_driver_health_report_incompatible");
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(
      fixture.store.getManagedPluginHealthSnapshot(pluginId)?.details?.providerState,
      "incompatible",
    );
  } finally {
    await fixture.close();
  }
});

test("lease replacement closes the stale pool and prevents generation G from committing", async () => {
  const healthGate = deferred();
  const fixture = await activationFixture({ healthGate });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const activating = fixture.service.enable({ store: fixture.store, descriptor, now });
    await waitFor(() => fixture.healthCalls === 1);

    const nextLease = lease({ generation: 12, endpoint: "http://127.0.0.1:43124/mcp" });
    assert.equal(fixture.registry.publish(nextLease).accepted, true);
    healthGate.resolve();
    const result = await activating;
    await waitFor(() => fixture.closes === 1);

    assert.equal(result.statusCode, 409);
    assert.equal(result.committed, false);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.equal(fixture.store.getCuaDriverActivationState(pluginId).requestedEnabled, true);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
    assert.equal(fixture.listCalls, 0);
  } finally {
    await fixture.close();
  }
});

test("lease replacement after check stops before health_report and closes the old client", async () => {
  const checkGate = deferred();
  const fixture = await activationFixture({ checkGate });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const activating = fixture.service.enable({ store: fixture.store, descriptor, now });
    await waitFor(() => fixture.checkCalls === 1);

    assert.equal(fixture.registry.publish(lease({ generation: 12 })).accepted, true);
    checkGate.resolve();
    const result = await activating;
    await waitFor(() => fixture.closes === 1);

    assert.equal(result.statusCode, 409);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.deepEqual(fixture.phaseCalls, ["check"]);
    assert.equal(fixture.healthCalls, 0);
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("an unexpected check failure reports stale when its lease was replaced concurrently", async () => {
  const checkGate = deferred();
  const fixture = await activationFixture({ checkGate, throwCheck: true });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const activating = fixture.service.enable({ store: fixture.store, descriptor, now });
    await waitFor(() => fixture.checkCalls === 1);

    assert.equal(fixture.registry.publish(lease({ generation: 12 })).accepted, true);
    checkGate.resolve();
    const result = await activating;
    await waitFor(() => fixture.closes === 1);

    assert.equal(result.statusCode, 409);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.equal(fixture.healthCalls, 0);
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.pool.size, 0);
  } finally {
    await fixture.close();
  }
});

test("activation crossing lease expiry cannot commit before the deadline timer runs", async () => {
  let liveNow = now;
  const fixture = await activationFixture({
    clock: () => liveNow,
    healthGate: deferred(),
  });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const activating = fixture.service.enable({ store: fixture.store, descriptor, now });
    await waitFor(() => fixture.healthCalls === 1);

    liveNow = lease().expiresAt;
    fixture.healthGate.resolve();
    const result = await activating;

    assert.equal(result.statusCode, 409);
    assert.equal(result.committed, false);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.equal(fixture.listCalls, 0);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("lease expiry during listTools fences publication and closes the expired client", async () => {
  let liveNow = now;
  const listGate = deferred();
  const fixture = await activationFixture({
    clock: () => liveNow,
    listGate,
  });
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const activating = fixture.service.enable({ store: fixture.store, descriptor, now });
    await waitFor(() => fixture.listCalls === 1);

    liveNow = lease().expiresAt;
    listGate.resolve();
    const result = await activating;
    await waitFor(() => fixture.closes === 1);

    assert.equal(result.statusCode, 409);
    assert.equal(result.committed, false);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.deepEqual(fixture.phaseCalls, ["check", "health", "listTools"]);
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("final activation CAS loss returns stale without retiring the shared lease client", async () => {
  const fixture = await activationFixture();
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    const staleStore = interceptActivationCommits(fixture.store, ({ attempt, commit, state }) => (
      attempt === 2 ? { committed: false, state } : commit()
    ));

    const result = await fixture.service.enable({ store: staleStore, descriptor, now });

    assert.equal(result.statusCode, 409);
    assert.equal(result.committed, false);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.deepEqual(fixture.phaseCalls, ["check", "health", "listTools"]);
    assert.equal(fixture.pool.size, 1);
    assert.equal(fixture.closes, 0);
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
  } finally {
    await fixture.close();
  }
});

test("stale disable does not close the client owned by a newer enable winner", async () => {
  const fixture = await activationFixture();
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    assert.equal((await fixture.service.enable({ store: fixture.store, descriptor, now })).statusCode, 200);
    const staleState = fixture.store.getCuaDriverActivationState(pluginId);
    assert.equal((await fixture.service.enable({
      store: fixture.store,
      descriptor,
      now: "2026-07-18T00:00:05.000Z",
    })).statusCode, 200);
    const staleStore = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "ensureCuaDriverActivationState") {
          return () => staleState;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await fixture.service.disable({
      store: staleStore,
      descriptor,
      now: "2026-07-18T00:00:10.000Z",
    });

    assert.equal(result.statusCode, 409);
    assert.equal(result.committed, false);
    assert.equal(result.error, "cua_driver_activation_stale");
    assert.equal(fixture.connects.length, 1);
    assert.equal(fixture.pool.size, 1);
    assert.equal(fixture.closes, 0);
    assert.deepEqual(fixture.store.getCuaDriverActivationState(pluginId), {
      pluginId,
      requestedEnabled: true,
      requestedRevision: 1,
      activationEpoch: 2,
      updatedAt: "2026-07-18T00:00:05.000Z",
    });
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, true);
  } finally {
    await fixture.close();
  }
});

test("disable advances requestedRevision and fences an in-flight check", async () => {
  const fixture = await activationFixture();
  try {
    assert.equal(fixture.registry.publish(lease()).accepted, true);
    assert.equal((await fixture.service.enable({ store: fixture.store, descriptor, now })).statusCode, 200);

    const healthGate = deferred();
    fixture.healthGate = healthGate;
    const checking = fixture.service.check({
      store: fixture.store,
      descriptor,
      now: "2026-07-18T00:00:10.000Z",
    });
    await waitFor(() => fixture.healthCalls >= 2);
    const disabling = fixture.service.disable({
      store: fixture.store,
      descriptor,
      now: "2026-07-18T00:00:11.000Z",
      reason: "user disabled",
    });
    await waitFor(() => fixture.store.getCuaDriverActivationState(pluginId).requestedEnabled === false);
    healthGate.resolve();
    const [disabled, late] = await Promise.all([disabling, checking]);

    assert.equal(disabled.statusCode, 200);
    assert.equal(late.statusCode, 409);
    assert.deepEqual(fixture.store.getCuaDriverActivationState(pluginId), {
      pluginId,
      requestedEnabled: false,
      requestedRevision: 2,
      activationEpoch: 3,
      updatedAt: "2026-07-18T00:00:11.000Z",
    });
    assert.equal(fixture.store.getManagedPlugin(pluginId).enabled, false);
    assert.equal(fixture.store.getMcpServer(serverId).enabled, false);
    assert.equal(fixture.store.listMcpTools({ serverId }).length, 0);
    assert.equal(fixture.listCalls, 1, "the stale health result must not start a second listTools call");
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.closes, 1);
  } finally {
    await fixture.close();
  }
});

async function activationFixture(options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-cua-bundled-activation-"));
  const store = createSqliteRunStore(cwd);
  if (!options.clean) {
    store.upsertManagedPlugin({
      id: pluginId,
      sourceKind: descriptor.sourceKind,
      version: descriptor.version,
      enabled: false,
      descriptor,
    }, now);
    store.replaceManagedPluginContributions(pluginId, [{
      contributionKind: "mcp-server",
      contributionId: serverId,
      linkedResourceId: serverId,
      enabled: false,
    }], now);
    store.createMcpServer({
      id: serverId,
      displayName: "Cua Driver",
      enabled: false,
      transport: {
        type: "stdio",
        command: "/persisted-command-must-never-run",
        args: ["mcp"],
        env: {},
        secretEnvRefs: {},
      },
      startupTimeoutSec: 30,
      toolTimeoutSec: 60,
    }, now);
    store.ensureCuaDriverActivationState(pluginId, now);
  }

  const connects = [];
  let closes = 0;
  let checkCalls = 0;
  let healthCalls = 0;
  let listCalls = 0;
  const phaseCalls = [];
  let healthGate = options.healthGate;
  let pool;
  const registry = new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-golden",
    workspaceCwd: "/Users/test/Ling Workspace",
    now: options.clock ?? (() => now),
    onReplaced: (_previous, next) => {
      void pool?.closeStale(next);
    },
  });
  pool = new CuaDriverClientPool({
    factory: {
      async connect(currentLease) {
        connects.push(currentLease);
        return {
          async initialize() {},
          async check(server, checkedAt) {
            checkCalls += 1;
            phaseCalls.push("check");
            await options.checkGate?.promise;
            if (options.throwCheck) {
              throw new Error("unexpected check failure");
            }
            if (options.failCheck) {
              return {
                statusSnapshot: failedStatus(
                  server.id,
                  checkedAt,
                  "check failed",
                  "cua_driver_check_failed",
                ),
              };
            }
            return { statusSnapshot: readyStatus(server.id, checkedAt, 0) };
          },
          async checkHealth(server, checkedAt) {
            healthCalls += 1;
            phaseCalls.push("health");
            await healthGate?.promise;
            const healthErrorCode = options.healthErrorCode
              ?? (options.failHealth ? "cua_driver_health_report_failed" : undefined);
            return {
              statusSnapshot: healthErrorCode
                ? failedStatus(
                    server.id,
                    checkedAt,
                    "health failed",
                    healthErrorCode,
                  )
                : readyStatus(server.id, checkedAt, 0),
            };
          },
          async listTools(server, checkedAt) {
            listCalls += 1;
            phaseCalls.push("listTools");
            await options.listGate?.promise;
            if (options.failList) {
              return {
                statusSnapshot: failedStatus(
                  server.id,
                  checkedAt,
                  "list failed",
                  "cua_driver_tool_sync_failed",
                ),
                tools: [],
              };
            }
            const tools = options.tools ?? [toolInput()];
            return {
              statusSnapshot: readyStatus(server.id, checkedAt, tools.length),
              tools,
            };
          },
          async callTool() {
            return { content: [{ type: "text", text: "ok" }], isError: false };
          },
          close() {
            closes += 1;
          },
        };
      },
    },
  });
  const service = new BundledCuaDriverActivationService({
    leaseRegistry: registry,
    clientPool: pool,
    ...(options.desktopAvailability
      ? { getDesktopAvailability: () => options.desktopAvailability }
      : {}),
  });
  return {
    cwd,
    store,
    registry,
    pool,
    service,
    connects,
    get closes() { return closes; },
    get checkCalls() { return checkCalls; },
    get healthCalls() { return healthCalls; },
    get listCalls() { return listCalls; },
    phaseCalls,
    get healthGate() { return healthGate; },
    set healthGate(value) { healthGate = value; },
    async close() {
      await pool.closeAll();
      registry.clear();
      store.close();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

function interceptActivationCommits(store, decide) {
  let attempt = 0;
  return new Proxy(store, {
    get(target, property) {
      if (property === "commitCuaDriverActivation") {
        return (input) => {
          attempt += 1;
          return decide({
            attempt,
            input,
            state: target.getCuaDriverActivationState(input.pluginId),
            commit: () => target.commitCuaDriverActivation(input),
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function activationServer() {
  return {
    id: serverId,
    workspaceId: "/Users/test/Ling Workspace",
    displayName: "Cua Driver",
    transport: {
      type: "stdio",
      command: "/persisted-command-must-never-run",
      args: ["mcp"],
      env: {},
      secretEnvRefs: {},
    },
    enabled: true,
    required: false,
    status: { kind: "unknown" },
    startupTimeoutSec: 30,
    toolTimeoutSec: 60,
    disabledTools: [],
    createdAt: now,
    updatedAt: now,
  };
}

function readyStatus(id, checkedAt, toolCount) {
  return {
    serverId: id,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 5 * 60 * 1_000).toISOString(),
    status: "ready",
    serverInfo: { name: "cua-driver", version: "0.8.3" },
    toolCount,
    missingSecretRefs: [],
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
    message: toolCount > 0 ? `${toolCount} MCP tool(s) discovered.` : "Connected to cua-driver.",
  };
}

function failedStatus(id, checkedAt, message, errorCode = "cua_desktop_lease_client_failed") {
  return {
    serverId: id,
    checkedAt,
    expiresAt: new Date(Date.parse(checkedAt) + 5 * 60 * 1_000).toISOString(),
    status: "failed",
    toolCount: 0,
    missingSecretRefs: [],
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
    errorCode,
    message,
  };
}

function healthReport(overrides = {}) {
  return {
    schema_version: 1,
    driver_version: "0.8.3",
    platform: "darwin",
    overall: "ok",
    checks: [
      { name: "binary_version", status: "pass" },
      { name: "platform_supported", status: "pass" },
      { name: "bundle_identity", status: "skip" },
    ],
    ...overrides,
  };
}

function toolInput(overrides = {}) {
  return {
    rawName: "list_windows",
    displayName: "List windows",
    description: "List visible windows.",
    inputSchema: { type: "object" },
    callableNamespace: serverId,
    callableName: "list_windows",
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition_not_reached");
}

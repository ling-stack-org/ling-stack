import assert from "node:assert/strict";
import test from "node:test";
import { checkCuaDriverProviderHealth } from "../dist/features/plugins/provider-health.js";

const requiredTools = ["health_report", "list_windows", "get_window_state"];
const requiredChecks = [
  "binary_version",
  "platform_supported",
  "session_active",
  "ax_capability",
  "screen_capture_capability",
];

function createServer() {
  return {
    id: "mcp_cua_driver",
    displayName: "Cua Driver",
    enabled: true,
    transport: {
      type: "stdio",
      command: "cua-driver",
      args: ["mcp"],
      env: {},
      secretEnvRefs: {},
    },
  };
}

function createReport(overrides = {}) {
  return {
    schema_version: "1",
    platform: "win32",
    driver_version: "0.8.3",
    overall: "ok",
    checks: requiredChecks.map((name) => ({
      name,
      status: "pass",
      message: `${name} passed`,
    })),
    ...overrides,
  };
}

function createBroker(result) {
  const calls = [];
  return {
    calls,
    async callTool(server, options, toolName, input) {
      calls.push({ server, options, toolName, input });
      return result;
    },
  };
}

function checkInput(broker, overrides = {}) {
  return {
    server: createServer(),
    mcpBroker: broker,
    secretResolver: {},
    now: "2026-07-16T00:00:00.000Z",
    platform: "win32",
    availableToolNames: requiredTools,
    ...overrides,
  };
}

test("provider health is skipped off Windows without calling the broker", async () => {
  const broker = createBroker({});
  const result = await checkCuaDriverProviderHealth(checkInput(broker, { platform: "darwin" }));
  assert.equal(result.ok, true);
  assert.equal(broker.calls.length, 0);
});

test("provider health fails closed when a required Windows tool is missing", async () => {
  const broker = createBroker({});
  const result = await checkCuaDriverProviderHealth(checkInput(broker, {
    availableToolNames: ["health_report", "list_windows"],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.details?.errorCode, "plugin_provider_incompatible");
  assert.deepEqual(result.details?.missingTools, ["get_window_state"]);
  assert.equal(broker.calls.length, 0);
});

test("provider health validates the upstream schema and required capability checks", async () => {
  const broker = createBroker({
    content: [],
    details: { structuredContent: createReport() },
  });
  const result = await checkCuaDriverProviderHealth(checkInput(broker));
  assert.equal(result.ok, true);
  assert.equal(result.details?.driverVersion, "0.8.3");
  assert.deepEqual(broker.calls[0].input, { include: requiredChecks });
});

test("provider health rejects unreviewed or malformed provider reports", async (t) => {
  await t.test("old version", async () => {
    const broker = createBroker({ content: [], details: { structuredContent: createReport({ driver_version: "0.8.2" }) } });
    const result = await checkCuaDriverProviderHealth(checkInput(broker));
    assert.equal(result.ok, false);
    assert.equal(result.details?.errorCode, "plugin_provider_incompatible");
  });

  await t.test("missing capability check", async () => {
    const checks = createReport().checks.filter((check) => check.name !== "screen_capture_capability");
    const broker = createBroker({ content: [], details: { structuredContent: createReport({ checks }) } });
    const result = await checkCuaDriverProviderHealth(checkInput(broker));
    assert.equal(result.ok, false);
    assert.equal(result.details?.errorCode, "plugin_provider_incompatible");
  });

  const newerBroker = createBroker({
    content: [],
    details: { structuredContent: createReport({ driver_version: "0.8.4" }) },
  });
  const newerResult = await checkCuaDriverProviderHealth(checkInput(newerBroker));
  assert.equal(newerResult.ok, false);
  assert.equal(newerResult.details?.errorCode, "plugin_provider_incompatible");
  assert.deepEqual(newerResult.details?.supportedDriverVersions, ["0.8.3"]);
});

test("provider health reports interactive/UIA/DXGI failures instead of claiming ready", async () => {
  const checks = createReport().checks.map((check) => (
    check.name === "ax_capability"
      ? { ...check, status: "fail", hint: "Run from an interactive user session." }
      : check
  ));
  const broker = createBroker({ content: [], details: { structuredContent: createReport({ overall: "degraded", checks }) } });
  const result = await checkCuaDriverProviderHealth(checkInput(broker));
  assert.equal(result.ok, false);
  assert.equal(result.details?.errorCode, "plugin_provider_health_failed");
  assert.equal(result.details?.checks?.[3]?.status, "fail");
});

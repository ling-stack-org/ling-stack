import assert from "node:assert/strict";
import test from "node:test";
import { CuaDriverDesktopCoordinator } from "../dist/main/cua-driver/coordinator.js";
import { CuaDriverLeasePublisher } from "../dist/main/cua-driver/lease-publisher.js";
import { CuaDriverMcpProxy, deriveCuaDriverWorkspaceBinding } from "../dist/main/cua-driver/mcp-proxy.js";
import { createA34CoordinatorArtifactFixture } from "./support/a34-coordinator-artifact-fixture.mjs";

test("host drain cannot be reopened by an initialize already awaiting readiness", async (t) => {
  const entered = deferred();
  const readiness = deferred();
  const fixture = await createProxy(t, {
    async onInitialized() {
      entered.resolve();
      await readiness.promise;
      return { callGate: "open" };
    },
  });
  const initializing = fixture.post(initialize(1));
  await entered.promise;
  fixture.proxy.beginHostDrain("host_draining");
  readiness.resolve();
  const initialized = await initializing;
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id");
  const called = await fixture.post({ jsonrpc: "2.0", id: 2, method: "tools/call" }, sessionId);
  assert.equal((await called.json()).error?.message, "mcp_call_gate_closed");
  assert.equal(fixture.stopReasons.length, 0);
});

test("host drain preserves accepted exchange and server replies but rejects new calls and initialize", async (t) => {
  const accepted = deferred();
  const result = deferred();
  const fixture = await createProxy(t, {
    async exchange(message) {
      if (message.id === "in-flight") {
        accepted.resolve();
        await result.promise;
        return { jsonrpc: "2.0", id: message.id, result: "completed-on-original-host" };
      }
    },
  });
  const initialized = await fixture.post(initialize(1));
  const sessionId = initialized.headers.get("mcp-session-id");
  const inFlight = fixture.post({ jsonrpc: "2.0", id: "in-flight", method: "tools/call" }, sessionId);
  await accepted.promise;
  fixture.proxy.beginHostDrain("host_draining");
  fixture.proxy.openCallGate();
  await assert.rejects(fixture.proxy.start(), /mcp_host_draining/);
  const denied = await fixture.post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, sessionId);
  assert.equal((await denied.json()).error?.message, "mcp_call_gate_closed");
  const reinitialize = await fixture.post(initialize(4));
  assert.equal(reinitialize.status, 503);
  assert.equal((await reinitialize.json()).error, "mcp_host_draining");
  const beforeNotification = fixture.messages.length;
  await fixture.post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  assert.equal(fixture.messages.length, beforeNotification);
  await fixture.post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "not-accepted" } }, sessionId);
  assert.equal(fixture.messages.length, beforeNotification);
  const cancellation = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "in-flight" } };
  assert.equal((await fixture.post(cancellation, sessionId)).status, 202);
  assert.deepEqual(fixture.messages.at(-1), cancellation);
  const serverReply = { jsonrpc: "2.0", id: "server-request", result: "accepted" };
  assert.equal((await fixture.post(serverReply, sessionId)).status, 202);
  assert.deepEqual(fixture.messages.at(-1), serverReply);
  assert.deepEqual(fixture.stopReasons, []);
  result.resolve();
  assert.equal((await (await inFlight).json()).result, "completed-on-original-host");
  assert.equal(fixture.proxy.activeSessionId, sessionId);
  const afterCompletion = fixture.messages.length;
  await fixture.post(cancellation, sessionId);
  assert.equal(fixture.messages.length, afterCompletion);
});

test("host drain retains the provider and session across SSE loss and session DELETE", async (t) => {
  const fixture = await createProxy(t);
  const initialized = await fixture.post(initialize(1));
  const sessionId = initialized.headers.get("mcp-session-id");
  const stream = await fetch(fixture.endpoint.url, { headers: fixture.headers(sessionId) });
  const reader = stream.body.getReader();
  await reader.read();
  const closed = new Promise((resolve) => fixture.proxy.sseResponse.once("close", resolve));
  fixture.proxy.beginHostDrain("host_draining");
  await reader.cancel();
  await closed;
  assert.deepEqual(fixture.stopReasons, []);
  assert.equal(fixture.proxy.activeSessionId, sessionId);
  const deleted = await fetch(fixture.endpoint.url, { method: "DELETE", headers: fixture.headers(sessionId) });
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).error, "mcp_host_draining");
  assert.deepEqual(fixture.stopReasons, []);
  assert.equal(fixture.proxy.activeSessionId, sessionId);
});

test("ordinary security gate closure does not inherit host-drain reply exceptions", async (t) => {
  const fixture = await createProxy(t);
  const initialized = await fixture.post(initialize(1));
  const sessionId = initialized.headers.get("mcp-session-id");
  const before = fixture.messages.length;
  fixture.proxy.closeCallGate("system_locked");
  const reply = await fixture.post({ jsonrpc: "2.0", id: "server-request", result: "not-admitted" }, sessionId);
  assert.equal((await reply.json()).error?.message, "mcp_call_gate_closed");
  assert.equal(fixture.messages.length, before);
});

test("host drain does not stop the provider when late readiness rejects or SSE overflows", async (t) => {
  const entered = deferred();
  const readiness = deferred();
  const fixture = await createProxy(t, {
    async onInitialized() {
      entered.resolve();
      await readiness.promise;
      throw new Error("late_readiness_failed");
    },
  });
  const initializing = fixture.post(initialize(1));
  await entered.promise;
  fixture.proxy.beginHostDrain("host_draining");
  readiness.resolve();
  const response = await initializing;
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("mcp-session-id"));
  fixture.proxy.revokeSseSession("mcp_server_backpressure_exceeded");
  assert.deepEqual(fixture.stopReasons, []);
  assert.ok(fixture.proxy.activeSessionId);
});

test("lease drain stops renewal without revoking or turning a late failure into recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const calls = [];
  let lost = 0;
  const publisher = new CuaDriverLeasePublisher({
    lease: leaseTemplate(),
    ttlMs: 5_000,
    renewIntervalMs: 1_000,
    telemetry: { emit() {} },
    onLeaseLost() { lost += 1; },
    client: {
      async publish(_lease, signal) { calls.push({ kind: "publish", signal }); await first.promise; },
      async revoke() { calls.push({ kind: "revoke" }); },
    },
  });
  const publishing = publisher.publish();
  publisher.beginHostDrain();
  assert.equal(calls[0].signal.aborted, false);
  first.resolve();
  await publishing;
  t.mock.timers.tick(20_000);
  assert.equal(calls.length, 1);
  await assert.rejects(publisher.publish(), /lease_publisher_draining/);
  await assert.rejects(publisher.publishReadinessDetails({ integrity: "verified" }), /lease_publisher_draining/);
  assert.equal(lost, 0);
  await publisher.revoke();
  assert.deepEqual(calls.map((call) => call.kind), ["publish", "revoke"]);
});

test("lease drain retains the original failure without dispatching lease-lost recovery", async () => {
  const pending = deferred();
  let lost = 0;
  const publisher = new CuaDriverLeasePublisher({
    lease: leaseTemplate(), telemetry: { emit() {} },
    onLeaseLost() { lost += 1; },
    client: {
      async publish() { await pending.promise; throw new Error("late_network_failure"); },
      async revoke() {},
    },
  });
  const publishing = publisher.publish();
  publisher.beginHostDrain();
  pending.resolve();
  await assert.rejects(publishing, /late_network_failure/);
  assert.equal(lost, 0);
});

test("coordinator drain latches pending real lazy enable without destructive cleanup or successor", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const fixture = await createA34CoordinatorArtifactFixture(t);
  const entered = deferred();
  const publishing = deferred();
  const calls = [];
  const coordinator = createCoordinator({
    ...fixture,
    processLifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn() { throw new Error("synthetic_payload_must_not_spawn"); },
      async terminate() { calls.push("terminate"); },
    },
    leaseClient: {
      async publish() { calls.push("publish"); entered.resolve(); await publishing.promise; },
      async revoke() { calls.push("revoke"); },
    },
  });
  t.after(async () => { publishing.resolve(); await coordinator.shutdown(); });
  const enabling = coordinator.enable();
  await entered.promise;
  const host = coordinator.providerHost;
  const proxy = coordinator.proxy;
  coordinator.beginHostDrain("host_draining");
  publishing.resolve();
  await assert.rejects(enabling, /cua_driver_host_draining/);
  await assert.rejects(coordinator.enable(), /cua_driver_host_draining/);
  await assert.rejects(coordinator.restart(), /cua_driver_host_draining/);
  await assert.rejects(coordinator.disable(), /cua_driver_host_draining/);
  coordinator.scheduleRecovery("late_lease_failure", host.generation);
  coordinator.scheduleTerminalFailure("late_readiness_failure", host.generation, "platform_unavailable");
  assert.deepEqual(calls, ["publish"]);
  assert.equal(coordinator.providerHost, host);
  assert.equal(coordinator.proxy, proxy);
  assert.ok(proxy.endpoint);
  assert.equal(coordinator.generation, 1);
  await coordinator.shutdown();
  assert.deepEqual(calls, ["publish", "revoke"]);
  assert.equal(coordinator.providerHost, undefined);
});

test("coordinator drain fences a disable already waiting on lease revoke", async () => {
  const coordinator = createCoordinator();
  const entered = deferred();
  const revoked = deferred();
  const calls = [];
  coordinator.host = { generation: 1, async stop() { calls.push("stop"); } };
  coordinator.proxy = { closeCallGate() {}, beginHostDrain() { calls.push("drain-proxy"); }, async close() { calls.push("close"); } };
  coordinator.leasePublisher = {
    beginHostDrain() { calls.push("drain-lease"); },
    async revoke() { calls.push("revoke"); entered.resolve(); await revoked.promise; },
  };
  const disabling = coordinator.disable();
  await entered.promise;
  coordinator.beginHostDrain("host_draining");
  revoked.resolve();
  await disabling;
  assert.deepEqual(calls, ["revoke", "drain-proxy", "drain-lease"]);
  assert.ok(coordinator.providerHost);
  await coordinator.shutdown();
  assert.deepEqual(calls, ["revoke", "drain-proxy", "drain-lease", "revoke", "close", "stop"]);
});

async function createProxy(t, overrides = {}) {
  const messages = [];
  const stopReasons = [];
  const host = {
    onServerMessage() { return () => {}; },
    async exchange(message) {
      messages.push(message);
      const override = await overrides.exchange?.(message);
      if (override !== undefined) return override;
      if (!("method" in message) || !("id" in message)) return undefined;
      return { jsonrpc: "2.0", id: message.id, result: { capabilities: {}, serverInfo: { name: "fixture", version: "1" } } };
    },
    async stop(reason) { stopReasons.push(reason); },
  };
  const context = { ...leaseTemplate(), bridgeToken: "test-bridge-secret" };
  const proxy = new CuaDriverMcpProxy({ host, context, onInitialized: overrides.onInitialized, telemetry: { emit() {} } });
  t.after(() => proxy.close("test-final-cleanup"));
  const endpoint = await proxy.start();
  const headers = (sessionId) => ({
    authorization: `Bearer ${endpoint.authorizationToken}`,
    "content-type": "application/json",
    "x-ling-cua-driver-generation": String(context.generation),
    "x-ling-cua-driver-workspace-sha256": deriveCuaDriverWorkspaceBinding(context.workspaceCwd),
    "x-ling-cua-driver-authority-epoch": context.daemonAuthorityEpoch,
    "x-ling-cua-driver-instance-epoch": String(context.desktopInstanceEpoch),
    "x-ling-cua-driver-bridge-connection": context.bridgeConnectionId,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
  return { proxy, endpoint, headers, messages, stopReasons,
    post: (message, sessionId) => fetch(endpoint.url, { method: "POST", headers: headers(sessionId), body: JSON.stringify(message) }),
  };
}

function initialize(id) {
  return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
}

function leaseTemplate() {
  return {
    schemaVersion: 1, providerId: "cua-driver", desktopInstanceId: "desktop-drain-fixture", desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-drain-fixture", generation: 1, daemonAuthorityEpoch: "authority-drain-fixture",
    workspaceCwd: "/workspace", endpoint: "http://127.0.0.1:1234/mcp", providerVersion: "0.8.3",
    distributionRevision: "ling.1", integrationMode: "embedded-stdio", lockDigest: "a".repeat(64),
    providerSealDigest: "b".repeat(64), platform: "darwin", architecture: "arm64",
  };
}

function createCoordinator(overrides = {}) {
  const workspaceCwd = overrides.workspaceCwd ?? "/workspace";
  return new CuaDriverDesktopCoordinator({
    platform: "darwin", architecture: "arm64", resourcesPath: "/not-used", userDataPath: "/not-used",
    daemonBaseUrl: "http://127.0.0.1:17891", telemetry: { emit() {} },
    featureFlags: { bundledEmbedded: { darwin: true, win32: false }, packagedProvider: { darwin: true, win32: false } },
    ...overrides, workspaceCwd,
    bridgeContext: { bridgeToken: "test-bridge-secret", daemonAuthorityEpoch: "authority-drain-fixture", bridgeConnectionId: "bridge-drain-fixture", desktopInstanceEpoch: 1, workspaceCwd },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

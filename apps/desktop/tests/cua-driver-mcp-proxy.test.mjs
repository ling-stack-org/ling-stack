import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import {
  CuaDriverMcpProxy,
  deriveCuaDriverProxyToken,
  deriveCuaDriverWorkspaceBinding,
  publicCuaDriverMcpProxyEndpoint,
} from "../dist/main/cua-driver/mcp-proxy.js";

test("loopback proxy authenticates one generation and rejects wrong token/origin/context", async () => {
  const fixture = createHostFixture();
  const context = createContext();
  let readinessChecks = 0;
  let changedPayload;
  const proxy = new CuaDriverMcpProxy({
    host: fixture.host,
    context,
    async onInitialized() {
      assert.equal(fixture.initialized, true);
      readinessChecks += 1;
    },
    onManagedReadinessChanged(payload) {
      changedPayload = payload;
    },
  });
  const endpoint = await proxy.start();
  const baseHeaders = headers(context, endpoint.authorizationToken);

  const wrongToken = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, authorization: "Bearer wrong-token" },
    body: JSON.stringify(initialize(1)),
  });
  assert.equal(wrongToken.status, 401);

  const wrongOrigin = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, origin: "https://evil.example" },
    body: JSON.stringify(initialize(1)),
  });
  assert.equal(wrongOrigin.status, 403);

  const wrongGeneration = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "x-ling-cua-driver-generation": "999" },
    body: JSON.stringify(initialize(1)),
  });
  assert.equal(wrongGeneration.status, 409);

  const initialized = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(1)),
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.match(sessionId, /^[A-Za-z0-9_-]{16,128}$/u);
  assert.equal((await initialized.json()).result.serverInfo.version, "0.8.3");
  assert.equal(readinessChecks, 1);

  const secondInitialize = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify(initialize(2)),
  });
  assert.equal(secondInitialize.status, 409);

  const call = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { x: 1 } }),
  });
  assert.equal(call.status, 200);
  assert.deepEqual((await call.json()).result, { echoed: { x: 1 } });

  const notification = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);

  fixture.emit({
    jsonrpc: "2.0",
    method: "ling/managed_readiness_changed",
    params: { schemaVersion: 1, leaseGeneration: context.generation },
  });
  assert.deepEqual(changedPayload, { schemaVersion: 1, leaseGeneration: context.generation });

  proxy.closeCallGate("locked");
  const fencedCall = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: "call-2", method: "tools/list" }),
  });
  assert.equal(fencedCall.status, 200);
  assert.equal((await fencedCall.json()).error.message, "mcp_call_gate_closed");

  const released = await fetch(endpoint.url, {
    method: "DELETE",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
  });
  assert.equal(released.status, 204);
  assert.equal(fixture.stopCount, 1);
  await proxy.close("test_complete");
});

test("an initialized host can reattach after a daemon client disappears before opening SSE", async () => {
  const fixture = createHostFixture();
  const context = createContext();
  const proxy = new CuaDriverMcpProxy({ host: fixture.host, context });
  const endpoint = await proxy.start();
  const baseHeaders = headers(context, endpoint.authorizationToken);

  const first = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(1)),
  });
  assert.equal(first.status, 200);
  const firstSessionId = first.headers.get("mcp-session-id");

  const second = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(2)),
  });
  assert.equal(second.status, 200);
  assert.notEqual(second.headers.get("mcp-session-id"), firstSessionId);
  assert.equal((await second.json()).id, 2);
  assert.equal(fixture.stopCount, 0);

  await proxy.close("test_complete");
  assert.equal(fixture.stopCount, 1);
});

test("proxy does not expose endpoint secret through the lease identity and token is generation-fenced", () => {
  const context = createContext();
  const token = deriveCuaDriverProxyToken(context);
  assert.notEqual(token, deriveCuaDriverProxyToken({ ...context, generation: context.generation + 1 }));
  assert.notEqual(token, deriveCuaDriverProxyToken({ ...context, workspaceCwd: "/other" }));
  assert.match(deriveCuaDriverWorkspaceBinding("/用户/工作区"), /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(publicCuaDriverMcpProxyEndpoint({
    url: "http://127.0.0.1:1234/mcp",
    port: 1234,
    generation: 2,
    authorizationToken: token,
  }), {
    generation: 2,
  });
});

test("initialize can retain one healthy provider session while the call gate stays closed", async () => {
  const fixture = createHostFixture();
  const context = createContext();
  const proxy = new CuaDriverMcpProxy({
    host: fixture.host,
    context,
    onInitialized: async () => ({ callGate: "closed" }),
  });
  const endpoint = await proxy.start();
  const baseHeaders = headers(context, endpoint.authorizationToken);

  const initialized = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(1)),
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get("mcp-session-id");
  assert.match(sessionId, /^[A-Za-z0-9_-]{16,128}$/u);
  assert.equal(fixture.stopCount, 0, "permission gating must retain the initialized child");

  const initializedNotification = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(initializedNotification.status, 202, "the MCP handshake must finish behind a closed call gate");

  const streamResponse = await fetch(endpoint.url, {
    headers: { ...baseHeaders, "mcp-session-id": sessionId, accept: "text/event-stream" },
  });
  assert.equal(streamResponse.status, 200, "the retained session keeps its transport stream alive");

  const fencedCall = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: "call-1", method: "tools/list" }),
  });
  assert.equal(fencedCall.status, 200, "readiness gating must not make the MCP transport look disconnected");
  assert.deepEqual(await fencedCall.json(), {
    jsonrpc: "2.0",
    id: "call-1",
    error: { code: -32003, message: "mcp_call_gate_closed" },
  });
  assert.equal(fixture.stopCount, 0);

  const secondFencedCall = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: "call-2", method: "ping" }),
  });
  assert.equal(secondFencedCall.status, 200);
  assert.equal((await secondFencedCall.json()).error.message, "mcp_call_gate_closed");
  assert.equal(fixture.stopCount, 0, "repeated gated calls must reuse the retained session");

  const reinitialized = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(2)),
  });
  assert.equal(reinitialized.status, 200, "a new daemon client can replace a dormant gated session");
  const replacementSessionId = reinitialized.headers.get("mcp-session-id");
  assert.match(replacementSessionId, /^[A-Za-z0-9_-]{16,128}$/u);
  assert.notEqual(replacementSessionId, sessionId);
  assert.equal((await reinitialized.json()).id, 2);
  assert.equal(fixture.stopCount, 0, "gated reattachment must not initialize or stop the child again");

  const replacementNotification = await fetch(endpoint.url, {
    method: "POST",
    headers: { ...baseHeaders, "mcp-session-id": replacementSessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(replacementNotification.status, 202);
  const replacementStream = await fetch(endpoint.url, {
    headers: { ...baseHeaders, "mcp-session-id": replacementSessionId, accept: "text/event-stream" },
  });
  assert.equal(replacementStream.status, 200);
  await replacementStream.body?.cancel();
  await waitFor(() => proxy.activeSessionId === undefined);
  assert.equal(fixture.stopCount, 0, "a gated daemon disconnect must retain the child for permission recovery");

  const thirdInitialize = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(3)),
  });
  assert.equal(thirdInitialize.status, 200);
  assert.equal(fixture.stopCount, 0);

  await proxy.close("test_complete");
  await streamResponse.body?.cancel().catch(() => undefined);
  assert.equal(fixture.stopCount, 1);
});

test("close during bind rejects the pending start and leaves no listening proxy", async () => {
  const fixture = createHostFixture();
  const proxy = new CuaDriverMcpProxy({ host: fixture.host, context: createContext() });

  const starting = proxy.start();
  const closing = proxy.close("close_before_listening");

  await assert.rejects(starting, (error) => error?.code === "proxy_closed");
  await closing;
  assert.equal(proxy.endpoint, undefined);
  assert.equal(proxy.server.listening, false);
  assert.equal(fixture.stopCount, 1);
});

test("close fences an in-flight initialize before any session response is exposed", async () => {
  const fixture = createHostFixture();
  const context = createContext();
  const initializationEntered = deferred();
  const releaseInitialization = deferred();
  const proxy = new CuaDriverMcpProxy({
    host: fixture.host,
    context,
    requestTimeoutMs: 100,
    async onInitialized() {
      initializationEntered.resolve();
      await releaseInitialization.promise;
    },
  });
  const endpoint = await proxy.start();
  const initializing = fetch(endpoint.url, {
    method: "POST",
    headers: headers(context, endpoint.authorizationToken),
    body: JSON.stringify(initialize(1)),
  });

  await initializationEntered.promise;
  const closing = proxy.close("initialize_race_shutdown");
  releaseInitialization.resolve();
  const initializeResult = await initializing.then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  await closing;

  if (initializeResult.response) {
    assert.notEqual(initializeResult.response.status, 200);
    assert.equal(initializeResult.response.headers.get("mcp-session-id"), null);
  } else {
    assert.ok(initializeResult.error instanceof Error);
  }
  assert.equal(proxy.activeSessionId, undefined);
  assert.equal(proxy.callGateOpen, false);
  assert.equal(proxy.endpoint, undefined);
  assert.equal(fixture.stopCount, 1);
});

test("close bounds a slow authenticated POST and stops the provider", async () => {
  const fixture = createHostFixture();
  const context = createContext();
  const proxy = new CuaDriverMcpProxy({ host: fixture.host, context, requestTimeoutMs: 50 });
  const endpoint = await proxy.start();
  const request = httpRequest(endpoint.url, {
    method: "POST",
    headers: {
      ...headers(context, endpoint.authorizationToken),
      "content-length": "64",
    },
  });
  const requestClosed = new Promise((resolve) => request.once("close", resolve));
  request.on("error", () => undefined);
  request.write("{");
  await waitFor(() => proxy.sockets.size === 1);

  await Promise.race([
    proxy.close("slow_post_shutdown"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("proxy_close_unbounded")), 500)),
  ]);
  await requestClosed;
  await waitFor(() => proxy.sockets.size === 0);

  assert.equal(request.destroyed, true);
  assert.equal(proxy.server.listening, false);
  assert.equal(proxy.sockets.size, 0);
  assert.equal(fixture.stopCount, 1);
});

test("proxy accepts one SSE stream and forwards server notifications without rewriting JSON-RPC", async () => {
  const fixture = createHostFixture();
  const context = createContext();
  const proxy = new CuaDriverMcpProxy({ host: fixture.host, context });
  const endpoint = await proxy.start();
  const baseHeaders = headers(context, endpoint.authorizationToken);
  const initialized = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(1)),
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  const controller = new AbortController();
  const streamResponse = await fetch(endpoint.url, {
    headers: { ...baseHeaders, "mcp-session-id": sessionId, accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(streamResponse.status, 200);
  fixture.emit({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
  const reader = streamResponse.body.getReader();
  let text = "";
  for (let index = 0; index < 3 && !text.includes("event: message"); index += 1) {
    const next = await reader.read();
    text += new TextDecoder().decode(next.value ?? new Uint8Array());
  }
  assert.match(text, /event: message/);
  assert.match(text, /notifications\/progress/);
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fixture.stopCount, 1);
  await proxy.close("test_complete");
});

test("proxy bounds an unread SSE stream and revokes the provider on backpressure", async () => {
  const fixture = createHostFixture();
  const context = createContext();
  const proxy = new CuaDriverMcpProxy({
    host: fixture.host,
    context,
    maxBodyBytes: 64 * 1024,
    maxSseQueueBytes: 32 * 1024,
  });
  const endpoint = await proxy.start();
  const baseHeaders = headers(context, endpoint.authorizationToken);
  const initialized = await fetch(endpoint.url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify(initialize(1)),
  });
  const sessionId = initialized.headers.get("mcp-session-id");
  const streamResponse = await fetch(endpoint.url, {
    headers: { ...baseHeaders, "mcp-session-id": sessionId, accept: "text/event-stream" },
  });
  assert.equal(streamResponse.status, 200);

  const payload = "x".repeat(8 * 1024);
  for (let index = 0; index < 1_000 && fixture.stopCount === 0; index += 1) {
    fixture.emit({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { index, payload },
    });
  }

  await waitFor(() => fixture.stopCount === 1);
  assert.equal(proxy.activeSessionId, undefined);
  await streamResponse.body?.cancel().catch(() => undefined);
  await proxy.close("test_complete");
});

function createContext() {
  return {
    bridgeToken: "bridge-secret-fixture",
    daemonAuthorityEpoch: "authority-1",
    bridgeConnectionId: "bridge-connection-1",
    desktopInstanceEpoch: 4,
    generation: 2,
    workspaceCwd: "/workspace/one",
  };
}

function headers(context, token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-ling-cua-driver-generation": String(context.generation),
    "x-ling-cua-driver-workspace-sha256": deriveCuaDriverWorkspaceBinding(context.workspaceCwd),
    "x-ling-cua-driver-authority-epoch": context.daemonAuthorityEpoch,
    "x-ling-cua-driver-instance-epoch": String(context.desktopInstanceEpoch),
    "x-ling-cua-driver-bridge-connection": context.bridgeConnectionId,
  };
}

function initialize(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  };
}

function createHostFixture() {
  const listeners = new Set();
  let initialized = false;
  let stopCount = 0;
  const host = {
    onServerMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async exchange(message) {
      if (message.method === "initialize") {
        if (initialized) {
          throw new Error("already_initialized");
        }
        initialized = true;
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "cua-driver", version: "0.8.3" },
          },
        };
      }
      if (message.method === "notifications/initialized") {
        return undefined;
      }
      return { jsonrpc: "2.0", id: message.id, result: { echoed: message.params } };
    },
    async stop() {
      stopCount += 1;
    },
  };
  return {
    host,
    emit(message) {
      for (const listener of listeners) {
        listener(message);
      }
    },
    get stopCount() {
      return stopCount;
    },
    get initialized() {
      return initialized;
    },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition_not_reached");
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

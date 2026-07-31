import assert from "node:assert/strict";
import test from "node:test";
import {
  CuaDriverClientPool,
  CuaDriverGenerationBrokerError,
  CuaDriverLeaseRegistry,
  createCuaDriverGenerationBroker,
} from "../dist/index.js";

const now = "2026-07-20T00:00:00.000Z";
const workspaceCwd = "/tmp/ling-cua-generation-broker";

test("generation broker delegates ordinary and external Cua MCP servers unchanged", async () => {
  const base = baseBroker();
  const registry = registryFixture();
  const pool = clientPool();
  const ordinary = server({ id: "mcp_other" });
  const bundledWrapper = createCuaDriverGenerationBroker({
    baseBroker: base.broker,
    bundledEnabled: true,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });
  await bundledWrapper.checkServer(ordinary, brokerOptions());
  await bundledWrapper.listTools(ordinary, brokerOptions());
  await bundledWrapper.callTool(ordinary, brokerOptions(), "ordinary", {});

  const externalWrapper = createCuaDriverGenerationBroker({
    baseBroker: base.broker,
    bundledEnabled: false,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });
  await externalWrapper.callTool(server(), brokerOptions(), "list_windows", {});

  assert.deepEqual(base.calls, ["check", "list", "call", "call"]);
  assert.equal(pool.size, 0);
});

test("bundled check list and call share one lease client and never delegate or fetch", async () => {
  const base = baseBroker();
  const registry = registryFixture();
  const current = lease();
  assert.equal(registry.publish(current).accepted, true);
  const observed = [];
  let connects = 0;
  let closes = 0;
  const pool = clientPool({
    async connect() {
      connects += 1;
      return {
        async check(currentServer, checkedAt, signal) {
          observed.push(["check", signal.aborted]);
          return { statusSnapshot: readyStatus(currentServer.id, checkedAt, 0) };
        },
        async checkHealth() {
          throw new Error("generation broker does not run activation health");
        },
        async listTools(currentServer, checkedAt, signal) {
          observed.push(["list", signal.aborted]);
          return {
            statusSnapshot: readyStatus(currentServer.id, checkedAt, 1),
            tools: [toolInput()],
          };
        },
        async callTool(_currentServer, name, input, signal) {
          observed.push(["call", name, input, signal.aborted]);
          return { content: [{ type: "text", text: "pooled" }] };
        },
        async close() { closes += 1; },
      };
    },
  });
  const broker = createCuaDriverGenerationBroker({
    baseBroker: base.broker,
    bundledEnabled: true,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("raw HTTP fallback must be unreachable");
  };
  try {
    const checked = await broker.checkServer(server(), brokerOptions());
    const listed = await broker.listTools(server(), brokerOptions());
    const called = await broker.callTool(
      server(),
      { ...brokerOptions(), assertResultCurrent: () => observed.push(["postcheck"]) },
      "list_windows",
      { pid: 42 },
    );
    assert.equal(checked.statusSnapshot.status, "ready");
    assert.deepEqual(listed.tools.map((tool) => tool.rawName), ["list_windows"]);
    assert.deepEqual(called.content, [{ type: "text", text: "pooled" }]);
  } finally {
    globalThis.fetch = originalFetch;
    await pool.closeAll();
  }

  assert.equal(connects, 1);
  assert.equal(closes, 1);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(base.calls, []);
  assert.deepEqual(observed, [
    ["check", false],
    ["list", false],
    ["postcheck"],
    ["call", "list_windows", { pid: 42 }, false],
    ["postcheck"],
  ]);
});

test("bundled broker fails closed without the exact workspace lease authority", async () => {
  const base = baseBroker();
  const registry = registryFixture();
  const pool = clientPool();
  const broker = createCuaDriverGenerationBroker({
    baseBroker: base.broker,
    bundledEnabled: true,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });

  const missing = await broker.listTools(server(), brokerOptions());
  assert.equal(missing.statusSnapshot.errorCode, "cua_desktop_lease_unavailable");
  await assert.rejects(
    broker.callTool(server(), brokerOptions(), "list_windows", {}),
    (error) => error instanceof CuaDriverGenerationBrokerError
      && error.code === "cua_desktop_lease_unavailable",
  );

  assert.equal(registry.publish(lease()).accepted, true);
  const wrongWorkspace = await broker.checkServer(server(), {
    ...brokerOptions(),
    workspaceCwd: `${workspaceCwd}-other`,
  });
  assert.equal(wrongWorkspace.statusSnapshot.errorCode, "cua_driver_workspace_mismatch");
  assert.deepEqual(base.calls, []);
  assert.equal(pool.size, 0);
});

test("bundled broker never acquires a client for the disabled canonical server", async () => {
  const base = baseBroker();
  const registry = registryFixture();
  assert.equal(registry.publish(lease()).accepted, true);
  let connects = 0;
  const pool = clientPool({
    async connect() {
      connects += 1;
      throw new Error("disabled canonical server must not connect");
    },
  });
  const broker = createCuaDriverGenerationBroker({
    baseBroker: base.broker,
    bundledEnabled: true,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });
  const disabled = server({ enabled: false });

  const checked = await broker.checkServer(disabled, brokerOptions());
  const listed = await broker.listTools(disabled, brokerOptions());
  await assert.rejects(
    broker.callTool(disabled, brokerOptions(), "list_windows", {}),
    (error) => error instanceof CuaDriverGenerationBrokerError
      && error.code === "cua_desktop_lease_unavailable",
  );

  assert.equal(checked.statusSnapshot.status, "disabled");
  assert.equal(listed.statusSnapshot.status, "disabled");
  assert.deepEqual(listed.tools, []);
  assert.equal(connects, 0);
  assert.equal(pool.size, 0);
  assert.deepEqual(base.calls, []);
});

for (const operation of ["checkServer", "listTools", "callTool"]) {
  test(`bundled ${operation} fails closed when the current lease client cannot connect`, async () => {
    const base = baseBroker();
    const registry = registryFixture();
    assert.equal(registry.publish(lease()).accepted, true);
    const connectError = new Error(`lease client connect failed during ${operation}`);
    const pool = clientPool({
      async connect() {
        throw connectError;
      },
    });
    const broker = createCuaDriverGenerationBroker({
      baseBroker: base.broker,
      bundledEnabled: true,
      workspaceCwd,
      leaseRegistry: registry,
      clientPool: pool,
    });

    if (operation === "checkServer") {
      const result = await broker.checkServer(server(), brokerOptions());
      assert.equal(result.statusSnapshot.status, "failed");
      assert.equal(result.statusSnapshot.errorCode, connectError.message);
    } else if (operation === "listTools") {
      const result = await broker.listTools(server(), brokerOptions());
      assert.equal(result.statusSnapshot.status, "failed");
      assert.equal(result.statusSnapshot.errorCode, connectError.message);
      assert.deepEqual(result.tools, []);
    } else {
      await assert.rejects(
        broker.callTool(server(), brokerOptions(), "list_windows", {}),
        (error) => error === connectError,
      );
    }

    assert.equal(pool.size, 0);
    assert.deepEqual(base.calls, []);
  });
}

for (const operation of ["checkServer", "listTools", "callTool"]) {
  test(`bundled ${operation} maps a connected client operation failure and releases its handle`, async () => {
    const registry = registryFixture();
    assert.equal(registry.publish(lease()).accepted, true);
    const operationError = new Error(`lease client ${operation} failed`);
    let connects = 0;
    let closes = 0;
    const pool = clientPool({
      closeTimeoutMs: 20,
      async connect() {
        connects += 1;
        return {
          async check() {
            if (operation === "checkServer") throw operationError;
            throw new Error("unexpected check");
          },
          async checkHealth() { throw new Error("not used"); },
          async listTools() {
            if (operation === "listTools") throw operationError;
            throw new Error("unexpected listTools");
          },
          async callTool() {
            if (operation === "callTool") throw operationError;
            throw new Error("unexpected callTool");
          },
          async close() { closes += 1; },
        };
      },
    });
    const broker = poolBroker(registry, pool);

    if (operation === "checkServer") {
      const result = await broker.checkServer(server(), brokerOptions());
      assert.equal(result.statusSnapshot.status, "failed");
      assert.equal(result.statusSnapshot.errorCode, operationError.message);
    } else if (operation === "listTools") {
      const result = await broker.listTools(server(), brokerOptions());
      assert.equal(result.statusSnapshot.status, "failed");
      assert.equal(result.statusSnapshot.errorCode, operationError.message);
      assert.deepEqual(result.tools, []);
    } else {
      await assert.rejects(
        broker.callTool(server(), brokerOptions(), "list_windows", {}),
        (error) => error === operationError,
      );
    }

    assert.equal(connects, 1);
    assert.equal(pool.size, 1);
    const closing = pool.closeAll();
    const closeOutcome = await Promise.race([
      closing.then(() => "closed"),
      new Promise((resolve) => setImmediate(() => resolve("still-active"))),
    ]);
    assert.equal(closeOutcome, "closed");
    await closing;
    assert.equal(closes, 1);
  });
}

test("generation broker discards a completed tool result after lease replacement", async () => {
  const registry = registryFixture();
  const first = lease();
  assert.equal(registry.publish(first).accepted, true);
  const gate = deferred();
  const pool = clientPool({
    async connect() {
      return {
        async check() { throw new Error("not used"); },
        async checkHealth() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        async callTool() {
          await gate.promise;
          return { content: [{ type: "text", text: "stale result" }] };
        },
        async close() {},
      };
    },
  });
  const broker = createCuaDriverGenerationBroker({
    baseBroker: baseBroker().broker,
    bundledEnabled: true,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });

  const calling = broker.callTool(server(), brokerOptions(), "list_windows", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.publish(lease({ generation: 2 })).accepted, true);
  gate.resolve();

  await assert.rejects(
    calling,
    (error) => error instanceof CuaDriverGenerationBrokerError
      && error.code === "cua_desktop_lease_stale",
  );
  await pool.closeAll();
});

test("generation broker discards a successful result when the caller aborts before transport return", async () => {
  const registry = registryFixture();
  assert.equal(registry.publish(lease()).accepted, true);
  const controller = new AbortController();
  const abortReason = new Error("caller cancelled the tool");
  const pool = clientPool({
    async connect() {
      return {
        async check() { throw new Error("not used"); },
        async checkHealth() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        async callTool() {
          controller.abort(abortReason);
          return { content: [{ type: "text", text: "late result" }] };
        },
        async close() {},
      };
    },
  });
  try {
    await assert.rejects(
      poolBroker(registry, pool).callTool(
        server(),
        { ...brokerOptions(), signal: controller.signal },
        "list_windows",
        {},
      ),
      (error) => error === abortReason,
    );
  } finally {
    await pool.closeAll();
  }
});

for (const operation of ["checkServer", "listTools"]) {
  test(`generation broker discards a successful ${operation} result after caller cancellation`, async () => {
    const registry = registryFixture();
    assert.equal(registry.publish(lease()).accepted, true);
    const controller = new AbortController();
    const abortReason = new Error(`caller cancelled ${operation}`);
    const pool = clientPool({
      async connect() {
        return {
          async check(currentServer, checkedAt) {
            controller.abort(abortReason);
            return { statusSnapshot: readyStatus(currentServer.id, checkedAt, 0) };
          },
          async checkHealth() { throw new Error("not used"); },
          async listTools(currentServer, checkedAt) {
            controller.abort(abortReason);
            return {
              statusSnapshot: readyStatus(currentServer.id, checkedAt, 1),
              tools: [toolInput()],
            };
          },
          async callTool() { throw new Error("not used"); },
          async close() {},
        };
      },
    });
    try {
      const pending = operation === "checkServer"
        ? poolBroker(registry, pool).checkServer(server(), {
            ...brokerOptions(),
            signal: controller.signal,
          })
        : poolBroker(registry, pool).listTools(server(), {
            ...brokerOptions(),
            signal: controller.signal,
          });
      await assert.rejects(pending, (error) => error === abortReason);
    } finally {
      await pool.closeAll();
    }
  });
}

for (const operation of ["checkServer", "listTools"]) {
  test(`generation broker discards a completed ${operation} result after lease replacement`, async () => {
    await assertStaleResultAfterReplacement(operation);
  });
}

test("retiring a generation aborts a hung tool call after bounded drain", async () => {
  const registry = registryFixture();
  const first = lease();
  const second = lease({ generation: 2 });
  assert.equal(registry.publish(first).accepted, true);
  let closes = 0;
  const pool = clientPool({
    closeTimeoutMs: 10,
    async connect() {
      return {
        async check() { throw new Error("not used"); },
        async checkHealth() { throw new Error("not used"); },
        async listTools() { throw new Error("not used"); },
        callTool(_server, _name, _input, signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("generation aborted")), { once: true });
          });
        },
        async close() { closes += 1; },
      };
    },
  });
  const broker = createCuaDriverGenerationBroker({
    baseBroker: baseBroker().broker,
    bundledEnabled: true,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });
  const calling = broker.callTool(server(), brokerOptions(), "list_windows", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(registry.publish(second).accepted, true);
  const closing = pool.closeStale(second);

  await assert.rejects(
    calling,
    (error) => error instanceof CuaDriverGenerationBrokerError
      && error.code === "cua_desktop_lease_stale",
  );
  await closing;
  assert.equal(closes, 1);
  await pool.closeAll();
});

function registryFixture() {
  return new CuaDriverLeaseRegistry({
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd,
    now: () => now,
  });
}

function clientPool(input = {}) {
  const factory = input.connect
    ? { connect: input.connect }
    : {
        async connect() {
          return {
            async check() { throw new Error("unexpected pooled check"); },
            async checkHealth() { throw new Error("unexpected pooled health"); },
            async listTools() { throw new Error("unexpected pooled list"); },
            async callTool() { throw new Error("unexpected pooled call"); },
            async close() {},
          };
        },
      };
  return new CuaDriverClientPool({
    factory,
    ...(input.closeTimeoutMs ? { closeTimeoutMs: input.closeTimeoutMs } : {}),
  });
}

async function assertStaleResultAfterReplacement(operation) {
  const registry = registryFixture();
  assert.equal(registry.publish(lease()).accepted, true);
  const gate = deferred();
  const pool = clientPool({
    async connect() {
      return {
        async check(currentServer, checkedAt) {
          await gate.promise;
          return { statusSnapshot: readyStatus(currentServer.id, checkedAt, 0) };
        },
        async checkHealth() { throw new Error("not used"); },
        async listTools(currentServer, checkedAt) {
          await gate.promise;
          return {
            statusSnapshot: readyStatus(currentServer.id, checkedAt, 1),
            tools: [toolInput()],
          };
        },
        async callTool() { throw new Error("not used"); },
        async close() {},
      };
    },
  });
  try {
    const pending = operation === "checkServer"
      ? poolBroker(registry, pool).checkServer(server(), brokerOptions())
      : poolBroker(registry, pool).listTools(server(), brokerOptions());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.publish(lease({ generation: 2 })).accepted, true);
    gate.resolve();

    await assert.rejects(
      pending,
      (error) => error instanceof CuaDriverGenerationBrokerError
        && error.code === "cua_desktop_lease_stale",
    );
  } finally {
    gate.resolve();
    await pool.closeAll();
  }
}

function poolBroker(registry, pool) {
  return createCuaDriverGenerationBroker({
    baseBroker: baseBroker().broker,
    bundledEnabled: true,
    workspaceCwd,
    leaseRegistry: registry,
    clientPool: pool,
  });
}

function baseBroker() {
  const calls = [];
  return {
    calls,
    broker: {
      async checkServer(currentServer) {
        calls.push("check");
        return { statusSnapshot: readyStatus(currentServer.id, now, 0) };
      },
      async listTools(currentServer) {
        calls.push("list");
        return { statusSnapshot: readyStatus(currentServer.id, now, 0), tools: [] };
      },
      async callTool() {
        calls.push("call");
        return { content: [{ type: "text", text: "base" }] };
      },
    },
  };
}

function brokerOptions() {
  return {
    secretResolver: { resolve: () => ({ configured: false }) },
    workspaceCwd,
    now: () => now,
  };
}

function lease(overrides = {}) {
  return {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-a",
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-a",
    generation: 1,
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd,
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: "2026-07-20T00:01:00.000Z",
    lockDigest: "a".repeat(64),
    providerSealDigest: "b".repeat(64),
    providerCatalogDigest: "c".repeat(64),
    platform: "darwin",
    architecture: "arm64",
    ...overrides,
  };
}

function server(overrides = {}) {
  return {
    id: "mcp_cua_driver",
    workspaceId: workspaceCwd,
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
    ...overrides,
  };
}

function readyStatus(serverId, checkedAt, toolCount) {
  return {
    serverId,
    checkedAt,
    expiresAt: "2026-07-20T00:05:00.000Z",
    status: "ready",
    toolCount,
    missingSecretRefs: [],
    authStatus: { kind: "not_required", refs: [], missingRefs: [] },
  };
}

function toolInput() {
  return {
    rawName: "list_windows",
    displayName: "List windows",
    inputSchema: { type: "object" },
    callableNamespace: "mcp_cua_driver",
    callableName: "list_windows",
    sideEffectLevel: "read",
    defaultApproval: "allow",
    enabled: true,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

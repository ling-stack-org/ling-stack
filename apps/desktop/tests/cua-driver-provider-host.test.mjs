import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  CuaDriverProviderHost,
  CuaDriverProviderPreSpawnError,
  createManagedProviderEnvironment,
} from "../dist/main/cua-driver/provider-host.js";

const stateRoot = {
  userDataPath: "/tmp/ling-user-data",
  rootPath: "/tmp/ling-user-data/providers/cua-driver/state/v1/0.8.3-ling.1",
  telemetryPath: "/tmp/ling-user-data/providers/cua-driver/state/v1/0.8.3-ling.1/telemetry",
  versionCheckPath: "/tmp/ling-user-data/providers/cua-driver/state/v1/0.8.3-ling.1/version-check",
  environment: {
    CUA_DRIVER_STATE_HOME: "/tmp/ling-user-data/providers/cua-driver/state/v1/0.8.3-ling.1",
    CUA_DRIVER_TELEMETRY_HOME: "/tmp/ling-user-data/providers/cua-driver/state/v1/0.8.3-ling.1/telemetry",
  },
};

test("managed provider environment is narrow, generation-bound and disables updater/telemetry", () => {
  const environment = createManagedProviderEnvironment({
    baseEnvironment: {
      HOME: "/Users/fixture",
      PATH: "/tmp/hostile-path",
      LING_DESKTOP_BRIDGE_TOKEN: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      LANG: "en_US.UTF-8",
    },
    stateRoot,
    hostProcessId: 42,
    generation: 7,
    childInstanceNonce: "a".repeat(32),
    inputFence: { port: 41234, token: "b".repeat(64), epoch: 7 },
  });
  assert.deepEqual(environment, {
    HOME: "/Users/fixture",
    LANG: "en_US.UTF-8",
    CUA_DRIVER_EMBEDDED: "1",
    CUA_DRIVER_LING_MANAGED: "1",
    CUA_DRIVER_HOST_BUNDLE_ID: "com.lingstack.desktop",
    CUA_DRIVER_HOST_PID: "42",
    CUA_DRIVER_CHILD_INSTANCE_NONCE: "a".repeat(32),
    CUA_DRIVER_LEASE_GENERATION: "7",
    CUA_DRIVER_INPUT_FENCE_PORT: "41234",
    CUA_DRIVER_INPUT_FENCE_TOKEN: "b".repeat(64),
    CUA_DRIVER_INPUT_EPOCH: "7",
    CUA_DRIVER_STATE_HOME: stateRoot.rootPath,
    CUA_DRIVER_TELEMETRY_HOME: stateRoot.telemetryPath,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
  });
  assert.equal(environment.PATH, undefined);
  assert.equal(environment.LING_DESKTOP_BRIDGE_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
});

test("one generation creates one child and permits exactly one initialize", async (t) => {
  const fixture = createHostFixture(t);
  const firstInitialize = fixture.host.exchange(initializeMessage(1));
  await assert.rejects(fixture.host.exchange(initializeMessage(2)), /already_initialized/);
  const response = await firstInitialize;
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.equal(fixture.spawnInputs.length, 1);
  assert.equal(fixture.spawnInputs[0].executablePath, "/private/ling/cua-driver");
  assert.deepEqual(fixture.spawnInputs[0].args, ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"]);
  assert.equal(fixture.host.state, "ready");

  const echoed = await fixture.host.exchange({
    jsonrpc: "2.0",
    id: "echo-1",
    method: "tools/call",
    params: { name: "fixture", arguments: { value: 42 } },
  });
  assert.deepEqual(echoed.result, { name: "fixture", arguments: { value: 42 } });
  await assert.rejects(
    fixture.host.exchange({ jsonrpc: "2.0", id: "ling-control:forged", method: "tools/list" }),
    /reserved_namespace/,
  );

  await fixture.host.stop("test_complete");
  assert.equal(fixture.host.state, "stopped");
  assert.equal(fixture.residueChecks, 1);
});

test("Desktop permission readiness uses one fixed private check_permissions request", async (t) => {
  const fixture = createHostFixture(t);
  await assert.rejects(fixture.host.requestCheckPermissions(), /not_initialized/);
  await fixture.host.exchange(initializeMessage(1));

  const response = await fixture.host.requestCheckPermissions({
    name: "forged_tool",
    arguments: { prompt: true },
  });
  assert.match(String(response.id), /^ling-control:/);
  assert.deepEqual(response.result, {
    name: "check_permissions",
    arguments: { prompt: false },
  });

  await assert.rejects(
    fixture.host.requestControl("tools/call", {
      name: "forged_tool",
      arguments: { prompt: true },
    }),
    /reserved_namespace/,
  );

  const daemonRequest = await fixture.host.exchange({
    jsonrpc: "2.0",
    id: "daemon-call",
    method: "tools/call",
    params: { name: "fixture", arguments: { value: 7 } },
  });
  assert.equal(daemonRequest.id, "daemon-call");
  assert.deepEqual(daemonRequest.result, {
    name: "fixture",
    arguments: { value: 7 },
  });
});

test("requests before initialize and duplicate ids fail closed", async (t) => {
  const fixture = createHostFixture(t);
  await assert.rejects(
    fixture.host.exchange({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    /not_initialized/,
  );
  await fixture.host.exchange(initializeMessage(2));
  const first = fixture.host.exchange({ jsonrpc: "2.0", id: "slow", method: "fixture/slow" });
  await assert.rejects(
    fixture.host.exchange({ jsonrpc: "2.0", id: "slow", method: "fixture/slow" }),
    /duplicate_request_id/,
  );
  assert.deepEqual((await first).result, { slow: true });
});

test("initialize request must use the locked client protocol and clientInfo contract", async (t) => {
  const oldProtocol = createHostFixture(t);
  await assert.rejects(
    oldProtocol.host.exchange({
      ...initializeMessage(1),
      params: { ...initializeMessage(1).params, protocolVersion: "2024-11-05" },
    }),
    /initialize_request_contract_mismatch/,
  );
  assert.equal(oldProtocol.spawnInputs.length, 0);

  const missingClient = createHostFixture(t);
  await assert.rejects(
    missingClient.host.exchange({
      ...initializeMessage(1),
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    }),
    /initialize_request_contract_mismatch/,
  );
  assert.equal(missingClient.spawnInputs.length, 0);
});

test("stdout EOF is terminal and retained-handle cleanup leaves no residue", async (t) => {
  let terminal;
  const fixture = createHostFixture(t, {
    onTerminal(value) {
      terminal = value;
    },
  });
  await fixture.host.exchange(initializeMessage(1));
  await assert.rejects(
    fixture.host.exchange({ jsonrpc: "2.0", id: 2, method: "fixture/eof" }),
    /child_terminal/,
  );
  await waitFor(() => fixture.residueChecks === 1);
  assert.equal(terminal.reason, "stdout_eof");
  assert.equal(terminal.unexpected, true);
  assert.equal(fixture.host.state, "failed");
});

test("Windows provider host refuses a lifecycle without the Rust Job Object boundary", () => {
  assert.throws(() => new CuaDriverProviderHost({
    executablePath: "/windows/Ling Stack/resources/cua-driver.exe",
    stateRoot,
    generation: 1,
    platform: "win32",
  }), /windows_provider_job_object_lifecycle_required/);
});

test("lazy start revalidates the sealed artifact immediately before spawn", async (t) => {
  let checks = 0;
  let terminal;
  const fixture = createHostFixture(t, {
    async preSpawn() {
      checks += 1;
      throw new CuaDriverProviderPreSpawnError("artifact_invalid");
    },
    onTerminal(value) {
      terminal = value;
    },
  });
  await assert.rejects(fixture.host.exchange(initializeMessage(1)), /pre_spawn_validation_failed/);
  assert.equal(checks, 1);
  assert.equal(fixture.spawnInputs.length, 0);
  assert.deepEqual(terminal, {
    generation: 3,
    reason: "pre_spawn_validation_failed",
    unexpected: true,
    preSpawnFailureKind: "artifact_invalid",
  });
});

test("pre-spawn platform unavailability is preserved without exposing error details", async (t) => {
  let terminal;
  const fixture = createHostFixture(t, {
    async preSpawn() {
      throw new CuaDriverProviderPreSpawnError("platform_unavailable");
    },
    onTerminal(value) {
      terminal = value;
    },
  });
  await assert.rejects(fixture.host.exchange(initializeMessage(1)), /pre_spawn_validation_failed/);
  assert.equal(fixture.spawnInputs.length, 0);
  assert.deepEqual(terminal, {
    generation: 3,
    reason: "pre_spawn_validation_failed",
    unexpected: true,
    preSpawnFailureKind: "platform_unavailable",
  });
});

test("stop aborts an unsettled pre-spawn check and fences late completion", async (t) => {
  const entered = deferred();
  const releasePreSpawn = deferred();
  const children = [];
  const spawnInputs = [];
  let preSpawnSignal;
  const host = new CuaDriverProviderHost({
    executablePath: "/private/ling/cua-driver",
    stateRoot,
    generation: 1,
    platform: "darwin",
    shutdownTimeoutMs: 25,
    async preSpawn(signal) {
      preSpawnSignal = signal;
      entered.resolve();
      await releasePreSpawn.promise;
    },
    lifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn(input) {
        spawnInputs.push(input);
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: input.environment,
        });
        children.push(child);
        return child;
      },
      async terminate(child) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      },
    },
  });
  t.after(async () => {
    releasePreSpawn.resolve();
    await host.stop("test_cleanup").catch(() => undefined);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  const startResult = host.start().then(
    () => undefined,
    (error) => error,
  );
  await entered.promise;
  const stopStartedAt = Date.now();
  try {
    await Promise.race([
      host.stop("pre_spawn_shutdown"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pre_spawn_stop_unbounded")), 250)),
    ]);
  } finally {
    releasePreSpawn.resolve();
  }

  assert.ok(Date.now() - stopStartedAt < 200, "stop must honor the 25ms shutdown boundary");
  assert.equal(preSpawnSignal?.aborted, true);
  assert.match(String(await startResult), /child_terminal/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnInputs.length, 0);
  assert.equal(host.state, "stopped");
});

test("a matching real exit resolves cleanup before terminal-event deduplication", async (t) => {
  const children = [];
  let residueChecks = 0;
  let terminal;
  const host = new CuaDriverProviderHost({
    executablePath: "/private/ling/cua-driver",
    stateRoot,
    generation: 1,
    platform: "darwin",
    shutdownTimeoutMs: 25,
    lifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn(input) {
        const child = spawn(process.execPath, [
          "-e",
          "process.stdout.end(); process.stdin.resume(); setInterval(() => {}, 1000)",
        ], {
          stdio: ["pipe", "pipe", "pipe"],
          env: input.environment,
        });
        children.push(child);
        return child;
      },
      async terminate(child) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      },
      async assertNoResidue() {
        residueChecks += 1;
      },
    },
    onTerminal(value) {
      terminal = value;
    },
  });
  t.after(async () => {
    await host.stop("test_cleanup").catch(() => undefined);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  await host.start();
  await waitFor(() => terminal?.reason === "stdout_eof");
  await host.stop("terminal_cleanup");

  assert.equal(terminal.unexpected, true);
  assert.equal(residueChecks, 1);
  assert.equal(host.state, "failed");
});

test("stop deadline fails closed when retained-handle termination cannot end the child", async () => {
  const children = [];
  const host = new CuaDriverProviderHost({
    executablePath: "/private/ling/cua-driver",
    stateRoot,
    generation: 1,
    platform: "darwin",
    shutdownTimeoutMs: 25,
    lifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn(input) {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: input.environment,
        });
        children.push(child);
        return child;
      },
      async terminate() {
        // Simulate a retained native handle that failed to terminate its process.
      },
    },
  });
  try {
    await host.start();
    await assert.rejects(host.stop("timeout_fixture"), /provider_child_did_not_exit/);
  } finally {
    for (const child of children) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve))));
  await host.stop("late_exit_cleanup");
  assert.equal(host.state, "failed");
});

test("security-boundary termination bypasses graceful shutdown and confirms retained-child exit", async () => {
  let gracefulCount = 0;
  let immediateCount = 0;
  let residueChecks = 0;
  const host = new CuaDriverProviderHost({
    executablePath: "/private/ling/cua-driver",
    stateRoot,
    generation: 9,
    platform: "darwin",
    lifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn(input) {
        return spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: input.environment,
        });
      },
      async terminate() { gracefulCount += 1; },
      async terminateImmediately(child) {
        immediateCount += 1;
        child.kill("SIGKILL");
      },
      async assertNoResidue() { residueChecks += 1; },
    },
  });

  await host.start();
  await host.terminateImmediately("locked_control_input_fence_timeout");

  assert.equal(gracefulCount, 0);
  assert.equal(immediateCount, 1);
  assert.equal(residueChecks, 1);
  assert.equal(host.state, "failed");
});

test("missing stdio retains a nonterminating child until residue cleanup succeeds", async () => {
  let child;
  let residueChecks = 0;
  const host = new CuaDriverProviderHost({
    executablePath: "/windows/Ling Stack/resources/cua-driver.exe",
    stateRoot,
    generation: 1,
    platform: "win32",
    shutdownTimeoutMs: 25,
    lifecycle: {
      lifetimeBoundary: "test-fixture",
      spawn(input) {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
          env: input.environment,
        });
        return child;
      },
      async terminate() {
        // Simulate a retained child handle whose Rust-owned Job did not terminate.
      },
      async assertNoResidue() {
        residueChecks += 1;
      },
    },
  });

  try {
    await assert.rejects(host.start(), /provider_stdio_cleanup_failed/);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(residueChecks, 0);
    await assert.rejects(host.stop("retry_before_exit"), /provider_child_did_not_exit/);
  } finally {
    child?.kill("SIGKILL");
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await host.stop("late_partial_cleanup");
  assert.equal(residueChecks, 1);
  assert.equal(host.state, "stopped");
});

function createHostFixture(t, overrides = {}) {
  const spawnInputs = [];
  let residueChecks = 0;
  const children = [];
  const lifecycle = {
    lifetimeBoundary: "test-fixture",
    spawn(input) {
      spawnInputs.push(input);
      const child = spawn(process.execPath, ["-e", providerFixtureScript], {
        stdio: ["pipe", "pipe", "pipe"],
        env: input.environment,
      });
      children.push(child);
      return child;
    },
    async terminate(child) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    },
    async assertNoResidue() {
      residueChecks += 1;
    },
  };
  const host = new CuaDriverProviderHost({
    executablePath: "/private/ling/cua-driver",
    stateRoot,
    generation: 3,
    platform: "darwin",
    lifecycle,
    requestTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
    ...overrides,
  });
  t.after(async () => {
    await host.stop("test_cleanup").catch(() => undefined);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
  return {
    host,
    spawnInputs,
    get residueChecks() {
      return residueChecks;
    },
  };
}

function initializeMessage(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "ling-test", version: "1" },
    },
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition_timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const providerFixtureScript = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cua-driver", version: "0.8.3" },
      },
    }) + "\n");
    return;
  }
  if (message.method === "fixture/slow") {
    setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { slow: true } }) + "\n"), 50);
    return;
  }
  if (message.method === "fixture/eof") {
    process.stdout.end();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.params || null }) + "\n");
  }
});
`;

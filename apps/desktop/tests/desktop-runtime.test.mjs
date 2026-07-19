import assert from "node:assert/strict";
import test from "node:test";
import { DesktopRuntime } from "../dist/main/desktop-runtime.js";

const workspaceCwd = "/tmp/ling-desktop-runtime-workspace";

test("DesktopRuntime composes once for one cached tuple and keeps a stable Desktop id", async () => {
  const daemon = fakeDaemon(authority("connection-a", 1));
  const coordinatorOptions = [];
  const coordinators = [];
  const diagnostics = [];
  const runtime = createRuntime(daemon, {
    desktopInstanceId: "desktop-stable",
    coordinatorFactory: (options) => {
      coordinatorOptions.push(options);
      const coordinator = fakeCoordinator();
      coordinators.push(coordinator);
      return coordinator;
    },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  const [first, second] = await Promise.all([runtime.ensureStarted(), runtime.ensureStarted()]);

  assert.deepEqual(second, first);
  assert.equal(daemon.ensureStartedCalls, 1, "concurrent startup shares one daemon connection and handshake");
  assert.equal(coordinatorOptions.length, 1);
  assert.equal(runtime.desktopInstanceId, "desktop-stable");
  assert.equal(coordinatorOptions[0].desktopInstanceId, "desktop-stable");
  assert.equal(coordinatorOptions[0].resourcesPath, "/tmp/ling-desktop-runtime-resources");
  assert.deepEqual(coordinatorOptions[0].bridgeContext, {
    bridgeToken: "bridge-token",
    daemonAuthorityEpoch: "authority-a",
    bridgeConnectionId: "connection-a",
    desktopInstanceEpoch: 1,
    workspaceCwd,
  });
  assert.equal(Object.isFrozen(coordinatorOptions[0].bridgeContext), true);
  assert.equal(coordinators[0].shutdownCalls, 0);
  assert.deepEqual(diagnostics, [{
    event: "desktop_runtime.cua_driver_composed",
    details: { platform: "darwin", gateEnabled: true },
  }]);
  const diagnosticJson = JSON.stringify(diagnostics);
  assert.doesNotMatch(diagnosticJson, /bridge-token|authority-a|connection-a|desktopInstanceEpoch/);
});

test("DesktopRuntime restart shuts down the old coordinator before rotating and composing", async () => {
  const events = [];
  const daemon = fakeDaemon(authority("connection-a", 1), {
    onRestart: () => {
      events.push("daemon.restart");
      daemon.cuaDriverAuthorityTuple = authority("connection-b", 2);
    },
  });
  const created = [];
  const runtime = createRuntime(daemon, {
    coordinatorFactory: (options) => {
      const coordinator = fakeCoordinator(() => events.push(`coordinator.shutdown:${options.bridgeContext.bridgeConnectionId}`));
      created.push({ coordinator, options });
      events.push(`coordinator.create:${options.bridgeContext.bridgeConnectionId}`);
      return coordinator;
    },
  });
  await runtime.ensureStarted();

  const [firstRestart, secondRestart] = await Promise.all([runtime.restart(), runtime.restart()]);

  assert.deepEqual(secondRestart, firstRestart);
  assert.deepEqual(events, [
    "coordinator.create:connection-a",
    "coordinator.shutdown:connection-a",
    "daemon.restart",
    "coordinator.create:connection-b",
  ]);
  assert.equal(created.length, 2);
  assert.equal(daemon.restartCalls, 1);
  assert.equal(created[0].coordinator.shutdownCalls, 1);
  assert.equal(created[1].options.desktopInstanceId, created[0].options.desktopInstanceId);
});

test("closed gate never composes a provider even when the daemon returned a typed tuple", async () => {
  const daemon = fakeDaemon(authority("ignored-closed-gate-connection", 1));
  let factoryCalls = 0;
  let bindingFactoryCalls = 0;
  const runtime = createRuntime(daemon, {
    featureFlags: closedFeatureFlags(),
    platformBinding: undefined,
    platformBindingFactory: () => {
      bindingFactoryCalls += 1;
      throw new Error("closed gate must not resolve a platform binding");
    },
    coordinatorFactory: () => {
      factoryCalls += 1;
      return fakeCoordinator();
    },
  });

  const status = await runtime.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(factoryCalls, 0);
  assert.equal(bindingFactoryCalls, 0);
  assert.equal(runtime.cuaDriverCoordinator, undefined);
});

test("open bundled gate fails closed when daemon authority is missing", async () => {
  const daemon = fakeDaemon(undefined);
  const runtime = createRuntime(daemon);

  await assert.rejects(
    runtime.ensureStarted(),
    (error) => error?.code === "authority_missing",
  );
});

test("Win32 composition maps x64 to the shared x86_64 contract and uses the injected binding factory", async () => {
  const daemon = fakeDaemon(authority("connection-win32", 3));
  const binding = { platform: "win32", fixture: true };
  const bindingPlatforms = [];
  let coordinatorOptions;
  const runtime = createRuntime(daemon, {
    platform: "win32",
    architecture: "x64",
    featureFlags: bundledWin32FeatureFlags(),
    platformBinding: undefined,
    platformBindingFactory: (platform) => {
      bindingPlatforms.push(platform);
      return binding;
    },
    coordinatorFactory: (options) => {
      coordinatorOptions = options;
      return fakeCoordinator();
    },
  });

  await runtime.ensureStarted();

  assert.deepEqual(bindingPlatforms, ["win32"]);
  assert.equal(coordinatorOptions.platform, "win32");
  assert.equal(coordinatorOptions.architecture, "x86_64");
  assert.equal(coordinatorOptions.platformBinding, binding);
});

test("shutdown continues to the owned daemon after coordinator cleanup fails", async () => {
  const events = [];
  const cleanupError = new Error("coordinator cleanup failed");
  const daemon = fakeDaemon(authority("connection-a", 1), {
    onStop: () => events.push("daemon.stop"),
  });
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => ({
      async shutdown() {
        events.push("coordinator.shutdown");
        throw cleanupError;
      },
    }),
  });
  await runtime.ensureStarted();

  await assert.rejects(runtime.shutdown(), (error) => error === cleanupError);
  await assert.rejects(runtime.ensureStarted(), (error) => error?.code === "shutdown_requested");

  assert.deepEqual(events, ["coordinator.shutdown", "daemon.stop"]);
  assert.equal(daemon.stopCalls, 1);
});

test("restart still rotates daemon authority when old coordinator cleanup fails", async () => {
  const cleanupError = new Error("old coordinator cleanup failed");
  const daemon = fakeDaemon(authority("connection-a", 1), {
    onRestart: () => {
      daemon.cuaDriverAuthorityTuple = authority("connection-b", 2);
    },
  });
  let factoryCalls = 0;
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => {
      factoryCalls += 1;
      return {
        async shutdown() {
          throw cleanupError;
        },
      };
    },
  });
  await runtime.ensureStarted();

  await assert.rejects(runtime.restart(), (error) => error === cleanupError);
  await assert.rejects(runtime.ensureStarted(), (error) => error === cleanupError);

  assert.equal(daemon.restartCalls, 1, "daemon handshake must still fence the old lease");
  assert.equal(factoryCalls, 1, "an incompletely stopped coordinator blocks replacement");
  assert.ok(runtime.cuaDriverCoordinator, "failed cleanup remains retained for retry instead of being forgotten");
});

test("shutdown fences an in-flight startup and still stops the daemon", async () => {
  const startup = deferred();
  const events = [];
  const daemon = fakeDaemon(authority("connection-a", 1), {
    ensureStarted: async () => {
      events.push("daemon.start.begin");
      await startup.promise;
      events.push("daemon.start.end");
      return daemon.status;
    },
    onStop: () => events.push("daemon.stop"),
  });
  let factoryCalls = 0;
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => {
      factoryCalls += 1;
      return fakeCoordinator();
    },
  });

  const starting = runtime.ensureStarted();
  await Promise.resolve();
  const stopping = runtime.shutdown();
  startup.resolve();

  await assert.rejects(starting, (error) => error?.code === "shutdown_requested");
  await stopping;
  assert.equal(factoryCalls, 0);
  assert.deepEqual(events, ["daemon.start.begin", "daemon.start.end", "daemon.stop"]);
});

function createRuntime(daemon, overrides = {}) {
  return new DesktopRuntime({
    daemon,
    daemonBaseUrl: "http://127.0.0.1:17891",
    bridgeToken: "bridge-token",
    workspaceCwd,
    resourcesRoot: "/tmp/ling-desktop-runtime-resources",
    userDataPath: "/tmp/ling-desktop-runtime-user-data",
    platform: "darwin",
    architecture: "arm64",
    featureFlags: bundledDarwinFeatureFlags(),
    platformBinding: fakePlatformBinding(),
    ...overrides,
  });
}

function fakeDaemon(initialAuthority, options = {}) {
  return {
    status: { state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true },
    cuaDriverAuthorityTuple: initialAuthority,
    ensureStartedCalls: 0,
    restartCalls: 0,
    stopCalls: 0,
    async ensureStarted() {
      this.ensureStartedCalls += 1;
      return options.ensureStarted ? options.ensureStarted() : this.status;
    },
    async restart() {
      this.restartCalls += 1;
      options.onRestart?.();
      return this.status;
    },
    async stopOwnedDaemon() {
      this.stopCalls += 1;
      options.onStop?.();
    },
    onStatusChanged() {
      return () => {};
    },
  };
}

function fakeCoordinator(onShutdown) {
  return {
    shutdownCalls: 0,
    async shutdown() {
      this.shutdownCalls += 1;
      onShutdown?.();
    },
  };
}

function authority(bridgeConnectionId, desktopInstanceEpoch) {
  return Object.freeze({
    daemonAuthorityEpoch: "authority-a",
    bridgeConnectionId,
    desktopInstanceEpoch,
    workspaceCwd,
  });
}

function bundledDarwinFeatureFlags() {
  return {
    bundledEmbedded: { darwin: true, win32: false },
    packagedProvider: { darwin: true, win32: false },
  };
}

function closedFeatureFlags() {
  return {
    bundledEmbedded: { darwin: false, win32: false },
    packagedProvider: { darwin: false, win32: false },
  };
}

function bundledWin32FeatureFlags() {
  return {
    bundledEmbedded: { darwin: false, win32: true },
    packagedProvider: { darwin: false, win32: true },
  };
}

function fakePlatformBinding() {
  return {
    platform: "darwin",
    availability: { status: "available" },
    platformIdentityVerifier: { async verify() {} },
    processLifecycle: {
      lifetimeBoundary: "darwin-direct-child",
      spawn() {
        throw new Error("not used by composition tests");
      },
      async terminate() {},
    },
    readinessController: {
      async check() {
        return { ready: false, providerState: "platform_unavailable" };
      },
      invalidate() {},
    },
    metadata: { limitations: [] },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

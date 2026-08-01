import assert from "node:assert/strict";
import test from "node:test";
import { DesktopRuntime, DesktopRuntimeError } from "../dist/main/desktop-runtime.js";

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
  assert.equal(coordinators[0].enableCalls, 1, "startup publishes one lazy availability lease");
  assert.equal(coordinators[0].shutdownCalls, 0);
  assert.deepEqual(diagnostics, [{
    event: "desktop_runtime.cua_driver_composed",
    details: { platform: "darwin", gateEnabled: true },
  }]);
  const diagnosticJson = JSON.stringify(diagnostics);
  assert.doesNotMatch(diagnosticJson, /bridge-token|authority-a|connection-a|desktopInstanceEpoch/);

  coordinatorOptions[0].telemetry.emit("info", "cua_driver.host.spawned", {
    generation: 1,
    pid: 4321,
    authorizationToken: "must-not-leak",
  });
  coordinatorOptions[0].onStateChanged({
    lifecycle: "active",
    providerState: "permission_required",
    generation: 1,
    pid: 4321,
    reason: "darwin_accessibility_permission_required",
  });
  assert.deepEqual(diagnostics.slice(1), [
    {
      event: "desktop_runtime.cua_driver_telemetry",
      details: {
        platform: "darwin",
        level: "info",
        providerEvent: "cua_driver.host.spawned",
        generation: 1,
        pid: 4321,
      },
    },
    {
      event: "desktop_runtime.cua_driver_state_changed",
      details: {
        platform: "darwin",
        lifecycle: "active",
        providerState: "permission_required",
        generation: 1,
        pid: 4321,
        reason: "darwin_accessibility_permission_required",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /must-not-leak/);
});

test("DesktopRuntime sequential ensure reuses the coordinator for the same authority tuple", async () => {
  const daemon = fakeDaemon(authority("connection-a", 1));
  const coordinators = [];
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => {
      const coordinator = fakeCoordinator();
      coordinators.push(coordinator);
      return coordinator;
    },
  });

  await runtime.ensureStarted();
  const firstCoordinator = runtime.cuaDriverCoordinator;
  await runtime.ensureStarted();

  assert.equal(daemon.ensureStartedCalls, 2, "each window-open check may ask the cached daemon lifecycle");
  assert.equal(coordinators.length, 1, "the same authority tuple must not construct another provider owner");
  assert.equal(runtime.cuaDriverCoordinator, firstCoordinator);
  assert.equal(coordinators[0].enableCalls, 2, "the cached tuple revalidates through idempotent enable without a second owner");
  assert.equal(coordinators[0].shutdownCalls, 0);
});

test("DesktopRuntime rejects ambiguous or cross-platform owner composition", async () => {
  const daemon = fakeDaemon(authority("connection-owner-guard", 1));
  const owner = {
    platform: "darwin",
    binding: fakePlatformBinding(),
    async start() {},
    async dispose() {},
  };
  assert.throws(
    () => createRuntime(daemon, { platformOwner: owner }),
    (error) => error instanceof DesktopRuntimeError && error.code === "platform_owner_conflict",
  );

  let ownerStartCalls = 0;
  const mismatch = createRuntime(daemon, {
    platformBinding: undefined,
    platformOwner: {
      ...owner,
      platform: "win32",
      binding: { ...owner.binding, platform: "win32" },
      async start() { ownerStartCalls += 1; },
    },
  });
  await assert.rejects(
    mismatch.ensureStarted(),
    (error) => error instanceof DesktopRuntimeError && error.code === "platform_owner_mismatch",
  );
  assert.equal(ownerStartCalls, 0, "a mismatched owner must be rejected before observer startup");
  await mismatch.shutdown();
});

test("DesktopRuntime reuses one platform owner across authority rotation and disposes after coordinator", async () => {
  const daemon = fakeDaemon(authority("connection-owner-a", 1));
  const events = [];
  const binding = fakePlatformBinding();
  const owner = {
    platform: "darwin",
    binding,
    startCalls: 0,
    disposeCalls: 0,
    async start() {
      this.startCalls += 1;
      events.push("owner.start");
    },
    async dispose() {
      this.disposeCalls += 1;
      events.push("owner.dispose");
    },
  };
  const coordinators = [];
  const runtime = createRuntime(daemon, {
    platformBinding: undefined,
    platformOwner: owner,
    coordinatorFactory: (options) => {
      assert.equal(options.platformBinding, binding);
      const coordinator = fakeCoordinator(() => events.push("coordinator.shutdown"));
      coordinators.push(coordinator);
      return coordinator;
    },
  });

  await runtime.ensureStarted();
  daemon.cuaDriverAuthorityTuple = authority("connection-owner-b", 2);
  await runtime.ensureStarted();
  await runtime.shutdown();

  assert.equal(coordinators.length, 2);
  assert.equal(owner.startCalls, 2, "authority rotation may revalidate but never recreates the owner");
  assert.equal(owner.disposeCalls, 1);
  assert.deepEqual(events, [
    "owner.start",
    "coordinator.shutdown",
    "owner.start",
    "coordinator.shutdown",
    "owner.dispose",
  ]);
});

test("platform refresh rotates only the current provider generation", async () => {
  const daemon = fakeDaemon(authority("connection-refresh", 1));
  const coordinator = fakeCoordinator();
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => coordinator,
  });
  await runtime.ensureStarted();

  await runtime.refreshCuaDriverPlatform("darwin_permission_changed");

  assert.equal(coordinator.restartCalls, 1);
  assert.deepEqual(coordinator.restartReasons, ["darwin_permission_changed"]);
  assert.equal(daemon.restartCalls, 0, "permission changes must not restart the daemon handshake");
});

test("platform refresh is inert behind a closed gate and composes when no coordinator exists", async () => {
  const closedDaemon = fakeDaemon(authority("connection-refresh-closed", 1));
  const closedRuntime = createRuntime(closedDaemon, { featureFlags: closedFeatureFlags() });
  await closedRuntime.refreshCuaDriverPlatform("closed_gate");
  assert.equal(closedDaemon.ensureStartedCalls, 0);
  assert.equal(closedRuntime.cuaDriverCoordinator, undefined);
  await closedRuntime.shutdown();

  const daemon = fakeDaemon(authority("connection-refresh-compose", 1));
  const coordinator = fakeCoordinator();
  const runtime = createRuntime(daemon, { coordinatorFactory: () => coordinator });
  await runtime.refreshCuaDriverPlatform("initial_observation");
  assert.equal(coordinator.enableCalls, 1);
  assert.equal(runtime.cuaDriverCoordinator, coordinator);
  assert.equal(daemon.restartCalls, 0);
  await runtime.shutdown();
});

test("platform refresh replaces a coordinator that has no restart operation", async () => {
  const daemon = fakeDaemon(authority("connection-refresh-replace", 1));
  const coordinators = [];
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => {
      const coordinator = {
        enableCalls: 0,
        shutdownCalls: 0,
        async enable() {
          this.enableCalls += 1;
          return availabilitySnapshot();
        },
        async shutdown() { this.shutdownCalls += 1; },
      };
      coordinators.push(coordinator);
      return coordinator;
    },
  });
  await runtime.ensureStarted();
  await runtime.refreshCuaDriverPlatform("adapter_without_restart");
  assert.equal(coordinators.length, 2);
  assert.equal(coordinators[0].shutdownCalls, 1);
  assert.equal(coordinators[1].enableCalls, 1);
  await runtime.shutdown();
});

test("runtime binds availability reports to the authenticated Desktop authority tuple", async () => {
  const daemon = fakeDaemon(authority("connection-availability", 4));
  const reports = [];
  const runtime = createRuntime(daemon, {
    availabilityClient: {
      async publish(report) {
        reports.push(report);
      },
    },
    coordinatorFactory: (options) => ({
      async enable() {
        await options.availabilityPublisher.publish({
          lifecycle: "failed",
          providerState: "permission_required",
          generation: 3,
          reason: "darwin_accessibility_permission_required",
        });
        return availabilitySnapshot();
      },
      async shutdown() {
        await options.availabilityPublisher.close();
      },
    }),
  });

  await runtime.ensureStarted();

  assert.deepEqual(reports, [{
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: runtime.desktopInstanceId,
    desktopInstanceEpoch: 4,
    bridgeConnectionId: "connection-availability",
    daemonAuthorityEpoch: "authority-a",
    workspaceCwd,
    generation: 3,
    sequence: 1,
    platform: "darwin",
    providerState: "permission_required",
    reason: "darwin_accessibility_permission_required",
    limitations: [],
  }]);
  await runtime.shutdown();
});

test("platform observer startup failure keeps the daemon usable and provider fail-closed", async () => {
  const daemon = fakeDaemon(authority("connection-observer-failure", 1));
  const diagnostics = [];
  const coordinator = fakeCoordinator();
  const ownerBinding = fakePlatformBinding();
  let composedBinding;
  const runtime = createRuntime(daemon, {
    platformBinding: undefined,
    platformOwner: {
      platform: "darwin",
      binding: ownerBinding,
      async start() {
        throw new Error("permission monitor unavailable");
      },
      async dispose() {},
    },
    coordinatorFactory: (options) => {
      composedBinding = options.platformBinding;
      return coordinator;
    },
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  const status = await runtime.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(coordinator.enableCalls, 1);
  assert.equal(composedBinding.availability.status, "unavailable");
  assert.notEqual(composedBinding, ownerBinding);
  assert.deepEqual(diagnostics[0], {
    event: "desktop_runtime.cua_driver_platform_observer_unavailable",
    details: { platform: "darwin", error: "permission monitor unavailable" },
  });
  await runtime.shutdown();
});

test("a recovered platform observer replaces the fail-closed coordinator on the same authority", async () => {
  const daemon = fakeDaemon(authority("connection-observer-recovery", 1));
  const ownerBinding = fakePlatformBinding();
  const bindings = [];
  const coordinators = [];
  let startCalls = 0;
  const runtime = createRuntime(daemon, {
    platformBinding: undefined,
    platformOwner: {
      platform: "darwin",
      binding: ownerBinding,
      async start() {
        startCalls += 1;
        if (startCalls === 1) throw new Error("transient observer failure");
      },
      async dispose() {},
    },
    coordinatorFactory: (options) => {
      bindings.push(options.platformBinding);
      const coordinator = fakeCoordinator();
      coordinators.push(coordinator);
      return coordinator;
    },
  });

  await runtime.ensureStarted();
  assert.equal(bindings[0].availability.status, "unavailable");
  await runtime.ensureStarted();

  assert.equal(startCalls, 2);
  assert.equal(coordinators.length, 2);
  assert.equal(coordinators[0].shutdownCalls, 1);
  assert.equal(bindings[1], ownerBinding);
  await runtime.shutdown();
});

test("a transient availability failure is non-fatal and the same tuple retries idempotent enable", async () => {
  const daemon = fakeDaemon(authority("connection-provider-invalid", 1));
  const diagnostics = [];
  const enableError = new Error("provider_lock_digest_mismatch");
  let enableAttempts = 0;
  const coordinator = fakeCoordinator(undefined, {
    enable: async () => {
      enableAttempts += 1;
      if (enableAttempts === 1) {
        throw enableError;
      }
      return availabilitySnapshot();
    },
  });
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => coordinator,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  const firstStatus = await runtime.ensureStarted();
  const secondStatus = await runtime.ensureStarted();

  assert.equal(firstStatus.state, "connected", "provider availability must not masquerade as daemon startup failure");
  assert.equal(secondStatus.state, "connected");
  assert.equal(runtime.cuaDriverCoordinator, coordinator, "the same fail-closed owner is retained and retried");
  assert.equal(coordinator.enableCalls, 2);
  assert.equal(coordinator.shutdownCalls, 0);
  assert.deepEqual(diagnostics, [
    {
      event: "desktop_runtime.cua_driver_composed",
      details: { platform: "darwin", gateEnabled: true },
    },
    {
      event: "desktop_runtime.cua_driver_availability_failed",
      details: { platform: "darwin", error: enableError.message },
    },
  ]);
});

test("resolved fail-closed availability snapshots are diagnosed without failing daemon startup", async () => {
  const daemon = fakeDaemon(authority("connection-platform-unavailable", 1));
  const diagnostics = [];
  const coordinator = fakeCoordinator(undefined, {
    enable: async () => ({
      lifecycle: "failed",
      providerState: "platform_unavailable",
      generation: 0,
      reason: "platform_binding_unavailable",
    }),
  });
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => coordinator,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
  });

  const status = await runtime.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(runtime.cuaDriverCoordinator, coordinator);
  assert.deepEqual(diagnostics.at(-1), {
    event: "desktop_runtime.cua_driver_availability_failed",
    details: {
      platform: "darwin",
      providerState: "platform_unavailable",
      reason: "platform_binding_unavailable",
    },
  });
});

test("daemon status loss during availability enable revokes the captured coordinator before authority_missing", async () => {
  const enableStarted = deferred();
  const releaseEnable = deferred();
  const daemon = fakeDaemon(authority("connection-status-loss", 1));
  const coordinator = fakeCoordinator(undefined, {
    enable: async () => {
      enableStarted.resolve();
      await releaseEnable.promise;
      return availabilitySnapshot();
    },
  });
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => coordinator,
  });

  const starting = runtime.ensureStarted();
  await enableStarted.promise;
  daemon.cuaDriverAuthorityTuple = undefined;
  daemon.emitStatus({
    state: "disconnected",
    baseUrl: "http://127.0.0.1:17891",
    ownedByDesktop: false,
    reason: "child_exited",
  });
  releaseEnable.resolve();

  await assert.rejects(starting, (error) => error?.code === "authority_missing");
  await runtime.shutdown();
  assert.equal(coordinator.shutdownCalls, 1, "post-enable authority validation owns the single revoke");
  assert.equal(runtime.cuaDriverCoordinator, undefined);
});

test("authority rotation during availability enable revokes G and a later ensure composes the new tuple", async () => {
  const enableStarted = deferred();
  const releaseEnable = deferred();
  const daemon = fakeDaemon(authority("connection-a", 1));
  const created = [];
  const runtime = createRuntime(daemon, {
    coordinatorFactory: (options) => {
      const coordinator = fakeCoordinator(undefined, created.length === 0
        ? {
            enable: async () => {
              enableStarted.resolve();
              await releaseEnable.promise;
              return availabilitySnapshot();
            },
          }
        : {});
      created.push({ coordinator, options });
      return coordinator;
    },
  });

  const starting = runtime.ensureStarted();
  await enableStarted.promise;
  daemon.cuaDriverAuthorityTuple = authority("connection-b", 2);
  releaseEnable.resolve();

  await assert.rejects(starting, (error) => error?.code === "authority_missing");
  assert.equal(created[0].coordinator.shutdownCalls, 1);

  const recovered = await runtime.ensureStarted();
  assert.equal(recovered.state, "connected");
  assert.equal(created.length, 2);
  assert.equal(created[1].options.bridgeContext.bridgeConnectionId, "connection-b");
  assert.equal(created[1].coordinator.enableCalls, 1);
  assert.equal(runtime.cuaDriverCoordinator, created[1].coordinator);
});

test("initial daemon checking events cannot enqueue cleanup for a coordinator composed later", async () => {
  let daemon;
  daemon = fakeDaemon(authority("connection-initial-check", 1), {
    ensureStarted: async () => {
      daemon.emitStatus({ state: "checking", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: false });
      daemon.emitStatus({ state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true });
      return daemon.status;
    },
  });
  const coordinator = fakeCoordinator();
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => coordinator,
  });

  await runtime.ensureStarted();
  await Promise.resolve();

  assert.equal(coordinator.enableCalls, 1);
  assert.equal(coordinator.shutdownCalls, 0);
  assert.equal(runtime.cuaDriverCoordinator, coordinator);
});

test("daemon status loss after availability closes the coordinator captured by that event", async () => {
  const daemon = fakeDaemon(authority("connection-active-loss", 1));
  const coordinator = fakeCoordinator();
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => coordinator,
  });
  await runtime.ensureStarted();

  daemon.cuaDriverAuthorityTuple = undefined;
  daemon.emitStatus({
    state: "disconnected",
    baseUrl: "http://127.0.0.1:17891",
    ownedByDesktop: false,
    reason: "child_exited",
  });

  await assert.rejects(runtime.ensureStarted(), (error) => error?.code === "authority_missing");
  assert.equal(coordinator.shutdownCalls, 1);
  assert.equal(runtime.cuaDriverCoordinator, undefined);
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
      const coordinator = fakeCoordinator(
        () => events.push(`coordinator.shutdown:${options.bridgeContext.bridgeConnectionId}`),
        {
          enable: async () => {
            events.push(`coordinator.enable:${options.bridgeContext.bridgeConnectionId}`);
            return availabilitySnapshot();
          },
        },
      );
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
    "coordinator.enable:connection-a",
    "coordinator.shutdown:connection-a",
    "daemon.restart",
    "coordinator.create:connection-b",
    "coordinator.enable:connection-b",
  ]);
  assert.equal(created.length, 2);
  assert.equal(daemon.restartCalls, 1);
  assert.equal(created[0].coordinator.enableCalls, 1);
  assert.equal(created[0].coordinator.shutdownCalls, 1);
  assert.equal(created[1].coordinator.enableCalls, 1);
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
  assert.equal(daemon.statusListenerCount, 0, "closed gates do not add provider lifecycle observers");
  assert.equal(runtime.cuaDriverCoordinator, undefined);
});

test("task continuation observes lock state even when the Cua Driver gate is closed", async () => {
  const daemon = fakeDaemon(authority("closed-gate-task-continuation", 1));
  const powerMonitor = fakePowerMonitor();
  const published = [];
  const runtime = createRuntime(daemon, {
    featureFlags: closedFeatureFlags(),
    platformBinding: undefined,
    powerMonitor,
    lockedTaskContinuationPreferenceStore: {
      async load() {
        return { schemaVersion: 1, continueWhileLocked: false };
      },
      async save() {},
    },
    lockedTaskContinuationClient: recordingLockedTaskContinuationClient(published),
  });

  await runtime.ensureStarted();
  powerMonitor.emit("lock-screen");
  await flushAsyncWork();
  assert.deepEqual(published.at(-1), {
    workspaceCwd,
    desktopInstanceId: runtime.desktopInstanceId,
    leaseTtlMs: 15_000,
    continueWhileLocked: false,
    locked: true,
  });
  await runtime.shutdown();
  assert.deepEqual(powerMonitor.observedEvents(), []);
});

test("open bundled gate fails closed when daemon authority is missing", async () => {
  const daemon = fakeDaemon(undefined);
  const runtime = createRuntime(daemon);

  await assert.rejects(
    runtime.ensureStarted(),
    (error) => error?.code === "authority_missing",
  );
});

test("open bundled gate rejects authority issued for a different workspace", async () => {
  const daemon = fakeDaemon(Object.freeze({
    ...authority("connection-wrong-workspace", 1),
    workspaceCwd: "/tmp/ling-desktop-runtime-other-workspace",
  }));
  let factoryCalls = 0;
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => {
      factoryCalls += 1;
      return fakeCoordinator();
    },
  });

  await assert.rejects(
    runtime.ensureStarted(),
    (error) => error?.code === "authority_missing",
  );

  assert.equal(factoryCalls, 0);
  assert.equal(runtime.cuaDriverCoordinator, undefined);
});

test("unsupported platforms remain gate-closed and unsupported bundled architectures fail closed", async () => {
  const unsupportedPlatformDaemon = fakeDaemon(authority("connection-linux", 1));
  let unsupportedPlatformFactoryCalls = 0;
  const unsupportedPlatformRuntime = createRuntime(unsupportedPlatformDaemon, {
    platform: "linux",
    architecture: "x64",
    platformBinding: undefined,
    coordinatorFactory: () => {
      unsupportedPlatformFactoryCalls += 1;
      return fakeCoordinator();
    },
  });

  const unsupportedPlatformStatus = await unsupportedPlatformRuntime.ensureStarted();
  assert.equal(unsupportedPlatformStatus.state, "connected");
  assert.equal(unsupportedPlatformFactoryCalls, 0);

  for (const input of [
    { platform: "darwin", architecture: "ia32", featureFlags: bundledDarwinFeatureFlags() },
    { platform: "win32", architecture: "ia32", featureFlags: bundledWin32FeatureFlags() },
  ]) {
    const daemon = fakeDaemon(authority(`connection-${input.platform}`, 1));
    let factoryCalls = 0;
    const runtime = createRuntime(daemon, {
      ...input,
      platformBinding: undefined,
      platformBindingFactory: () => {
        throw new Error("unsupported architecture must fail before binding selection");
      },
      coordinatorFactory: () => {
        factoryCalls += 1;
        return fakeCoordinator();
      },
    });

    await assert.rejects(
      runtime.ensureStarted(),
      (error) => error?.code === "architecture_unsupported",
    );
    assert.equal(factoryCalls, 0);
  }
});

test("Win32 composition maps x64 to the shared x86_64 contract and uses the injected binding factory", async () => {
  const daemon = fakeDaemon(authority("connection-win32", 3));
  const binding = {
    platform: "win32",
    fixture: true,
    metadata: {
      integrityCoverage: "standard",
      limitations: ["elevated_pixel_input", "uwp_send_input"],
    },
  };
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
  assert.equal(runtime.cuaDriverCoordinator.enableCalls, 1);
});

test("packaged Computer Control permission commands stay platform-scoped", async () => {
  const macDaemon = fakeDaemon(authority("connection-macos-permissions", 1));
  const macCalls = [];
  const macCoordinator = fakeCoordinator();
  const macRuntime = createRuntime(macDaemon, {
    packaged: true,
    platformBinding: undefined,
    platformOwner: {
      platform: "darwin",
      binding: fakePlatformBinding(),
      async start() {},
      async dispose() {},
      async requestPermissions() {
        macCalls.push("requestPermissions");
      },
    },
    openExternal: async (url) => {
      macCalls.push(url);
    },
    coordinatorFactory: () => macCoordinator,
  });

  assert.equal(macRuntime.computerControlPlatform, "macos");
  assert.deepEqual(await macRuntime.requestComputerControlPermissions(), { accepted: true });
  assert.deepEqual(
    await macRuntime.openComputerControlPermissionSettings("accessibility"),
    { accepted: true },
  );
  assert.deepEqual(
    await macRuntime.openComputerControlPermissionSettings("screen_recording"),
    { accepted: true },
  );
  assert.deepEqual(macCalls, [
    "requestPermissions",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  ]);
  assert.equal(macCoordinator.enableCalls, 1);
  await macRuntime.shutdown();

  const windowsRuntime = createRuntime(fakeDaemon(authority("connection-windows-permissions", 1)), {
    platform: "win32",
    architecture: "x64",
    featureFlags: bundledWin32FeatureFlags(),
    packaged: true,
    platformBinding: undefined,
    platformOwner: {
      platform: "win32",
      binding: { ...fakePlatformBinding(), platform: "win32" },
      async start() {},
      async dispose() {},
    },
  });

  assert.equal(windowsRuntime.computerControlPlatform, "windows");
  assert.deepEqual(
    await windowsRuntime.requestComputerControlPermissions(),
    { accepted: false, reason: "unsupported_platform_action" },
  );
  assert.deepEqual(
    await windowsRuntime.openComputerControlPermissionSettings("accessibility"),
    { accepted: false, reason: "unsupported_platform_action" },
  );
  await windowsRuntime.shutdown();
});

test("packaged Desktop runtime suspends computer control across lock and sleep and removes power listeners on shutdown", async () => {
  const daemon = fakeDaemon(authority("connection-power-monitor", 1));
  const powerMonitor = fakePowerMonitor();
  const lifecycleEvents = [];
  const coordinator = {
    ...fakeCoordinator(() => lifecycleEvents.push("coordinator.shutdown")),
    async suspendForSystem(reason) {
      lifecycleEvents.push(`suspend:${reason}`);
    },
    async resumeForSystem() {
      lifecycleEvents.push("resume");
    },
  };
  const binding = fakePlatformBinding();
  const platformOwner = {
    platform: "darwin",
    binding,
    async start() {},
    async dispose() {
      lifecycleEvents.push("owner.dispose");
    },
  };
  const runtime = createRuntime(daemon, {
    packaged: true,
    platformBinding: undefined,
    platformOwner,
    powerMonitor,
    coordinatorFactory: () => coordinator,
  });

  assert.deepEqual(powerMonitor.observedEvents(), [
    "lock-screen",
    "resume",
    "suspend",
    "unlock-screen",
  ]);
  await runtime.ensureStarted();

  powerMonitor.emit("lock-screen");
  await flushAsyncWork();
  powerMonitor.emit("suspend");
  await flushAsyncWork();
  powerMonitor.emit("unlock-screen");
  await flushAsyncWork();
  powerMonitor.emit("resume");
  await flushAsyncWork();

  powerMonitor.emit("lock-screen");
  await flushAsyncWork();
  powerMonitor.emit("suspend");
  await flushAsyncWork();
  powerMonitor.emit("resume");
  await flushAsyncWork();
  assert.equal(
    lifecycleEvents.filter((event) => event === "resume").length,
    1,
    "system resume while the session remains locked must keep Computer Control paused",
  );
  powerMonitor.emit("unlock-screen");
  await flushAsyncWork();

  assert.deepEqual(lifecycleEvents, [
    "suspend:system_lock",
    "suspend:system_suspend",
    "resume",
    "suspend:system_lock",
    "suspend:system_suspend",
    "resume",
  ]);
  assert.equal(daemon.ensureStartedCalls, 1, "lock and sleep must not restart the task daemon");
  assert.equal(daemon.stopCalls, 0, "lock and sleep pause only Computer Control, not running tasks");

  await runtime.shutdown();
  assert.equal(daemon.stopCalls, 1, "the daemon stops only when Desktop itself shuts down");
  assert.deepEqual(powerMonitor.observedEvents(), []);
  assert.deepEqual(lifecycleEvents, [
    "suspend:system_lock",
    "suspend:system_suspend",
    "resume",
    "suspend:system_lock",
    "suspend:system_suspend",
    "resume",
    "coordinator.shutdown",
    "owner.dispose",
  ]);

  powerMonitor.emit("lock-screen");
  powerMonitor.emit("resume");
  await flushAsyncWork();
  assert.equal(lifecycleEvents.length, 8, "detached listeners must not enqueue work after shutdown");
});

test("a lock received during provider enable is reasserted after enable completes", async () => {
  const daemon = fakeDaemon(authority("connection-enable-lock", 1));
  const powerMonitor = fakePowerMonitor();
  const enableStarted = deferred();
  const releaseEnable = deferred();
  const events = [];
  const coordinator = {
    ...fakeCoordinator(undefined, {
      enable: async () => {
        events.push("enable.begin");
        enableStarted.resolve();
        await releaseEnable.promise;
        events.push("enable.end");
        return availabilitySnapshot();
      },
    }),
    closeCallGateForSecurityBoundary(reason) {
      events.push(`gate:${reason}`);
    },
    async suspendForSystem(reason) {
      events.push(`suspend:${reason}`);
    },
  };
  const runtime = createRuntime(daemon, {
    packaged: true,
    platformBinding: undefined,
    platformOwner: {
      platform: "darwin",
      binding: fakePlatformBinding(),
      async start() {},
      async dispose() {},
    },
    powerMonitor,
    coordinatorFactory: () => coordinator,
  });

  const starting = runtime.ensureStarted();
  await enableStarted.promise;
  powerMonitor.emit("lock-screen");
  await flushAsyncWork();
  releaseEnable.resolve();
  await starting;

  assert.deepEqual(events, [
    "enable.begin",
    "gate:locked_control_session_mismatch",
    "suspend:system_lock",
    "enable.end",
    "gate:system_lock",
    "suspend:system_lock",
  ]);
  assert.equal(daemon.stopCalls, 0, "the task daemon remains alive while control is paused");
  await runtime.shutdown();
});

test("a lock received before provider composition still blocks a later resume hint", async () => {
  const daemon = fakeDaemon(authority("connection-precomposition-lock", 1));
  const powerMonitor = fakePowerMonitor();
  const events = [];
  const coordinator = {
    ...fakeCoordinator(),
    closeCallGateForSecurityBoundary(reason) {
      events.push(`gate:${reason}`);
    },
    async suspendForSystem(reason) {
      events.push(`suspend:${reason}`);
    },
    async resumeForSystem() {
      events.push("resume");
    },
  };
  const runtime = createRuntime(daemon, {
    packaged: true,
    platformBinding: undefined,
    platformOwner: {
      platform: "darwin",
      binding: fakePlatformBinding(),
      async start() {},
      async dispose() {},
    },
    powerMonitor,
    coordinatorFactory: () => coordinator,
  });

  powerMonitor.emit("lock-screen");
  await flushAsyncWork();
  await runtime.ensureStarted();
  powerMonitor.emit("suspend");
  await flushAsyncWork();
  powerMonitor.emit("resume");
  await flushAsyncWork();
  assert.equal(events.includes("resume"), false);

  powerMonitor.emit("unlock-screen");
  await flushAsyncWork();
  assert.equal(events.filter((event) => event === "resume").length, 1);
  await runtime.shutdown();
});

test("shutdown continues to the owned daemon after coordinator cleanup fails", async () => {
  const events = [];
  const cleanupError = new Error("coordinator cleanup failed");
  const daemon = fakeDaemon(authority("connection-a", 1), {
    onStop: () => events.push("daemon.stop"),
  });
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => ({
      async enable() {
        return availabilitySnapshot();
      },
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

test("concurrent and repeated shutdown calls share one coordinator and daemon cleanup", async () => {
  const shutdownStarted = deferred();
  const releaseShutdown = deferred();
  let coordinatorShutdownCalls = 0;
  const daemon = fakeDaemon(authority("connection-a", 1));
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => ({
      async enable() {
        return availabilitySnapshot();
      },
      async shutdown() {
        coordinatorShutdownCalls += 1;
        shutdownStarted.resolve();
        await releaseShutdown.promise;
      },
    }),
  });
  await runtime.ensureStarted();

  const firstShutdown = runtime.shutdown();
  assert.equal(daemon.statusListenerCount, 0, "shutdown synchronously removes the internal status observer");
  await shutdownStarted.promise;
  daemon.emitStatus({ state: "disconnected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: false });
  const secondShutdown = runtime.shutdown();

  assert.equal(secondShutdown, firstShutdown);
  releaseShutdown.resolve();
  await Promise.all([firstShutdown, secondShutdown]);
  assert.equal(runtime.shutdown(), firstShutdown, "completed shutdown remains idempotent");
  assert.equal(coordinatorShutdownCalls, 1);
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
        async enable() {
          return availabilitySnapshot();
        },
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

test("shutdown racing availability publication revokes the composed coordinator before daemon stop", async () => {
  const enableStarted = deferred();
  const releaseEnable = deferred();
  const events = [];
  const daemon = fakeDaemon(authority("connection-enable-race", 1), {
    onStop: () => events.push("daemon.stop"),
  });
  const coordinator = fakeCoordinator(() => events.push("coordinator.shutdown"), {
    enable: async () => {
      events.push("coordinator.enable.begin");
      enableStarted.resolve();
      await releaseEnable.promise;
      events.push("coordinator.enable.end");
      return availabilitySnapshot();
    },
  });
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => coordinator,
  });

  const starting = runtime.ensureStarted();
  await enableStarted.promise;
  const stopping = runtime.shutdown();
  releaseEnable.resolve();

  await assert.rejects(starting, (error) => error?.code === "shutdown_requested");
  await stopping;
  assert.equal(coordinator.enableCalls, 1);
  assert.equal(coordinator.shutdownCalls, 1);
  assert.deepEqual(events, [
    "coordinator.enable.begin",
    "coordinator.enable.end",
    "coordinator.shutdown",
    "daemon.stop",
  ]);
});

test("shutdown fences an in-flight restart before it can compose replacement authority", async () => {
  const restartStarted = deferred();
  const releaseRestart = deferred();
  const events = [];
  let factoryCalls = 0;
  const daemon = fakeDaemon(authority("connection-a", 1), {
    restart: async () => {
      events.push("daemon.restart.begin");
      restartStarted.resolve();
      await releaseRestart.promise;
      daemon.cuaDriverAuthorityTuple = authority("connection-b", 2);
      events.push("daemon.restart.end");
      return daemon.status;
    },
    onStop: () => events.push("daemon.stop"),
  });
  const runtime = createRuntime(daemon, {
    coordinatorFactory: () => {
      factoryCalls += 1;
      return fakeCoordinator(() => events.push("coordinator.shutdown"));
    },
  });
  await runtime.ensureStarted();

  const restarting = runtime.restart();
  await restartStarted.promise;
  const rejectedRestart = assert.rejects(
    restarting,
    (error) => error?.code === "shutdown_requested",
  );
  const shuttingDown = runtime.shutdown();
  releaseRestart.resolve();

  await rejectedRestart;
  await shuttingDown;
  assert.deepEqual(events, [
    "coordinator.shutdown",
    "daemon.restart.begin",
    "daemon.restart.end",
    "daemon.stop",
  ]);
  assert.equal(factoryCalls, 1, "shutdown must prevent replacement coordinator construction");
  assert.equal(daemon.restartCalls, 1);
  assert.equal(daemon.stopCalls, 1);
  assert.equal(runtime.cuaDriverCoordinator, undefined);
});

test("locked-task continuation loads once and syncs the persisted preference after daemon startup", async () => {
  const daemon = fakeDaemon(authority("connection-task-continuation-load", 1));
  const published = [];
  let loadCalls = 0;
  const runtime = createRuntime(daemon, {
    lockedTaskContinuationPreferenceStore: {
      async load() {
        loadCalls += 1;
        return { schemaVersion: 1, continueWhileLocked: false };
      },
      async save() {},
    },
    lockedTaskContinuationClient: recordingLockedTaskContinuationClient(published),
  });

  assert.deepEqual(await runtime.getLockedTaskContinuationPreferences(), {
    continueWhileLocked: false,
  });
  await runtime.ensureStarted();
  assert.equal(loadCalls, 1);
  assert.deepEqual(published, [{
    workspaceCwd,
    desktopInstanceId: runtime.desktopInstanceId,
    leaseTtlMs: 15_000,
    continueWhileLocked: false,
    locked: false,
  }]);
  await runtime.shutdown();
});

test("locked-task continuation publishes the probed locked state on first startup sync", async () => {
  const daemon = fakeDaemon(authority("connection-task-continuation-initial-lock", 1));
  const published = [];
  const runtime = createRuntime(daemon, {
    readSystemSessionLocked: async () => true,
    lockedTaskContinuationPreferenceStore: {
      async load() {
        return { schemaVersion: 1, continueWhileLocked: false };
      },
      async save() {},
    },
    lockedTaskContinuationClient: recordingLockedTaskContinuationClient(published),
  });

  await runtime.ensureStarted();
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    workspaceCwd,
    desktopInstanceId: runtime.desktopInstanceId,
    leaseTtlMs: 15_000,
    continueWhileLocked: false,
    locked: true,
  });
  await runtime.shutdown();
});

test("locked-task continuation fails closed when the initial session state is unknown", async () => {
  const daemon = fakeDaemon(authority("connection-task-continuation-unknown-lock", 1));
  const published = [];
  const diagnostics = [];
  const runtime = createRuntime(daemon, {
    readSystemSessionLocked: async () => undefined,
    onDiagnostic: (event, details) => diagnostics.push({ event, details }),
    lockedTaskContinuationPreferenceStore: {
      async load() {
        return { schemaVersion: 1, continueWhileLocked: false };
      },
      async save() {},
    },
    lockedTaskContinuationClient: recordingLockedTaskContinuationClient(published),
  });

  await runtime.ensureStarted();
  assert.equal(published[0].locked, true);
  assert.deepEqual(diagnostics.find((diagnostic) =>
    diagnostic.event === "desktop_runtime.locked_task_initial_state_unknown"), {
    event: "desktop_runtime.locked_task_initial_state_unknown",
    details: { platform: "darwin", failClosed: true },
  });
  await runtime.shutdown();
});

test("locked-task continuation remains blocked until lock and suspend boundaries both clear", async () => {
  const daemon = fakeDaemon(authority("connection-task-continuation-boundaries", 1));
  const published = [];
  const saved = [];
  const runtime = createRuntime(daemon, {
    lockedTaskContinuationPreferenceStore: {
      async load() {
        return { schemaVersion: 1, continueWhileLocked: true };
      },
      async save(preference) {
        saved.push(preference);
      },
    },
    lockedTaskContinuationClient: recordingLockedTaskContinuationClient(published),
  });

  assert.deepEqual(await runtime.setContinueTasksWhileLocked(false), { accepted: true });
  await runtime.suspendComputerControlForSystem("system_lock");
  await runtime.suspendComputerControlForSystem("system_suspend");
  await runtime.resumeComputerControlForSystem("unlock");
  assert.equal(published.at(-1).locked, true);
  await runtime.resumeComputerControlForSystem("resume");
  assert.deepEqual(published.at(-1), {
    workspaceCwd,
    desktopInstanceId: runtime.desktopInstanceId,
    leaseTtlMs: 15_000,
    continueWhileLocked: false,
    locked: false,
  });
  assert.deepEqual(saved, [{ schemaVersion: 1, continueWhileLocked: false }]);
  await runtime.shutdown();
});

test("enabling continuation while locked releases task work without resuming Computer Control", async () => {
  const daemon = fakeDaemon(authority("connection-task-continuation-toggle", 1));
  const published = [];
  const runtime = createRuntime(daemon, {
    lockedTaskContinuationPreferenceStore: {
      async load() {
        return { schemaVersion: 1, continueWhileLocked: false };
      },
      async save() {},
    },
    lockedTaskContinuationClient: recordingLockedTaskContinuationClient(published),
  });

  await runtime.suspendComputerControlForSystem("system_lock");
  assert.deepEqual(await runtime.setContinueTasksWhileLocked(true), { accepted: true });
  assert.deepEqual(published.at(-1), {
    workspaceCwd,
    desktopInstanceId: runtime.desktopInstanceId,
    leaseTtlMs: 15_000,
    continueWhileLocked: true,
    locked: true,
  });
  await runtime.shutdown();
});

test("a failed daemon sync restores the previously persisted continuation preference", async () => {
  const daemon = fakeDaemon(authority("connection-task-continuation-rollback", 1));
  const saved = [];
  const published = [];
  const runtime = createRuntime(daemon, {
    lockedTaskContinuationPreferenceStore: {
      async load() {
        return { schemaVersion: 1, continueWhileLocked: true };
      },
      async save(preference) {
        saved.push(preference);
      },
    },
    lockedTaskContinuationClient: {
      async publish(input) {
        published.push(input);
        if (!input.continueWhileLocked) throw new Error("daemon unavailable");
        return {
          revision: published.length,
          ...input,
          blocked: input.locked && !input.continueWhileLocked,
        };
      },
    },
  });

  assert.deepEqual(await runtime.setContinueTasksWhileLocked(false), {
    accepted: false,
    reason: "locked_task_continuation_sync_failed",
  });
  assert.deepEqual(await runtime.getLockedTaskContinuationPreferences(), {
    continueWhileLocked: true,
  });
  assert.deepEqual(saved, [
    { schemaVersion: 1, continueWhileLocked: false },
    { schemaVersion: 1, continueWhileLocked: true },
  ]);
  assert.deepEqual(published.map((input) => input.continueWhileLocked), [false, true]);
  await runtime.shutdown();
});

test("a failed durable rollback keeps the newly persisted continuation preference as truth", async () => {
  const daemon = fakeDaemon(authority("connection-task-continuation-rollback-failure", 1));
  const saved = [];
  let saveCalls = 0;
  const runtime = createRuntime(daemon, {
    lockedTaskContinuationPreferenceStore: {
      async load() {
        return { schemaVersion: 1, continueWhileLocked: true };
      },
      async save(preference) {
        saveCalls += 1;
        saved.push(preference);
        if (saveCalls === 2) throw new Error("rollback disk failure");
      },
    },
    lockedTaskContinuationClient: {
      async publish(input) {
        if (!input.continueWhileLocked) throw new Error("daemon unavailable");
        return {
          revision: 1,
          ...input,
          blocked: input.locked && !input.continueWhileLocked,
        };
      },
    },
  });

  assert.deepEqual(await runtime.setContinueTasksWhileLocked(false), {
    accepted: false,
    reason: "locked_task_continuation_rollback_failed",
  });
  assert.deepEqual(await runtime.getLockedTaskContinuationPreferences(), {
    continueWhileLocked: false,
  });
  assert.deepEqual(saved, [
    { schemaVersion: 1, continueWhileLocked: false },
    { schemaVersion: 1, continueWhileLocked: true },
  ]);
  await runtime.shutdown();
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
    readSystemSessionLocked: async () => false,
    lockedTaskContinuationClient: {
      async publish(input) {
        return {
          revision: 0,
          continueWhileLocked: input.continueWhileLocked,
          locked: input.locked,
          blocked: input.locked && !input.continueWhileLocked,
        };
      },
    },
    ...overrides,
  });
}

function recordingLockedTaskContinuationClient(published) {
  return {
    async publish(input) {
      published.push(input);
      return {
        revision: published.length,
        continueWhileLocked: input.continueWhileLocked,
        locked: input.locked,
        blocked: input.locked && !input.continueWhileLocked,
      };
    },
  };
}

function fakeDaemon(initialAuthority, options = {}) {
  const statusListeners = new Set();
  return {
    status: { state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true },
    cuaDriverAuthorityTuple: initialAuthority,
    ensureStartedCalls: 0,
    restartCalls: 0,
    stopCalls: 0,
    get statusListenerCount() {
      return statusListeners.size;
    },
    emitStatus(status) {
      this.status = status;
      for (const listener of statusListeners) {
        listener(status);
      }
    },
    async ensureStarted() {
      this.ensureStartedCalls += 1;
      return options.ensureStarted ? options.ensureStarted() : this.status;
    },
    async restart() {
      this.restartCalls += 1;
      if (options.restart) {
        return options.restart();
      }
      options.onRestart?.();
      return this.status;
    },
    async stopOwnedDaemon() {
      this.stopCalls += 1;
      options.onStop?.();
    },
    onStatusChanged(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}

function fakeCoordinator(onShutdown, options = {}) {
  return {
    enableCalls: 0,
    restartCalls: 0,
    restartReasons: [],
    shutdownCalls: 0,
    async enable() {
      this.enableCalls += 1;
      return options.enable ? options.enable() : availabilitySnapshot();
    },
    async restart(reason) {
      this.restartCalls += 1;
      this.restartReasons.push(reason);
      return availabilitySnapshot();
    },
    async shutdown() {
      this.shutdownCalls += 1;
      onShutdown?.();
    },
  };
}

function fakePowerMonitor() {
  const listeners = new Map();
  return {
    on(event, listener) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    off(event, listener) {
      const eventListeners = listeners.get(event);
      eventListeners?.delete(listener);
      if (eventListeners?.size === 0) listeners.delete(event);
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    observedEvents() {
      return [...listeners.keys()].sort();
    },
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function availabilitySnapshot() {
  return {
    lifecycle: "active",
    providerState: "desktop_unavailable",
    generation: 1,
  };
}

function authority(bridgeConnectionId, desktopInstanceEpoch) {
  return Object.freeze({
    daemonAuthorityEpoch: "authority-a",
    bridgeConnectionId,
    desktopInstanceEpoch,
    workspaceCwd,
    readinessDetailsV1: false,
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

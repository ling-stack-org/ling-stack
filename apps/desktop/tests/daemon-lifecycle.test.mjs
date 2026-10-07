import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DesktopDaemonLifecycle } from "../dist/main/daemon-lifecycle.js";

const existingEntryPath = fileURLToPath(import.meta.url);

test("Desktop daemon starts in the selected workspace and stops the owned child", async () => {
  const child = createFakeChild();
  const spawnInputs = [];
  let healthChecks = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17991",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-workspace",
    fetch: async () => {
      healthChecks += 1;
      return healthChecks === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : daemonHealth("/tmp/ling-desktop-workspace");
    },
    probePort: async () => "free",
    spawnDaemon: (input) => {
      spawnInputs.push(input);
      return child;
    },
  });

  const status = await lifecycle.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(status.ownedByDesktop, true);
  assert.equal(spawnInputs.length, 1);
  assert.equal(spawnInputs[0].cwd, canonicalWorkspace("/tmp/ling-desktop-workspace"));
  assert.equal(
    spawnInputs[0].env.LING_STACK_DEFAULT_WORKSPACE_CWD,
    canonicalWorkspace("/tmp/ling-desktop-workspace"),
  );
  assert.equal(spawnInputs[0].env.LING_STACK_RUNTIME_UNIFIED_EXEC, "1");
  assert.equal(spawnInputs[0].env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawnInputs[0].env.LING_STACK_PACKAGED_DESKTOP, undefined);

  const repeatedStatus = await lifecycle.ensureStarted();
  assert.equal(repeatedStatus.ownedByDesktop, true, "re-probing an owned child must not erase ownership");
  assert.equal(healthChecks, 2, "an already connected owned child must not be probed again");

  await lifecycle.stopOwnedDaemon();

  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(lifecycle.status.state, "disconnected");
});

test("packaged Desktop marks only its fixed child bootstrap as packaged", async () => {
  const child = createFakeChild();
  const inputs = [];
  let healthChecks = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17995",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-packaged-workspace",
    packaged: true,
    fetch: async () => ++healthChecks === 1
      ? Promise.reject(new TypeError("fetch failed"))
      : daemonHealth("/tmp/ling-desktop-packaged-workspace"),
    probePort: async () => "free",
    spawnDaemon: input => { inputs.push(input); return child; },
  });
  await lifecycle.ensureStarted();
  assert.equal(inputs[0].env.LING_STACK_PACKAGED_DESKTOP, "1");
  await lifecycle.stopOwnedDaemon();
});

test("unexpected owned child exit emits one recovery signal while intentional stop stays silent", async () => {
  const child = createFakeChild({ exitOnTerm: false });
  const exits = [];
  let healthChecks = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17993",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-unexpected-exit-workspace",
    fetch: async () => {
      healthChecks += 1;
      return healthChecks === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : daemonHealth("/tmp/ling-desktop-unexpected-exit-workspace");
    },
    probePort: async () => "free",
    spawnDaemon: () => child,
    onUnexpectedExit: (details) => exits.push(details),
  });

  await lifecycle.ensureStarted();
  child.exitCode = 23;
  child.emit("exit", 23, null);
  child.emit("exit", 23, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(exits, [{
    baseUrl: "http://127.0.0.1:17993",
    code: 23,
    signal: null,
  }]);

  const intentionallyStoppedChild = createFakeChild();
  const intentionalExits = [];
  const intentionalLifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17994",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-intentional-stop-workspace",
    fetch: async () => daemonHealth("/tmp/ling-desktop-intentional-stop-workspace"),
    probePort: async () => "free",
    spawnDaemon: () => intentionallyStoppedChild,
    onUnexpectedExit: (details) => intentionalExits.push(details),
  });
  await intentionalLifecycle.ensureStarted();
  await intentionalLifecycle.stopOwnedDaemon();

  assert.deepEqual(intentionalExits, []);
});

test("Desktop daemon escalates to SIGKILL when startup cleanup cannot stop the child", async () => {
  const child = createFakeChild({ exitOnTerm: false });
  const diagnostics = [];
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17992",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-stuck-workspace",
    startupTimeoutMs: 0,
    shutdownTimeoutMs: 0,
    fetch: async () => Promise.reject(new TypeError("fetch failed")),
    probePort: async () => "free",
    spawnDaemon: () => child,
    onDiagnostic: (event) => diagnostics.push(event),
  });

  await assert.rejects(lifecycle.ensureStarted(), /daemon_start_timeout/);

  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.ok(diagnostics.includes("daemon.force_killed"));
});

test("missing daemon resources produce a typed recoverable startup failure", async () => {
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17990",
    daemonEntryPath: "/definitely/missing/ling-daemon.mjs",
    defaultWorkspaceCwd: "/tmp/ling-desktop-missing-resource-workspace",
    fetch: async () => Promise.reject(new TypeError("fetch failed")),
    probePort: async () => "free",
  });

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "resource_missing",
  );
  assert.equal(lifecycle.status.reason, "resource_missing");
});

test("a synchronous daemon spawn failure is mapped to the startup recovery contract", async () => {
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17989",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-sync-spawn-workspace",
    fetch: async () => Promise.reject(new TypeError("fetch failed")),
    probePort: async () => "free",
    spawnDaemon: () => {
      throw new Error("spawn EACCES private executable");
    },
  });

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "spawn_failed",
  );
  assert.equal(lifecycle.status.reason, "spawn_failed");
  assert.doesNotMatch(lifecycle.status.message, /EACCES/u);
});

test("an asynchronous child-process error aborts daemon startup immediately", async () => {
  const child = createFakeChild({ exitOnTerm: false });
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17988",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-async-spawn-workspace",
    startupTimeoutMs: 1_000,
    fetch: async () => Promise.reject(new TypeError("fetch failed")),
    probePort: async () => "free",
    spawnDaemon: () => {
      queueMicrotask(() => child.emit("error", new Error("spawn ENOENT private executable")));
      return child;
    },
  });
  const startedAt = performance.now();

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "spawn_failed",
  );
  assert.ok(performance.now() - startedAt < 250, "spawn error must beat the startup deadline");
  assert.equal(lifecycle.status.reason, "spawn_failed");
});

test("Desktop reuses a healthy daemon only after the authenticated preview handshake", async () => {
  const requests = [];
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17993",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-compatible-workspace",
    desktopBridgeToken: "bridge-token",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ pathname: url.pathname, headers: init?.headers });
      if (url.pathname === "/health") {
        return daemonHealth("/tmp/ling-desktop-compatible-workspace");
      }
      assert.equal(url.pathname, "/computer-use/desktop-bridge/handshake");
      assert.equal(new Headers(init?.headers).get("X-Ling-Desktop-Bridge-Token"), "bridge-token");
      return Response.json({
        protocolVersion: 1,
        capabilities: ["preview-source"],
        bridgeTokenAccepted: true,
        routeTokenAccepted: true,
        defaultWorkspaceCwd: canonicalWorkspace("/tmp/ling-desktop-compatible-workspace"),
      });
    },
    spawnDaemon: () => {
      throw new Error("compatible daemon must be reused");
    },
  });

  const status = await lifecycle.ensureStarted();
  const reopenedStatus = await lifecycle.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(status.ownedByDesktop, false);
  assert.deepEqual(reopenedStatus, status);
  assert.equal(lifecycle.cuaDriverAuthorityTuple, undefined);
  assert.deepEqual(requests.map((request) => request.pathname), [
    "/health",
    "/computer-use/desktop-bridge/handshake",
  ]);
});

test("bundled gate accepts the typed handshake guard and freezes its authority tuple", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-typed-handshake-workspace";
  let handshakeCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18010",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        return daemonHealth(defaultWorkspaceCwd);
      }
      handshakeCount += 1;
      return Response.json(typedHandshake(defaultWorkspaceCwd, {
        daemonAuthorityEpoch: "authority-a",
        bridgeConnectionId: "connection-a",
        desktopInstanceEpoch: 7,
      }));
    },
  });

  await lifecycle.ensureStarted();
  const authority = lifecycle.cuaDriverAuthorityTuple;

  assert.deepEqual(authority, {
    daemonAuthorityEpoch: "authority-a",
    bridgeConnectionId: "connection-a",
    desktopInstanceEpoch: 7,
    workspaceCwd: canonicalWorkspace(defaultWorkspaceCwd),
    readinessDetailsV1: true,
  });
  assert.equal(Object.isFrozen(authority), true);
  await lifecycle.ensureStarted();
  assert.equal(handshakeCount, 1, "window reopen must not fence its own daemon lease with another handshake");
});

test("closed bundled gate accepts a typed preview handshake without caching provider authority", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-typed-handshake-gate-off-workspace";
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18015",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "bridge-token",
    platform: "darwin",
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/health"
        ? daemonHealth(defaultWorkspaceCwd)
        : Response.json(typedHandshake(defaultWorkspaceCwd, {
            daemonAuthorityEpoch: "authority-gate-off",
            bridgeConnectionId: "connection-gate-off",
            desktopInstanceEpoch: 1,
          }));
    },
    spawnDaemon: () => {
      throw new Error("a compatible gate-off daemon must be reused");
    },
  });

  const status = await lifecycle.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(status.ownedByDesktop, false);
  assert.equal(lifecycle.cuaDriverAuthorityTuple, undefined);
});

test("bundled gate rejects a legacy preview-only handshake without issuing authority", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-legacy-gate-on-workspace";
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18011",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/health"
        ? daemonHealth(defaultWorkspaceCwd)
        : Response.json({
            protocolVersion: 1,
            capabilities: ["preview-source"],
            bridgeTokenAccepted: true,
            routeTokenAccepted: true,
            defaultWorkspaceCwd: canonicalWorkspace(defaultWorkspaceCwd),
          });
    },
  });

  await assert.rejects(lifecycle.ensureStarted(), /daemon_desktop_bridge_incompatible/);
  assert.equal(lifecycle.cuaDriverAuthorityTuple, undefined);
});

test("bundled gate rejects a healthy daemon when Desktop bridge authority is absent", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-missing-bridge-token-workspace";
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18016",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async () => daemonHealth(defaultWorkspaceCwd),
    spawnDaemon: () => {
      spawnCount += 1;
      return createFakeChild();
    },
  });

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "bridge_incompatible" && error?.occupant === "ling_daemon",
  );

  assert.equal(spawnCount, 0);
  assert.equal(lifecycle.cuaDriverAuthorityTuple, undefined);
});

test("explicit restart rotates a reused daemon authority tuple and stop clears it", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-restart-authority-workspace";
  let handshakeCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18012",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        return daemonHealth(defaultWorkspaceCwd);
      }
      handshakeCount += 1;
      return Response.json(typedHandshake(defaultWorkspaceCwd, {
        daemonAuthorityEpoch: "authority-a",
        bridgeConnectionId: `connection-${handshakeCount}`,
        desktopInstanceEpoch: handshakeCount,
      }));
    },
  });

  await lifecycle.ensureStarted();
  const first = lifecycle.cuaDriverAuthorityTuple;
  await lifecycle.restart();
  const second = lifecycle.cuaDriverAuthorityTuple;

  assert.equal(handshakeCount, 2);
  assert.notDeepEqual(second, first);
  assert.equal(second?.desktopInstanceEpoch, 2);
  await lifecycle.stopOwnedDaemon();
  assert.equal(lifecycle.cuaDriverAuthorityTuple, undefined);
});

test("owned daemon exit clears authority and reconnect issues a fresh tuple", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-owned-reconnect-workspace";
  const children = [createFakeChild({ exitOnTerm: false }), createFakeChild()];
  let daemonAvailable = false;
  let spawnCount = 0;
  let handshakeCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18014",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        if (!daemonAvailable) {
          throw new TypeError("daemon unavailable");
        }
        return daemonHealth(defaultWorkspaceCwd);
      }
      handshakeCount += 1;
      return Response.json(typedHandshake(defaultWorkspaceCwd, {
        daemonAuthorityEpoch: `authority-${spawnCount}`,
        bridgeConnectionId: `connection-${handshakeCount}`,
        desktopInstanceEpoch: 1,
      }));
    },
    probePort: async () => "free",
    spawnDaemon: () => {
      const child = children[spawnCount++];
      daemonAvailable = true;
      return child;
    },
  });

  await lifecycle.ensureStarted();
  const first = lifecycle.cuaDriverAuthorityTuple;
  daemonAvailable = false;
  children[0].exitCode = 17;
  children[0].emit("exit", 17, null);
  assert.equal(lifecycle.cuaDriverAuthorityTuple, undefined);

  await lifecycle.ensureStarted();
  const second = lifecycle.cuaDriverAuthorityTuple;

  assert.equal(spawnCount, 2);
  assert.equal(handshakeCount, 2);
  assert.notDeepEqual(second, first);
  await lifecycle.stopOwnedDaemon();
});

test("Desktop refuses to reuse the same bridge token for a different workspace", async () => {
  let handshakeCount = 0;
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17999",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-authoritative-workspace",
    desktopBridgeToken: "shared-bridge-token",
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        return daemonHealth("/tmp/ling-desktop-other-workspace");
      }
      handshakeCount += 1;
      return Response.json({});
    },
    spawnDaemon: () => {
      spawnCount += 1;
      return createFakeChild();
    },
  });

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "bridge_incompatible" && error?.occupant === "ling_daemon",
  );

  assert.equal(handshakeCount, 0, "workspace mismatch must fail before the authenticated handshake");
  assert.equal(spawnCount, 0);
});

test("Desktop requires the handshake to authorize its secret for scoped Computer Use routes", async () => {
  let spawnCount = 0;
  const defaultWorkspaceCwd = "/tmp/ling-desktop-route-authority-workspace";
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18000",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "shared-bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        return daemonHealth(defaultWorkspaceCwd);
      }
      return Response.json({
        ...typedHandshake(defaultWorkspaceCwd, {
          daemonAuthorityEpoch: "authority-route-rejected",
          bridgeConnectionId: "connection-route-rejected",
          desktopInstanceEpoch: 1,
        }),
        routeTokenAccepted: false,
      });
    },
    spawnDaemon: () => {
      spawnCount += 1;
      return createFakeChild();
    },
  });

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "bridge_incompatible" && error?.occupant === "ling_daemon",
  );

  assert.equal(spawnCount, 0);
});

test("Desktop requires health and handshake to report the same canonical workspace", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-handshake-workspace";
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18001",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "shared-bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        return daemonHealth(defaultWorkspaceCwd);
      }
      return Response.json({
        ...typedHandshake(defaultWorkspaceCwd, {
          daemonAuthorityEpoch: "authority-workspace-mismatch",
          bridgeConnectionId: "connection-workspace-mismatch",
          desktopInstanceEpoch: 1,
        }),
        defaultWorkspaceCwd: canonicalWorkspace("/tmp/ling-desktop-other-handshake-workspace"),
      });
    },
    spawnDaemon: () => {
      throw new Error("mismatched daemon must not be reused or replaced");
    },
  });

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "bridge_incompatible" && error?.occupant === "ling_daemon",
  );
});

test("Desktop fails closed when a healthy daemon rejects the bridge token", async () => {
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17994",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-incompatible-workspace",
    desktopBridgeToken: "bridge-token",
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/health"
        ? daemonHealth("/tmp/ling-desktop-incompatible-workspace")
        : new Response(null, { status: 403 });
    },
    spawnDaemon: () => {
      spawnCount += 1;
      return createFakeChild();
    },
  });

  await assert.rejects(lifecycle.ensureStarted(), /daemon_desktop_bridge_incompatible/);

  assert.equal(spawnCount, 0);
  assert.equal(lifecycle.status.state, "disconnected");
  assert.equal(lifecycle.status.reason, "bridge_incompatible");
});

test("concurrent ensureStarted calls share one startup and spawn one daemon", async () => {
  const child = createFakeChild();
  let spawnCount = 0;
  let healthChecks = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17996",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-single-flight-workspace",
    fetch: async () => {
      healthChecks += 1;
      return healthChecks === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : daemonHealth("/tmp/ling-desktop-single-flight-workspace");
    },
    probePort: async () => "free",
    spawnDaemon: () => {
      spawnCount += 1;
      return child;
    },
  });

  const [first, second] = await Promise.all([lifecycle.ensureStarted(), lifecycle.ensureStarted()]);

  assert.equal(spawnCount, 1);
  assert.equal(first.ownedByDesktop, true);
  assert.deepEqual(second, first);
  await lifecycle.stopOwnedDaemon();
});

test("stopping during an in-flight port probe cancels startup before spawning", async () => {
  const probeStarted = deferred();
  const allowProbe = deferred();
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18002",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-cancelled-startup-workspace",
    fetch: async () => Promise.reject(new TypeError("fetch failed")),
    probePort: async () => {
      probeStarted.resolve();
      await allowProbe.promise;
      return "free";
    },
    spawnDaemon: () => {
      spawnCount += 1;
      return createFakeChild();
    },
  });

  const startup = lifecycle.ensureStarted();
  await probeStarted.promise;
  const rejectedStartup = assert.rejects(startup, /daemon_start_cancelled/);

  await lifecycle.stopOwnedDaemon();
  allowProbe.resolve();
  await rejectedStartup;

  assert.equal(spawnCount, 0, "shutdown must invalidate startup before it can spawn an owned daemon");
  assert.equal(lifecycle.status.state, "disconnected");
  assert.equal(lifecycle.status.ownedByDesktop, false);
});

test("stopping during an in-flight typed handshake cannot restore a stale authority tuple", async () => {
  const handshakeStarted = deferred();
  const allowHandshake = deferred();
  const defaultWorkspaceCwd = "/tmp/ling-desktop-cancelled-handshake-workspace";
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18013",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        return daemonHealth(defaultWorkspaceCwd);
      }
      handshakeStarted.resolve();
      await allowHandshake.promise;
      return Response.json(typedHandshake(defaultWorkspaceCwd, {
        daemonAuthorityEpoch: "authority-stale",
        bridgeConnectionId: "connection-stale",
        desktopInstanceEpoch: 1,
      }));
    },
  });

  const starting = lifecycle.ensureStarted();
  await handshakeStarted.promise;
  const stopping = lifecycle.stopOwnedDaemon();
  allowHandshake.resolve();

  await assert.rejects(starting, /daemon_start_cancelled/);
  await stopping;
  assert.equal(lifecycle.cuaDriverAuthorityTuple, undefined);
});

test("restart authority wins when an older in-flight ensure handshake resolves last", async () => {
  const handshakeStarted = [deferred(), deferred()];
  const releaseHandshake = [deferred(), deferred()];
  const defaultWorkspaceCwd = "/tmp/ling-desktop-handshake-restart-order-workspace";
  let handshakeCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18017",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    desktopBridgeToken: "bridge-token",
    platform: "darwin",
    cuaDriverFeatureFlags: bundledDarwinFeatureFlags(),
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        return daemonHealth(defaultWorkspaceCwd);
      }
      const handshakeIndex = handshakeCount++;
      handshakeStarted[handshakeIndex].resolve();
      await releaseHandshake[handshakeIndex].promise;
      return Response.json(typedHandshake(defaultWorkspaceCwd, {
        daemonAuthorityEpoch: "authority-a",
        bridgeConnectionId: `connection-${handshakeIndex + 1}`,
        desktopInstanceEpoch: handshakeIndex + 1,
      }));
    },
  });

  const ensuring = lifecycle.ensureStarted();
  await handshakeStarted[0].promise;
  const restarting = lifecycle.restart();
  await handshakeStarted[1].promise;

  releaseHandshake[1].resolve();
  await restarting;
  assert.equal(lifecycle.cuaDriverAuthorityTuple?.bridgeConnectionId, "connection-2");

  releaseHandshake[0].resolve();
  await ensuring;
  assert.deepEqual(lifecycle.cuaDriverAuthorityTuple, {
    daemonAuthorityEpoch: "authority-a",
    bridgeConnectionId: "connection-2",
    desktopInstanceEpoch: 2,
    workspaceCwd: canonicalWorkspace(defaultWorkspaceCwd),
    readinessDetailsV1: true,
  });
  assert.equal(handshakeCount, 2);
  await lifecycle.stopOwnedDaemon();
});

test("an older stop cannot overwrite a newer owned daemon connection", async () => {
  const oldChild = createFakeChild({ exitOnTerm: false });
  const newChild = createFakeChild();
  const children = [oldChild, newChild];
  const defaultWorkspaceCwd = "/tmp/ling-desktop-stop-restart-race-workspace";
  let healthChecks = 0;
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18003",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    shutdownTimeoutMs: 1_000,
    fetch: async () => {
      healthChecks += 1;
      return healthChecks % 2 === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : daemonHealth(defaultWorkspaceCwd);
    },
    probePort: async () => "free",
    spawnDaemon: () => children[spawnCount++],
  });

  await lifecycle.ensureStarted();
  const stoppingOldChild = lifecycle.stopOwnedDaemon();
  assert.deepEqual(oldChild.killSignals, ["SIGTERM"]);

  const restarting = lifecycle.ensureStarted();
  oldChild.signalCode = "SIGTERM";
  oldChild.emit("exit", null, "SIGTERM");
  const restarted = await restarting;
  assert.equal(restarted.state, "connected");
  assert.equal(restarted.ownedByDesktop, true);
  assert.equal(spawnCount, 2);

  await stoppingOldChild;

  assert.equal(lifecycle.status.state, "connected");
  assert.equal(lifecycle.status.ownedByDesktop, true);
  assert.deepEqual(newChild.killSignals, []);
  await lifecycle.stopOwnedDaemon();
});

test("ensureStarted waits for an in-flight stop before probing daemon health", async () => {
  const oldChild = createFakeChild({ exitOnTerm: false });
  const newChild = createFakeChild();
  const children = [oldChild, newChild];
  const defaultWorkspaceCwd = "/tmp/ling-desktop-stop-health-race-workspace";
  let oldChildAlive = true;
  let newChildSpawned = false;
  let healthChecks = 0;
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18004",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    shutdownTimeoutMs: 50,
    fetch: async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        throw new TypeError("fetch failed");
      }
      if (healthChecks === 2 || oldChildAlive || newChildSpawned) {
        return daemonHealth(defaultWorkspaceCwd);
      }
      throw new TypeError("fetch failed");
    },
    probePort: async () => "free",
    spawnDaemon: () => {
      const child = children[spawnCount++];
      newChildSpawned = spawnCount === 2;
      return child;
    },
  });

  await lifecycle.ensureStarted();
  const stoppingOldChild = lifecycle.stopOwnedDaemon();
  assert.deepEqual(oldChild.killSignals, ["SIGTERM"]);

  let restartSettled = false;
  const restarting = lifecycle.ensureStarted();
  restarting.then(
    () => { restartSettled = true; },
    () => { restartSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(healthChecks, 2, "startup must not probe while the old daemon is still stopping");
  assert.equal(restartSettled, false);

  oldChildAlive = false;
  oldChild.signalCode = "SIGTERM";
  oldChild.emit("exit", null, "SIGTERM");
  const restarted = await restarting;
  await stoppingOldChild;

  assert.equal(restarted.state, "connected");
  assert.equal(restarted.ownedByDesktop, true);
  assert.equal(spawnCount, 2);
  assert.equal(lifecycle.status.state, "connected");
  await lifecycle.stopOwnedDaemon();
});

test("concurrent stopOwnedDaemon calls share the same child termination", async () => {
  const child = createFakeChild({ exitOnTerm: false });
  const defaultWorkspaceCwd = "/tmp/ling-desktop-stop-single-flight-workspace";
  let healthChecks = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18005",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    shutdownTimeoutMs: 50,
    fetch: async () => {
      healthChecks += 1;
      return healthChecks === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : daemonHealth(defaultWorkspaceCwd);
    },
    probePort: async () => "free",
    spawnDaemon: () => child,
  });

  await lifecycle.ensureStarted();
  const firstStop = lifecycle.stopOwnedDaemon();
  let secondStopSettled = false;
  const secondStop = lifecycle.stopOwnedDaemon();
  secondStop.then(
    () => { secondStopSettled = true; },
    () => { secondStopSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(secondStopSettled, false, "all stop callers must await the same child exit barrier");

  child.signalCode = "SIGTERM";
  child.emit("exit", null, "SIGTERM");
  await Promise.all([firstStop, secondStop]);
  assert.equal(lifecycle.status.state, "disconnected");
});

test("restart waits for an in-flight owned stop before probing daemon health", async () => {
  const oldChild = createFakeChild({ exitOnTerm: false });
  const newChild = createFakeChild();
  const children = [oldChild, newChild];
  const defaultWorkspaceCwd = "/tmp/ling-desktop-restart-stop-barrier-workspace";
  let oldChildAlive = true;
  let newChildSpawned = false;
  let healthChecks = 0;
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18006",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    shutdownTimeoutMs: 50,
    fetch: async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        throw new TypeError("fetch failed");
      }
      if (oldChildAlive || newChildSpawned) {
        return daemonHealth(defaultWorkspaceCwd);
      }
      throw new TypeError("fetch failed");
    },
    probePort: async () => "free",
    spawnDaemon: () => {
      const child = children[spawnCount++];
      newChildSpawned = spawnCount === 2;
      return child;
    },
  });

  await lifecycle.ensureStarted();
  const stoppingOldChild = lifecycle.stopOwnedDaemon();
  assert.deepEqual(oldChild.killSignals, ["SIGTERM"]);

  let restartSettled = false;
  const restarting = lifecycle.restart();
  restarting.then(
    () => { restartSettled = true; },
    () => { restartSettled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(healthChecks, 2, "restart must not probe the still-live child after stop detached it");
  assert.equal(restartSettled, false);

  oldChildAlive = false;
  oldChild.signalCode = "SIGTERM";
  oldChild.emit("exit", null, "SIGTERM");
  const restarted = await restarting;
  await stoppingOldChild;

  assert.equal(restarted.state, "connected");
  assert.equal(restarted.ownedByDesktop, true);
  assert.equal(spawnCount, 2);
  await lifecycle.stopOwnedDaemon();
});

test("concurrent restart calls share one stop and one replacement startup", async () => {
  const oldChild = createFakeChild({ exitOnTerm: false });
  const newChild = createFakeChild();
  const children = [oldChild, newChild];
  const defaultWorkspaceCwd = "/tmp/ling-desktop-restart-single-flight-workspace";
  let oldChildAlive = true;
  let newChildSpawned = false;
  let healthChecks = 0;
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18007",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    shutdownTimeoutMs: 50,
    fetch: async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        throw new TypeError("fetch failed");
      }
      if (oldChildAlive || newChildSpawned) {
        return daemonHealth(defaultWorkspaceCwd);
      }
      throw new TypeError("fetch failed");
    },
    probePort: async () => "free",
    spawnDaemon: () => {
      const child = children[spawnCount++];
      newChildSpawned = spawnCount === 2;
      return child;
    },
  });

  await lifecycle.ensureStarted();
  const firstRestart = lifecycle.restart();
  const secondRestart = lifecycle.restart();
  const sharedRestart = firstRestart === secondRestart;
  await new Promise((resolve) => setImmediate(resolve));

  oldChildAlive = false;
  oldChild.signalCode = "SIGTERM";
  oldChild.emit("exit", null, "SIGTERM");
  const [firstStatus, secondStatus] = await Promise.all([firstRestart, secondRestart]);

  assert.equal(sharedRestart, true, "restart callers must receive the same in-flight operation");
  assert.equal(firstStatus.ownedByDesktop, true);
  assert.deepEqual(secondStatus, firstStatus);
  assert.equal(spawnCount, 2, "concurrent restarts must spawn exactly one replacement daemon");
  assert.deepEqual(oldChild.killSignals, ["SIGTERM"]);
  await lifecycle.stopOwnedDaemon();
});

test("restart leaves a compatible external daemon running", async () => {
  const defaultWorkspaceCwd = "/tmp/ling-desktop-external-restart-workspace";
  let healthChecks = 0;
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:18008",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd,
    fetch: async () => {
      healthChecks += 1;
      return daemonHealth(defaultWorkspaceCwd);
    },
    spawnDaemon: () => {
      spawnCount += 1;
      return createFakeChild();
    },
  });

  const status = await lifecycle.restart();

  assert.equal(status.state, "connected");
  assert.equal(status.ownedByDesktop, false);
  assert.match(status.message, /not owned by Desktop/i);
  assert.equal(healthChecks, 1);
  assert.equal(spawnCount, 0);
});

test("Desktop passes its bridge token to an owned daemon and verifies the same protocol", async () => {
  const child = createFakeChild();
  const spawnInputs = [];
  let firstHealthProbe = true;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17995",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-owned-bridge-workspace",
    desktopBridgeToken: "owned-bridge-token",
    fetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") {
        if (firstHealthProbe) {
          firstHealthProbe = false;
          throw new TypeError("fetch failed");
        }
        return daemonHealth("/tmp/ling-desktop-owned-bridge-workspace");
      }
      assert.equal(new Headers(init?.headers).get("X-Ling-Desktop-Bridge-Token"), "owned-bridge-token");
      return Response.json({
        protocolVersion: 1,
        capabilities: ["preview-source"],
        bridgeTokenAccepted: true,
        routeTokenAccepted: true,
        defaultWorkspaceCwd: canonicalWorkspace("/tmp/ling-desktop-owned-bridge-workspace"),
      });
    },
    probePort: async () => "free",
    spawnDaemon: (input) => {
      spawnInputs.push(input);
      return child;
    },
  });

  const status = await lifecycle.ensureStarted();

  assert.equal(status.ownedByDesktop, true);
  assert.equal(spawnInputs[0].env.LING_DESKTOP_BRIDGE_TOKEN, "owned-bridge-token");
  assert.equal(spawnInputs[0].env.LING_COMPUTER_USE_ROUTE_TOKEN, "owned-bridge-token");
  assert.equal(typeof spawnInputs[0].env.LING_MOBILE_ACCESS_MANAGEMENT_CAPABILITY, "string");
  assert.notEqual(
    spawnInputs[0].env.LING_MOBILE_ACCESS_MANAGEMENT_CAPABILITY,
    "owned-bridge-token",
  );
  await lifecycle.stopOwnedDaemon();
});

test("owned child may bind the port before health becomes ready", async () => {
  const child = createFakeChild();
  let healthChecks = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17998",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-bound-before-ready-workspace",
    fetch: async () => {
      healthChecks += 1;
      if (healthChecks === 1) {
        throw new TypeError("port is initially free");
      }
      return healthChecks === 2
        ? new Response(null, { status: 503 })
        : daemonHealth("/tmp/ling-desktop-bound-before-ready-workspace");
    },
    probePort: async () => "free",
    spawnDaemon: () => child,
  });

  const status = await lifecycle.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(status.ownedByDesktop, true);
  assert.equal(healthChecks, 3);
  assert.deepEqual(child.killSignals, []);
  await lifecycle.stopOwnedDaemon();
});

test("foreign service on the fixed daemon port is reported occupied without spawning", async (t) => {
  const foreignServer = createServer((socket) => {
    // The port probe intentionally disconnects as soon as TCP connect proves
    // occupancy. A foreign service must be allowed to observe that as a reset
    // without turning the test fixture into an uncaught server-side error.
    socket.on("error", () => undefined);
    socket.end("foreign-service\n");
  });
  await new Promise((resolve, reject) => {
    foreignServer.once("error", reject);
    foreignServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => foreignServer.close(resolve)));
  const address = foreignServer.address();
  assert.ok(address && typeof address !== "string");
  let spawnCount = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: `http://127.0.0.1:${address.port}`,
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-foreign-service-workspace",
    startupTimeoutMs: 0,
    fetch: async () => {
      throw new TypeError("foreign service is not an HTTP daemon");
    },
    spawnDaemon: () => {
      spawnCount += 1;
      return createFakeChild();
    },
  });

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "bridge_incompatible" && error?.occupant === "foreign_service",
  );

  assert.equal(spawnCount, 0);
  assert.equal(lifecycle.status.state, "disconnected");
  assert.equal(lifecycle.status.reason, "bridge_incompatible");
  assert.match(lifecycle.status.message, /foreign service/i);
});

test("owned child early exit aborts readiness probing immediately", async () => {
  const child = createFakeChild({ exitOnTerm: false });
  let healthChecks = 0;
  const lifecycle = new DesktopDaemonLifecycle({
    baseUrl: "http://127.0.0.1:17997",
    daemonEntryPath: existingEntryPath,
    defaultWorkspaceCwd: "/tmp/ling-desktop-early-exit-workspace",
    startupTimeoutMs: 1_000,
    fetch: async () => {
      healthChecks += 1;
      throw new TypeError("fetch failed");
    },
    probePort: async () => "free",
    spawnDaemon: () => {
      queueMicrotask(() => {
        child.exitCode = 17;
        child.emit("exit", 17, null);
      });
      return child;
    },
  });
  const startedAt = performance.now();

  await assert.rejects(
    lifecycle.ensureStarted(),
    (error) => error?.code === "child_exited",
  );

  assert.ok(performance.now() - startedAt < 250, "child exit must beat the one-second startup deadline");
  assert.ok(healthChecks <= 2, "readiness probing must stop after the owned child exits");
  assert.equal(lifecycle.status.reason, "child_exited");
});

function createFakeChild(options = {}) {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    pid: 42,
    exitCode: null,
    signalCode: null,
    killSignals: [],
    kill(signal = "SIGTERM") {
      this.killSignals.push(signal);
      if (signal === "SIGKILL" || options.exitOnTerm !== false) {
        this.signalCode = signal;
        queueMicrotask(() => this.emit("exit", null, signal));
      }
      return true;
    },
  });
  return child;
}

function daemonHealth(defaultWorkspaceCwd) {
  return Response.json({
    service: "ling-stack-daemon",
    defaultWorkspaceCwd: canonicalWorkspace(defaultWorkspaceCwd),
  });
}

function canonicalWorkspace(path) {
  return resolve(path);
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function bundledDarwinFeatureFlags() {
  return {
    bundledEmbedded: { darwin: true, win32: false },
    packagedProvider: { darwin: true, win32: false },
  };
}

function typedHandshake(defaultWorkspaceCwd, authority) {
  return {
    protocolVersion: 1,
    capabilities: ["preview-source", "cua-driver-lease-v1", "cua-driver-readiness-details-v1"],
    bridgeTokenAccepted: true,
    routeTokenAccepted: true,
    defaultWorkspaceCwd: canonicalWorkspace(defaultWorkspaceCwd),
    ...authority,
  };
}

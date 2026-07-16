import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
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
        : Response.json({ service: "ling-stack-daemon" });
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
  assert.equal(spawnInputs[0].cwd, "/tmp/ling-desktop-workspace");
  assert.equal(spawnInputs[0].env.LING_STACK_DEFAULT_WORKSPACE_CWD, "/tmp/ling-desktop-workspace");
  assert.equal(spawnInputs[0].env.ELECTRON_RUN_AS_NODE, "1");

  const repeatedStatus = await lifecycle.ensureStarted();
  assert.equal(repeatedStatus.ownedByDesktop, true, "re-probing an owned child must not erase ownership");
  assert.equal(healthChecks, 2, "an already connected owned child must not be probed again");

  await lifecycle.stopOwnedDaemon();

  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(lifecycle.status.state, "disconnected");
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
        return Response.json({ service: "ling-stack-daemon" });
      }
      assert.equal(url.pathname, "/computer-use/desktop-bridge/handshake");
      assert.equal(new Headers(init?.headers).get("X-Ling-Desktop-Bridge-Token"), "bridge-token");
      return Response.json({
        protocolVersion: 1,
        capabilities: ["preview-source"],
        bridgeTokenAccepted: true,
      });
    },
    spawnDaemon: () => {
      throw new Error("compatible daemon must be reused");
    },
  });

  const status = await lifecycle.ensureStarted();

  assert.equal(status.state, "connected");
  assert.equal(status.ownedByDesktop, false);
  assert.deepEqual(requests.map((request) => request.pathname), [
    "/health",
    "/computer-use/desktop-bridge/handshake",
  ]);
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
        ? Response.json({ service: "ling-stack-daemon" })
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
        : Response.json({ service: "ling-stack-daemon" });
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
        return Response.json({ service: "ling-stack-daemon" });
      }
      assert.equal(new Headers(init?.headers).get("X-Ling-Desktop-Bridge-Token"), "owned-bridge-token");
      return Response.json({
        protocolVersion: 1,
        capabilities: ["preview-source"],
        bridgeTokenAccepted: true,
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
        : Response.json({ service: "ling-stack-daemon" });
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

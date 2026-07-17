import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopExitLifecycle,
  createDesktopStartupOpenCoordinator,
  runDesktopStartup,
} from "../dist/main/startup-lifecycle.js";

test("concurrent main-window opens share one lifecycle attempt", async () => {
  const coordinator = createDesktopStartupOpenCoordinator({ requestExit() {} });
  const releaseOpen = deferred();
  let openCount = 0;
  const openWindow = async () => {
    openCount += 1;
    await releaseOpen.promise;
    return true;
  };

  const first = coordinator.run(openWindow);
  const second = coordinator.run(openWindow);
  assert.equal(first, second);
  releaseOpen.resolve();

  assert.equal(await first, true);
  assert.equal(openCount, 1);
});

test("shutdown invalidates an early main-window open before it can create daemon resources", async () => {
  const coordinator = createDesktopStartupOpenCoordinator({ requestExit() {} });
  const pathsResolved = deferred();
  const pathsStarted = deferred();
  let daemonCreateCount = 0;

  const open = coordinator.run(async (attempt) => {
    pathsStarted.resolve();
    await pathsResolved.promise;
    if (!attempt.isCurrent()) {
      return false;
    }
    daemonCreateCount += 1;
    return true;
  });

  await pathsStarted.promise;
  let shutdownComplete = false;
  const shutdown = coordinator.stopAcceptingAndWait().then(() => {
    shutdownComplete = true;
  });

  await Promise.resolve();
  assert.equal(shutdownComplete, false, "shutdown must drain the active open before exiting");
  pathsResolved.resolve();

  assert.equal(await open, false);
  await shutdown;
  assert.equal(daemonCreateCount, 0);
  assert.equal(await coordinator.run(async () => true), false);
});

test("an open-triggered exit can stop accepting work without waiting on its own open flight", async () => {
  const calls = [];
  let shutdown;
  let coordinator;
  coordinator = createDesktopStartupOpenCoordinator({
    requestExit(exitCode) {
      calls.push(`requestExit:${exitCode}`);
      shutdown = coordinator.stopAcceptingAndWait();
    },
  });

  const open = coordinator.run(async (attempt) => {
    calls.push("open.started");
    attempt.requestExit(0);
    calls.push("open.returning");
    return false;
  });

  assert.equal(await open, false);
  await shutdown;
  assert.deepEqual(calls, ["open.started", "open.returning", "requestExit:0"]);
});

test("an async open failure arriving after quit is treated as cancellation", async () => {
  const coordinator = createDesktopStartupOpenCoordinator({ requestExit() {} });
  const operationStarted = deferred();
  const operationFailed = deferred();

  const open = coordinator.run(async () => {
    operationStarted.resolve();
    await operationFailed.promise;
    throw new Error("daemon_start_cancelled");
  });

  await operationStarted.promise;
  const shutdown = coordinator.stopAcceptingAndWait();
  operationFailed.resolve();

  assert.equal(await open, false);
  await shutdown;
});

test("quit during daemon startup leaves no daemon, coordinator, or window resource behind", async () => {
  const coordinator = createDesktopStartupOpenCoordinator({ requestExit() {} });
  const daemonPublished = deferred();
  const daemonStartupReleased = deferred();
  let daemon;
  let daemonStopCount = 0;
  let computerUseCreateCount = 0;
  let windowCreateCount = 0;

  const open = coordinator.run(async (attempt) => {
    daemon = {
      stopOwnedDaemon() {
        daemonStopCount += 1;
        daemonStartupReleased.resolve();
      },
    };
    daemonPublished.resolve();
    await daemonStartupReleased.promise;
    if (!attempt.isCurrent()) {
      return false;
    }
    computerUseCreateCount += 1;
    windowCreateCount += 1;
    return true;
  });

  await daemonPublished.promise;
  const activeOpen = coordinator.stopAcceptingAndWait();
  const activeDaemon = daemon;
  daemon = undefined;
  activeDaemon.stopOwnedDaemon();
  await activeOpen;

  assert.equal(await open, false);
  assert.equal(daemon, undefined);
  assert.equal(daemonStopCount, 1);
  assert.equal(computerUseCreateCount, 0);
  assert.equal(windowCreateCount, 0);
});

test("startup failure after an owned daemon and coordinator start cleans every resource before exit 1", async () => {
  const calls = [];
  const resources = {
    daemon: { started: false, stopCount: 0 },
    coordinator: { started: false, disposeCount: 0 },
    window: { created: false, destroyCount: 0 },
  };
  const exitCodes = [];
  let quitCount = 0;
  const failures = [];
  const lifecycle = createDesktopExitLifecycle({
    shutdown: async () => {
      calls.push("shutdown");
      if (resources.coordinator.started) {
        resources.coordinator.disposeCount += 1;
        calls.push("coordinator.dispose");
      }
      if (resources.window.created) {
        resources.window.destroyCount += 1;
        calls.push("window.destroy");
      }
      if (resources.daemon.started) {
        resources.daemon.stopCount += 1;
        calls.push("daemon.stopOwnedDaemon");
      }
    },
    quit: () => {
      quitCount += 1;
    },
    exit: (exitCode) => exitCodes.push(exitCode),
  });

  await runDesktopStartup({
    start: async () => {
      resources.daemon.started = true;
      calls.push("daemon.started");
      resources.coordinator.started = true;
      calls.push("coordinator.started");
      resources.window.created = true;
      calls.push("window.created");
      throw new Error("main_window_load_failed");
    },
    requestExit: lifecycle.requestExit,
    onStartupError: (error) => failures.push(error),
  });

  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /main_window_load_failed/u);
  assert.deepEqual(calls, [
    "daemon.started",
    "coordinator.started",
    "window.created",
    "shutdown",
    "coordinator.dispose",
    "window.destroy",
    "daemon.stopOwnedDaemon",
  ]);
  assert.equal(resources.daemon.stopCount, 1);
  assert.equal(resources.coordinator.disposeCount, 1);
  assert.equal(resources.window.destroyCount, 1);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(quitCount, 0);
  assert.equal(lifecycle.isCleanupComplete(), true);
});

test("a later startup failure upgrades an in-flight normal quit without running shutdown twice", async () => {
  let shutdownCount = 0;
  let releaseShutdown;
  const shutdownBlocked = new Promise((resolve) => {
    releaseShutdown = resolve;
  });
  let signalShutdownStarted;
  const shutdownStarted = new Promise((resolve) => {
    signalShutdownStarted = resolve;
  });
  const exitCodes = [];
  let quitCount = 0;
  const lifecycle = createDesktopExitLifecycle({
    shutdown: async () => {
      shutdownCount += 1;
      signalShutdownStarted();
      await shutdownBlocked;
    },
    quit: () => {
      quitCount += 1;
    },
    exit: (exitCode) => exitCodes.push(exitCode),
  });

  const normalQuit = lifecycle.requestExit(0);
  await shutdownStarted;
  const failureExit = lifecycle.requestExit(1);
  assert.equal(normalQuit, failureExit);
  releaseShutdown();
  await Promise.all([normalQuit, failureExit]);

  assert.equal(shutdownCount, 1);
  assert.equal(quitCount, 0);
  assert.deepEqual(exitCodes, [1]);
  assert.equal(lifecycle.isCleanupComplete(), true);
});

test("normal exit also awaits exactly one shutdown before using Electron quit", async () => {
  const calls = [];
  const lifecycle = createDesktopExitLifecycle({
    shutdown: async () => {
      calls.push("shutdown");
    },
    quit: () => calls.push("quit"),
    exit: (exitCode) => calls.push(`exit:${exitCode}`),
  });

  await Promise.all([
    lifecycle.requestExit(0),
    lifecycle.requestExit(0),
  ]);

  assert.deepEqual(calls, ["shutdown", "quit"]);
  assert.equal(lifecycle.isExitRequested(), true);
  assert.equal(lifecycle.isCleanupComplete(), true);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

import assert from "node:assert/strict";
import test from "node:test";
import { DesktopDaemonLifecycleError } from "../dist/main/daemon-lifecycle.js";
import { createDesktopExitLifecycle } from "../dist/main/startup-lifecycle.js";

// R03: a refused/unconfirmed Host stop is not an ordinary cleanup failure.
// This executes the production exit lifecycle; it is not packaged GUI evidence.
for (const code of ["stop_blocked", "stop_unconfirmed"]) {
  test(`exit retains the application when the owned Host reports ${code}`, async () => {
    const failure = new DesktopDaemonLifecycleError(code, "http://127.0.0.1:17928");
    const events = [];
    let calls = 0;
    const lifecycle = createDesktopExitLifecycle({
      async shutdown() { calls += 1; throw failure; },
      quit() { events.push("quit"); },
      exit(code) { events.push(`exit:${code}`); },
      onShutdownError(error) { assert.equal(error, failure); events.push("diagnostic"); },
    });
    const first = lifecycle.requestExit();
    assert.equal(lifecycle.requestExit(), first);
    await first;
    assert.equal(lifecycle.isCleanupComplete(), false);
    assert.equal(lifecycle.isExitRequested(), false);
    assert.deepEqual(events, ["diagnostic"]);
    await lifecycle.requestExit(1);
    assert.equal(calls, 2, "an explicit later quit must recheck the original stop barrier");
    assert.deepEqual(events, ["diagnostic", "diagnostic"]);
  });
}

test("a diagnostic exception cannot turn refused stop into process exit", async () => {
  let exits = 0;
  const lifecycle = createDesktopExitLifecycle({
    async shutdown() { throw new DesktopDaemonLifecycleError("stop_blocked", "http://127.0.0.1:17928"); },
    quit() { exits += 1; }, exit() { exits += 1; },
    onShutdownError() { throw new Error("diagnostic_failed"); },
  });
  await lifecycle.requestExit();
  assert.equal(exits, 0);
  assert.equal(lifecycle.isCleanupComplete(), false);
});

test("only a fresh successful stop barrier permits explicit quit after an observation failure", async () => {
  const events = [];
  let stopped = false;
  const lifecycle = createDesktopExitLifecycle({
    async shutdown() {
      events.push("preflight");
      if (!stopped) throw new DesktopDaemonLifecycleError("stop_unconfirmed", "http://127.0.0.1:17928");
      events.push("cleanup");
    },
    quit() { events.push("quit"); }, exit(code) { events.push(`exit:${code}`); },
  });
  await lifecycle.requestExit();
  assert.deepEqual(events, ["preflight"]);
  stopped = true;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["preflight"], "a late stop receipt cannot trigger automatic exit");
  await lifecycle.requestExit();
  assert.deepEqual(events, ["preflight", "preflight", "cleanup", "quit"]);
  assert.equal(lifecycle.isCleanupComplete(), true);
});

test("synchronous exit callbacks join the installed single flight", async () => {
  let calls = 0, reentered;
  const lifecycle = createDesktopExitLifecycle({
    shutdown() { calls += 1; reentered = lifecycle.requestExit(); return Promise.resolve(); },
    quit() {}, exit() {},
  });
  const first = lifecycle.requestExit();
  await first;
  assert.equal(reentered, first);
  assert.equal(calls, 1);
});

for (const failure of [new Error("cleanup_failed"), { code: "stop_blocked" },
  new DesktopDaemonLifecycleError("spawn_failed", "http://127.0.0.1:17928")]) {
  test(`ordinary cleanup failure retains exit-1 semantics: ${failure.message ?? "untyped code"}`, async () => {
    const events = [];
    const lifecycle = createDesktopExitLifecycle({
      async shutdown() { throw failure; },
      quit() { events.push("quit"); }, exit(code) { events.push(code); },
    });
    await lifecycle.requestExit();
    assert.deepEqual(events, [1]);
    assert.equal(lifecycle.isCleanupComplete(), true);
  });
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { defaultRuntimeTimeoutPolicy } from "../../core/dist/index.js";
import { createDaemonServer, defaultDaemonConfig, RuntimeSupervisor } from "../dist/index.js";
import { LockedTaskContinuationGate } from "../dist/runtime/locked-task-continuation.js";

const DESKTOP_TOKEN = "locked-task-desktop-bridge-token";

test("locked-task gate blocks cooperatively and releases on unlock or preference enable", async () => {
  const gate = new LockedTaskContinuationGate();
  assert.deepEqual(gate.snapshot(), {
    revision: 0,
    continueWhileLocked: true,
    locked: false,
    blocked: false,
  });

  gate.update({ continueWhileLocked: false, locked: true });
  let released = false;
  const waiting = gate.waitUntilAllowed().then(() => {
    released = true;
  });
  await Promise.resolve();
  assert.equal(released, false);
  gate.update({ continueWhileLocked: false, locked: false });
  await waiting;
  assert.equal(released, true);

  gate.update({ continueWhileLocked: false, locked: true });
  const enabled = gate.waitUntilAllowed();
  gate.update({ continueWhileLocked: true, locked: true });
  await enabled;
  assert.equal(gate.snapshot().blocked, false);
});

test("locked-task gate removes an aborted waiter", async () => {
  const gate = new LockedTaskContinuationGate();
  gate.update({ continueWhileLocked: false, locked: true });
  const controller = new AbortController();
  const waiting = gate.waitUntilAllowed(controller.signal);
  controller.abort(new Error("test abort"));
  await assert.rejects(waiting, /test abort/u);
  gate.update({ continueWhileLocked: false, locked: false });
});

test("locked-task Desktop lease releases waiters after owner exit or expiry", async () => {
  const supervisor = new RuntimeSupervisor(defaultDaemonConfig);
  supervisor.updateLockedTaskContinuation({
    desktopInstanceId: "desktop-owner-a",
    leaseTtlMs: 25,
    continueWhileLocked: false,
    locked: true,
  });
  assert.equal(supervisor.isLockedTaskContinuationBlocked(), true);
  supervisor.releaseLockedTaskContinuation("stale-owner");
  assert.equal(supervisor.isLockedTaskContinuationBlocked(), true);
  supervisor.releaseLockedTaskContinuation("desktop-owner-a");
  assert.equal(supervisor.isLockedTaskContinuationBlocked(), false);

  supervisor.updateLockedTaskContinuation({
    desktopInstanceId: "desktop-owner-b",
    leaseTtlMs: 25,
    continueWhileLocked: false,
    locked: true,
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  assert.deepEqual(supervisor.getLockedTaskContinuationSnapshot(), {
    revision: 4,
    continueWhileLocked: true,
    locked: false,
    blocked: false,
  });
});

test("locked-task Desktop route requires bridge authority, exact workspace, and schema", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-locked-task-route-"));
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { desktopBridgeToken: DESKTOP_TOKEN },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/computer-use/locked-task-continuation/desktop/state`;
    const forbidden = await post(url, { workspaceCwd: cwd, continueWhileLocked: false, locked: true });
    assert.equal(forbidden.status, 403);

    const accepted = await post(
      url,
      { workspaceCwd: cwd, continueWhileLocked: false, locked: true },
      DESKTOP_TOKEN,
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await accepted.json(), {
      revision: 1,
      continueWhileLocked: false,
      locked: true,
      blocked: true,
    });

    const mismatch = await post(
      url,
      { workspaceCwd: resolve(cwd, "other"), continueWhileLocked: true, locked: false },
      DESKTOP_TOKEN,
    );
    assert.equal(mismatch.status, 409);
    const wrongMethod = await fetch(url, {
      headers: { "X-Ling-Desktop-Bridge-Token": DESKTOP_TOKEN },
    });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a locked run can outwait idle and hard budgets then resume the same runner", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-locked-task-run-"));
  const originalTimeoutPolicy = { ...defaultRuntimeTimeoutPolicy };
  Object.assign(defaultRuntimeTimeoutPolicy, {
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 25,
    idleTimeoutMs: 25,
    hardTimeoutMs: 35,
    cancelGraceMs: 20,
  });
  const runner = new CompletingRunner();
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { desktopBridgeToken: DESKTOP_TOKEN, runner },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const stateUrl = `${baseUrl}/computer-use/locked-task-continuation/desktop/state`;
    const blocked = await post(
      stateUrl,
      { workspaceCwd: cwd, continueWhileLocked: false, locked: true },
      DESKTOP_TOKEN,
    );
    assert.equal(blocked.status, 200);

    const responsePromise = fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd,
        teammateId: "teammate_builtin_engineer",
        task: {
          id: "task_locked_continuation_timeout",
          title: "Wait for unlock",
          prompt: "Continue after the system unlocks.",
        },
        provider: { provider: "static-chat", model: "static-model" },
        tools: ["read"],
      }),
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    assert.equal(runner.calls, 0, "the runner must stay gated beyond both timeout budgets");

    const released = await post(
      stateUrl,
      { workspaceCwd: cwd, continueWhileLocked: false, locked: false },
      DESKTOP_TOKEN,
    );
    assert.equal(released.status, 200);
    const response = await responsePromise;
    const body = await response.text();
    assert.equal(response.ok, true, body);
    assert.equal(runner.calls, 1);
    assert.match(body, /event: result/u);
    assert.doesNotMatch(body, /idle_timeout|hard_timeout/u);
  } finally {
    Object.assign(defaultRuntimeTimeoutPolicy, originalTimeoutPolicy);
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unlock between hard-timeout ticks excludes the complete blocked interval", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-locked-task-partial-tick-"));
  const originalTimeoutPolicy = { ...defaultRuntimeTimeoutPolicy };
  Object.assign(defaultRuntimeTimeoutPolicy, {
    heartbeatIntervalMs: 80,
    heartbeatTimeoutMs: 500,
    idleTimeoutMs: 500,
    hardTimeoutMs: 80,
    cancelGraceMs: 20,
  });
  const runner = new SignalAwareDelayedRunner(50);
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { desktopBridgeToken: DESKTOP_TOKEN, runner },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const stateUrl = `${baseUrl}/computer-use/locked-task-continuation/desktop/state`;
    await post(stateUrl, { workspaceCwd: cwd, continueWhileLocked: false, locked: true }, DESKTOP_TOKEN);

    const responsePromise = postRun(baseUrl, cwd, "task_locked_partial_tick");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.equal(runner.calls, 0);
    await post(stateUrl, { workspaceCwd: cwd, continueWhileLocked: false, locked: false }, DESKTOP_TOKEN);

    const response = await responsePromise;
    const body = await response.text();
    assert.equal(response.ok, true, body);
    assert.match(body, /event: result/u);
    assert.equal(runner.abortedAt, undefined);
  } finally {
    Object.assign(defaultRuntimeTimeoutPolicy, originalTimeoutPolicy);
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an opaque runner keeps consuming hard-timeout budget until it reaches a cooperative boundary", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-locked-task-opaque-runner-"));
  const originalTimeoutPolicy = { ...defaultRuntimeTimeoutPolicy };
  Object.assign(defaultRuntimeTimeoutPolicy, {
    heartbeatIntervalMs: 10,
    heartbeatTimeoutMs: 500,
    idleTimeoutMs: 500,
    hardTimeoutMs: 50,
    cancelGraceMs: 20,
  });
  const runner = new SignalAwareDelayedRunner(250);
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { desktopBridgeToken: DESKTOP_TOKEN, runner },
  );
  await daemon.start();
  try {
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const stateUrl = `${baseUrl}/computer-use/locked-task-continuation/desktop/state`;
    const responsePromise = postRun(baseUrl, cwd, "task_locked_opaque_runner");
    await runner.started;
    await post(stateUrl, { workspaceCwd: cwd, continueWhileLocked: false, locked: true }, DESKTOP_TOKEN);
    const unlockPromise = new Promise((resolvePromise) => {
      setTimeout(() => {
        void post(
          stateUrl,
          { workspaceCwd: cwd, continueWhileLocked: false, locked: false },
          DESKTOP_TOKEN,
        ).then(() => {
          runner.unlockedAt = Date.now();
          resolvePromise();
        });
      }, 120);
    });

    const response = await responsePromise;
    const body = await response.text();
    await unlockPromise;
    assert.equal(response.ok, true, body);
    assert.doesNotMatch(body, /event: result/u);
    assert.ok(runner.abortedAt, "the hard timeout must abort the still-running opaque runner");
    assert.ok(runner.unlockedAt && runner.abortedAt < runner.unlockedAt);
  } finally {
    Object.assign(defaultRuntimeTimeoutPolicy, originalTimeoutPolicy);
    await daemon.stop().catch(() => undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

function post(url, body, token) {
  const payload = Object.hasOwn(body, "continueWhileLocked")
    ? {
        desktopInstanceId: "desktop-test-instance",
        leaseTtlMs: 5_000,
        ...body,
      }
    : body;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Ling-Desktop-Bridge-Token": token } : {}),
    },
    body: JSON.stringify(payload),
  });
}

function postRun(baseUrl, cwd, taskId) {
  return fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd,
      teammateId: "teammate_builtin_engineer",
      task: { id: taskId, title: taskId, prompt: "Continue safely." },
      provider: { provider: "static-chat", model: "static-model" },
      tools: ["read"],
    }),
  });
}

class CompletingRunner {
  calls = 0;

  async runTask(options) {
    this.calls += 1;
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "resumed" }],
    };
  }
}

class SignalAwareDelayedRunner {
  calls = 0;
  abortedAt = undefined;
  unlockedAt = undefined;
  #resolveStarted;
  started = new Promise((resolveStarted) => {
    this.#resolveStarted = resolveStarted;
  });

  constructor(delayMs) {
    this.delayMs = delayMs;
  }

  async runTask(options) {
    this.calls += 1;
    this.#resolveStarted();
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(resolvePromise, this.delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.abortedAt = Date.now();
        rejectPromise(new DOMException("Run aborted", "AbortError"));
      };
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "resumed" }],
    };
  }
}

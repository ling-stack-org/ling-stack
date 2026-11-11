import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultRuntimeTimeoutPolicy } from "@ling-stack/core";
import type { PiRunnerResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { createDaemonServer, type RunnerAdapter } from "../dist/index.js";
import { LockedTaskContinuationGate } from "../dist/runtime/locked-task-continuation.js";

const DESKTOP_TOKEN = "locked-task-timer-desktop-bridge-token";

test("unlock between hard-timeout ticks excludes the complete blocked interval", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-task-timers-")), cwd = join(root, "workspace");
  await mkdir(cwd);
  const previous = { LING_STACK_HOME: process.env.LING_STACK_HOME,
    LING_STACK_DEFAULT_WORKSPACE_CWD: process.env.LING_STACK_DEFAULT_WORKSPACE_CWD };
  process.env.LING_STACK_HOME = join(root, "user");
  process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const originalTimeoutPolicy = { ...defaultRuntimeTimeoutPolicy };
  Object.assign(defaultRuntimeTimeoutPolicy, { heartbeatIntervalMs: 80, heartbeatTimeoutMs: 500,
    idleTimeoutMs: 500, hardTimeoutMs: 80, cancelGraceMs: 20 });
  const runner = new SignalAwareDelayedRunner(50);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    { desktopBridgeToken: DESKTOP_TOKEN, runner });
  try {
    await daemon.start();
    let monotonic = 0, notifyWaiting!: () => void;
    const waiting = new Promise<void>(resolve => { notifyWaiting = resolve; });
    const originalWait = LockedTaskContinuationGate.prototype.waitUntilAllowed;
    t.mock.method(LockedTaskContinuationGate.prototype, "waitUntilAllowed", function (
      this: LockedTaskContinuationGate, signal?: AbortSignal,
    ) {
      notifyWaiting();
      return originalWait.call(this, signal);
    });
    t.mock.method(performance, "now", () => monotonic);
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const advance = (milliseconds: number) => { monotonic += milliseconds; t.mock.timers.tick(milliseconds); };
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const stateUrl = `${baseUrl}/computer-use/locked-task-continuation/desktop/state`;
    assert.equal((await postLock(stateUrl, cwd, true)).status, 200);
    const responsePromise = fetch(`${baseUrl}/runs`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, teammateId: "teammate_builtin_engineer",
        task: { id: "task_locked_partial_tick", title: "Continue safely", prompt: "Continue safely." },
        provider: { provider: "static-chat", model: "static-model" }, tools: ["read"] }) });
    await waiting;
    advance(60);
    assert.equal(runner.calls, 0);
    assert.equal((await postLock(stateUrl, cwd, false)).status, 200);
    await runner.started;
    advance(20);
    assert.equal(runner.abortedAt, undefined);
    advance(30);
    const response = await responsePromise, body = await response.text();
    assert.equal(response.ok, true, body);
    assert.equal(runner.calls, 1);
    assert.match(body, /event: result/u);
    assert.doesNotMatch(body, /idle_timeout|hard_timeout/u);
    assert.equal(runner.abortedAt, undefined);
  } finally {
    t.mock.timers.reset();
    t.mock.restoreAll();
    Object.assign(defaultRuntimeTimeoutPolicy, originalTimeoutPolicy);
    await daemon.stop();
  }
});

function postLock(url: string, cwd: string, locked: boolean): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Ling-Desktop-Bridge-Token": DESKTOP_TOKEN },
    body: JSON.stringify({ workspaceCwd: cwd, desktopInstanceId: "desktop-timer-instance", leaseTtlMs: 5_000,
      continueWhileLocked: false, locked }) });
}

class SignalAwareDelayedRunner implements RunnerAdapter {
  calls = 0;
  abortedAt: number | undefined;
  private resolveStarted!: () => void;
  readonly started = new Promise<void>(resolve => { this.resolveStarted = resolve; });
  private readonly delayMs: number;
  constructor(delayMs: number) { this.delayMs = delayMs; }

  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
    this.calls++;
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { options.signal?.removeEventListener("abort", onAbort); resolve(); }, this.delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.abortedAt = performance.now();
        options.signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Run aborted", "AbortError"));
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.resolveStarted();
    await completed;
    return { taskId: options.task.id, events: [], messages: [{ role: "assistant", content: "resumed" }] };
  }
}

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { PiRunnerResult, PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { resolveStoragePaths } from "../../core/dist/index.js";
import { HostRunCapacityStore } from "../../core/dist/runtime-host-capacity-store-bridge.js";
import { createDaemonServer } from "../dist/index.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-host-capacity-daemon-")));
  const home = join(cwd, "ling-home");
  const previous = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, home, globalDatabasePath: resolveStoragePaths(cwd).user.globalDatabasePath };
}

function policy(databasePath: string): { revision: number; maxConcurrentRuns: number } | undefined {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare("SELECT revision, max_concurrent_runs AS maxConcurrentRuns FROM host_run_capacity_policy WHERE singleton=1").get() as
      { revision: number; maxConcurrentRuns: number } | undefined;
    return row && { revision: row.revision, maxConcurrentRuns: row.maxConcurrentRuns };
  } finally {
    database.close();
  }
}

const config = (cwd: string, enabled: boolean, maxConcurrentRuns = 3) => ({
  host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
  concurrency: {
    enabled, maxConcurrentRuns, maxReadOnlyRuns: 4, maxWorkspaceWriteRuns: 2,
    maxRunsPerProvider: 4, maxRunsPerRunner: 4, isolatedWriteMaxConcurrentSteps: 2,
  },
});

function deferred<T = void>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

class BlockingRunner extends ToolFreePiRunner {
  readonly calls: PiRunnerRunOptions[] = [];
  readonly entered = deferred<void>();
  private readonly releases: Array<() => void> = [];

  release(): void {
    this.releases.shift()?.();
  }

  async runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult> {
    this.calls.push(options);
    this.entered.resolve();
    await new Promise<void>(resolve => this.releases.push(resolve));
    return super.runTask(options, () => "done");
  }
}

function runBody(cwd: string, taskId: string): Record<string, unknown> {
  return {
    cwd,
    task: { id: taskId, title: taskId, prompt: "Run through the real Host capacity composition." },
    provider: { provider: "test-provider", model: "test-model" },
    tools: ["read"],
    thinkingLevel: "off",
  };
}

test("enabled daemon installs one Host policy in the canonical global database", async t => {
  const f = await fixture(t);
  const daemon = createDaemonServer(config(f.cwd, true, 3));
  try {
    assert.deepEqual(policy(f.globalDatabasePath), { revision: 1, maxConcurrentRuns: 3 });
    const second = new HostRunCapacityStore({ globalDatabasePath: f.globalDatabasePath });
    try {
      assert.deepEqual(second.getPolicy(), { revision: 1, maxConcurrentRuns: 3, installedAt: second.getPolicy()!.installedAt });
    } finally {
      second.close();
    }
  } finally {
    await daemon.stop();
  }
});

test("disabled daemon preserves an existing Host policy without enabling queue admission", async t => {
  const f = await fixture(t);
  const enabled = createDaemonServer(config(f.cwd, true, 2));
  await enabled.stop();
  const before = policy(f.globalDatabasePath);
  const disabled = createDaemonServer(config(f.cwd, false, 4));
  try {
    assert.deepEqual(policy(f.globalDatabasePath), before);
  } finally {
    await disabled.stop();
  }
});

test("a conflicting Host policy during construction closes its private authority", async t => {
  const f = await fixture(t);
  const first = createDaemonServer(config(f.cwd, true, 2));
  const secondCwd = await realpath(await mkdtemp(join(tmpdir(), "ling-host-capacity-daemon-conflict-")));
  t.after(async () => {
    await rm(secondCwd, { recursive: true, force: true });
  });
  try {
    assert.equal(resolveStoragePaths(secondCwd).user.globalDatabasePath, f.globalDatabasePath);
    assert.equal(policy(f.globalDatabasePath)?.maxConcurrentRuns, 2);
    assert.throws(() => createDaemonServer(config(secondCwd, true, 3)), error =>
      error instanceof Error && error.message === "runtime_host_capacity.policy_changed");
    const reopened = new HostRunCapacityStore({ globalDatabasePath: f.globalDatabasePath });
    try {
      assert.equal(reopened.getPolicy()?.maxConcurrentRuns, 2);
      assert.doesNotThrow(() => reopened.installPolicy({
        expectedRevision: 1, maxConcurrentRuns: 2, installedAt: "2026-11-07T00:00:00.000Z",
      }));
    } finally {
      reopened.close();
    }
  } finally {
    await first.stop();
  }
});

test("constructor failure closes the Host store before returning the startup error", async t => {
  const f = await fixture(t);
  const failure = new Error("store composition failed");
  assert.throws(() => createDaemonServer(config(f.cwd, true), {
    storeFactory: () => { throw failure; },
  }), error => error === failure);

  const reopened = new HostRunCapacityStore({ globalDatabasePath: f.globalDatabasePath });
  try {
    assert.deepEqual(reopened.getPolicy(), { revision: 1, maxConcurrentRuns: 3, installedAt: reopened.getPolicy()!.installedAt });
  } finally {
    reopened.close();
  }
});

test("real daemon shares one Host budget across nested workspaces and releases it after drain", async t => {
  const f = await fixture(t);
  const workspaceA = join(f.cwd, "workspace-a"), workspaceB = join(f.cwd, "workspace-b");
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  const runner = new BlockingRunner();
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = f.home;
  const daemon = createDaemonServer(config(f.cwd, true, 1), { runner });
  try {
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/runs`;
    const firstRequest = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runBody(workspaceA, "host-budget-a")),
    });
    const firstResponse = await firstRequest;
    await runner.entered.promise;
    const secondResponse = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(runBody(workspaceB, "host-budget-b")),
    });
    assert.equal(secondResponse.status, 200);
    const secondBody = await secondResponse.text();
    assert.match(secondBody, /"queued":true/);
    assert.match(secondBody, /"queueReason":"runtime_semaphore_conflict"/);
    assert.equal(runner.calls.length, 1);

    const held = new HostRunCapacityStore({ globalDatabasePath: f.globalDatabasePath });
    try { assert.deepEqual(held.counts(), { held: 1, released: 0, total: 1 }); }
    finally { held.close(); }

    runner.release();
    assert.equal(firstResponse.status, 200);
    await firstResponse.text();
    for (let i = 0; i < 100 && runner.calls.length < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(runner.calls.length, 2);
    runner.release();

    for (let i = 0; i < 100; i += 1) {
      const snapshot = new HostRunCapacityStore({ globalDatabasePath: f.globalDatabasePath });
      const counts = snapshot.counts();
      snapshot.close();
      if (counts.held === 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const released = new HostRunCapacityStore({ globalDatabasePath: f.globalDatabasePath });
    try { assert.deepEqual(released.counts(), { held: 0, released: 2, total: 2 }); }
    finally { released.close(); }
  } finally {
    runner.release();
    runner.release();
    await daemon.stop();
    if (previousHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousHome;
  }
});

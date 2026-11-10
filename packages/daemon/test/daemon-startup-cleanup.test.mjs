import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { resolveStoragePaths } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { DaemonRunnerRecoveryCoordinator } from "../dist/features/harness/continuations/daemon-recovery-coordinator.js";
import { initializeDaemonWithCleanup } from "../dist/startup/initialization.js";

const executeFile = promisify(execFile);

test("successful initialization does not invoke failure cleanup", async () => {
  let cleaned = false;
  await initializeDaemonWithCleanup(async () => {}, async () => { cleaned = true; });
  assert.equal(cleaned, false);
});

test("cleanup failure preserves both causes and cannot masquerade as a successful rollback", async () => {
  const startupError = new Error("isolated-startup-failure");
  const cleanupError = new Error("isolated-cleanup-failure");
  await assert.rejects(initializeDaemonWithCleanup(
    async () => { throw startupError; }, async () => { throw cleanupError; },
  ), error => error instanceof AggregateError && error.cause === startupError
    && error.message === "daemon_startup_failed_cleanup_incomplete"
    && error.errors[0] === startupError && error.errors[1] === cleanupError);
});

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-daemon-startup-cleanup-"));
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(cwd, "ling-home");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.LING_STACK_HOME;
    else process.env.LING_STACK_HOME = previousHome;
    await rm(cwd, { recursive: true, force: true });
  });
  const config = { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd };
  const create = () => createDaemonServer(config);
  const lockPath = join(resolveStoragePaths(cwd).workspace.rootDir, "runtime.lock");
  return { cwd, config, create, lockPath };
}

test("unowned daemon construction is refused before listening and cannot release another process's runtime lock", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const owner = f.create();
  await owner.start();
  try {
    const originalLock = await readFile(f.lockPath, "utf8");
    const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
    const program = `
      const { createDaemonServer } = await import(${JSON.stringify(moduleUrl)});
      let daemon;
      let failure;
      try {
        daemon = createDaemonServer(${JSON.stringify(f.config)});
        await daemon.start();
      } catch (error) { failure = error; }
      const observation = { error: failure?.code, constructed: Boolean(daemon), listeningAfterFailure: daemon?.server.listening ?? false };
      await daemon?.stop();
      process.stdout.write(JSON.stringify(observation));
    `;
    const child = await executeFile(process.execPath, ["--input-type=module", "-e", program], {
      timeout: 10_000, env: { ...process.env },
    });
    const observation = JSON.parse(child.stdout);
    assert.equal(observation.error, "runtime_already_running");
    assert.equal(observation.constructed, false, "ownership admission must precede constructor recovery, not merely start");
    assert.equal(observation.listeningAfterFailure, false, "start rejection must not leak a listening HTTP server");
    assert.equal(owner.server.listening, true);
    assert.equal(await readFile(f.lockPath, "utf8"), originalLock, "cleanup must preserve the live owner's exact lock");
  } finally {
    await owner.stop();
  }
});

test("a failed initialization drains its own runtime and permits a fresh daemon to take ownership", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const failure = new Error("injected-startup-recovery-failure");
  t.mock.method(DaemonRunnerRecoveryCoordinator.prototype, "start", () => { throw failure; });
  const daemon = f.create();
  try {
    await assert.rejects(daemon.start(), error => error === failure, "preserve the actual startup error");
    assert.equal(daemon.server.listening, false);
    await assert.rejects(readFile(f.lockPath, "utf8"), error => error.code === "ENOENT", "release only the failed owner's lock");
  } finally {
    await daemon.stop();
    t.mock.restoreAll();
  }
  const replacement = f.create();
  try {
    await replacement.start();
    assert.equal(replacement.server.listening, true);
  } finally {
    await replacement.stop();
  }
});

test("a port bind failure cannot shut down the healthy listener already using that port", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const owner = f.create();
  await owner.start();
  // Distinct workspace ownership isolates the listener collision from the
  // earlier same-workspace constructor gate tested above.
  const contenderCwd = await mkdtemp(join(tmpdir(), "ling-daemon-port-conflict-"));
  let contender;
  try {
    contender = createDaemonServer({ ...f.config, defaultWorkspaceCwd: contenderCwd, port: owner.server.address().port });
    await assert.rejects(contender.start(), error => error.code === "EADDRINUSE");
    assert.equal(contender.server.listening, false);
    assert.equal(owner.server.listening, true);
  } finally {
    try { await contender?.stop(); }
    finally {
      await owner.stop();
      await rm(contenderCwd, { recursive: true, force: true });
    }
  }
});

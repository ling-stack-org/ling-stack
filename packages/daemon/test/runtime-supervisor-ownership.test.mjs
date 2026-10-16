import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";

const WAIT_MS = 10_000;
const TEST_TIMEOUT_MS = 45_000;
const temporaryPrefix = "ling-a31-runtime-ownership-";
const coreUrl = new URL("../../core/dist/index.js", import.meta.url).href;
const supervisorUrl = new URL("../dist/runtime/supervisor.js", import.meta.url).href;

// Every daemon-like participant is a real, separately owned Node process, using
// only this test's temp SQLite store. There is no listener, model, or real app.
// The wrappers below pause real synchronous filesystem calls; they neither
// return fabricated lock bytes nor replace SQLite ownership or store effects.
const peerProgram = String.raw`
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  const input = JSON.parse(process.argv[1]);
  const originalRead = fs.readFileSync;
  const originalUnlink = fs.unlinkSync;
  const originalExists = fs.existsSync;
  const originalAppend = fs.appendFileSync;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let paused = false;
  const emit = value => process.send(value);
  function pause(kind) {
    paused = true;
    emit({ kind, pid: process.pid });
    const deadline = performance.now() + input.waitMs;
    while (!originalExists(input.gatePath)) {
      if (performance.now() >= deadline) throw new Error("a31_owned_barrier_timeout");
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
  if (input.barrier === "stale-read") {
    fs.readFileSync = function(path, ...args) {
      const value = originalRead.call(this, path, ...args);
      if (!paused && String(path) === input.lockPath
        && String(value).includes(input.staleRuntimeInstanceId)) pause("stale_read");
      return value;
    };
  }
  if (input.barrier === "release-unlink") {
    fs.unlinkSync = function(path, ...args) {
      if (!paused && String(path) === input.lockPath) pause("release_unlink");
      return originalUnlink.call(this, path, ...args);
    };
  }
  syncBuiltinESMExports();
  const core = await import(input.coreUrl);
  const { RuntimeSupervisor } = await import(input.supervisorUrl);
  const paths = core.resolveStoragePaths(input.cwd, {
    userRootDir: input.userRoot, workspaceStateLocation: "user-data-dir",
  }).workspace;
  const store = core.createSqliteRunStore(input.cwd, paths);
  let failReconcile = input.failReconcile === true;
  function observedStore(owner) {
    return new Proxy(store, {
      get(target, name) {
        const value = Reflect.get(target, name, target);
        if (name !== "expireRuntimeSemaphoreSlots") return typeof value === "function" ? value.bind(target) : value;
        return (...args) => {
          originalAppend(input.reconcilePath, JSON.stringify({ owner, pid: process.pid }) + "\n");
          if (failReconcile) {
            failReconcile = false;
            throw new Error("a31_injected_reconcile_failure");
          }
          return value.apply(target, args);
        };
      },
    });
  }
  const config = {
    host: "127.0.0.1", port: input.port, maxBodyBytes: 1024 * 1024,
    defaultWorkspaceCwd: input.cwd, runners: {}, runtimeTools: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true },
    channels: {},
  };
  const primary = new RuntimeSupervisor(config);
  const primaryStore = observedStore("primary");
  let secondary;
  let runtime;
  let ownedUnit;
  let ownedAttempt;
  const failure = error => ({ code: error?.code, message: String(error?.message ?? error) });
  const snapshot = () => ({
    unit: ownedUnit ? store.getWorkUnit(ownedUnit.id) : null,
    attempt: ownedAttempt ? store.getWorkUnitAttempt(ownedAttempt.id) : null,
  });
  process.on("message", message => {
    try {
      if (message.command === "acquire") {
        try {
          runtime = primary.getRuntime(input.cwd, primaryStore);
          emit({ kind: "acquired", pid: process.pid, runtime });
        } catch (error) { emit({ kind: "acquire_error", ...failure(error) }); }
      } else if (message.command === "second") {
        secondary = new RuntimeSupervisor(config);
        try {
          const secondRuntime = secondary.getRuntime(input.cwd, observedStore("secondary"));
          emit({ kind: "second_acquired", pid: process.pid, runtime: secondRuntime });
        } catch (error) { emit({ kind: "second_error", ...failure(error) }); }
      } else if (message.command === "release-second") {
        secondary?.releaseAll();
        emit({ kind: "second_released" });
      } else if (message.command === "seed") {
        if (!runtime) throw new Error("a31_seed_requires_real_runtime");
        const now = new Date().toISOString();
        ownedUnit = store.createWorkUnit({
          workspaceId: core.DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
          ownerId: "a31-owned-run-" + process.pid, idempotencyKey: "a31-owned-unit-" + process.pid,
          status: "running", createdByActor: "system", request: {}, now,
        });
        ownedAttempt = store.createWorkUnitAttempt({ workUnitId: ownedUnit.id,
          attemptNumber: 1, runtimeInstanceId: runtime.runtimeInstanceId,
          runnerId: "pi", status: "started", now });
        emit({ kind: "seeded", ...snapshot() });
      } else if (message.command === "snapshot") {
        emit({ kind: "snapshot", ...snapshot() });
      } else if (message.command === "release") {
        primary.releaseAll();
        emit({ kind: "released" });
      } else if (message.command === "shutdown") {
        primary.releaseAll();
        secondary?.releaseAll();
        store.close();
        process.send({ kind: "stopped" }, () => process.disconnect());
      } else {
        throw new Error("a31_unknown_test_command");
      }
    } catch (error) {
      process.send({ kind: "fatal", ...failure(error) }, () => process.exit(1));
    }
  });
  emit({ kind: "ready", pid: process.pid });
`;

/** A bounded IPC mailbox which retains events emitted before a waiter starts. */
function mailbox(child) {
  const messages = [];
  const waiters = new Set();
  let stderr = "";
  let ended;
  child.stderr?.on("data", bytes => { stderr = (stderr + bytes).slice(-16_384); });
  child.stdout?.resume();
  function settle() {
    for (const waiter of waiters) {
      const index = messages.findIndex(message => waiter.kinds.includes(message.kind) || message.kind === "fatal");
      if (index < 0 && !ended) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      if (index >= 0) {
        const [message] = messages.splice(index, 1);
        if (message.kind === "fatal") waiter.reject(new Error(JSON.stringify(message)));
        else waiter.resolve(message);
      } else waiter.reject(new Error(`A31 owned peer exited (${ended.code}/${ended.signal}): ${stderr}`));
    }
  }
  child.on("message", message => { messages.push(message); settle(); });
  child.on("error", error => {
    ended = { code: "spawn-error", signal: error.message };
    settle();
  });
  let resolveExit;
  const exited = new Promise(resolvePromise => { resolveExit = resolvePromise; });
  child.on("exit", (code, signal) => {
    ended = { code, signal };
    resolveExit(ended);
    settle();
  });
  return {
    child,
    async wait(kinds) {
      return new Promise((resolvePromise, reject) => {
        const waiter = { kinds, resolve: resolvePromise, reject };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`A31 peer timed out waiting for ${kinds.join("/")}: ${stderr}`));
        }, WAIT_MS);
        waiters.add(waiter);
        settle();
      });
    },
    send(command) { child.send({ command }); },
    async waitExit() {
      let timer;
      try {
        return await Promise.race([exited, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("A31 owned peer exit timeout")), WAIT_MS);
        })]);
      } finally { clearTimeout(timer); }
    },
    async terminate() {
      // Never signal a PID found in a lock file: only this exact spawned child.
      if (!ended && child.pid) child.kill("SIGKILL");
      if (!ended) await this.waitExit();
    },
  };
}

async function fixture(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, temporaryPrefix));
  const peers = [];
  t.after(async () => {
    try { await Promise.all(peers.map(peer => peer.terminate())); }
    finally {
      assert.equal(dirname(root), parent);
      assert.ok(basename(root).startsWith(temporaryPrefix));
      await rm(root, { recursive: true, force: true });
    }
  });
  const cwd = join(root, "workspace");
  const userRoot = join(root, "user-root");
  const temp = join(root, "tmp");
  await mkdir(cwd);
  await mkdir(temp);
  const paths = resolveStoragePaths(cwd, { userRootDir: userRoot, workspaceStateLocation: "user-data-dir" }).workspace;
  assert.ok(!relative(root, paths.rootDir).startsWith(".."));
  // Finish schema setup before contenders start; the test is runtime ownership,
  // not a simultaneous migration or a port-bind test.
  const seed = createSqliteRunStore(cwd, paths);
  seed.close();
  const lockPath = join(paths.rootDir, "runtime.lock");
  const reconcilePath = join(root, "reconcile.jsonl");
  let nextPeer = 0;
  return {
    root, cwd, lockPath,
    async peer(options = {}) {
      const peerId = ++nextPeer;
      const gatePath = join(root, `peer-${peerId}.gate`);
      const input = { cwd, userRoot, lockPath, reconcilePath, coreUrl, supervisorUrl, gatePath,
        waitMs: WAIT_MS, port: 17_000 + peerId, ...options };
      const child = spawn(process.execPath, ["--input-type=module", "-e", peerProgram, JSON.stringify(input)], {
        cwd, env: { LING_STACK_HOME: join(root, "ling-home"), TMPDIR: temp },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const peer = mailbox(child);
      peers.push(peer);
      await peer.wait(["ready"]);
      return { ...peer, openGate: () => writeFile(gatePath, "continue\n") };
    },
    async exitedOwner() {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { cwd, env: {}, stdio: "ignore" });
      const peer = mailbox(child);
      peers.push(peer);
      const { code, signal } = await peer.waitExit();
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.ok(Number.isInteger(child.pid) && child.pid > 0);
      assert.throws(() => process.kill(child.pid, 0), error => error.code === "ESRCH",
        "stale fixture PID must really be exited, not guessed or permission-denied");
      const runtimeInstanceId = `a31-real-exited-owner-${child.pid}`;
      await writeFile(lockPath, JSON.stringify({ runtimeInstanceId, pid: child.pid,
        host: "127.0.0.1", port: 16_999, cwd, startedAt: new Date().toISOString() }));
      return runtimeInstanceId;
    },
    async lock() { return JSON.parse(await readFile(lockPath, "utf8")); },
    async lockBytes() { return readFile(lockPath, "utf8"); },
    async reconciles() {
      try { return (await readFile(reconcilePath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

async function acquire(peer) {
  peer.send("acquire");
  const result = await peer.wait(["acquired", "acquire_error"]);
  assert.equal(result.kind, "acquired", JSON.stringify(result));
  return result.runtime;
}

async function release(peer) {
  peer.send("release");
  await peer.wait(["released"]);
}

async function seedOwnedWork(peer) {
  peer.send("seed");
  const { unit, attempt } = await peer.wait(["seeded"]);
  assert.equal(unit.status, "running");
  assert.equal(attempt.status, "started");
  return { unit, attempt };
}

async function assertOwnedWorkUnchanged(peer, baseline) {
  peer.send("snapshot");
  const { unit, attempt } = await peer.wait(["snapshot"]);
  assert.deepEqual({ unit, attempt }, baseline, "a refused contender must not reconcile the live owner's real Attempt");
}

test("same PID, host and port do not let a second supervisor share a workspace owner", { timeout: TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const owner = await f.peer();
  const runtime = await acquire(owner);
  const baseline = await seedOwnedWork(owner);
  const bytes = await f.lockBytes();
  owner.send("second");
  const result = await owner.wait(["second_acquired", "second_error"]);
  assert.equal(result.kind, "second_error", "a different Supervisor is not the original owner even in the same process");
  assert.equal(result.code, "runtime_already_running");
  assert.equal(await f.lockBytes(), bytes);
  assert.equal((await f.lock()).runtimeInstanceId, runtime.runtimeInstanceId);
  await assertOwnedWorkUnchanged(owner, baseline);
  assert.equal((await f.reconciles()).length, 1);
  owner.send("release-second");
  await owner.wait(["second_released"]);
  assert.equal(await f.lockBytes(), bytes, "failed same-process owner cleanup cannot remove the real owner");
});

test("two stale-lock contenders cannot both acquire or reconcile after observing the same exited owner", { timeout: TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const staleRuntimeInstanceId = await f.exitedOwner();
  const a = await f.peer({ barrier: "stale-read", staleRuntimeInstanceId });
  const b = await f.peer({ barrier: "stale-read", staleRuntimeInstanceId });
  a.send("acquire");
  const aBoundary = await a.wait(["stale_read", "acquired", "acquire_error"]);
  assert.notEqual(aBoundary.kind, "acquire_error", JSON.stringify(aBoundary));
  b.send("acquire");
  const bBoundary = await b.wait(["stale_read", "acquired", "acquire_error"]);
  assert.notEqual(bBoundary.kind, "acquired", "B cannot become owner while A is paused inside its acquisition");
  let aResult = aBoundary;
  if (aBoundary.kind === "stale_read") {
    await a.openGate();
    aResult = await a.wait(["acquired", "acquire_error"]);
  }
  assert.equal(aResult.kind, "acquired", JSON.stringify(aResult));
  const baseline = await seedOwnedWork(a);
  const ownerBytes = await f.lockBytes();
  let bResult = bBoundary;
  if (bBoundary.kind === "stale_read") {
    // Both old read results are now real. B resumes only after A has published
    // its live runtime and started a real Attempt. An old unlink must not win.
    await b.openGate();
    bResult = await b.wait(["acquired", "acquire_error"]);
  }
  assert.equal(bResult.kind, "acquire_error", "B's stale read cannot authorize unlinking the successor lock");
  assert.equal(bResult.code, "runtime_already_running");
  assert.equal(await f.lockBytes(), ownerBytes);
  assert.equal((await f.lock()).runtimeInstanceId, aResult.runtime.runtimeInstanceId);
  await assertOwnedWorkUnchanged(a, baseline);
  assert.deepEqual(await f.reconciles(), [{ owner: "primary", pid: a.child.pid }]);
  await release(b);
  assert.equal(await f.lockBytes(), ownerBytes, "failed B cleanup preserves A's projection");
});

test("a distinct live process is refused before reconcile and its cleanup preserves the owner", { timeout: TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const owner = await f.peer();
  await acquire(owner);
  const baseline = await seedOwnedWork(owner);
  const ownerBytes = await f.lockBytes();
  const contender = await f.peer();
  contender.send("acquire");
  const result = await contender.wait(["acquired", "acquire_error"]);
  assert.equal(result.kind, "acquire_error");
  assert.equal(result.code, "runtime_already_running");
  await release(contender);
  assert.equal(await f.lockBytes(), ownerBytes);
  await assertOwnedWorkUnchanged(owner, baseline);
  assert.deepEqual(await f.reconciles(), [{ owner: "primary", pid: owner.child.pid }]);
});

test("runtime publication remains owned until cleanup finishes and an old release cannot remove a legal successor", { timeout: TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const owner = await f.peer({ barrier: "release-unlink" });
  await acquire(owner);
  const contender = await f.peer();
  owner.send("release");
  const boundary = await owner.wait(["release_unlink", "released"]);
  if (boundary.kind === "release_unlink") {
    contender.send("acquire");
    const denied = await contender.wait(["acquired", "acquire_error"]);
    assert.equal(denied.kind, "acquire_error", "do not release coordination before metadata cleanup has settled");
    assert.equal(denied.code, "runtime_already_running");
    await owner.openGate();
    await owner.wait(["released"]);
  }
  assert.equal(existsSync(f.lockPath), false);
  const successor = await acquire(contender);
  const successorBytes = await f.lockBytes();
  await release(owner);
  assert.equal(await f.lockBytes(), successorBytes, "retired owner release must not unlink the successor's path");
  assert.equal((await f.lock()).runtimeInstanceId, successor.runtimeInstanceId);
  await release(contender);
  assert.equal(existsSync(f.lockPath), false);
});

test("a crashed owner permits a fresh owner despite its real stale diagnostic metadata", { timeout: TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const owner = await f.peer();
  const oldRuntime = await acquire(owner);
  const oldBytes = await f.lockBytes();
  owner.child.kill("SIGKILL");
  const exit = await owner.waitExit();
  assert.equal(exit.signal, "SIGKILL");
  assert.equal(await f.lockBytes(), oldBytes, "the crash leaves the real stale metadata in place");
  const successor = await f.peer();
  const newRuntime = await acquire(successor);
  assert.notEqual(newRuntime.runtimeInstanceId, oldRuntime.runtimeInstanceId);
  assert.equal((await f.lock()).pid, successor.child.pid);
  assert.deepEqual(await f.reconciles(), [
    { owner: "primary", pid: owner.child.pid }, { owner: "primary", pid: successor.child.pid },
  ]);
  await release(successor);
  assert.equal(existsSync(f.lockPath), false);
});

test("reconcile failure before runtime publication still releases the probe and permits a fresh owner", { timeout: TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t);
  const failed = await f.peer({ failReconcile: true });
  failed.send("acquire");
  const result = await failed.wait(["acquired", "acquire_error"]);
  assert.equal(result.kind, "acquire_error");
  assert.equal(result.message, "a31_injected_reconcile_failure");
  await release(failed);
  assert.equal(existsSync(f.lockPath), false, "release acquired ownership even when no RuntimeInstance was cached");
  const successor = await f.peer();
  const runtime = await acquire(successor);
  assert.equal((await f.lock()).runtimeInstanceId, runtime.runtimeInstanceId);
  const successorBytes = await f.lockBytes();
  await release(failed);
  assert.equal(await f.lockBytes(), successorBytes);
  await release(successor);
  assert.equal(existsSync(f.lockPath), false);
});

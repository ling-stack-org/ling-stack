import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const childEnv = "LING_A25_QUEUE_BUSY_CHILD";
const terminal = new Set(["committed", "failed", "conflict", "expired", "recovery_required"]);
test("A25 distinct queued request cannot remain orphan requested after its busy worker settles", { timeout: 45_000 },
  t => process.env[childEnv] ? exercise(t) : runOwnedChild());

async function runOwnedChild() {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-a25-queue-busy-")));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [childEnv]: "1" },
      stdio: ["ignore", "pipe", "pipe"], timeout: 35_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { stdout += value; });
    child.stderr.on("data", value => { stderr += value; });
    const exit = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done({ code, signal }));
    });
    process.stdout.write(stdout); process.stderr.write(stderr);
    console.log(`A25 distinct queued busy child exit: ${JSON.stringify(exit)}`);
    assert.ok(stdout.includes("A25 distinct queued busy case entered"));
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a25-queue-busy-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function within(promise, name) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`A25 timed out waiting for ${name}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Child-local passthrough FS observation; only one actual scan return is delayed. */
async function exercise(t) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log("A25 distinct queued busy case entered");
  const actual = { readdir: fs.readdir, realpath: fs.realpath, rename: fs.rename, readFile: fs.readFile };
  const gateEntered = deferred(), gateRelease = deferred();
  const victim = join(cwd, "project.txt");
  let armed = false, gateHeld = false, gateCalls = 0, trackingRoots = false;
  let queueRootCalls = 0, workerObserved = false, realApplyRenames = 0, direct;
  let store, observer, reopened;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A25 distinct queued busy test forbids network access"); };
  const patches = [t.mock.method(os, "homedir", () => home)];
  patches.push(t.mock.method(fs, "readdir", async function (path, options) {
    const result = await actual.readdir.call(this, path, options);
    if (armed && path === cwd && options?.withFileTypes === true) {
      armed = false; gateHeld = true; gateCalls++;
      gateEntered.resolve();
      await gateRelease.promise;
      gateHeld = false;
    }
    return result;
  }));
  patches.push(t.mock.method(fs, "realpath", async function (path, ...args) {
    const result = await actual.realpath.call(this, path, ...args);
    if (trackingRoots && path === cwd) {
      queueRootCalls++;
      if (queueRootCalls >= 2) workerObserved = true;
    }
    return result;
  }));
  patches.push(t.mock.method(fs, "rename", async function (source, destination, ...args) {
    const result = await actual.rename.call(this, source, destination, ...args);
    if (destination === victim && typeof source === "string" && source.startsWith(`${victim}.ling-restore-`)) realApplyRenames++;
    return result;
  }));
  syncBuiltinESMExports();
  try {
    const core = await import("../../core/dist/index.js");
    const restore = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd);
    await fs.writeFile(victim, "baseline project\n", { mode: 0o600 });
    const snapshot = await restore.captureWorkspaceSnapshot(store, cwd);
    await fs.writeFile(victim, "current project\n");
    const anchor = await restore.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, snapshot.manifest.id);
    const now = new Date().toISOString();
    const confirmation = () => {
      const pending = store.createSnapshotRestoreConfirmation({ workspaceId: snapshot.manifest.workspaceId,
        anchorId: anchor.id, snapshotId: snapshot.manifest.id, createdAt: now });
      assert.equal(store.resolveSnapshotRestoreConfirmation(pending.id, "confirmed", now)?.state, "confirmed");
      return pending.id;
    };
    const inputA = { idempotencyKey: "a25-busy-direct-a", anchorId: anchor.id,
      snapshotId: snapshot.manifest.id, confirmationId: confirmation() };
    const inputB = { idempotencyKey: "a25-busy-queue-b", anchorId: anchor.id,
      snapshotId: snapshot.manifest.id, confirmationId: confirmation() };
    assert.notEqual(inputA.confirmationId, inputB.confirmationId);
    const requestA = store.createSnapshotRestoreRequest({ ...inputA, workspaceId: snapshot.manifest.workspaceId,
      expectedWorkspaceFingerprint: anchor.expectedWorkspaceFingerprint,
      expectedProvenanceWatermark: anchor.expectedProvenanceWatermark, createdAt: now });
    observer = core.createSqliteRunStore(cwd);
    armed = true;
    direct = restore.restoreWorkspaceSnapshot(store, cwd, inputA).then(
      value => ({ value }), error => ({ error: { code: error.code, message: error.message } }));
    await within(gateEntered.promise, "direct A's real scan");
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), true);
    assert.equal(observer.getSnapshotRestoreRequest(requestA.id)?.state, "requested");
    assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: requestA.id }), []);
    assert.equal(gateCalls, 1);
    assert.equal(gateHeld, true);
    let accepted, rejection;
    trackingRoots = true;
    try { accepted = await restore.queueWorkspaceSnapshotRestore(store, cwd, inputB); }
    catch (error) { rejection = { statusCode: error.statusCode, code: error.code, message: error.message }; }
    // Permit a correct implementation to defer its worker until A releases the
    // lock. In the current candidate the actual second lookup instead hits busy.
    const observeUntil = Date.now() + 150;
    while (!workerObserved && accepted && Date.now() < observeUntil) await delay(5);
    await nextTurn(); await nextTurn();
    const blocked = { acceptedId: accepted?.id, rejection, workerObserved,
      requestB: observer.getSnapshotRestoreRequestByIdempotency(snapshot.manifest.workspaceId, inputB.idempotencyKey),
      directState: observer.getSnapshotRestoreRequest(requestA.id)?.state, gateHeld };
    console.log(`A25 distinct queued busy blocked: ${JSON.stringify(blocked)}`);
    // Stop lookup observation before releasing A: its later fingerprint lookup
    // must never be mistaken for B. A corrected queue may start B only after A.
    trackingRoots = false;
    gateRelease.resolve();
    const completedA = await within(direct, "direct A completion");
    // Read-only polling: do not replay B and accidentally create a replacement
    // worker that would hide a previously accepted, permanently orphaned request.
    const deadline = Date.now() + 5_000;
    let requestB = observer.getSnapshotRestoreRequestByIdempotency(snapshot.manifest.workspaceId, inputB.idempotencyKey);
    while (accepted && requestB && !terminal.has(requestB.state) && Date.now() < deadline) {
      await delay(20);
      requestB = observer.getSnapshotRestoreRequest(requestB.id);
    }
    reopened = core.createSqliteRunStore(cwd);
    const durableA = reopened.getSnapshotRestoreRequest(requestA.id);
    const journalA = reopened.listSnapshotRestoreJournalEntries({ restoreRequestId: requestA.id });
    const lockActive = await restore.isWorkspaceSnapshotRestoreActive(cwd);
    console.log(`A25 distinct queued busy settled: ${JSON.stringify({ completedA, requestB, lockActive, realApplyRenames, queueRootCalls })}`);
    assert.equal(completedA.error, undefined, JSON.stringify(completedA));
    assert.equal(completedA.value.id, requestA.id);
    assert.equal(durableA.state, "committed");
    assert.equal(journalA.length, 1);
    assert.equal(journalA[0].state, "applied");
    assert.equal(journalA[0].relativePath, "project.txt");
    assert.equal(realApplyRenames, 1, "B must not duplicate A's genuine file effect");
    assert.equal(await actual.readFile(victim, "utf8"), "baseline project\n");
    assert.equal(lockActive, false);
    if (rejection) {
      assert.equal(rejection.statusCode, 409, "a synchronous busy rejection must be explicit");
      assert.ok(!requestB || terminal.has(requestB.state), "synchronous rejection cannot leave an orphan requested record");
    } else {
      assert.ok(accepted, "queue must either explicitly reject or return a durable request");
      assert.notEqual(accepted.id, requestA.id);
      assert.ok(requestB && terminal.has(requestB.state),
        `accepted B has no settled outcome after A committed and lock released: ${JSON.stringify(requestB)}`);
      assert.equal(requestB.id, accepted.id);
      assert.equal(requestB.confirmationId, inputB.confirmationId);
    }
    if (requestB) {
      assert.notEqual(requestB.id, requestA.id);
      assert.deepEqual(reopened.getSnapshotRestoreRequest(requestB.id), requestB);
      if (requestB.state !== "committed") assert.ok(requestB.lastError?.trim(), "a rejected background request needs a durable explanation");
    }
  } finally {
    gateRelease.resolve();
    if (direct) await within(direct, "direct A cleanup");
    for (const candidate of [reopened, observer, store]) if (candidate?.database.isOpen) candidate.close();
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
  }
}

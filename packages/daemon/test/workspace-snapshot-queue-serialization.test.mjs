import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const caseEnv = "LING_A25_QUEUE_SERIALIZATION_CASE";
const cases = {
  direct_busy: "A25 direct restore retains explicit busy rejection without changing the active owner",
  queued_many: "A25 queued replays and distinct requests serialize without duplicate effects or orphan rows",
};
for (const [scenario, name] of Object.entries(cases)) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(name, { timeout: 45_000 }, t => process.env[caseEnv] ? exercise(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a25-queue-serialization-${scenario}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
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
    console.log(`A25 queue serialization child exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A25 queue serialization case entered: ${scenario}`));
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a25-queue-serialization-${scenario}-`));
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

/** The only scheduling hook defers one real directory scan, never a worker or lock. */
async function exercise(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A25 queue serialization case entered: ${scenario}`);
  const victim = join(cwd, "project.txt");
  const actual = { readdir: fs.readdir, rename: fs.rename, readFile: fs.readFile };
  const entered = deferred(), release = deferred();
  let armed = false, gateHeld = false, scanCalls = 0, applyRenames = 0, direct;
  let store, observer, reopened;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A25 queue serialization test forbids network access"); };
  const patches = [t.mock.method(os, "homedir", () => home)];
  patches.push(t.mock.method(fs, "readdir", async function (path, options) {
    const entries = await actual.readdir.call(this, path, options);
    if (armed && path === cwd && options?.withFileTypes === true) {
      armed = false; gateHeld = true; scanCalls++;
      entered.resolve(); await release.promise; gateHeld = false;
    }
    return entries;
  }));
  patches.push(t.mock.method(fs, "rename", async function (source, destination, ...args) {
    const result = await actual.rename.call(this, source, destination, ...args);
    if (destination === victim && typeof source === "string" && source.startsWith(`${victim}.ling-restore-`)) applyRenames++;
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
    const input = key => {
      const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId: snapshot.manifest.workspaceId,
        anchorId: anchor.id, snapshotId: snapshot.manifest.id, createdAt: now });
      assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
      return { idempotencyKey: key, anchorId: anchor.id, snapshotId: snapshot.manifest.id, confirmationId: confirmation.id };
    };
    const inputA = input("a25-serialization-a");
    const requestA = store.createSnapshotRestoreRequest({ ...inputA, workspaceId: snapshot.manifest.workspaceId,
      expectedWorkspaceFingerprint: anchor.expectedWorkspaceFingerprint,
      expectedProvenanceWatermark: anchor.expectedProvenanceWatermark, createdAt: now });
    observer = core.createSqliteRunStore(cwd);
    armed = true;
    direct = restore.restoreWorkspaceSnapshot(store, cwd, inputA).then(value => ({ value }), error => ({ error }));
    await within(entered.promise, "the genuine direct scan");
    assert.equal(scanCalls, 1); assert.equal(gateHeld, true);
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), true);
    const blockedA = observer.getSnapshotRestoreRequest(requestA.id);
    assert.equal(blockedA.state, "requested");
    assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: requestA.id }), []);
    let accepted = [];
    if (scenario === "direct_busy") {
      await assert.rejects(() => restore.restoreWorkspaceSnapshot(store, cwd, inputA), error =>
        error.statusCode === 409 && error.code === "workspace_restore_busy");
      assert.deepEqual(observer.getSnapshotRestoreRequest(requestA.id), blockedA);
    } else {
      const replays = await Promise.all([0, 1, 2].map(() => restore.queueWorkspaceSnapshotRestore(store, cwd, inputA)));
      assert.deepEqual(replays.map(value => value.id), [requestA.id, requestA.id, requestA.id]);
      accepted = await Promise.all([input("a25-serialization-b"), input("a25-serialization-c")]
        .map(value => restore.queueWorkspaceSnapshotRestore(store, cwd, value)));
      assert.equal(new Set(accepted.map(value => value.id)).size, 2);
      assert.equal(new Set(accepted.map(value => value.confirmationId)).size, 2);
      await nextTurn(); await nextTurn();
      for (const request of accepted) assert.equal(observer.getSnapshotRestoreRequest(request.id).state, "requested");
      assert.deepEqual(observer.getSnapshotRestoreRequest(requestA.id), blockedA);
    }
    assert.equal(applyRenames, 0);
    assert.equal(gateHeld, true);
    assert.equal(await actual.readFile(victim, "utf8"), "current project\n");
    release.resolve();
    const completed = await within(direct, "the genuine direct completion");
    assert.equal(completed.error, undefined);
    assert.equal(completed.value.state, "committed");
    const deadline = Date.now() + 10_000;
    let settled;
    do {
      settled = accepted.map(value => observer.getSnapshotRestoreRequest(value.id));
      if (settled.every(value => value?.state === "conflict") && !await restore.isWorkspaceSnapshotRestoreActive(cwd)) break;
      await pause(10);
    } while (Date.now() < deadline);
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), false);
    for (const request of settled) {
      assert.equal(request.state, "conflict", "each accepted waiter actually runs and records its stale fingerprint");
      assert.match(request.lastError ?? "", /Workspace fingerprint changed/u);
      assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), []);
    }
    const requests = observer.listSnapshotRestoreRequests({ workspaceId: snapshot.manifest.workspaceId });
    const journalA = observer.listSnapshotRestoreJournalEntries({ restoreRequestId: requestA.id });
    assert.equal(requests.length, scenario === "direct_busy" ? 1 : 3);
    assert.equal(journalA.length, 1); assert.equal(journalA[0].state, "applied");
    assert.equal(applyRenames, 1, "same-id replay and competing queued requests cannot duplicate the real file effect");
    assert.equal(await actual.readFile(victim, "utf8"), "baseline project\n");
    assert.equal(observer.getWorkspaceSnapshotFence(snapshot.manifest.workspaceId).ownerRequestId, undefined);
    observer.close(); observer = undefined;
    store.close(); store = undefined;
    reopened = core.createSqliteRunStore(cwd);
    assert.deepEqual(reopened.listSnapshotRestoreRequests({ workspaceId: snapshot.manifest.workspaceId }), requests);
    assert.deepEqual(reopened.listSnapshotRestoreJournalEntries({ restoreRequestId: requestA.id }), journalA);
    console.log(`A25 queue serialization evidence: ${JSON.stringify({ scenario, scanCalls, applyRenames, requests, journalA })}`);
  } finally {
    release.resolve();
    if (direct) await within(direct, "direct cleanup");
    for (const candidate of [reopened, observer, store]) if (candidate?.database.isOpen) candidate.close();
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
  }
}

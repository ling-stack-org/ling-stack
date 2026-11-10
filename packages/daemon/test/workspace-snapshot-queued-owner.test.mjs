import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const caseEnv = "LING_A25_QUEUE_OWNER_CASE";
const cases = {
  direct: "A25 queued owner control direct restore commits its existing durable request",
  overlap: "A25 queued owner busy fallback cannot relabel another direct worker's same request",
};
for (const [scenario, name] of Object.entries(cases)) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(name, { timeout: 45_000 }, t => process.env[caseEnv] ? exercise(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a25-queued-owner-${scenario}-`)));
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
    console.log(`A25 queued owner child exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A25 queued owner case entered: ${scenario}`));
    assert.equal(exit.signal, null, "the owned child must settle rather than time out");
    assert.equal(exit.code, 0);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a25-queued-owner-${scenario}-`));
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

/** Only one real readdir return is deferred; restore, lock and Store stay real. */
async function exercise(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A25 queued owner case entered: ${scenario}`);
  const actual = { readdir: fs.readdir, realpath: fs.realpath, readFile: fs.readFile };
  const gateEntered = deferred(), gateRelease = deferred(), backgroundResolvedRoot = deferred();
  let armed = false, gateHeld = false, gateCalls = 0, trackingBackground = false, backgroundRootCalls = 0;
  let store, observer, reopened, direct;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A25 queued owner test forbids network access"); };
  const patches = [t.mock.method(os, "homedir", () => home)];
  patches.push(t.mock.method(fs, "readdir", async function (path, options) {
    const children = await actual.readdir.call(this, path, options);
    if (armed && path === cwd && options?.withFileTypes === true) {
      armed = false;
      gateCalls++;
      gateHeld = true;
      gateEntered.resolve();
      await gateRelease.promise;
      gateHeld = false;
    }
    return children;
  }));
  patches.push(t.mock.method(fs, "realpath", async function (path, ...args) {
    const result = await actual.realpath.call(this, path, ...args);
    if (trackingBackground && path === cwd) {
      backgroundRootCalls++;
      // #1 is queue's entry validation; #2 is its real background worker.
      if (backgroundRootCalls === 2) backgroundResolvedRoot.resolve();
    }
    return result;
  }));
  syncBuiltinESMExports();
  try {
    const core = await import("../../core/dist/index.js");
    const restore = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd);
    const victim = join(cwd, "project.txt");
    await fs.writeFile(victim, "baseline project\n", { mode: 0o600 });
    const snapshot = await restore.captureWorkspaceSnapshot(store, cwd);
    await fs.writeFile(victim, "current project\n");
    const anchor = await restore.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, snapshot.manifest.id);
    const now = new Date().toISOString();
    const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId: snapshot.manifest.workspaceId,
      anchorId: anchor.id, snapshotId: snapshot.manifest.id, createdAt: now });
    assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
    const input = { idempotencyKey: "a25-queued-owner", anchorId: anchor.id,
      snapshotId: snapshot.manifest.id, confirmationId: confirmation.id };
    const request = store.createSnapshotRestoreRequest({ ...input, workspaceId: snapshot.manifest.workspaceId,
      expectedWorkspaceFingerprint: anchor.expectedWorkspaceFingerprint,
      expectedProvenanceWatermark: anchor.expectedProvenanceWatermark, createdAt: now });
    observer = core.createSqliteRunStore(cwd);
    assert.equal(observer.getSnapshotRestoreRequest(request.id)?.state, "requested");
    assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), []);
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), false);
    if (scenario === "overlap") armed = true;
    direct = restore.restoreWorkspaceSnapshot(store, cwd, input).then(
      value => ({ value }), error => ({ error: { code: error.code, message: error.message } }));
    let queued, whileBlocked;
    if (scenario === "overlap") {
      await within(gateEntered.promise, "the direct worker's real scan readdir");
      assert.equal(gateCalls, 1);
      assert.equal(gateHeld, true);
      assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), true, "direct worker really holds withRestoreLock");
      assert.equal(observer.getSnapshotRestoreRequest(request.id)?.state, "requested");
      assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), []);
      trackingBackground = true;
      queued = await restore.queueWorkspaceSnapshotRestore(store, cwd, input);
      await within(backgroundResolvedRoot.promise, "the queued worker's real root lookup");
      trackingBackground = false;
      // Once the real lookup has returned, withRestoreLock rejects synchronously;
      // two event-loop boundaries drain that rejection, catch and finally chain.
      await nextTurn(); await nextTurn();
      whileBlocked = {
        queuedId: queued.id,
        state: observer.getSnapshotRestoreRequest(request.id)?.state,
        lastError: observer.getSnapshotRestoreRequest(request.id)?.lastError,
        journal: observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }),
        lockActive: await restore.isWorkspaceSnapshotRestoreActive(cwd),
        bytes: await actual.readFile(victim, "utf8"), gateCalls, gateHeld,
      };
      console.log(`A25 queued owner blocked observation: ${JSON.stringify(whileBlocked)}`);
      assert.equal(backgroundRootCalls, 2, "queue validation and its actual worker both ran");
      gateRelease.resolve();
    }
    const completed = await within(direct, "the original direct restore");
    reopened = core.createSqliteRunStore(cwd);
    const durable = reopened.getSnapshotRestoreRequest(request.id);
    const journal = reopened.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id });
    if (scenario === "overlap") {
      assert.deepEqual(whileBlocked, { queuedId: request.id, state: "requested", lastError: undefined,
        journal: [], lockActive: true, bytes: "current project\n", gateCalls: 1, gateHeld: true },
      "an unowned queue job hitting busy cannot turn the active direct worker's request terminal");
    }
    assert.equal(completed.error, undefined, JSON.stringify(completed));
    assert.equal(completed.value.id, request.id);
    assert.equal(completed.value.state, "committed");
    assert.equal(durable.state, "committed");
    assert.equal(await actual.readFile(victim, "utf8"), "baseline project\n");
    assert.equal(journal.length, 1, "only the original request's one real file journal is created");
    assert.equal(journal[0].relativePath, "project.txt");
    assert.equal(journal[0].state, "applied");
    assert.equal(new Set(journal.map(entry => entry.id)).size, 1);
    assert.equal(reopened.listSnapshotRestoreRequests({ workspaceId: snapshot.manifest.workspaceId }).length, 1);
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), false);
    if (scenario === "overlap") {
      const replay = await restore.queueWorkspaceSnapshotRestore(store, cwd, input);
      assert.equal(replay.id, request.id);
      assert.equal(replay.state, "committed");
      assert.deepEqual(reopened.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), journal);
    }
  } finally {
    gateRelease.resolve();
    if (direct) await within(direct, "direct restore cleanup");
    for (const candidate of [reopened, observer, store]) if (candidate?.database.isOpen) candidate.close();
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
  }
}

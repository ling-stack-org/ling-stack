import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A25_RECONCILE_FENCE_CASE";
const cases = {
  before: "A25 reconcile fence all-before recovery releases its current epoch for a fresh capture",
  after: "A25 reconcile fence all-after commit releases its current epoch for a fresh capture",
};
for (const [scenario, name] of Object.entries(cases)) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(name, { timeout: 45_000 }, t => process.env[caseEnv] ? exercise(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a25-reconcile-fence-${scenario}-`)));
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
    console.log(`A25 reconcile fence child exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A25 synthetic crash-staged reconcile entered: ${scenario}`));
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a25-reconcile-fence-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Real capture/restore produces the plan. Only the crash lifecycle is synthetic. */
async function exercise(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A25 synthetic crash-staged reconcile entered: ${scenario}`);
  const patch = t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A25 reconcile fixture forbids network access"); };
  let store, reopened, observer;
  try {
    const core = await import("../../core/dist/index.js");
    const restore = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd);
    const file = join(cwd, "project.txt");
    const targetText = "snapshot target bytes\n", beforeText = "pre-restore current bytes\n";
    await fs.writeFile(file, targetText, { mode: 0o600 });
    await fs.chmod(file, 0o600);
    const snapshot = await restore.captureWorkspaceSnapshot(store, cwd);
    await fs.writeFile(file, beforeText);
    await fs.chmod(file, 0o640);
    const anchor = await restore.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, snapshot.manifest.id);
    const now = new Date().toISOString();
    const pending = store.createSnapshotRestoreConfirmation({ workspaceId: snapshot.manifest.workspaceId,
      anchorId: anchor.id, snapshotId: snapshot.manifest.id, createdAt: now });
    assert.equal(store.resolveSnapshotRestoreConfirmation(pending.id, "confirmed", now)?.state, "confirmed");
    const original = await restore.restoreWorkspaceSnapshot(store, cwd, {
      idempotencyKey: "a25-reconcile-fence", anchorId: anchor.id, snapshotId: snapshot.manifest.id,
      confirmationId: pending.id,
    });
    assert.equal(original.state, "committed", "the genuine plan and restore must work before synthetic seeding");
    const plan = store.listSnapshotRestoreJournalEntries({ restoreRequestId: original.id });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].relativePath, "project.txt");
    assert.equal(plan[0].state, "applied");
    assert.ok(plan[0].rollbackBlobSha256 && plan[0].targetBlobSha256, "both before and target blobs came from the real worker");
    assert.equal(await fs.readFile(file, "utf8"), targetText);
    assert.equal((await fs.lstat(file)).mode & 0o777, 0o600);
    assert.equal(store.getWorkspaceSnapshotFence(original.workspaceId).ownerRequestId, undefined);

    // Explicit synthetic crash-staged fixture, NOT a process-kill experiment:
    // retain the producer's real request, blob IDs and plan; reset only lifecycle
    // fields through existing Core APIs in this owned database before reopening.
    if (scenario === "before") {
      await fs.writeFile(file, beforeText);
      await fs.chmod(file, 0o640);
    }
    const epoch = store.acquireWorkspaceSnapshotFence(original.workspaceId, original.id, now);
    assert.ok(epoch > original.fencingEpoch);
    const state = scenario === "after" ? "verifying" : "staged";
    const seeded = store.updateSnapshotRestoreRequest({ id: original.id, expectedState: "committed",
      state, fencingEpoch: epoch, updatedAt: now });
    assert.equal(seeded?.fencingEpoch, epoch);
    assert.equal(seeded?.state, state);
    assert.equal(store.updateSnapshotRestoreJournalEntry({ id: plan[0].id, expectedState: "applied",
      state: "pending", expectedFencingEpoch: epoch, updatedAt: now })?.state, "pending");
    store.close();
    reopened = core.createSqliteRunStore(cwd);
    assert.equal(reopened.getSnapshotRestoreRequest(original.id)?.state, state);
    assert.deepEqual(reopened.getWorkspaceSnapshotFence(original.workspaceId), { epoch, ownerRequestId: original.id });
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), false, "no live worker or in-process lock survives the synthetic fixture");
    const expectedFingerprint = scenario === "after" ? snapshot.manifest.fingerprint : anchor.expectedWorkspaceFingerprint;
    assert.equal(await restore.fingerprintWorkspace(cwd), expectedFingerprint);
    const reconciled = await restore.reconcileWorkspaceSnapshotRestore(reopened, cwd, original.id);
    observer = core.createSqliteRunStore(cwd);
    const fenceAfterReconcile = observer.getWorkspaceSnapshotFence(original.workspaceId);
    const durable = observer.getSnapshotRestoreRequest(original.id);
    const recoveredJournal = observer.listSnapshotRestoreJournalEntries({ restoreRequestId: original.id });
    let captured, captureError;
    try { captured = await restore.captureWorkspaceSnapshot(reopened, cwd); }
    catch (error) { captureError = { code: error.code, message: error.message }; }
    const observation = { scenario, reconcileState: reconciled.state, durableState: durable.state,
      fenceAfterReconcile, journalState: recoveredJournal[0].state,
      captureState: captured?.manifest.state, captureError };
    console.log(`A25 reconcile fence observation: ${JSON.stringify(observation)}`);
    assert.deepEqual(observation, {
      scenario, reconcileState: scenario === "after" ? "committed" : "requested",
      durableState: scenario === "after" ? "committed" : "requested",
      fenceAfterReconcile: { epoch }, journalState: scenario === "after" ? "applied" : "pending",
      captureState: "committed", captureError: undefined,
    }, "a reconciled lifecycle must release only its current epoch so real future capture is not permanently blocked");
    assert.equal(recoveredJournal.length, plan.length);
    assert.equal(recoveredJournal[0].id, plan[0].id, "recovery must not duplicate the existing plan");
    assert.equal(await fs.readFile(file, "utf8"), scenario === "after" ? targetText : beforeText);
    assert.equal((await fs.lstat(file)).mode & 0o777, scenario === "after" ? 0o600 : 0o640);
    assert.deepEqual(observer.getWorkspaceSnapshotFence(original.workspaceId), { epoch: epoch + 1 });
    assert.equal(captured.manifest.fingerprint, expectedFingerprint);
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), false);
  } finally {
    for (const candidate of [observer, reopened, store]) if (candidate?.database.isOpen) candidate.close();
    patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
  }
}

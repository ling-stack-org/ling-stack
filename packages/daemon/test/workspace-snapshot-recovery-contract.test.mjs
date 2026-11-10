import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A25_RECOVERY_CASE";
const cases = {
  no_effect: "A25 no-effect syscall failure proves the full before state before ordinary failed",
  journal_conflict: "A25 real apply followed by a journal CAS conflict cannot claim rollback",
  stale_epoch: "A25 old worker cannot roll back or release a newer same-owner fence",
  mode_reconcile: "A25 staged same-content wrong-mode state is visible recovery not committed",
  external_edit: "A25 external content after real apply is never blindly rolled back",
  rollback_partial: "A25 failure after a real rollback rename cannot claim verified rollback",
};
for (const [scenario, name] of Object.entries(cases)) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(name, { timeout: 45_000 }, t => process.env[caseEnv] ? exerciseCase(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a25-recovery-${scenario}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
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
    console.log(`A25 recovery child exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A25 recovery case entered: ${scenario}`));
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a25-recovery-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Real Core and restore implementation; syscall faults stay inside this child. */
async function exerciseCase(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A25 recovery case entered: ${scenario}`);
  const actual = { unlink: fs.unlink, chmod: fs.chmod, rename: fs.rename, readFile: fs.readFile, lstat: fs.lstat };
  const victim = join(cwd, "z-victim.txt"), prior = join(cwd, "a-prior.txt");
  let store, other, reopened, armed = false, faultCalls = 0, rollbackFaultCalls = 0, advancedEpoch, changedJournal;
  const externalText = "external writer content must survive\n";
  let rollbackAtFault;
  const previousUmask = process.umask(0o022), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A25 direct restore forbids network access"); };
  const patches = [t.mock.method(os, "homedir", () => home)];
  if (scenario === "no_effect") {
    patches.push(t.mock.method(fs, "unlink", async function (path, ...args) {
      if (armed && path === victim && faultCalls === 0) {
        faultCalls++;
        throw Object.assign(new Error("A25 injected no-effect unlink failure"), { code: "EIO" });
      }
      return actual.unlink.call(this, path, ...args);
    }));
  } else if (["journal_conflict", "stale_epoch", "external_edit", "rollback_partial"].includes(scenario)) {
    patches.push(t.mock.method(fs, "chmod", async function (path, mode, ...args) {
      const result = await actual.chmod.call(this, path, mode, ...args);
      if (armed && path === victim && faultCalls === 0) {
        faultCalls++;
        const request = other.listSnapshotRestoreRequests({ limit: 10 }).find(value => value.state === "committing");
        assert.ok(request);
        assert.equal(await actual.readFile(victim, "utf8"), "baseline victim\n");
        if (scenario === "external_edit") {
          await fs.writeFile(victim, externalText);
          throw Object.assign(new Error("A25 injected failure after real apply and external content change"), { code: "EIO" });
        } else if (scenario === "rollback_partial") {
          throw Object.assign(new Error("A25 injected failure after real apply chmod"), { code: "EIO" });
        } else if (scenario === "journal_conflict") {
          const entry = other.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }).find(value => value.relativePath === "z-victim.txt");
          assert.equal(entry.state, "pending");
          changedJournal = other.updateSnapshotRestoreJournalEntry({ id: entry.id, expectedState: "pending", state: "conflict", updatedAt: new Date().toISOString() });
          assert.ok(changedJournal, "use a genuine second-connection CAS, not a mocked result");
        } else {
          advancedEpoch = other.acquireWorkspaceSnapshotFence(request.workspaceId, request.id, new Date().toISOString());
          assert.ok(advancedEpoch > request.fencingEpoch);
        }
      }
      return result;
    }));
  }
  if (scenario === "rollback_partial") {
    patches.push(t.mock.method(fs, "rename", async function (source, destination, ...args) {
      const result = await actual.rename.call(this, source, destination, ...args);
      if (armed && destination === victim && typeof source === "string"
        && source.startsWith(`${victim}.ling-rollback-`) && rollbackFaultCalls === 0) {
        rollbackFaultCalls++;
        rollbackAtFault = { content: await actual.readFile(victim, "utf8"), mode: (await actual.lstat(victim)).mode & 0o777 };
        throw Object.assign(new Error("A25 injected failure after real rollback rename"), { code: "EIO" });
      }
      return result;
    }));
  }
  syncBuiltinESMExports();
  try {
    const core = await import("../../core/dist/index.js");
    const restore = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd);
    await fs.writeFile(prior, "baseline prior\n", { mode: 0o600 });
    await fs.writeFile(join(cwd, "y-target.txt"), "internal target\n", { mode: 0o600 });
    if (scenario === "no_effect") await fs.symlink("y-target.txt", victim);
    else await fs.writeFile(victim, "baseline victim\n", { mode: 0o600 });
    const snapshot = await restore.captureWorkspaceSnapshot(store, cwd);
    await fs.writeFile(prior, "current prior\n");
    await actual.chmod(prior, 0o640);
    if (scenario === "no_effect") await actual.unlink(victim);
    await fs.writeFile(victim, scenario === "mode_reconcile" ? "baseline victim\n" : "current victim\n");
    await actual.chmod(victim, 0o640);
    const before = await facts(actual, [prior, victim]);
    const anchor = await restore.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, snapshot.manifest.id);
    const now = new Date().toISOString();
    const pending = store.createSnapshotRestoreConfirmation({ anchorId: anchor.id, snapshotId: snapshot.manifest.id,
      workspaceId: snapshot.manifest.workspaceId, createdAt: now });
    store.resolveSnapshotRestoreConfirmation(pending.id, "confirmed", now);
    if (scenario === "mode_reconcile") {
      // Explicit synthetic crash state, not an original-emitter claim. Bytes,
      // kind and content fingerprint match; only durable before/target modes do not.
      await fs.writeFile(prior, "baseline prior\n");
      await actual.chmod(prior, 0o600);
      const request = store.createSnapshotRestoreRequest({ idempotencyKey: "a25-mode-reconcile", workspaceId: snapshot.manifest.workspaceId,
        anchorId: anchor.id, snapshotId: snapshot.manifest.id, expectedWorkspaceFingerprint: await restore.fingerprintWorkspace(cwd),
        expectedProvenanceWatermark: anchor.expectedProvenanceWatermark, confirmationId: pending.id, createdAt: now });
      const epoch = store.acquireWorkspaceSnapshotFence(request.workspaceId, request.id, now);
      store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "requested", state: "validating", updatedAt: now });
      store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "validating", state: "fenced", fencingEpoch: epoch, updatedAt: now });
      store.updateSnapshotRestoreRequest({ id: request.id, expectedState: "fenced", state: "staged", journalEntryCount: 1, updatedAt: now });
      const digest = sha256("baseline victim\n");
      store.createSnapshotRestoreJournalEntries([{ restoreRequestId: request.id, sequence: 0, relativePath: "z-victim.txt",
        expectedBeforeSha256: digest, expectedAfterSha256: digest, rollbackBlobSha256: digest, targetBlobSha256: digest,
        rollbackMode: 0o640, targetMode: 0o600, targetKind: "file", targetExists: true, updatedAt: now }]);
      await actual.chmod(victim, 0o644);
      assert.equal(await restore.fingerprintWorkspace(cwd), snapshot.manifest.fingerprint);
      const reconciled = await restore.reconcileWorkspaceSnapshotRestore(store, cwd, request.id);
      assert.equal(reconciled.state, "recovery_required", "matching content does not authorize committing unknown permissions");
      assert.equal((await actual.lstat(victim)).mode & 0o777, 0o644);
      store.close(); store = undefined;
      reopened = core.createSqliteRunStore(cwd);
      assert.equal((await restore.reconcileWorkspaceSnapshotRestore(reopened, cwd, request.id)).state, "recovery_required");
      return;
    }

    other = core.createSqliteRunStore(cwd);
    armed = true;
    await assert.rejects(() => restore.restoreWorkspaceSnapshot(store, cwd, { idempotencyKey: `a25-${scenario}`,
      anchorId: anchor.id, snapshotId: snapshot.manifest.id, confirmationId: pending.id }));
    armed = false;
    assert.equal(faultCalls, 1, "the owned real-producer boundary must actually be reached");
    const request = store.listSnapshotRestoreRequests({ limit: 10 }).find(value => value.idempotencyKey === `a25-${scenario}`);
    assert.ok(request);
    const journal = store.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id });
    const victimEntry = journal.find(value => value.relativePath === "z-victim.txt");
    assert.ok(victimEntry?.rollbackBlobSha256);
    assert.equal(await actual.readFile(join(store.paths.snapshotBlobsDir, victimEntry.rollbackBlobSha256), "utf8"), "current victim\n");
    const fence = store.getWorkspaceSnapshotFence(request.workspaceId);
    if (scenario === "no_effect") {
      assert.equal(request.state, "failed");
      assert.deepEqual(await facts(actual, [prior, victim]), before);
      assert.equal(fence.ownerRequestId, undefined);
    } else {
      assert.notEqual(request.state, "failed", "an unresolved journal or stale owner cannot claim ordinary failed");
      assert.notEqual(request.state, "committed");
      const expectedContent = scenario === "external_edit" ? externalText
        : scenario === "rollback_partial" ? "current victim\n" : "baseline victim\n";
      assert.equal(await actual.readFile(victim, "utf8"), expectedContent, "do not automatically overwrite an unresolved target");
      assert.notEqual(victimEntry.state, "rolled_back");
      if (scenario === "journal_conflict") {
        assert.equal(request.state, "recovery_required");
        assert.equal(victimEntry.state, "conflict");
      } else if (scenario === "stale_epoch") {
        assert.equal(victimEntry.state, "pending", "a stale worker cannot install the applied journal state");
        assert.equal(fence.epoch, advancedEpoch);
        assert.equal(fence.ownerRequestId, request.id, "never release the newer epoch even when its owner ID is unchanged");
      } else {
        assert.equal(request.state, "recovery_required");
        assert.equal(fence.ownerRequestId, request.id);
        assert.equal(fence.epoch, request.fencingEpoch);
        if (scenario === "external_edit") {
          assert.notEqual(sha256(expectedContent), victimEntry.expectedAfterSha256);
          assert.equal(await actual.readFile(victim, "utf8"), externalText, "the original after-digest external-edit guard must remain effective");
        } else {
          assert.equal(rollbackFaultCalls, 1, "the native rollback rename must complete before the injected rollback error");
          assert.deepEqual(rollbackAtFault, { content: "current victim\n", mode: 0o644 });
          assert.equal((await actual.lstat(victim)).mode & 0o777, 0o644, "bytes alone do not prove the before-mode was restored");
          assert.equal(victimEntry.state, "pending");
          assert.match(request.lastError ?? "", /after real rollback rename/u);
        }
      }
    }
    const durable = { request, journal, fence };
    other.close(); other = undefined;
    store.close(); store = undefined;
    reopened = core.createSqliteRunStore(cwd);
    assert.deepEqual({ request: reopened.getSnapshotRestoreRequest(request.id),
      journal: reopened.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }),
      fence: reopened.getWorkspaceSnapshotFence(request.workspaceId) }, durable,
    "the actual outcome, journal and fence must survive a real SQLite close/reopen");
    assert.equal(await actual.readFile(join(reopened.paths.snapshotBlobsDir, victimEntry.rollbackBlobSha256), "utf8"), "current victim\n");
    console.log(`A25 recovery evidence: ${JSON.stringify({ scenario, request, victimEntry, fence, advancedEpoch, rollbackFaultCalls, rollbackAtFault })}`);
  } finally {
    armed = false;
    other?.close(); store?.close(); reopened?.close();
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    process.umask(previousUmask);
  }
}

async function facts(actual, paths) {
  const result = {};
  for (const path of paths) {
    const info = await actual.lstat(path);
    result[path] = { kind: info.isFile() ? "file" : "other", mode: info.mode & 0o777, content: await actual.readFile(path, "utf8") };
  }
  return result;
}
function sha256(content) { return createHash("sha256").update(content).digest("hex"); }

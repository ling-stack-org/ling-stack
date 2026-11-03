import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A30_FENCE_FAILURE_CASE";
const scenarios = ["bind_throw_before", "bind_throw_after", "bind_false_successor", "terminalization_throw",
  "restore_release_throw", "capture_release_throw", "postcheck_successor"];
const baselineBody = "A30 fence failure baseline\n", currentBody = "A30 fence failure current\n";

for (const scenario of scenarios) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(`A30 fence failure edge: ${scenario}`, { timeout: 35_000 }, t =>
      process.env[caseEnv] ? exercise(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-a30-fence-failure-")));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 25_000,
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
    console.log(`A30 fence edge actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A30 fence edge entered: ${scenario}`));
    assert.ok(stdout.includes("A30 fence edge observation:"), "fixture failures do not prove the lifecycle defect");
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a30-fence-failure-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Faults isolate real SQLite transitions; no fake successful acquisition or release. */
async function exercise(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A30 fence edge entered: ${scenario}`);
  const patches = [t.mock.method(os, "homedir", () => home)];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A30 fence edge fixture forbids network access"); };
  syncBuiltinESMExports();
  let store, observer, reopened;
  try {
    const core = await import("../../core/dist/index.js");
    const snapshot = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd); observer = core.createSqliteRunStore(cwd);
    const file = join(cwd, "project.txt");
    await fs.writeFile(file, baselineBody, { mode: 0o600 });
    const baseline = await snapshot.captureWorkspaceSnapshot(store, cwd);
    await fs.writeFile(file, currentBody);
    const anchor = await snapshot.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, baseline.manifest.id);
    const now = new Date().toISOString(), workspaceId = baseline.manifest.workspaceId;
    const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId, anchorId: anchor.id,
      snapshotId: baseline.manifest.id, createdAt: now });
    assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
    const input = { idempotencyKey: `a30-edge-${scenario}`, anchorId: anchor.id,
      snapshotId: baseline.manifest.id, confirmationId: confirmation.id };
    const before = await facts(file), manifestsBefore = observer.listWorkspaceSnapshotManifests({ workspaceId });
    const originals = { update: store.updateSnapshotRestoreRequest, acquire: store.acquireWorkspaceSnapshotFence,
      claim: store.claimSnapshotRestoreFence, prepare: store.database.prepare,
      active: store.listActiveRunScopes, release: store.releaseWorkspaceSnapshotFence };
    const primary = Object.assign(new Error(`A30 primary ${scenario}`), { code: "EIO" });
    const cleanup = Object.assign(new Error(`A30 cleanup ${scenario}`), { code: "ENOSPC" });
    const fenceBefore = observer.getWorkspaceSnapshotFence(workspaceId);
    let acquired, attempted, beforeClaim, successor, bindFaults = 0, cleanupFaults = 0, scopeCalls = 0;
    const releases = [], mutations = [];
    let rootScans = 0, stagingWrites = 0;
    const inWorkspace = path => typeof path === "string" && (path === cwd || path.startsWith(`${cwd}/`));
    for (const name of ["rename", "unlink", "chmod", "rm", "rmdir", "mkdir", "symlink"]) {
      const original = fs[name];
      patches.push(t.mock.method(fs, name, function (...args) {
        if (inWorkspace(args[0]) || ["rename", "symlink"].includes(name) && inWorkspace(args[1])) mutations.push(name);
        return original.apply(this, args);
      }));
    }
    const originalReaddir = fs.readdir, originalCreateWriteStream = nativeFs.createWriteStream;
    patches.push(t.mock.method(fs, "readdir", function (path, options) {
      if (path === cwd && options?.withFileTypes === true) rootScans++;
      return originalReaddir.call(this, path, options);
    }));
    patches.push(t.mock.method(nativeFs, "createWriteStream", function (path, ...args) {
      if (typeof path === "string" && path.startsWith(`${store.paths.snapshotStagingDir}/`)) stagingWrites++;
      if (inWorkspace(path)) mutations.push("createWriteStream");
      return originalCreateWriteStream.call(this, path, ...args);
    }));
    patches.push(t.mock.method(store, "acquireWorkspaceSnapshotFence", function (id, owner, time) {
      const epoch = originals.acquire.call(this, id, owner, time);
      acquired = { workspaceId: id, ownerRequestId: owner, epoch };
      assert.deepEqual(observer.getWorkspaceSnapshotFence(id), { ownerRequestId: owner, epoch });
      return epoch;
    }));
    const advanceSuccessor = requestId => {
      const epoch = observer.acquireWorkspaceSnapshotFence(workspaceId, requestId, new Date().toISOString());
      assert.ok(epoch > acquired.epoch);
      const current = observer.getSnapshotRestoreRequest(requestId);
      const request = observer.updateSnapshotRestoreRequest({ id: requestId, expectedState: current.state,
        state: "fenced", fencingEpoch: epoch, updatedAt: new Date().toISOString() });
      assert.ok(request, "the successor is a genuine second-connection state transition");
      successor = { request, fence: observer.getWorkspaceSnapshotFence(workspaceId) };
      return successor;
    };
    patches.push(t.mock.method(store, "claimSnapshotRestoreFence", function (claim) {
      beforeClaim = observer.getSnapshotRestoreRequest(claim.requestId);
      assert.equal(beforeClaim?.state, "requested", "no separately committed validating intermediate");
      if (scenario === "bind_false_successor") {
        // A real competing Core claim commits before this caller's CAS. The
        // second invocation must return undefined without touching that owner.
        const epoch = observer.claimSnapshotRestoreFence(claim);
        assert.notEqual(epoch, undefined);
        successor = { request: observer.getSnapshotRestoreRequest(claim.requestId),
          fence: observer.getWorkspaceSnapshotFence(workspaceId) };
        const result = originals.claim.call(this, claim);
        assert.equal(result, undefined);
        bindFaults++;
        return result;
      }
      const epoch = originals.claim.call(this, claim);
      assert.notEqual(epoch, undefined);
      acquired = { workspaceId, ownerRequestId: claim.requestId, epoch };
      assert.equal(observer.getSnapshotRestoreRequest(claim.requestId)?.state, "fenced");
      assert.deepEqual(observer.getWorkspaceSnapshotFence(workspaceId), { epoch, ownerRequestId: claim.requestId });
      return epoch;
    }));
    patches.push(t.mock.method(store.database, "prepare", function (sql) {
      const statement = originals.prepare.call(this, sql);
      if (!scenario.startsWith("bind_throw_") || !sql.includes("UPDATE workspace_snapshot_restore_requests SET state = 'fenced'")) return statement;
      const originalRun = statement.run;
      statement.run = function (...args) {
        bindFaults++;
        attempted = { fence: store.getWorkspaceSnapshotFence(workspaceId), request: store.getSnapshotRestoreRequest(beforeClaim.id) };
        assert.ok(attempted.fence.epoch > fenceBefore.epoch, "a real fence write is visible only inside the open transaction");
        assert.equal(attempted.fence.ownerRequestId, beforeClaim.id);
        assert.deepEqual(observer.getWorkspaceSnapshotFence(workspaceId), fenceBefore, "uncommitted lease must not leak to another connection");
        assert.deepEqual(observer.getSnapshotRestoreRequest(beforeClaim.id), beforeClaim);
        if (scenario === "bind_throw_after") {
          assert.equal(Number(originalRun.apply(this, args).changes), 1, "the actual request epoch write must execute before the injected failure");
          attempted.request = store.getSnapshotRestoreRequest(beforeClaim.id);
          assert.equal(attempted.request.state, "fenced");
          assert.equal(attempted.request.fencingEpoch, attempted.fence.epoch);
          assert.deepEqual(observer.getSnapshotRestoreRequest(beforeClaim.id), beforeClaim, "the request write is also uncommitted");
        } else assert.equal(attempted.request.state, "requested");
        throw primary;
      };
      return statement;
    }));
    patches.push(t.mock.method(store, "updateSnapshotRestoreRequest", function (update) {
      if (scenario === "terminalization_throw" && update.state === "failed") {
        cleanupFaults++;
        assert.equal(observer.getSnapshotRestoreRequest(update.id)?.state, "fenced");
        throw cleanup;
      }
      return originals.update.call(this, update);
    }));
    patches.push(t.mock.method(store, "listActiveRunScopes", function (...args) {
      const scopes = originals.active.apply(this, args);
      scopeCalls++;
      if (scopeCalls === 2 && !scenario.startsWith("bind_")) {
        assert.ok(acquired);
        assert.deepEqual(observer.getWorkspaceSnapshotFence(workspaceId), {
          epoch: acquired.epoch, ownerRequestId: acquired.ownerRequestId,
        });
        if (scenario === "postcheck_successor") advanceSuccessor(acquired.ownerRequestId);
        throw primary;
      }
      return scopes;
    }));
    patches.push(t.mock.method(store, "releaseWorkspaceSnapshotFence", function (id, owner, time, epoch) {
      releases.push({ workspaceId: id, ownerRequestId: owner, epoch });
      if (scenario.endsWith("release_throw")) { cleanupFaults++; throw cleanup; }
      return originals.release.call(this, id, owner, time, epoch);
    }));
    syncBuiltinESMExports();
    let result, error;
    try {
      result = scenario === "capture_release_throw" ? await snapshot.captureWorkspaceSnapshot(store, cwd)
        : await snapshot.restoreWorkspaceSnapshot(store, cwd, input);
    } catch (caught) { error = caught; }
    const request = observer.getSnapshotRestoreRequestByIdempotency(workspaceId, input.idempotencyKey);
    const fence = observer.getWorkspaceSnapshotFence(workspaceId);
    console.log(`A30 fence edge observation: ${JSON.stringify({ scenario, acquired, attempted, beforeClaim, successor, bindFaults, cleanupFaults,
      scopeCalls, releases, request, fence, rootScans, stagingWrites, mutations,
      error: errorFacts(error), errorLeaves: leaves(error).map(value => ({ message: value?.message, code: value?.code })) })}`);
    if (!scenario.startsWith("bind_")) assert.ok(acquired, "the intended owned fence must really be reached");
    assert.equal(result, undefined);
    assert.equal(stagingWrites, 0);
    assert.deepEqual(mutations, []);
    assert.equal(rootScans, scenario === "capture_release_throw" ? 0 : 1);
    assert.deepEqual(await facts(file), before);
    assert.deepEqual(observer.listWorkspaceSnapshotManifests({ workspaceId }), manifestsBefore);
    if (request) assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), []);
    if (scenario.startsWith("bind_")) assert.equal(bindFaults, 1);
    if (scenario === "bind_throw_before" || scenario === "bind_throw_after") {
      assert.equal(error, primary);
      assert.ok(attempted, "the actual pre-COMMIT transactional write boundary must be reached");
      assert.equal(acquired, undefined, "a rolled-back transaction never grants caller cleanup authority");
      assert.deepEqual(request, beforeClaim, "all request fields roll back, including state, epoch and time");
      assert.equal(request.state, "requested", "failure does not strand a validating/fenced intermediate");
      assert.deepEqual(fence, fenceBefore, "the exact prior durable lease must survive rollback");
      assert.deepEqual(releases, [], "no fabricated release receipt for a claim that never committed");
    } else if (scenario === "bind_false_successor" || scenario === "postcheck_successor") {
      if (scenario === "bind_false_successor") assert.equal(error?.code, "restore_claim_conflict");
      else assert.equal(error, primary);
      assert.deepEqual(request, successor.request, "old completion cannot rewrite the successor request");
      assert.deepEqual(fence, successor.fence, "old cleanup cannot release the successor epoch");
      assert.deepEqual(releases, []);
    } else if (scenario === "terminalization_throw" || scenario.endsWith("release_throw")) {
      assert.equal(cleanupFaults, 1);
      assert.ok(error instanceof AggregateError, "both original and cleanup failures must remain observable");
      assert.ok(leaves(error).includes(primary), "a finally failure must never erase the original failure");
      assert.ok(leaves(error).includes(cleanup));
      assert.equal(error.cause, primary);
      if (scenario === "terminalization_throw") {
        assert.equal(request.state, "fenced", "a failed database terminalization cannot be claimed successful");
        assert.deepEqual(fence, { epoch: acquired.epoch }, "no workspace effects permit exact lease release despite state cleanup error");
      } else {
        assert.deepEqual(fence, { epoch: acquired.epoch, ownerRequestId: acquired.ownerRequestId },
          "a release syscall failure cannot be reported as physically released");
        if (scenario === "restore_release_throw") assert.equal(request.state, "failed");
        else assert.equal(request, undefined);
      }
      assert.deepEqual(releases, [acquired]);
    } else assert.fail(`unhandled A30 failure edge: ${scenario}`);
    reopened = core.createSqliteRunStore(cwd);
    assert.deepEqual(reopened.getWorkspaceSnapshotFence(workspaceId), fence);
    if (request) assert.deepEqual(reopened.getSnapshotRestoreRequest(request.id), request);
  } finally {
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports(); globalThis.fetch = originalFetch;
    for (const candidate of [reopened, observer, store]) if (candidate?.database.isOpen) candidate.close();
  }
}

async function facts(path) {
  const stat = await fs.lstat(path);
  return { body: await fs.readFile(path, "utf8"), mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs };
}
function leaves(error) { return error instanceof AggregateError ? error.errors.flatMap(leaves) : [error]; }
function errorFacts(error) {
  return { name: error?.name, code: error?.code, message: error?.message,
    cause: error?.cause?.message, children: error instanceof AggregateError ? error.errors.map(errorFacts) : [] };
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A30_POSTCHECK_CASE";
const modes = ["post_scope_throw", "post_realpath_EACCES", "post_busy", "pre_scope_throw", "pre_busy"];
const scenarios = ["capture", "restore"].flatMap(kind => modes.map(mode => `${kind}:${mode}`));
const baselineBody = "A30 postcheck baseline\n";
const currentBody = "A30 postcheck current bytes must remain\n";

for (const scenario of scenarios) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(`A30 snapshot postcheck lifecycle: ${scenario}`, { timeout: 35_000 }, t =>
      process.env[caseEnv] ? exercise(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-a30-postcheck-")));
  const home = join(root, "home"), cwd = join(root, "workspace"), outside = join(root, "sibling");
  for (const path of [home, cwd, outside]) await fs.mkdir(path);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, LING_A30_POSTCHECK_SIBLING: outside, [caseEnv]: scenario },
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
    console.log(`A30 postcheck child actual exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A30 postcheck case entered: ${scenario}`));
    assert.ok(stdout.includes("A30 postcheck observation:"), "fixture setup is not the target failure");
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0, "require actual lifecycle assertions and owned cleanup to pass");
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a30-postcheck-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Real snapshot producer and SQLite fences; only the read failure is injected. */
async function exercise(t, scenario) {
  const [kind, mode] = scenario.split(":"), postcheck = mode.startsWith("post_");
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  const outside = process.env.LING_A30_POSTCHECK_SIBLING;
  assert.ok(cwd && home && outside && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A30 postcheck case entered: ${scenario}`);
  const patches = [t.mock.method(os, "homedir", () => home)];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A30 postcheck fixture forbids network access"); };
  syncBuiltinESMExports();
  let store, observer, reopened;
  try {
    const core = await import("../../core/dist/index.js");
    const snapshot = await import("../dist/features/runs/workspace-snapshot-restore.js");
    store = core.createSqliteRunStore(cwd);
    observer = core.createSqliteRunStore(cwd);
    const file = join(cwd, "project.txt");
    await fs.writeFile(file, baselineBody, { mode: 0o600 });
    const baseline = await snapshot.captureWorkspaceSnapshot(store, cwd);
    await fs.writeFile(file, currentBody);
    const anchor = await snapshot.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, baseline.manifest.id);
    const now = new Date().toISOString(), workspaceId = baseline.manifest.workspaceId;
    const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId, anchorId: anchor.id,
      snapshotId: baseline.manifest.id, createdAt: now });
    assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
    const restoreInput = { idempotencyKey: `a30-postcheck-${scenario}`, anchorId: anchor.id,
      snapshotId: baseline.manifest.id, confirmationId: confirmation.id };
    const before = await fileFacts(file);
    const manifestsBefore = observer.listWorkspaceSnapshotManifests({ workspaceId });
    const fenceBefore = observer.getWorkspaceSnapshotFence(workspaceId);
    assert.equal(fenceBefore.ownerRequestId, undefined);

    if (mode === "pre_busy") seedRun(observer, cwd, "a30-precheck-real-run");
    if (mode === "post_realpath_EACCES") seedRun(observer, outside, "a30-sibling-real-run");
    const injectedError = Object.assign(new Error(`A30 owned ${mode} read failure`), {
      code: mode === "post_realpath_EACCES" ? "EACCES" : "EIO",
    });
    const originals = { active: store.listActiveRunScopes, acquire: store.acquireWorkspaceSnapshotFence,
      claim: store.claimSnapshotRestoreFence,
      release: store.releaseWorkspaceSnapshotFence, realpath: fs.realpath };
    let scopeCalls = 0, realpathCalls = 0, atFault;
    const acquired = [], releases = [];
    const effects = observeEffects(t, cwd, store.paths.snapshotStagingDir, patches);
    const observeFaultBoundary = () => {
      const fence = observer.getWorkspaceSnapshotFence(workspaceId);
      if (postcheck) {
        assert.equal(acquired.length, 1, "failure must be after a genuine acquire, never only the precheck");
        assert.equal(fence.ownerRequestId, acquired[0].ownerRequestId);
        assert.equal(fence.epoch, acquired[0].epoch);
        assert.ok(fence.epoch > fenceBefore.epoch);
      } else assert.deepEqual(fence, fenceBefore, "a precheck failure must not claim the fence");
      atFault = { fence, effects: effects() };
    };
    patches.push(t.mock.method(store, "listActiveRunScopes", function (...args) {
      scopeCalls++;
      const scopes = originals.active.apply(this, args);
      if ((mode === "pre_scope_throw" && scopeCalls === 1) || (mode === "post_scope_throw" && scopeCalls === 2)) {
        observeFaultBoundary();
        throw injectedError;
      }
      if ((mode === "pre_busy" && scopeCalls === 1) || (mode === "post_busy" && scopeCalls === 2)) {
        assert.ok(scopes.some(scope => scope.cwd === cwd), "busy is a real SQLite Run, not a fabricated boolean");
        observeFaultBoundary();
      }
      return scopes;
    }));
    patches.push(t.mock.method(store, "acquireWorkspaceSnapshotFence", function (id, ownerRequestId, time) {
      if (mode === "post_busy") {
        // Reproduce the admission race using the real second connection before
        // the real durable acquire. The postcheck must see its actual queued Run.
        seedRun(observer, cwd, "a30-raced-real-run");
      }
      const epoch = originals.acquire.call(this, id, ownerRequestId, time);
      const fence = observer.getWorkspaceSnapshotFence(id);
      assert.deepEqual(fence, { epoch, ownerRequestId });
      acquired.push({ workspaceId: id, ownerRequestId, epoch });
      return epoch;
    }));
    patches.push(t.mock.method(store, "claimSnapshotRestoreFence", function (input) {
      if (mode === "post_busy") seedRun(observer, cwd, "a30-raced-real-run");
      const request = observer.getSnapshotRestoreRequest(input.requestId);
      assert.equal(request?.state, input.expectedState);
      assert.equal(request.fencingEpoch, input.expectedRequestFencingEpoch);
      const epoch = originals.claim.call(this, input);
      assert.notEqual(epoch, undefined);
      assert.deepEqual(observer.getWorkspaceSnapshotFence(request.workspaceId), { epoch, ownerRequestId: request.id });
      assert.equal(observer.getSnapshotRestoreRequest(request.id)?.state, "fenced");
      acquired.push({ workspaceId: request.workspaceId, ownerRequestId: request.id, epoch });
      return epoch;
    }));
    patches.push(t.mock.method(store, "releaseWorkspaceSnapshotFence", function (id, ownerRequestId, time, epoch) {
      const beforeRelease = observer.getWorkspaceSnapshotFence(id);
      const released = originals.release.call(this, id, ownerRequestId, time, epoch);
      releases.push({ workspaceId: id, ownerRequestId, epoch, beforeRelease, released });
      return released;
    }));
    patches.push(t.mock.method(fs, "realpath", async function (path, ...args) {
      if (mode === "post_realpath_EACCES" && path === outside && ++realpathCalls === 2) {
        observeFaultBoundary();
        throw injectedError;
      }
      return originals.realpath.call(this, path, ...args);
    }));
    syncBuiltinESMExports();
    let result, error;
    try {
      result = kind === "capture" ? await snapshot.captureWorkspaceSnapshot(store, cwd)
        : await snapshot.restoreWorkspaceSnapshot(store, cwd, restoreInput);
    } catch (caught) { error = caught; }
    const request = observer.getSnapshotRestoreRequestByIdempotency(workspaceId, restoreInput.idempotencyKey);
    const fenceAfter = observer.getWorkspaceSnapshotFence(workspaceId), effectsAfter = effects();
    console.log(`A30 postcheck observation: ${JSON.stringify({ scenario, scopeCalls, realpathCalls,
      acquired, releases, atFault, fenceBefore, fenceAfter, error: { code: error?.code, message: error?.message },
      requestState: request?.state, requestEpoch: request?.fencingEpoch, effectsAfter })}`);
    assert.ok(atFault, "the exact intended pre/postcheck boundary must really be reached");
    assert.equal(result, undefined);
    if (mode.endsWith("busy")) {
      assert.equal(error?.code, "workspace_busy");
      assert.equal(error.statusCode, 409);
    } else assert.equal(error, injectedError, "release and terminalization must preserve the original read error");
    assert.equal(scopeCalls, postcheck ? 2 : 1);
    if (mode === "post_realpath_EACCES") assert.equal(realpathCalls, 2);
    assert.deepEqual(effectsAfter, atFault.effects, "nothing may scan/stage or modify the workspace after rejection");
    assert.equal(effectsAfter.stagingWrites, 0);
    assert.deepEqual(effectsAfter.mutations, [], "preflight failures must not attempt any workspace syscall effects");
    assert.equal(effectsAfter.rootScans, postcheck && kind === "restore" ? 1 : 0,
      "restore's read-only fingerprint preflight is allowed; the fenced operation must never begin");
    assert.deepEqual(await fileFacts(file), before);
    assert.deepEqual(observer.listWorkspaceSnapshotManifests({ workspaceId }), manifestsBefore);
    if (!postcheck) {
      assert.deepEqual(acquired, []);
      assert.deepEqual(releases, []);
      assert.deepEqual(fenceAfter, fenceBefore);
      assert.equal(request, undefined, "precheck rejection must not expose a restore request");
    } else {
      assert.equal(acquired.length, 1);
      assert.equal(releases.length, 1, "release exactly the acquired lease, not an unscoped or repeated owner");
      assert.deepEqual(releases[0], { ...acquired[0], beforeRelease: {
        epoch: acquired[0].epoch, ownerRequestId: acquired[0].ownerRequestId,
      }, released: true });
      assert.deepEqual(fenceAfter, { epoch: acquired[0].epoch }, "never strand an acquired owner after postcheck rejection");
      if (kind === "restore") {
        assert.equal(request?.state, "failed", "a no-effect postcheck rejection must never remain stuck validating");
        assert.equal(request.fencingEpoch, acquired[0].epoch, "failed outcome retains its genuine fence lineage");
        assert.equal(acquired[0].ownerRequestId, request.id);
        assert.ok(request.lastError, "the terminal request retains the failure diagnosis");
        assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), []);
      } else assert.equal(request, undefined);
    }
    // Verify durable cleanup, not just an in-memory return shape.
    reopened = core.createSqliteRunStore(cwd);
    assert.deepEqual(reopened.getWorkspaceSnapshotFence(workspaceId), fenceAfter);
    if (request) assert.deepEqual(reopened.getSnapshotRestoreRequest(request.id), request);
  } finally {
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    for (const candidate of [reopened, observer, store]) if (candidate?.database.isOpen) candidate.close();
  }
}

function seedRun(store, cwd, id) {
  return store.createRun({ id, cwd, taskId: `task-${id}`, providerName: "isolated-fixture", providerModel: "no-model",
    taskSnapshot: { id: `task-${id}`, title: "A30 real admission race", prompt: "No model or tool dispatch" },
    providerSnapshot: {}, requestSnapshot: { tools: ["read"], workspaceAccessMode: "read_only" },
    createdAt: "2026-01-01T00:00:00.000Z" });
}

function observeEffects(t, root, stagingDir, patches) {
  let rootScans = 0, stagingWrites = 0;
  const mutations = [];
  const actualReaddir = fs.readdir, actualCreateWriteStream = nativeFs.createWriteStream;
  const inWorkspace = path => typeof path === "string" && (path === root || path.startsWith(`${root}/`));
  patches.push(t.mock.method(fs, "readdir", async function (path, options) {
    if (path === root && options?.withFileTypes === true) rootScans++;
    return actualReaddir.call(this, path, options);
  }));
  patches.push(t.mock.method(nativeFs, "createWriteStream", function (path, ...args) {
    if (typeof path === "string" && path.startsWith(`${stagingDir}/`)) stagingWrites++;
    if (inWorkspace(path)) mutations.push({ operation: "createWriteStream", path });
    return actualCreateWriteStream.call(this, path, ...args);
  }));
  for (const name of ["rename", "unlink", "chmod", "rm", "rmdir", "mkdir", "symlink"]) {
    const original = fs[name];
    patches.push(t.mock.method(fs, name, function (...args) {
      if (inWorkspace(args[0]) || (name === "rename" || name === "symlink") && inWorkspace(args[1])) {
        mutations.push({ operation: name, path: String(args[0]), destination: String(args[1] ?? "") });
      }
      return original.apply(this, args);
    }));
  }
  return () => ({ rootScans, stagingWrites, mutations: [...mutations] });
}

async function fileFacts(path) {
  const stat = await fs.lstat(path);
  return { body: await fs.readFile(path, "utf8"), mode: stat.mode & 0o777, size: stat.size, mtimeMs: stat.mtimeMs };
}

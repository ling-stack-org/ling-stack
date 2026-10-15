import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const caseEnv = "LING_A25_PARTIAL_CASE";
const terminalStates = new Set(["committed", "failed", "conflict", "expired", "recovery_required"]);
const names = {
  symlink: "A25 public restore accounts for real remove before symlink failure",
  chmod: "A25 public restore accounts for real rename before chmod failure",
};

test(names.symlink, { timeout: 60_000 }, t => runOwnedCase(t, "symlink"));
test(names.chmod, { timeout: 60_000 }, t => runOwnedCase(t, "chmod"));

/** Builtin hooks are child-local; no API credential or daily user home is inherited. */
async function runOwnedCase(t, scenario) {
  if (process.env[caseEnv]) {
    assert.equal(process.env[caseEnv], scenario);
    return exercisePublicRestore(t, scenario);
  }
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a25-${scenario}-`)));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await fs.mkdir(home); await fs.mkdir(cwd);
  try {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern", `^${names[scenario]}$`, fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", LING_STACK_HOME: home,
        LING_STACK_DEFAULT_WORKSPACE_CWD: cwd, [caseEnv]: scenario },
      stdio: ["ignore", "pipe", "pipe"], timeout: 45_000,
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
    console.log(`A25 child exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A25 real public restore entered: ${scenario}`));
    assert.equal(exit.signal, null, "the owned child must settle, not be killed");
    assert.equal(exit.code, 0, `${scenario}: actual public restore regression failed`);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a25-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Keep actual routes, confirmation, SQLite, blob storage and restore implementation. */
async function exercisePublicRestore(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  for (const path of [cwd, home]) {
    assert.ok(path && isAbsolute(path) && resolve(path) === path && path !== "/" && path !== process.cwd());
    assert.equal((await fs.stat(path)).isDirectory(), true);
  }
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A25 real public restore entered: ${scenario}`);
  const previousUmask = process.umask(0o022);
  const actual = { lstat: fs.lstat, readFile: fs.readFile, readdir: fs.readdir, readlink: fs.readlink,
    unlink: fs.unlink, symlink: fs.symlink, rename: fs.rename, chmod: fs.chmod };
  const prior = join(cwd, "a-prior.txt"), target = join(cwd, "y-target.txt"), victim = join(cwd, "z-victim.txt");
  const observations = { faultCalls: 0, unlinkCompleted: false, renameCompleted: false };
  let armed = false, allowedOrigin, daemon, store, reopened, restoredHooks = false;
  const patches = [];
  const originalFetch = globalThis.fetch;
  let blockedFetches = 0, modelCalls = 0;
  function restoreHooks() {
    if (restoredHooks) return;
    restoredHooks = true;
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    process.umask(previousUmask);
  }
  t.after(restoreHooks);
  patches.push(t.mock.method(os, "homedir", () => home));
  if (scenario === "symlink") {
    patches.push(t.mock.method(fs, "unlink", async function (path, ...args) {
      const result = await actual.unlink.call(this, path, ...args);
      if (armed && path === victim && observations.faultCalls === 0) observations.unlinkCompleted = true;
      return result;
    }));
    patches.push(t.mock.method(fs, "symlink", async function (linkTarget, path, ...args) {
      if (armed && path === victim && observations.faultCalls === 0) {
        observations.faultCalls++;
        observations.linkTarget = linkTarget;
        try { observations.victimAtFault = await readFact(actual, victim); }
        catch (error) { if (error.code !== "ENOENT") throw error; observations.victimAtFault = null; }
        observations.priorAtFault = await readFact(actual, prior);
        throw Object.assign(new Error("A25 injected symlink failure after real remove"), { code: "EIO" });
      }
      return actual.symlink.call(this, linkTarget, path, ...args);
    }));
  } else {
    patches.push(t.mock.method(fs, "rename", async function (source, destination, ...args) {
      const result = await actual.rename.call(this, source, destination, ...args);
      if (armed && destination === victim && typeof source === "string" && source.startsWith(`${victim}.ling-restore-`)) {
        observations.renameCompleted = true;
      }
      return result;
    }));
    patches.push(t.mock.method(fs, "chmod", async function (path, mode, ...args) {
      if (armed && path === victim && observations.faultCalls === 0) {
        observations.faultCalls++;
        observations.requestedMode = mode;
        observations.victimAtFault = await readFact(actual, victim);
        observations.priorAtFault = await readFact(actual, prior);
        throw Object.assign(new Error("A25 injected chmod failure after real rename"), { code: "EIO" });
      }
      return actual.chmod.call(this, path, mode, ...args);
    }));
  }
  syncBuiltinESMExports();
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!allowedOrigin || url.origin !== allowedOrigin) {
      blockedFetches++;
      throw new Error("A25 refuses non-owned HTTP requests");
    }
    return originalFetch.call(this, input, init);
  };
  try {
    // Dynamic imports occur only in the owned child after builtin hooks are installed.
    const core = await import("../../core/dist/index.js");
    const { createDaemonServer } = await import("../dist/index.js");
    const { reconcileWorkspaceSnapshotRestore } = await import("../dist/features/runs/workspace-snapshot-restore.js");
    const secretResolver = core.createCompositeSecretResolver({ env: {} });
    const externalSecretStore = { ...secretResolver,
      setSecret() { throw new Error("A25 forbids external secret writes"); },
      deleteSecret() { throw new Error("A25 forbids external secret deletes"); } };
    await fs.writeFile(prior, "baseline prior\n", { mode: 0o600 });
    await fs.writeFile(target, "internal link target\n", { mode: 0o600 });
    if (scenario === "symlink") await actual.symlink("y-target.txt", victim);
    else await fs.writeFile(victim, "baseline victim\n", { mode: 0o600 });
    const baselineFacts = await workspaceFacts(actual, cwd);
    daemon = createDaemonServer({
      host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false },
      cuaDriver: { bundledEmbedded: { darwin: false, win32: false }, packagedProvider: { darwin: false, win32: false } },
      workspaceSnapshots: { captureEnabled: true, restoreEnabled: true, restoreUiEnabled: true },
    }, {
      secretResolver, externalSecretStore, chromeBrowserNativeMessagingEnabled: false,
      runner: { async runTask() { modelCalls++; throw new Error("A25 forbids model execution"); } },
      storeFactory(storeCwd) {
        assert.equal(resolve(storeCwd), cwd, "A25 may open only its owned workspace SQLite");
        store = core.createSqliteRunStore(storeCwd);
        return store;
      },
    });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    allowedOrigin = `http://127.0.0.1:${address.port}`;
    assert.equal(store.paths.databasePath, join(cwd, ".ling-stack", "ling-stack.sqlite"));
    const request = (path, body, expected = 200) => publicJson(allowedOrigin, cwd, path, body, expected);
    const captured = await request("/workspace/snapshots", {}, 201);
    assert.equal(captured.manifest.state, "committed");
    assert.equal(captured.entries.find(entry => entry.relativePath === "z-victim.txt")?.managed, true);
    assert.equal(captured.entries.find(entry => entry.relativePath === "z-victim.txt")?.kind, scenario === "symlink" ? "symlink" : "file");
    await fs.writeFile(prior, "current prior preimage\n");
    await actual.chmod(prior, 0o640);
    if (scenario === "symlink") await actual.unlink(victim);
    await fs.writeFile(victim, "current victim preimage\n");
    await actual.chmod(victim, 0o640);
    const beforeFacts = await workspaceFacts(actual, cwd);
    const anchor = await request(`/workspace/snapshots/${captured.manifest.id}/anchors`, {}, 201);
    const pending = await request(`/workspace/snapshots/${captured.manifest.id}/confirmations`, { anchorId: anchor.id }, 201);
    assert.equal(pending.state, "pending");
    const confirmation = await request(`/workspace/snapshot-confirmations/${pending.id}/confirm`, { state: "confirmed" });
    assert.equal(confirmation.state, "confirmed");
    armed = true;
    const queued = await request(`/workspace/snapshots/${captured.manifest.id}/restore`, {
      idempotencyKey: `a25-${scenario}`, anchorId: anchor.id, confirmationId: confirmation.id,
    }, 202);
    const settled = await pollTerminal(() => request(`/workspace/snapshot-restores/${queued.id}`));
    armed = false;
    const afterFacts = await workspaceFacts(actual, cwd);
    const durable = await inspectDurable(store, actual, queued.id);
    await daemon.stop(); daemon = undefined;
    restoreHooks();
    reopened = core.createSqliteRunStore(cwd);
    const afterReopen = await inspectDurable(reopened, actual, queued.id);
    const reconciled = await reconcileWorkspaceSnapshotRestore(reopened, cwd, queued.id);
    const afterReconcile = await inspectDurable(reopened, actual, queued.id);
    const reconciledFacts = await workspaceFacts(actual, cwd);
    console.log(`A25 partial-effect evidence: ${JSON.stringify({ scenario, observations, publicState: settled.state,
      beforeFacts, afterFacts, durable, afterReopen, reconciledState: reconciled.state, afterReconcile, reconciledFacts })}`);

    assert.equal(blockedFetches, 0, "no external network request may be attempted");
    assert.equal(modelCalls, 0);
    assert.equal(observations.faultCalls, 1, "the exact owned syscall fault must actually fire");
    assert.deepEqual(observations.priorAtFault, baselineFacts["a-prior.txt"], "a preceding entry must really have been applied before the fault");
    if (scenario === "symlink") {
      assert.equal(observations.unlinkCompleted, true, "native unlink must finish before injected symlink failure");
      assert.equal(observations.linkTarget, "y-target.txt");
      assert.equal(observations.victimAtFault, null, "the current file must already be absent when symlink fails");
    } else {
      assert.equal(observations.renameCompleted, true, "native file replacement must finish before injected chmod failure");
      assert.equal(observations.requestedMode, 0o600);
      assert.equal(observations.victimAtFault.content, baselineFacts["z-victim.txt"].content);
      assert.equal(observations.victimAtFault.mode, 0o644, "the injected failure precedes target-mode installation, not a no-effect failure");
    }
    assert.equal(durable.request.state, settled.state);
    assert.deepEqual(afterReopen, durable, "request, journal, preimages and fence must survive a real SQLite close/reopen");
    assert.deepEqual(afterReconcile, durable, "a terminal public result must not be silently reclassified on reopen/reconcile");
    assert.deepEqual(reconciledFacts, afterFacts, "reconciliation must not guess which partial paths to overwrite");
    assert.equal(durable.journal.length, durable.request.journalEntryCount);
    assert.ok(durable.journal.length >= 3);
    assert.equal(durable.fence.epoch, durable.request.fencingEpoch);
    assert.ok(durable.fence.ownerRequestId === undefined || durable.fence.ownerRequestId === queued.id,
      "the recovery fence must never name another owner");
    for (const path of ["a-prior.txt", "z-victim.txt"]) {
      const entry = durable.journal.find(value => value.relativePath === path);
      assert.ok(entry, `a durable preimage journal is required for ${path}`);
      assert.equal(entry.rollbackBlobSha256, sha256(beforeFacts[path].content));
      assert.equal(entry.rollbackMode, beforeFacts[path].mode);
      assert.equal(durable.preimages[path].content, beforeFacts[path].content);
      assert.equal(durable.preimages[path].registered, true);
    }
    // Both outcomes are safe: fully verified rollback, or a visible unresolved
    // recovery with its genuine preimages. Never require blind rollback over
    // an observed state that no longer matches this request's target digest.
    assert.ok(["failed", "recovery_required"].includes(settled.state), "an injected partial failure cannot be reported committed/conflict/expired");
    assert.match(durable.request.lastError ?? "", /A25 injected (symlink|chmod) failure/u);
    if (settled.state === "failed") {
      assert.deepEqual(afterFacts, beforeFacts, "ordinary failed is safe only after every before-state, including mode and missing paths, is restored");
      assert.equal(durable.fence.ownerRequestId, undefined, "a fully rolled-back failed request releases its fence");
    } else {
      const victimEntry = durable.journal.find(value => value.relativePath === "z-victim.txt");
      if (JSON.stringify(afterFacts) !== JSON.stringify(beforeFacts)) {
        assert.notEqual(victimEntry.state, "rolled_back", "a partial victim must not claim verified rollback");
      }
    }
  } finally {
    armed = false;
    if (daemon) await daemon.stop();
    reopened?.close();
    restoreHooks();
  }
}

async function publicJson(origin, cwd, path, body, expected) {
  const response = await fetch(`${origin}${path}?cwd=${encodeURIComponent(cwd)}`, {
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return JSON.parse(text);
}

async function pollTerminal(read) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (terminalStates.has(value.state)) return value;
    await new Promise(done => setTimeout(done, 10));
  }
  assert.fail("the actual background restore did not reach a durable terminal result");
}

async function inspectDurable(store, actual, id) {
  const request = store.getSnapshotRestoreRequest(id);
  assert.ok(request);
  const journal = store.listSnapshotRestoreJournalEntries({ restoreRequestId: id, limit: 100_000 });
  const preimages = {};
  for (const entry of journal) {
    if (!entry.rollbackBlobSha256) continue;
    preimages[entry.relativePath] = {
      registered: Boolean(store.getWorkspaceSnapshotBlob(entry.rollbackBlobSha256)),
      content: await actual.readFile(join(store.paths.snapshotBlobsDir, entry.rollbackBlobSha256), "utf8"),
    };
  }
  return { request, journal, preimages, fence: store.getWorkspaceSnapshotFence(request.workspaceId) };
}

async function workspaceFacts(actual, cwd) {
  const facts = {};
  for (const name of (await actual.readdir(cwd)).filter(value => value !== ".ling-stack").sort()) {
    facts[name] = await readFact(actual, join(cwd, name));
  }
  return facts;
}

async function readFact(actual, path) {
  const info = await actual.lstat(path);
  if (info.isSymbolicLink()) return { kind: "symlink", target: await actual.readlink(path) };
  if (info.isFile()) return { kind: "file", mode: info.mode & 0o777, content: await actual.readFile(path, "utf8") };
  if (info.isDirectory()) return { kind: "directory", mode: info.mode & 0o777 };
  assert.fail("A25 fixture encountered an unsupported owned entry");
}

function sha256(content) { return createHash("sha256").update(content).digest("hex"); }

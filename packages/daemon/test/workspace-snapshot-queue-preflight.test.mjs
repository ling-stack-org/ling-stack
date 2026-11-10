import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const caseEnv = "LING_A25_QUEUE_PREFLIGHT_CASE";
const cases = {
  fingerprint: "A25 an admitted queued preflight fingerprint conflict is durably terminal",
  scan_error: "A25 an admitted queued preflight I/O failure is durably failed without effects",
  success: "A25 an admitted queued worker still commits exactly one real restore",
};
for (const [scenario, name] of Object.entries(cases)) {
  if (!process.env[caseEnv] || process.env[caseEnv] === scenario) {
    test(name, { timeout: 45_000 }, t => process.env[caseEnv] ? exercise(t, scenario) : runOwnedChild(scenario));
  }
}

async function runOwnedChild(scenario) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), `ling-a25-queue-preflight-${scenario}-`)));
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
    console.log(`A25 queue preflight child exit: ${JSON.stringify({ scenario, ...exit })}`);
    assert.ok(stdout.includes(`A25 queue preflight case entered: ${scenario}`));
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
  } finally {
    assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-a25-queue-preflight-${scenario}-`));
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Fault only the real scan; request, worker, lock, confirmation and SQLite stay real. */
async function exercise(t, scenario) {
  const cwd = process.env.LING_STACK_DEFAULT_WORKSPACE_CWD, home = process.env.LING_STACK_HOME;
  assert.ok(cwd && home && cwd !== process.cwd());
  assert.deepEqual(Object.keys(process.env).filter(key => /API_?KEY|TOKEN|SECRET|BASE_URL/iu.test(key)), []);
  console.log(`A25 queue preflight case entered: ${scenario}`);
  const actual = { readdir: fs.readdir, readFile: fs.readFile, lstat: fs.lstat };
  let armed = false, faultCalls = 0, store, observer, reopened;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("A25 queue preflight test forbids network access"); };
  const patches = [t.mock.method(os, "homedir", () => home)];
  patches.push(t.mock.method(fs, "readdir", async function (path, options) {
    const children = await actual.readdir.call(this, path, options);
    if (armed && scenario === "scan_error" && path === cwd && options?.withFileTypes === true) {
      armed = false; faultCalls++;
      throw Object.assign(new Error("A25 injected real preflight scan I/O failure"), { code: "EIO" });
    }
    return children;
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
    await fs.chmod(victim, 0o640);
    const anchor = await restore.createWorkspaceSnapshotUserRestoreAnchor(store, cwd, snapshot.manifest.id);
    const now = new Date().toISOString();
    const confirmation = store.createSnapshotRestoreConfirmation({ workspaceId: snapshot.manifest.workspaceId,
      anchorId: anchor.id, snapshotId: snapshot.manifest.id, createdAt: now });
    assert.equal(store.resolveSnapshotRestoreConfirmation(confirmation.id, "confirmed", now)?.state, "confirmed");
    const input = { idempotencyKey: `a25-queue-preflight-${scenario}`, anchorId: anchor.id,
      snapshotId: snapshot.manifest.id, confirmationId: confirmation.id };
    if (scenario === "fingerprint") await fs.writeFile(victim, "external preflight content\n");
    const before = { content: await actual.readFile(victim, "utf8"), mode: (await actual.lstat(victim)).mode & 0o777 };
    observer = core.createSqliteRunStore(cwd);
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), false);
    armed = true;
    const accepted = await restore.queueWorkspaceSnapshotRestore(store, cwd, input);
    const terminal = new Set(["committed", "failed", "conflict", "expired", "recovery_required"]);
    const deadline = Date.now() + 10_000;
    let request;
    do {
      request = observer.getSnapshotRestoreRequest(accepted.id);
      if (terminal.has(request?.state) && !await restore.isWorkspaceSnapshotRestoreActive(cwd)) break;
      await pause(10);
    } while (Date.now() < deadline);
    armed = false;
    assert.ok(request && terminal.has(request.state), "a genuinely admitted failed job cannot remain requested forever");
    assert.equal(await restore.isWorkspaceSnapshotRestoreActive(cwd), false);
    assert.equal(request.id, accepted.id);
    const journal = observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id });
    const fence = observer.getWorkspaceSnapshotFence(request.workspaceId);
    assert.equal(fence.ownerRequestId, undefined);
    if (scenario === "success") {
      assert.equal(request.state, "committed");
      assert.equal(faultCalls, 0);
      assert.equal(await actual.readFile(victim, "utf8"), "baseline project\n");
      assert.equal((await actual.lstat(victim)).mode & 0o777, 0o600);
      assert.equal(journal.length, 1);
      assert.equal(journal[0].state, "applied");
      assert.equal(journal[0].relativePath, "project.txt");
      const replay = await restore.queueWorkspaceSnapshotRestore(store, cwd, input);
      assert.equal(replay.id, request.id);
      assert.equal(replay.state, "committed");
      assert.deepEqual(observer.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }), journal);
    } else {
      assert.equal(request.state, scenario === "fingerprint" ? "conflict" : "failed");
      assert.equal(request.fencingEpoch, 0, "the owned preflight failure precedes restore epoch publication");
      assert.equal(faultCalls, scenario === "scan_error" ? 1 : 0);
      assert.match(request.lastError ?? "", scenario === "fingerprint"
        ? /Workspace fingerprint changed/u : /A25 injected real preflight scan I\/O failure/u);
      assert.deepEqual(journal, [], "no workspace operation or journal is fabricated for a preflight failure");
      assert.deepEqual({ content: await actual.readFile(victim, "utf8"), mode: (await actual.lstat(victim)).mode & 0o777 }, before);
      await assert.rejects(() => restore.queueWorkspaceSnapshotRestore(store, cwd, input), error => error.code === "restore_terminal");
    }
    assert.equal(observer.listSnapshotRestoreRequests({ workspaceId: request.workspaceId }).length, 1);
    const durable = { request, journal, fence };
    observer.close(); observer = undefined;
    store.close(); store = undefined;
    reopened = core.createSqliteRunStore(cwd);
    assert.deepEqual({ request: reopened.getSnapshotRestoreRequest(request.id),
      journal: reopened.listSnapshotRestoreJournalEntries({ restoreRequestId: request.id }),
      fence: reopened.getWorkspaceSnapshotFence(request.workspaceId) }, durable,
    "owned preflight outcomes and normal completion survive real SQLite close/reopen");
    console.log(`A25 queue preflight evidence: ${JSON.stringify({ scenario, request, journal, fence, faultCalls })}`);
  } finally {
    armed = false;
    for (const candidate of [reopened, observer, store]) if (candidate?.database.isOpen) candidate.close();
    for (const patch of patches.reverse()) patch.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
  }
}

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";

const prefix = "ling-a31-owner-release-failure-";

/** Do not infer retained ownership from a PID projection: ask real SQLite. */
function assertIndependentSqliteWriterIsBusy(sidecar) {
  const contender = new DatabaseSync(sidecar);
  let began = false;
  try {
    contender.exec("PRAGMA busy_timeout=0");
    assert.throws(() => {
      contender.exec("BEGIN IMMEDIATE");
      began = true;
    }, error => typeof error?.errcode === "number" && (error.errcode & 0xff) === 5,
    "failed metadata cleanup must retain the real SQLite writer lease, not only a live PID file");
  } finally {
    if (began) contender.exec("ROLLBACK");
    contender.close();
  }
}

function includesCause(error, expected) {
  if (error === expected) return true;
  return error instanceof AggregateError && error.errors.some(entry => includesCause(entry, expected));
}

// The reviewer authored this independent fault candidate but does not execute it.
// No faked FD/SQLite result: exactly one own-path unlink is refused before IO.
test("A31 one metadata unlink failure retains ownership until retry and old release never deletes a successor", async t => {
  const temporaryParent = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryParent, prefix));
  const cwd = join(root, "workspace");
  fs.mkdirSync(cwd);
  const paths = resolveStoragePaths(cwd, { userRootDir: join(root, "ling-home"), workspaceStateLocation: "user-data-dir" }).workspace;
  const store = createSqliteRunStore(cwd, paths);
  const config = { host: "127.0.0.1", port: 17_032, defaultWorkspaceCwd: cwd,
    runners: {}, runtimeTools: {}, channels: {},
    transports: { providerWebSocketFallback: true, localWebSocketRpc: true } };
  const owner = new RuntimeSupervisor(config);
  const successor = new RuntimeSupervisor(config);
  const lockPath = join(paths.rootDir, "runtime.lock");
  const sidecar = `${lockPath}.coordination.sqlite`;
  const originalUnlink = fs.unlinkSync;
  const refusal = Object.assign(new Error("a31_owned_metadata_unlink_denied_once"), { code: "EACCES" });
  let attempts = 0;
  let armed = true;
  try {
    const firstRuntime = owner.getRuntime(cwd, store);
    const originalBytes = await readFile(lockPath, "utf8");
    t.mock.method(fs, "unlinkSync", function(path, ...args) {
      if (String(path) === lockPath) {
        attempts += 1;
        if (armed) { armed = false; throw refusal; }
      }
      return originalUnlink.call(this, path, ...args);
    });
    syncBuiltinESMExports();

    assert.throws(() => owner.releaseAll(), error => includesCause(error, refusal),
      "preserve the actual EACCES inside the lifecycle failure");
    assert.equal(attempts, 1);
    assert.equal(await readFile(lockPath, "utf8"), originalBytes, "the injected failure did not perform unlink");
    assertIndependentSqliteWriterIsBusy(sidecar);
    assert.throws(() => successor.getRuntime(cwd, store), error => error?.code === "runtime_already_running");
    assert.equal(await readFile(lockPath, "utf8"), originalBytes, "a denied successor cannot replace the failed owner's projection");

    owner.releaseAll();
    assert.equal(attempts, 2, "the same retained owner retries only its exact projection");
    assert.equal(fs.existsSync(lockPath), false);
    const successorRuntime = successor.getRuntime(cwd, store);
    assert.notEqual(successorRuntime.runtimeInstanceId, firstRuntime.runtimeInstanceId);
    const successorBytes = await readFile(lockPath, "utf8");

    owner.releaseAll();
    assert.equal(attempts, 2, "a fully retired old owner must not attempt to unlink any pathname again");
    assert.equal(await readFile(lockPath, "utf8"), successorBytes);
    assert.equal(successor.getRuntime(cwd, store).runtimeInstanceId, successorRuntime.runtimeInstanceId);
    assertIndependentSqliteWriterIsBusy(sidecar);
    successor.releaseAll();
    assert.equal(attempts, 3, "only the successor removes its own projection");
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try { owner.releaseAll(); }
    finally {
      try { successor.releaseAll(); }
      finally {
        store.close();
        assert.equal(dirname(root), temporaryParent);
        assert.ok(basename(root).startsWith(prefix));
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

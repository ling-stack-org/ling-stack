import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveUserConfigPaths } from "../dist/runtime-paths.js";
import { ExecutionEngineProfileStore } from "../dist/storage/execution-engine-profile-store.js";

const configuration = { engineId: "kimi-acp", executablePath: process.execPath,
  authProfileId: "original", kimiLoginRegion: "global" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ling-auth-generation-"));
  const paths = resolveUserConfigPaths({ userRootDir: root });
  const store = new ExecutionEngineProfileStore(paths);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store };
}

test("a disconnected authentication generation cannot be re-adopted by a current save", t => {
  const { store } = fixture(t);
  const original = store.save(configuration, 0);
  const disconnected = store.disconnect(configuration.engineId, original.revision);
  assert.deepEqual(disconnected.configuration, configuration);
  const restored = store.save(configuration, disconnected.revision);
  assert.notEqual(restored.configuration.authProfileId, original.configuration.authProfileId);
  assert.equal(restored.id, original.id);
  assert.deepEqual({ ...restored.configuration, authProfileId: "original" }, configuration);
  assert.deepEqual(store.save(restored.configuration, restored.revision), restored);
});

test("authentication retirement survives store reopen and several replacements", t => {
  const { store, paths } = fixture(t);
  const first = store.save(configuration, 0);
  const second = store.save({ ...configuration, authProfileId: "second" }, first.revision);
  const third = store.save({ ...configuration, authProfileId: "third" }, second.revision);
  const reopened = new ExecutionEngineProfileStore(paths);
  t.after(() => reopened.close());
  const next = reopened.save(first.configuration, third.revision);
  assert.ok(!["original", "second", "third"].includes(next.configuration.authProfileId));
  const again = store.save(second.configuration, next.revision);
  assert.ok(!["original", "second", "third", next.configuration.authProfileId].includes(again.configuration.authProfileId));
  assert.equal(again.id, first.id);
});

test("failed profile preparation rolls back retirement as well as configuration", t => {
  const { store } = fixture(t);
  const first = store.save(configuration, 0);
  assert.throws(() => store.save({ ...configuration, authProfileId: "replacement" }, first.revision,
    () => { throw Error("prepare-failed"); }), /prepare-failed/);
  assert.deepEqual(store.save(configuration, first.revision), first);
  let publications = 0;
  store.commitAuthRefresh(first, () => { publications++; });
  assert.equal(publications, 1);
  const second = store.save({ ...configuration, authProfileId: "replacement" }, first.revision);
  assert.equal(second.configuration.authProfileId, "replacement", "a rolled-back adoption was not retired");
});

test("opening a pre-retirement store fences its existing disconnected generation", t => {
  const { store, paths } = fixture(t);
  const first = store.save(configuration, 0);
  const database = new DatabaseSync(paths.globalDatabasePath);
  database.exec("UPDATE execution_engine_profiles SET status = 'disconnected'; DROP TABLE IF EXISTS execution_engine_retired_auth_generations;");
  database.close();
  const reopened = new ExecutionEngineProfileStore(paths);
  t.after(() => reopened.close());
  const restored = reopened.save(configuration, first.revision);
  assert.notEqual(restored.configuration.authProfileId, first.configuration.authProfileId);
});

test("refresh publication requires exact configured profile ownership", t => {
  const { store } = fixture(t), first = store.save(configuration, 0);
  let called = 0;
  for (const expected of [
    { ...first, id: "other-profile" }, { ...first, revision: first.revision + 1 },
    { ...first, configurationFingerprint: "0".repeat(64) },
    { ...first, configuration: { ...first.configuration, authProfileId: "other-account" } },
  ]) assert.throws(() => store.commitAuthRefresh(expected, () => { called++; }), { code: "profile_revision_conflict" });
  assert.equal(called, 0);
  store.commitAuthRefresh(first, () => { called++; });
  assert.equal(called, 1);
  assert.deepEqual(store.get(configuration.engineId), first, "refresh does not edit profile identity or revision");
  const disconnected = store.disconnect(configuration.engineId, first.revision);
  assert.throws(() => store.commitAuthRefresh(disconnected, () => { called++; }), { code: "profile_unavailable" });
  assert.equal(called, 1);
});

test("publication failure releases the database writer and preserves the profile", t => {
  const { store, paths } = fixture(t), first = store.save(configuration, 0);
  assert.throws(() => store.commitAuthRefresh(first, () => { throw Error("file-publication-failed"); }), /file-publication-failed/);
  assert.deepEqual(store.get(configuration.engineId), first);
  const other = new ExecutionEngineProfileStore(paths);
  try { assert.equal(other.disconnect(configuration.engineId, first.revision).status, "disconnected"); }
  finally { other.close(); }
});

test("publication and an independent process disconnect share the same SQLite writer boundary", async t => {
  const { root, store, paths } = fixture(t), first = store.save(configuration, 0);
  const marker = join(root, "writer-state"), token = join(root, "synthetic-token");
  const module = new URL("../dist/storage/execution-engine-profile-store.js", import.meta.url).href;
  const code = `import { ExecutionEngineProfileStore } from ${JSON.stringify(module)};
    import { DatabaseSync } from 'node:sqlite';
    import { writeFileSync, renameSync } from 'node:fs';
    const paths = JSON.parse(process.argv[1]), marker = process.argv[2];
    const store = new ExecutionEngineProfileStore(paths), database = new DatabaseSync(paths.globalDatabasePath);
    const mark = value => { writeFileSync(marker + '.tmp', value); renameSync(marker + '.tmp', marker); };
    database.exec('PRAGMA busy_timeout = 0');
    process.on('message', message => {
      if (message === 'check') {
        try { database.exec('BEGIN IMMEDIATE'); database.exec('ROLLBACK'); mark('unlocked'); }
        catch (error) { mark(error.message.includes('locked') ? 'blocked' : 'unexpected-error'); }
      } else {
        store.disconnect('kimi-acp', 1); database.close(); store.close(); process.disconnect();
      }
    }); process.send('ready');`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(paths), marker], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  let error = ""; child.stderr.on("data", chunk => { error += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child, "message");
  store.commitAuthRefresh(first, () => {
    child.send("check");
    const deadline = Date.now() + 5000, wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(marker) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 5);
    assert.equal(readFileSync(marker, "utf8"), "blocked");
    writeFileSync(token, "published-before-disconnect");
  });
  child.send("disconnect");
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, 0, error); assert.equal(signal, null);
  assert.equal(readFileSync(token, "utf8"), "published-before-disconnect");
  assert.equal(store.get(configuration.engineId).status, "disconnected");
  assert.throws(() => store.commitAuthRefresh(first, () => { writeFileSync(token, "late"); }), { code: "profile_revision_conflict" });
  assert.equal(readFileSync(token, "utf8"), "published-before-disconnect");
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

test("physical workspace aliases share one Store and cannot recover a live Run twice", async t => {
  const f = await fixture(t);
  const store = f.registry.getStore(f.cwd);
  const createdAt = "2026-11-03T00:00:00.000Z";
  const channel = store.createChannel({ name: "Canonical identity fixture", boundPath: f.cwd }, createdAt);
  const task = store.createTask({ channelId: channel.id, title: "Live owner", prompt: "Keep the original owner" }, createdAt);
  const run = store.createRun({ id: "canonical-registry-live-run", cwd: f.cwd, taskId: task.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: { id: task.id, title: task.title },
    providerSnapshot: { provider: "fixture", model: "fixture" }, requestSnapshot: { cwd: f.cwd }, createdAt });
  store.markRunStarted(run.id, createdAt);

  const aliased = f.registry.getStore(f.alias);
  assert.equal(store.getRun(run.id).status, "running", "a second open must not run stale recovery on the live owner");
  assert.ok(aliased === store, "opening an alias must reuse the original Store");
  assert.ok(f.registry.getInitializedStore(f.alias) === store, "alias observation must not construct another Store");
  assert.ok(f.registry.getStore(`${f.alias}/../alias`) === store);
  assert.deepEqual(f.opened, [f.cwd]);
  assert.deepEqual(f.initialized, [f.cwd]);
  assert.deepEqual(f.admitted, [f.cwd]);
  f.registry.closeAll();
  assert.deepEqual(f.closed, [f.cwd]);
});

test("an alias opened first retains its existing storage identity without opening another history", async t => {
  const f = await fixture(t);
  const store = f.registry.getStore(f.alias);
  assert.equal(store.paths.cwd, f.alias, "canonical cache keys must not migrate persisted workspace identities");
  assert.ok(f.registry.getInitializedStore(f.cwd) === store, "canonical observation must find the alias-opened Store");
  assert.ok(f.registry.getStore(f.cwd) === store);
  assert.deepEqual(f.opened, [f.alias]);
  assert.deepEqual(f.initialized, [f.alias]);
});

test("distinct checkout directories remain separate Stores and a failed alias initialization is not cached", async t => {
  let attempts = 0;
  const failure = new Error("fixture alias initialization failed");
  const f = await fixture(t, () => { if (++attempts === 1) throw failure; });
  assert.throws(() => f.registry.getStore(f.alias), error => error === failure);
  assert.equal(f.registry.getInitializedStore(f.cwd), undefined);
  const original = f.registry.getStore(f.cwd);
  const sibling = join(f.root, "sibling");
  await mkdir(sibling);
  const other = f.registry.getStore(sibling);
  assert.ok(original !== other);
  assert.notEqual(original.paths.databasePath, other.paths.databasePath);
  assert.ok(f.registry.getStore(f.alias) === original, "a failed initial alias open must not leave a second cache entry");
  assert.deepEqual(f.opened, [f.alias, f.cwd, sibling]);
  assert.deepEqual(f.closed, [f.alias]);
});

async function fixture(t, onInitialized = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-store-canonical-")));
  const cwd = join(root, "workspace"), alias = join(root, "alias");
  await mkdir(cwd);
  await symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
  const opened = [], initialized = [], admitted = [], closed = [], stores = new Set();
  const registry = new RunStoreRegistry(storeCwd => {
    opened.push(storeCwd);
    const store = createSqliteRunStore(storeCwd), close = store.close.bind(store);
    stores.add(store);
    store.close = () => { if (stores.delete(store)) { closed.push(storeCwd); close(); } };
    return store;
  }, {
    beforeRecovery: storeCwd => { admitted.push(storeCwd); },
    onStoreInitialized: (storeCwd, store) => { initialized.push(storeCwd); onInitialized(storeCwd, store); },
  });
  t.after(async () => {
    try { registry.closeAll(); }
    finally { for (const store of stores) store.close(); await rm(root, { recursive: true, force: true }); }
  });
  return { root, cwd, alias, opened, initialized, admitted, closed, registry };
}

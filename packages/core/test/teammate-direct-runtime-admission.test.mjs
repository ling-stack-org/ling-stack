import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-10-16T08:00:00.000Z";
const later = "2026-10-16T08:01:00.000Z";
const teammateId = "teammate_builtin_engineer";

/** Independent SQLite connections inspect actual rows, never a fake Store writer. */
async function fixture(t) {
  const parent = await realpath(tmpdir());
  const cwd = await realpath(await mkdtemp(join(parent, "ling-a28-runtime-cas-")));
  const store = createSqliteRunStore(cwd);
  const db = new DatabaseSync(store.paths.databasePath);
  db.exec("PRAGMA busy_timeout=1");
  t.after(async () => {
    db.close();
    store.close();
    assert.equal(dirname(cwd), parent);
    assert.ok(basename(cwd).startsWith("ling-a28-runtime-cas-"));
    await rm(cwd, { recursive: true, force: true });
  });
  const direct = store.getOrCreateTeammateDirectThread(teammateId, now);
  const message = store.createTeammateDirectMessage({ threadId: direct.id, teammateId,
    authorType: "ai-teammate", authorId: teammateId, body: "", status: "pending" }, now);
  const scope = { workspaceId: message.workspaceId, teammateId, threadId: direct.id, messageId: message.id };
  const observe = (override = {}) => store.getTeammateDirectMessageRuntimeObservation({ ...scope, ...override });
  const row = () => db.prepare("SELECT * FROM teammate_direct_messages WHERE id=?").get(message.id);
  const write = (expected, patch) => store.commitTeammateDirectMessageRuntime({ expected,
    operation: { kind: "pre_dispatch", patch } }, later);
  return { store, db, direct, message, scope, observe, row, write };
}

test("A28 pre-dispatch writes real pending progress and leaves same-value timestamp unchanged", async t => {
  const f = await fixture(t);
  const original = f.row();
  const first = f.write(f.observe(), { body: "Owned web evidence progress", status: "pending", errorMessage: null });
  assert.equal(first.kind, "applied");
  assert.equal(first.message.body, "Owned web evidence progress");
  assert.equal(f.row().body, first.message.body);
  assert.notEqual(f.row().updated_at, original.updated_at);
  const stored = f.row();
  const second = f.store.commitTeammateDirectMessageRuntime({ expected: f.observe(), operation: { kind: "pre_dispatch",
    patch: { body: first.message.body, status: "pending", errorMessage: null } } }, "2026-10-16T09:00:00.000Z");
  assert.equal(second.kind, "unchanged");
  assert.deepEqual(f.row(), stored, "an idempotent retry cannot create a new update revision or timestamp");
});

test("A28 a second SQLite writer makes a captured pre-dispatch patch stale even at the same timestamp", async t => {
  const f = await fixture(t);
  const expected = f.observe();
  f.db.prepare("UPDATE teammate_direct_messages SET body=? WHERE id=?").run("newer actual progress", f.message.id);
  const current = f.row();
  const result = f.write(expected, { body: "stale old callback", status: "pending" });
  assert.equal(result.kind, "stale");
  assert.deepEqual(f.row(), current);
  assert.equal(current.updated_at, now, "the test must not rely on updatedAt changing");
});

test("A28 terminalization after observation cannot be undone by a late pre-dispatch callback", async t => {
  const f = await fixture(t);
  const expected = f.observe();
  f.db.prepare("UPDATE teammate_direct_messages SET status='cancelled', error_message=? WHERE id=?")
    .run("owned independent cancellation", f.message.id);
  const current = f.row();
  const result = f.write(expected, { body: "stale progress", status: "pending", errorMessage: null });
  assert.equal(result.kind, "stale");
  assert.deepEqual(f.row(), current);
  const fresh = f.write(f.observe(), { body: "not allowed to resurrect", status: "pending", errorMessage: null });
  assert.notEqual(fresh.kind, "applied");
  assert.deepEqual(f.row(), current);
});

test("A28 a new durable link prevents a pre-run callback from clearing or relabelling ownership", async t => {
  const f = await fixture(t);
  const expected = f.observe();
  // Disposable corruption is an adversarial input, not a claim that this foreign Run executed.
  f.db.exec("PRAGMA foreign_keys=OFF");
  f.db.prepare("UPDATE teammate_direct_messages SET linked_run_id=? WHERE id=?").run("foreign-run", f.message.id);
  const before = f.row();
  const result = f.write(expected, { body: "old pre-run progress", linkedRunId: null, status: "pending" });
  assert.notEqual(result.kind, "applied");
  assert.deepEqual(f.row(), before);
});

test("A28 foreign scope and a forged observation cannot rewrite another private participant", async t => {
  const f = await fixture(t);
  const expected = f.observe();
  const before = f.row();
  for (const scope of [
    { ...f.scope, teammateId: "teammate_builtin_designer" },
    { ...f.scope, workspaceId: "foreign-workspace" },
    { ...f.scope, threadId: "foreign-direct-thread" },
  ]) {
    const result = f.write({ ...expected, scope }, { body: "foreign overwrite", status: "blocked" });
    assert.notEqual(result.kind, "applied");
    assert.notEqual(result.kind, "unchanged");
    assert.deepEqual(f.row(), before);
  }
});

test("A28 pre-dispatch cannot manufacture successful or failed execution facts", async t => {
  const f = await fixture(t);
  const before = f.row();
  for (const status of ["ready", "failed", "cancelled"]) {
    const result = f.write(f.observe(), { body: "fabricated terminal outcome", status });
    assert.notEqual(result.kind, "applied");
    assert.deepEqual(f.row(), before);
  }
  const blocked = f.write(f.observe(), { body: "Provider is not configured", status: "blocked",
    errorMessage: "Provider is not configured" });
  assert.equal(blocked.kind, "applied", "a genuine pre-run configuration blocker remains representable");
  assert.equal(f.row().status, "blocked");
});

test("A28 guarded runtime writer cannot mutate inside a readSnapshot", async t => {
  const f = await fixture(t);
  const before = f.row();
  assert.throws(() => f.store.readSnapshot(() => f.write(f.observe(), { body: "forbidden nested write" })),
    /transaction|read.?only|readonly/iu);
  assert.deepEqual(f.row(), before);
  assert.equal(f.write(f.observe(), { body: "writer still usable", status: "pending" }).kind, "applied",
    "a rejected nested write must not leave the connection or transaction unusable");
});

test("A28 serialization runs under the writer lock and cannot mutate the Store while observations are checked", async t => {
  const f = await fixture(t);
  const expected = f.observe();
  const before = f.row();
  let getterReads = 0;
  const patch = {
    status: "pending",
    get body() {
      getterReads++;
      assert.throws(() => f.db.exec("BEGIN IMMEDIATE"), /locked|busy/iu,
        "the second SQLite writer cannot change facts during admission");
      assert.throws(() => f.store.createTeammateDirectMessage({ threadId: f.direct.id, teammateId,
        authorType: "ai-teammate", body: "untrusted getter write", status: "pending" }, later), /read.?only|readonly/iu);
      return "read-only serialized progress";
    },
  };
  const result = f.write(expected, patch);
  assert.equal(result.kind, "applied");
  assert.ok(getterReads > 0, "this check requires executing the actual patch getter");
  assert.equal(f.row().body, "read-only serialized progress");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM teammate_direct_messages").get().n, 1);
  assert.notEqual(f.row().body, before.body);
});

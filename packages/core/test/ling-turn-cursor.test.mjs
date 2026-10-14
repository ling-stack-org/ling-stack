import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const now = "2026-09-06T00:00:00.000Z";
const later = "2026-09-06T00:00:01.000Z";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a13-turn-cursor-"));
  const f = { cwd };
  t.after(async () => {
    try { f.writer?.close(); }
    finally {
      try { f.store?.close(); }
      finally { await rm(cwd, { recursive: true, force: true }); }
    }
  });
  f.store = createSqliteRunStore(cwd);
  f.thread = f.store.createLingThread({ kind: "conversation", title: "A13 cursor", objective: "Stable Turn pages" }, now);
  f.append = (id, updatedAt = now, thread = f.thread) => f.store.createLingTurn({ id, threadId: thread.id,
    kind: "manual_followup", title: id, userInstruction: id, createdByActor: "local-user" }, updatedAt);
  return f;
}

function allPages(store, threadId, limit, scope = {}) {
  const turns = [];
  let beforeTurnId;
  while (true) {
    const page = store.listLingTurns({ threadId, limit, ...scope, ...(beforeTurnId ? { beforeTurnId } : {}) });
    turns.push(...page);
    if (page.length < limit) return turns;
    const next = page.at(-1).id;
    assert.notEqual(next, beforeTurnId, "stable cursor must advance");
    beforeTurnId = next;
  }
}

test("A13 cursor: more than 500 equal timestamps have no missing or repeated Turn", async (t) => {
  const f = await fixture(t);
  const expected = Array.from({ length: 503 }, (_, i) => `a13-cursor-${String(i).padStart(4, "0")}`);
  for (const id of expected) f.append(id);
  const pages = f.store.readSnapshot(() => allPages(f.store, f.thread.id, 500));
  assert.deepEqual(pages.map((turn) => turn.id), [...expected].reverse());
  assert.equal(new Set(pages.map((turn) => turn.id)).size, 503);
});

test("A13 cursor: mixed timestamps retain updatedAt DESC then id DESC order", async (t) => {
  const f = await fixture(t);
  for (const [id, at] of [["a13-a", now], ["a13-b", later], ["a13-c", now], ["a13-d", later]]) f.append(id, at);
  assert.deepEqual(f.store.readSnapshot(() => allPages(f.store, f.thread.id, 2)).map((turn) => turn.id),
    ["a13-d", "a13-b", "a13-c", "a13-a"]);
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id, beforeTurnId: "a13-a" }), []);
});

for (const cursor of ["a13-missing", ""]) {
  test(`A13 cursor: missing/empty cursor fails closed (${cursor || "empty"})`, async (t) => {
    const f = await fixture(t);
    f.append("a13-owned");
    assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id, beforeTurnId: cursor }), /cursor is missing/);
  });
}

test("A13 cursor: a foreign thread cursor cannot read or truncate the requested thread", async (t) => {
  const f = await fixture(t);
  f.append("a13-owned");
  const foreign = f.store.createLingThread({ kind: "conversation", title: "Foreign", objective: "Not cursor authority" }, now);
  f.append("a13-foreign", now, foreign);
  assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id, beforeTurnId: "a13-foreign" }), /requested thread/);
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id }).map((turn) => turn.id), ["a13-owned"]);
});

test("A13 cursor: timestamp cursor is unchanged and mixed cursors are explicitly rejected", async (t) => {
  const f = await fixture(t);
  f.append("a13-older", now);
  f.append("a13-newer", later);
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id, beforeUpdatedAt: later }).map((turn) => turn.id), ["a13-older"]);
  for (const beforeUpdatedAt of [later, ""]) assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id,
    beforeTurnId: "a13-newer", beforeUpdatedAt }), /cannot be combined/);
});

test("A13 cursor: a competing WAL update cannot move the cursor inside its read snapshot", async (t) => {
  const f = await fixture(t);
  const earlier = "2026-09-05T23:59:59.000Z";
  for (const id of ["a13-a", "a13-b", "a13-c"]) f.append(id);
  f.writer = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
  f.writer.exec("PRAGMA busy_timeout=1");
  f.store.readSnapshot(() => {
    const first = f.store.listLingTurns({ threadId: f.thread.id, limit: 1 });
    assert.equal(first[0].id, "a13-c");
    f.writer.prepare("UPDATE ling_turns SET updated_at=? WHERE id=?").run(earlier, "a13-c");
    assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id, limit: 500, beforeTurnId: first[0].id })
      .map((turn) => turn.id), ["a13-b", "a13-a"]);
  });
  assert.equal(f.store.getLingTurn("a13-c").updatedAt, earlier);
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id, beforeTurnId: "a13-c" }), [],
    "outside the snapshot, the moved cursor has no older rows; without isolation the in-snapshot assertion must fail");
});

test("A13 creation cursor: order and scope are independent of mutable update time", async (t) => {
  const f = await fixture(t);
  f.append("a13-a", now);
  f.append("a13-b", later);
  f.writer = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
  f.writer.prepare("UPDATE ling_turns SET updated_at=? WHERE id=?").run("2026-09-07T00:00:00.000Z", "a13-a");
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id }).map((turn) => turn.id), ["a13-a", "a13-b"]);
  assert.deepEqual(f.store.readSnapshot(() => allPages(f.store, f.thread.id, 1, { orderBy: "createdAt" }))
    .map((turn) => turn.id), ["a13-b", "a13-a"]);
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id, orderBy: "createdAt", createdBefore: later })
    .map((turn) => turn.id), ["a13-a"]);
});

test("A13 creation cursor: equal creation timestamps use SQLite binary ID order across pages", async (t) => {
  const f = await fixture(t);
  const ids = ["a13-a", "a13-A", "a13-_", "a13-!", "a13-z", "a13-Z"];
  for (const id of ids) f.append(id);
  assert.deepEqual(f.store.readSnapshot(() => allPages(f.store, f.thread.id, 2, { orderBy: "createdAt" }))
    .map((turn) => turn.id), [...ids].sort().reverse());
  const foreign = f.store.createLingThread({ kind: "conversation", title: "Foreign", objective: "Not cursor authority" }, now);
  f.append("a13-foreign", now, foreign);
  assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id, orderBy: "createdAt", beforeTurnId: "a13-foreign" }), /requested thread/);
  assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id, orderBy: "createdAt", beforeTurnId: "a13-missing" }), /cursor is missing/);
});

test("A13 creation cursor: incompatible order and malformed scope are rejected", async (t) => {
  const f = await fixture(t);
  f.append("a13-a");
  assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id, orderBy: "other" }), /cursor order/);
  for (const beforeUpdatedAt of [now, ""]) assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id,
    orderBy: "createdAt", beforeUpdatedAt }), /cannot use beforeUpdatedAt/);
  assert.throws(() => f.store.listLingTurns({ threadId: f.thread.id, orderBy: "createdAt", createdBefore: "" }), /creation scope/);
});

test("A13 cursor indexes: creation and update seeks avoid a temporary sort", async (t) => {
  const f = await fixture(t);
  f.append("a13-index-control");
  for (const [column, suffix] of [["created_at", "created"], ["updated_at", "updated"]]) {
    const plan = f.store.database.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ling_turns
      WHERE workspace_id=? AND thread_id=? AND (${column} < ? OR (${column} = ? AND id < ?))
      ORDER BY ${column} DESC, id DESC LIMIT ?`)
      .all(f.thread.workspaceId, f.thread.id, later, later, "a13-index-control", 500);
    const detail = plan.map((row) => row.detail).join("\n");
    assert.match(detail, new RegExp(`idx_ling_turns_workspace_thread_${suffix}_id`));
    assert.doesNotMatch(detail, /TEMP B-TREE/);
  }
});

test("A13 cursor indexes: an existing database receives indexes without changing history", async (t) => {
  const f = await fixture(t);
  f.append("a13-index-old", now);
  f.append("a13-index-new", later);
  const before = f.store.listLingTurns({ threadId: f.thread.id });
  f.store.database.exec(`DROP INDEX idx_ling_turns_workspace_thread_created_id;
    DROP INDEX idx_ling_turns_workspace_thread_updated_id;`);
  f.store.close();
  f.store = createSqliteRunStore(f.cwd);
  assert.deepEqual(f.store.listLingTurns({ threadId: f.thread.id }), before);
  const indexes = f.store.database.prepare("PRAGMA index_list('ling_turns')").all().map((row) => row.name);
  assert.ok(indexes.includes("idx_ling_turns_workspace_thread_created_id"));
  assert.ok(indexes.includes("idx_ling_turns_workspace_thread_updated_id"));
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexFileChangeContext } from "../dist/runtime/adapters/codex/file-change-context.js";
import { CodexActionPreparer } from "../dist/runtime/adapters/codex/action-preparation.js";

const identity = { threadId: "thread-1", turnId: "turn-1", itemId: "patch-1" };
const change = (path = "file.txt", diff = "+complete\n") => ({ path, kind: { type: "add" }, diff });
const update = (changes = [change()], ids = identity) => ({ method: "item/fileChange/patchUpdated", params: { ...ids, changes } });
const started = (changes = [change()], ids = identity) => ({ method: "item/started", params: {
  threadId: ids.threadId, turnId: ids.turnId, item: { type: "fileChange", id: ids.itemId, status: "inProgress", changes },
} });
const read = (context, ids = identity) => context.read(ids.threadId, ids.turnId, ids.itemId);
const request = { id: "approval-1", method: "item/fileChange/requestApproval", params: identity };
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "ling-patch-updates-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const context = new CodexFileChangeContext();
  const preparer = new CodexActionPreparer(cwd, { policy: {
    allowedWritePaths: [cwd], toolDecisions: { write: "ask", edit: "ask" },
  } }, context);
  return { context, preparer };
}

test("streaming patch previews are replaced and only a complete started item can authorize", t => {
  const { context, preparer } = fixture(t);
  context.receive(update([change("removed.txt", "+partial")]));
  context.receive(update([change()]));
  assert.equal(read(context), undefined);
  assert.equal(preparer.prepare(request).kind, "unsupported");
  context.receive(started());
  assert.deepEqual(read(context).changes, [change()]);
  const action = preparer.prepare(request);
  assert.equal(action.kind, "action");
  assert.deepEqual(action.approval.payload.touchedPaths, ["file.txt"]);
  assert.equal(action.approval.payload.diffPreview, "add: file.txt\n+complete\n");
});

test("patch updates invalidate an older started snapshot until the next full start", t => {
  const { context, preparer } = fixture(t);
  context.receive(started());
  const old = preparer.prepare(request);
  context.receive(update([change("next.txt")]));
  assert.equal(read(context), undefined);
  assert.throws(() => preparer.assertCurrent(request, old), { code: "handler_failed" });
  context.receive(started([change("next.txt")]));
  const next = preparer.prepare(request);
  assert.deepEqual(next.approval.payload.touchedPaths, ["next.txt"]);
  assert.doesNotThrow(() => preparer.assertCurrent(request, next));
  assert.throws(() => preparer.assertCurrent(request, old), { code: "handler_failed" });
});

test("changed then restored patch bytes cannot revive an earlier approval snapshot", t => {
  const { context, preparer } = fixture(t);
  context.receive(started());
  const old = preparer.prepare(request);
  context.receive(update([change("temporary.txt")]));
  context.receive(update());
  context.receive(started());
  assert.deepEqual(preparer.prepare(request).approval, old.approval);
  assert.throws(() => preparer.assertCurrent(request, old), { code: "handler_failed" });
});

test("identical update/start repetitions are idempotent and snapshots are private clones", t => {
  const { context, preparer } = fixture(t);
  const preview = update();
  context.receive(preview);
  preview.params.changes[0].path = "mutated.txt";
  context.receive(started());
  const action = preparer.prepare(request);
  context.receive(update());
  context.receive(started());
  read(context).changes[0].diff = "injected";
  assert.doesNotThrow(() => preparer.assertCurrent(request, action));
  assert.deepEqual(read(context).changes, [change()]);
});

test("empty previews revoke stale content and never produce an empty-path approval", t => {
  const { context, preparer } = fixture(t);
  context.receive(started());
  const old = preparer.prepare(request);
  context.receive(update([]));
  assert.equal(preparer.prepare(request).kind, "unsupported");
  assert.throws(() => preparer.assertCurrent(request, old), { code: "handler_failed" });
  context.receive(started([]));
  assert.equal(preparer.prepare(request).kind, "unsupported");
});

for (const method of ["item/completed", "turn/completed"]) test(`${method} cannot be reopened by a patch update`, () => {
  const context = new CodexFileChangeContext();
  context.receive(update());
  context.receive(started());
  context.receive(method === "item/completed" ? { ...started(), method }
    : { method, params: { threadId: identity.threadId, turn: { id: identity.turnId } } });
  assert.equal(read(context), undefined);
  assert.throws(() => context.receive(update()), { code: "protocol_error" });
  assert.equal(read(context), undefined);
});

test("foreign patch updates do not replace or retire another item's approval", t => {
  const { context, preparer } = fixture(t);
  context.receive(started());
  const old = preparer.prepare(request);
  for (const key of ["threadId", "turnId", "itemId"]) context.receive(update([change("foreign.txt")], { ...identity, [key]: "foreign" }));
  assert.doesNotThrow(() => preparer.assertCurrent(request, old));
});

test("malformed patch updates fail without changing the previous snapshot", () => {
  const context = new CodexFileChangeContext();
  context.receive(started());
  const before = read(context);
  for (const value of [null, {}, { ...identity, changes: "not-an-array" }, { ...identity, itemId: "" },
    { ...identity, changes: [{ ...change(), kind: { type: "unknown" } }] },
    { ...identity, changes: [change("file\u0000name")] },
    { ...identity, changes: Array.from({ length: 257 }, () => change()) }]) {
    assert.throws(() => context.receive({ method: "item/fileChange/patchUpdated", params: value }), { code: "protocol_error" });
    assert.deepEqual(read(context), before);
  }
});

test("preview replacement accounts bytes once and rejected overflow keeps the snapshot intact", () => {
  const context = new CodexFileChangeContext({ items: 1, bytes: 256 });
  for (let i = 0; i < 10; i++) context.receive(update([change("file.txt", `+${i}`)]));
  context.receive(started());
  const before = read(context);
  assert.throws(() => context.receive(update([change("file.txt", "x".repeat(300))])), { code: "capacity_exceeded" });
  assert.deepEqual(read(context), before);
  assert.throws(() => context.receive(update(undefined, { ...identity, itemId: "another" })), { code: "capacity_exceeded" });
  assert.deepEqual(read(context), before);
});

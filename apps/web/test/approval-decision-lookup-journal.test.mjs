import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalDecisionLookupJournal } from "../src/lib/approval-decision-lookup-journal.ts";

function fixture() {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key),
    key: index => [...entries.keys()][index] ?? null, get length() { return entries.size; } };
  return { entries, storage, journal: createApprovalDecisionLookupJournal(storage) };
}
const scope = { daemonBaseUrl: "http://127.0.0.1:17892", cwd: "/workspace" };
const first = { approvalId: "approval-1", token: "original-request" };

test("approval recovery pointers survive reopening and are isolated by daemon and workspace", () => {
  const f = fixture();
  f.journal.remember(scope, { ...first, decision: "approve", reason: "private text" });
  const reopened = createApprovalDecisionLookupJournal(f.storage);
  assert.deepEqual(reopened.read(scope), [first]);
  assert.deepEqual(reopened.read({ ...scope, cwd: "/other-workspace" }), []);
  assert.deepEqual(reopened.read({ ...scope, daemonBaseUrl: "http://127.0.0.1:17891" }), []);
  assert.equal([...f.entries.values()].some(value => /approve|private text/.test(value)), false);
});

test("independent approval pointers do not overwrite each other and stale settlement preserves a newer request", () => {
  const f = fixture();
  const otherClient = createApprovalDecisionLookupJournal(f.storage);
  const other = { approvalId: "approval-2", token: "other-request" };
  f.journal.remember(scope, first);
  otherClient.remember(scope, other);
  assert.deepEqual(f.journal.read(scope), [first, other]);
  const newer = { ...first, token: "new-request" };
  otherClient.remember(scope, newer);
  f.journal.forget(scope, first);
  assert.deepEqual(f.journal.read(scope), [newer, other]);
  f.journal.forget(scope, newer);
  f.journal.forget(scope, other);
  assert.equal(f.entries.size, 0);
});

test("approval IDs with punctuation round trip without crossing lookup scopes", () => {
  const f = fixture();
  const record = { approvalId: "approval:/a% b", token: "lookup-token" };
  f.journal.remember(scope, record);
  assert.deepEqual(f.journal.read(scope), [record]);
  f.journal.forget(scope, record);
  assert.deepEqual(f.journal.read(scope), []);
});

test("malformed approval pointers fail closed instead of being treated as decisions", () => {
  const f = fixture();
  f.journal.remember(scope, first);
  const key = [...f.entries.keys()][0];
  for (const value of ["", "invalid\ntoken", "a".repeat(201)]) {
    f.entries.set(key, value);
    assert.throws(() => f.journal.read(scope), /Pending confirmation/);
  }
  assert.throws(() => f.journal.remember(scope, { ...first, approvalId: "invalid\nid" }));
});

import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateStopLookupJournal } from "../src/features/teammates/private-stop-lookup-journal.ts";

function fixture() {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const scope = { cwd: "/workspace", teammateId: "engineer", threadId: "private-thread" };
  const record = { workUnitId: "original-work", messageId: "partial-reply", linkedRunId: "original-run", attemptId: "original-attempt" };
  return { entries, storage, scope, record, journal: createPrivateStopLookupJournal(storage) };
}

test("private stop journal survives recreation without retaining content or permission", () => {
  const f = fixture();
  f.journal.remember(f.scope, { ...f.record, body: "Do not persist", permission: "allow" });
  const reopened = createPrivateStopLookupJournal(f.storage);
  assert.deepEqual(reopened.read(f.scope), [f.record]);
  assert.equal([...f.entries.values()].some(value => /Do not persist|permission|allow/.test(value)), false);
  for (const scope of [{ ...f.scope, cwd: "/other" }, { ...f.scope, teammateId: "designer" }, { ...f.scope, threadId: "other-thread" }]) {
    assert.deepEqual(reopened.read(scope), []);
  }
});

test("settling an older stop retains other WorkUnits and newer Attempts", () => {
  const f = fixture();
  f.journal.remember(f.scope, f.record);
  f.journal.remember(f.scope, f.record);
  const newer = { ...f.record, attemptId: "new-attempt", linkedRunId: "new-run" };
  const other = { ...f.record, workUnitId: "other-work" };
  f.journal.remember(f.scope, newer);
  f.journal.remember(f.scope, other);
  f.journal.forget(f.scope, f.record);
  assert.deepEqual(f.journal.read(f.scope), [newer, other]);
  f.journal.forget(f.scope, f.record);
  assert.deepEqual(f.journal.read(f.scope), [newer, other]);
  f.journal.forget(f.scope, newer);
  f.journal.forget(f.scope, other);
  assert.equal(f.entries.size, 0);
});

test("malformed stop pointers fail closed rather than silently granting a retry", () => {
  const f = fixture();
  f.journal.remember(f.scope, f.record);
  const key = [...f.entries.keys()][0];
  for (const value of ["not-json", "{}", '[{"workUnitId":"work"}]',
    JSON.stringify([{ ...f.record, workUnitId: "foreign\noperation" }])]) {
    f.entries.set(key, value);
    assert.throws(() => f.journal.read(f.scope));
    assert.throws(() => f.journal.remember(f.scope, f.record));
  }
});

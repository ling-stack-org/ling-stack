import assert from "node:assert/strict";
import test from "node:test";
import { createRunStopLookupJournal } from "../src/lib/run-stop-lookup-journal.ts";

function fixture() {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
  const record = { cwd: "/workspace/tree", runId: "original-run", workUnitId: "original-work", attemptId: "original-attempt" };
  return { entries, storage, record, journal: createRunStopLookupJournal(storage) };
}

test("Run stop restart pointers are workspace-scoped and contain no content or authorization", () => {
  const f = fixture();
  f.journal.remember("/workspace", { ...f.record, body: "Do not persist", permission: "allow" });
  const reopened = createRunStopLookupJournal(f.storage);
  assert.deepEqual(reopened.read("/workspace"), [f.record]);
  assert.deepEqual(reopened.read("/other-workspace"), []);
  assert.equal([...f.entries.values()].some(value => /Do not persist|permission|allow/.test(value)), false);
});

test("settling a Run stop retains other Runs, paths and successor Attempt lookups", () => {
  const f = fixture();
  const newer = { ...f.record, attemptId: "successor-attempt" };
  const otherRun = { ...f.record, runId: "other-run" };
  const otherPath = { ...f.record, cwd: "/workspace/other-tree" };
  for (const record of [f.record, f.record, newer, otherRun, otherPath]) f.journal.remember("/workspace", record);
  f.journal.forget("/workspace", f.record);
  f.journal.forget("/workspace", f.record);
  assert.deepEqual(f.journal.read("/workspace"), [newer, otherRun, otherPath]);
  for (const record of [newer, otherRun, otherPath]) f.journal.forget("/workspace", record);
  assert.equal(f.entries.size, 0);
});

test("malformed Run stop pointers cannot silently become a new cancellation", () => {
  const f = fixture();
  f.journal.remember("/workspace", f.record);
  const key = [...f.entries.keys()][0];
  for (const value of ["not-json", "{}", '[{"runId":"run"}]',
    JSON.stringify([{ ...f.record, runId: "foreign\nrun" }]), JSON.stringify([{ ...f.record, cwd: "" }])]) {
    f.entries.set(key, value);
    assert.throws(() => f.journal.read("/workspace"));
    assert.throws(() => f.journal.remember("/workspace", f.record));
  }
});

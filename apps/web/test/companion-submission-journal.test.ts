import assert from "node:assert/strict";
import test from "node:test";
import {
  readPendingCompanionSubmission, rememberPendingCompanionSubmission, forgetPendingCompanionSubmission,
  markPendingCompanionSubmissionTerminal,
} from "../src/features/companions/companion-submission-journal.ts";

function storageFixture() {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } } });
  return { values, restore: () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  } };
}

test("pending keys are isolated by workspace and companion and stale completion cannot remove a newer key", () => {
  const fixture = storageFixture();
  try {
    rememberPendingCompanionSubmission(" /workspace/a ", "yui", "first");
    rememberPendingCompanionSubmission("/workspace/b", "yui", "other-workspace");
    rememberPendingCompanionSubmission("/workspace/a", "other", "other-companion");
    assert.deepEqual(readPendingCompanionSubmission("/workspace/a", "yui"), { key: "first" });
    rememberPendingCompanionSubmission("/workspace/a", "yui", "second");
    forgetPendingCompanionSubmission("/workspace/a", "yui", "first");
    assert.equal(readPendingCompanionSubmission("/workspace/a", "yui")?.key, "second");
    markPendingCompanionSubmissionTerminal("/workspace/a", "yui", "second");
    assert.deepEqual(readPendingCompanionSubmission("/workspace/a", "yui"), { key: "second", terminal: true });
    forgetPendingCompanionSubmission("/workspace/a", "yui", "second");
    assert.equal(readPendingCompanionSubmission("/workspace/a", "yui"), undefined);
    assert.equal(readPendingCompanionSubmission("/workspace/b", "yui")?.key, "other-workspace");
    assert.equal(readPendingCompanionSubmission("/workspace/a", "other")?.key, "other-companion");
    assert.deepEqual([...fixture.values.values()].sort(), ["other-companion", "other-workspace"]);
  } finally { fixture.restore(); }
});

test("unavailable browser storage does not prevent sending or receipt recovery", () => {
  const fixture = storageFixture();
  try {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } });
    assert.doesNotThrow(() => rememberPendingCompanionSubmission("/w", "yui", "key"));
    assert.equal(readPendingCompanionSubmission("/w", "yui"), undefined);
    assert.doesNotThrow(() => forgetPendingCompanionSubmission("/w", "yui", "key"));
  } finally { fixture.restore(); }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL(
  "../src/features/settings/computer-control/LockAwareComputerControlSection.tsx",
  import.meta.url,
);

test("lock behavior exposes task continuation without exposing locked control", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /data-lock-behavior="configurable-task-continuation"/u);
  assert.match(source, /Continue running while locked/u);
  assert.match(source, /Computer Control pauses/u);
  assert.match(source, /Control resumes after unlock/u);
  assert.match(source, /getLockedTaskContinuationPreferences/u);
  assert.match(source, /setContinueTasksWhileLocked/u);
  assert.match(source, /<Switch/u);
  assert.equal(source.includes("authorizeLockedControl"), false);
  assert.equal(source.includes("revokeLockedControl"), false);
  assert.equal(source.includes("lockedView"), false);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL(
  "../src/features/settings/computer-control/LockAwareComputerControlSection.tsx",
  import.meta.url,
);

test("lock behavior is informational and exposes no locked-control command", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /data-lock-behavior="pause-and-resume"/u);
  assert.match(source, /Tasks keep running/u);
  assert.match(source, /Computer Control pauses/u);
  assert.match(source, /Control resumes after unlock/u);
  assert.equal(source.includes("Switch"), false);
  assert.equal(source.includes("authorizeLockedControl"), false);
  assert.equal(source.includes("revokeLockedControl"), false);
  assert.equal(source.includes("lockedView"), false);
});

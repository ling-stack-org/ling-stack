import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_RUN_PREFERENCE_KEY,
  readFirstRunPreference,
  writeFirstRunPreference,
} from "../src/features/first-run/first-run-storage.ts";

test("First Run skip and completion preferences survive a storage round trip", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  const written = writeFirstRunPreference(
    "skipped",
    "/workspace/demo/",
    storage,
    "2026-07-30T00:00:00.000Z",
  );
  assert.deepEqual(written, {
    status: "skipped",
    updatedAt: "2026-07-30T00:00:00.000Z",
    version: 1,
    workspaceIdentity: "/workspace/demo",
  });
  assert.deepEqual(readFirstRunPreference(storage), written);

  values.set(FIRST_RUN_PREFERENCE_KEY, JSON.stringify({ version: 2, status: "completed", updatedAt: "now" }));
  assert.equal(readFirstRunPreference(storage), undefined);
  values.set(FIRST_RUN_PREFERENCE_KEY, "{invalid-json");
  assert.equal(readFirstRunPreference(storage), undefined);
});

test("First Run remains skippable when storage writes fail", () => {
  const preference = writeFirstRunPreference("completed", "", {
    getItem: () => null,
    setItem: () => { throw new Error("storage unavailable"); },
  }, "2026-07-30T00:00:00.000Z");

  assert.deepEqual(preference, {
    status: "completed",
    updatedAt: "2026-07-30T00:00:00.000Z",
    version: 1,
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
test("public exact expired task recovery is available without enumerating history", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-evaluation-task-exact-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, {
      recursive: true,
      force: true
    });
  });
  assert.equal(typeof store.reconcileExpiredRunEvaluationTaskAttempt, "function");
});

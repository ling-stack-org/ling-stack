import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { approveRawCommand, createRawSourceFixture, observeRawProducer } from "./support/unified-exec-raw-source-fixture.mjs";

// This real controlled raw producer intentionally retains unknown descendant
// history. Process isolation keeps that history out of the staged-source tests;
// never reset the production actor inventory to make later stages pass.
test("approved ordinary command executes in its declared subdirectory without moving the Run root", async t => {
  const f = await createRawSourceFixture(t);
  mkdirSync(join(f.cwd, "project"));
  const approved = approveRawCommand({ ...f, cwd: join(f.cwd, "project") }, "pwd");
  const calls = observeRawProducer(t);
  const result = await f.execute({ command: "pwd", cwd: "project" }, { approvalId: approved.approval.id });
  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].cwd, join(f.cwd, "project"));
  assert.equal(result.details.unifiedExec.cwd, join(f.cwd, "project"));
  assert.equal(f.store.getRun(f.run.id).cwd, f.cwd);
});

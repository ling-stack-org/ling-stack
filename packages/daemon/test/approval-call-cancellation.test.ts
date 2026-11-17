import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

test("a child deadline cancels its fenced pending approval without starting the command", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-child-approval-cancel-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  const task = { id: "task", title: "child cancellation", prompt: "Wait for approval" };
  const { store, run, sourceFence } = createUnifiedExecFixture(t, cwd, task, "child-cancel");
  assert.ok(run);
  const controller = new AbortController();
  const handler = createRunApprovalHandler({ store, run, sourceFence, unifiedExecEnabled: true,
    workUnitId: sourceFence.workUnitId, attemptId: sourceFence.attemptId,
    approvalPolicy: store.getApprovalPolicy(),
    appendAndMaybeStream: () => undefined, streamEnvelope: () => {},
  });
  assert.ok(handler);
  const timer = setTimeout(() => controller.abort(new Error("child timeout")), 30);
  t.after(() => clearTimeout(timer));
  const result = await handler({ toolCallId: "parent/1", toolName: "bash", cwd, task,
    input: { command: "printf unwanted > child-effect.txt" }, signal: controller.signal });
  assert.equal(result.approved, false);
  const approvals = store.listApprovalRequests({ runId: run.id, limit: 20 });
  assert.equal(approvals.length, 1); assert.equal(approvals[0].status, "cancelled");
  assert.equal(store.listApprovalRequests({ runId: run.id, status: "pending" }).length, 0);
  assert.equal(store.getRun(run.id)?.status, "failed");
  await assert.rejects(readFile(join(cwd, "child-effect.txt")), { code: "ENOENT" });
});

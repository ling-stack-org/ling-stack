import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunApprovalHandler } from "../dist/features/runs/approvals.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";

const policy = { toolDecisions: { bash: "allow" }, allowedWritePaths: ["."] };

for (const [command, approvalProfile] of [
  ["git commit -m fixture", { mode: "standard", requiredForActions: ["git_commit"] }],
  ["whois example.com", { mode: "strict" }],
]) test(`Pi handler reaches approval persistence before allowing ${command}`, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-action-policy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "task_fixture", title: "Fixture", prompt: "Exercise approval policy" };
  const { store, run, sourceFence } = createUnifiedExecFixture(t, cwd, task, "run_fixture");
  const persistenceReached = new Error("test approval persistence boundary");
  let writes = 0;
  store.createExecutionApprovalRequest = () => { writes += 1; throw persistenceReached; };
  store.findMatchingApprovalCommandRule = () => { assert.fail("Mandatory approval cannot look up a command rule"); };
  const handler = createRunApprovalHandler({
    store, run, sourceFence, unifiedExecEnabled: true,
    workUnitId: sourceFence.workUnitId, attemptId: sourceFence.attemptId, approvalPolicy: policy, approvalProfile,
    appendAndMaybeStream: () => { assert.fail("No events should precede persistence"); }, streamEnvelope: () => {},
  });
  await assert.rejects(handler({ toolCallId: "call_fixture", toolName: "bash", input: { command }, cwd }), error => error === persistenceReached);
  assert.equal(writes, 1);
});

test("Pi handler never consults saved command rules for risk-required approval", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-approval-risk-policy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "task_fixture", title: "Fixture", prompt: "Exercise risk approval" };
  const { store, run, sourceFence } = createUnifiedExecFixture(t, cwd, task, "run_fixture");
  const persistenceReached = new Error("test risk approval persistence boundary");
  let writes = 0;
  store.createExecutionApprovalRequest = () => { writes += 1; throw persistenceReached; };
  store.findMatchingApprovalCommandRule = () => { assert.fail("Risk review cannot consult command rules"); };
  const handler = createRunApprovalHandler({
    store, run, sourceFence, unifiedExecEnabled: true,
    workUnitId: sourceFence.workUnitId, attemptId: sourceFence.attemptId, approvalPolicy: policy,
    appendAndMaybeStream: () => {}, streamEnvelope: () => {},
  });
  await assert.rejects(handler({ toolCallId: "call_fixture", toolName: "bash",
    input: { command: "security find-generic-password" }, cwd }), error => error === persistenceReached);
  assert.equal(writes, 1);
});

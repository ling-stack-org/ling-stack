import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveSessionRunPolicy, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { b013CreateStep, b013OwnedStore, b013ParticipantId } from "../../core/test/support/b013-pre-gate-fixture.mjs";
import { executeHarnessedBashTool, executeHarnessedFileMutationTool } from "../dist/features/harness/tool-execution/broker.js";
import { createFileMutationActionDraft } from "../dist/features/harness/tool-execution/executors/file-mutation.js";
import { createMcpToolCallHandler } from "../dist/features/runs/mcp.js";
import { createRunPermissionRequestHandler } from "../dist/features/runs/permission-requests.js";
import { executeUnifiedBashTool } from "../dist/features/runs/unified-exec.js";
import { createWorkflowSafetyPlan, workflowSafetySnapshot } from "../dist/features/runs/workflow-safety.js";

// Exercise actual effect entry points with an owned SQLite Run, not replacement policy gates.
async function fixture(t) {
  const f = await b013OwnedStore(t), now = new Date().toISOString();
  const { step } = b013CreateStep(f, { sideEffectClass: "analysis_readonly", requiredTools: ["read"],
    parallelPolicy: { autoParallel: true, maxParallelSiblings: 2 } });
  const plan = createWorkflowSafetyPlan({ store: f.store, step, workspaceCwd: f.cwd, executionCwd: f.cwd });
  f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, safetyPlan: plan } }, now);
  const task = { id: "readonly-effects-task", channelId: f.channel.id, title: "Readonly effects", prompt: "Inspect only" };
  const requestSnapshot = { cwd: f.cwd, task, teammateId: b013ParticipantId, workflowStepId: step.id,
    tools: ["read"], runnerId: "pi", workflowSafetySnapshot: workflowSafetySnapshot(plan) };
  const unit = f.store.createWorkUnit({ workspaceId: f.channel.workspaceId, kind: "task_run", ownerType: "run", ownerId: "readonly-effects-run",
    idempotencyKey: "readonly-effects", status: "running", createdByActor: "system", request: requestSnapshot, now });
  const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "readonly-effects-runtime", runnerId: "pi", status: "started", now });
  f.store.createRun({ id: "readonly-effects-run", cwd: f.cwd, workUnitId: unit.id, taskId: task.id,
    channelId: f.channel.id, teammateId: b013ParticipantId, workflowStepId: step.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {}, requestSnapshot, createdAt: now });
  f.store.linkRunToWorkUnit("readonly-effects-run", unit.id, now);
  f.store.markRunStarted("readonly-effects-run", now);
  const run = f.store.getRun("readonly-effects-run");
  const policy = resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
    authorizationMode: "always", workspaceAccessMode: "workspace_write" });
  return { ...f, task, run, sourceFence: toRuntimeAttemptFence(attempt),
    effectivePolicySnapshot: policy.snapshot, approvalPolicy: policy.approvalPolicy,
    appendAndMaybeStream: (type, data) => f.store.appendEvent(run.id, type, data),
    request: (toolName, input) => ({ toolCallId: `readonly-${toolName}`, toolName, input, cwd: f.cwd, task }),
    assertNoExecution() {
      assert.deepEqual(f.store.listHarnessToolExecutions(run.id), []);
      assert.deepEqual(f.store.listEvents(run.id).filter(event => event.type === "host_command_prepared"), []);
      assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM approval_requests").get().n, 0);
    },
  };
}

for (const mode of ["off", "shadow", "enforce"]) {
  test(`readonly shell is rejected before Broker ${mode} can launch a command`, async t => {
    const f = await fixture(t);
    const result = await executeHarnessedBashTool({ ...f, mode,
      request: f.request("bash", { command: "printf unsafe > forbidden.txt" }) });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /workflow_safety_effect_denied/);
    await assert.rejects(readFile(join(f.cwd, "forbidden.txt")), { code: "ENOENT" });
    f.assertNoExecution();
  });

  test(`readonly file mutation is rejected before Broker ${mode} can apply a draft`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.cwd, "owned.txt"), "original\n");
    const request = f.request("write", { path: "owned.txt", content: "overwritten\n" });
    const draft = createFileMutationActionDraft({ request, allowedWritePaths: [f.cwd] });
    const result = await executeHarnessedFileMutationTool({ ...f, mode, request, draft, allowedWritePaths: [f.cwd] });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /workflow_safety_effect_denied/);
    assert.equal(await readFile(join(f.cwd, "owned.txt"), "utf8"), "original\n");
    f.assertNoExecution();
  });
}

test("direct unified execution cannot bypass the readonly workflow profile", async t => {
  const f = await fixture(t);
  const result = await executeUnifiedBashTool({ ...f,
    request: f.request("bash", { command: "printf unsafe > forbidden.txt" }) });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /workflow_safety_effect_denied/);
  await assert.rejects(readFile(join(f.cwd, "forbidden.txt")), { code: "ENOENT" });
  f.assertNoExecution();
});

test("readonly MCP is rejected before transport or observers, including self-declared read tools", async t => {
  const f = await fixture(t);
  let dispatched = 0, observed = 0;
  const definition = { registeredName: "mcp_fixture_read", serverId: "fixture", rawName: "read",
    inputSchema: { type: "object" }, sideEffectLevel: "read", defaultApproval: "allow" };
  const handler = createMcpToolCallHandler(f.store, { resolve() { throw new Error("No secret access"); } },
    { async callTool() { dispatched++; return { content: [] }; } }, [definition],
    { runId: f.run.id, onStart() { observed++; } });
  await assert.rejects(handler({ ...f.request("mcp", {}), ...definition }), { code: "workflow_safety_effect_denied" });
  assert.equal(dispatched, 0);
  assert.equal(observed, 0);
  f.assertNoExecution();
});

test("readonly permission expansion is denied without minting an approval or grant", async t => {
  const f = await fixture(t);
  const handler = createRunPermissionRequestHandler({ ...f, currentTools: ["read"], runnerId: "pi",
    supportedTools: ["read", "write"], streamEnvelope() { throw new Error("No permission event expected"); } });
  const result = await handler({ ...f.request("request_permissions", {}), requestKind: "core_tool",
    reason: "Expand to write", requestedScope: { kind: "core_tool", tools: ["write"] } });
  assert.equal(result.approved, false);
  assert.equal(result.grant, undefined);
  assert.match(result.reason, /workflow_safety_effect_denied/);
  f.assertNoExecution();
});

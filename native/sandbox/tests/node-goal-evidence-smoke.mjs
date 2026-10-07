import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, resolveSessionRunPolicy } from "../../../packages/core/dist/index.js";
import { bindChannelOperationPlan } from "../../../packages/daemon/dist/features/channels/channel-operation-bindings.js";
import { appendChannelItemFixture } from "../../../packages/core/test/channel-conversation-fixture.mjs";
import { createDelegatedStepRequirement } from "../../../packages/daemon/dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot } from "../../../packages/daemon/dist/features/runs/workflow-operation-snapshot.js";
import { verifyWorkflowStepExecutionOperations } from "../../../packages/daemon/dist/features/channels/workflow-operation-evidence.js";
import { listAllExecutionActionsForRun } from "../../../packages/daemon/dist/features/runs/execution-actions.js";
import { executeUnifiedBashTool } from "../../../packages/daemon/dist/features/runs/unified-exec.js";
import { NativeRestrictedCommandRuntime } from "../../../packages/daemon/dist/runtime/sandbox/restricted-command-runtime.js";
assert.equal(process.platform, "darwin"); assert.ok(process.argv[2] && isAbsolute(process.argv[2]));
const pin = path => ({ path: realpathSync(path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
const config = { inputHelper: { ...pin(process.argv[2]), version: "0.1.0-dev.0" }, executables: { node: pin(process.execPath) } };
const owner = { kind: "host_default" };
async function fixture(t) {
  const cwd = await mkdtemp("/private/tmp/ling-native-node-goal-");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd };
}
test("persisted goal verifies actual Host invocation evidence, not identical printed output", async t => {
  const { cwd } = await fixture(t);
  let store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const now = new Date().toISOString(), participantId = "teammate_builtin_engineer";
  const sourceText = '运行 Node 调用 proof.mjs 中的 formatProof("7319") 验证。';
  const channel = store.createChannel({ name: "Node goal evidence", boundPath: cwd }, now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: sourceText }, now);
  const bound = bindChannelOperationPlan({ sourceItemId: source.id, sourceText, workspaceCwd: cwd,
    defaultOwnerParticipantId: participantId, participants: [store.getAiTeammate(participantId)], candidate: { schemaVersion: 2, operations: [
      { id: "invoke", kind: "run_command", targetKind: "command", required: true, dependsOn: [], owner,
        sourceQuote: sourceText, commandGoal: { kind: "node_function", module: { path: "proof.mjs", sourceQuote: "proof.mjs" },
          invocation: 'formatProof("7319")', sourceQuote: 'formatProof("7319")' } },
    ] } });
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Node goal", objective: sourceText, status: "running", createdBy: "ling_agent" }, now);
  let step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Invoke", prompt: sourceText,
    toParticipantId: participantId, toParticipantLabel: "Engineer", status: "running",
    metadata: { executionPlan: bound.execution, executionOperationIds: ["invoke"] } }, now);
  const requirement = createDelegatedStepRequirement({ workflow, step, participant: { expectedOutcome: "execution" }, manifestFingerprint: "node-goal-test" });
  step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } }, now);
  const snapshot = createWorkflowOperationExecutionSnapshot(step);
  const task = store.createTask({ channelId: channel.id, title: "Invoke", prompt: sourceText, assigneeTeammateId: participantId }, now);
  const runId = "node_goal_evidence_run";
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: runId, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "goal-runtime", runnerId: "pi", status: "started", now });
  store.createRun({ id: runId, cwd, workUnitId: unit.id, taskId: task.id, channelId: channel.id, workflowStepId: step.id,
    teammateId: participantId, providerName: "fixture", providerModel: "fixture", taskSnapshot: task, providerSnapshot: {},
    requestSnapshot: { cwd, workflowOperationExecution: snapshot, delegatedRequirement: requirement,
      effectivePolicySnapshot: resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(), authorizationMode: "always", workspaceAccessMode: "full_access" }).snapshot }, createdAt: now });
  store.linkRunToWorkUnit(runId, unit.id, now); store.markRunStarted(runId, now);
  store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId }, now);
  await writeFile(join(cwd, "proof.mjs"), 'export const formatProof = async value => "proof:" + value;');
  const run = store.getRun(runId), sourceFence = toRuntimeAttemptFence(attempt);
  const execute = async (command, toolCallId) => {
    store.appendEvent(runId, "tool_start", { toolCallId, toolName: "bash", args: { command } });
    const result = await executeUnifiedBashTool({ store, run, sourceFence, restrictedCommandRuntime: new NativeRestrictedCommandRuntime(config),
      request: { toolName: "bash", toolCallId, cwd, task, input: { command, timeoutMs: 4000 } },
      appendAndMaybeStream: (type, data) => store.appendEvent(runId, type, data) });
    store.appendEvent(runId, "tool_end", { toolCallId, toolName: "bash", result, isError: result.isError });
    return result;
  };
  const verify = () => verifyWorkflowStepExecutionOperations({ store, step: store.getChannelWorkflowStep(step.id), now: new Date().toISOString() });
  // The unified Host executor now enforces exact binding itself. A direct caller
  // cannot run a same-output substitute, nor can that failed call satisfy evidence.
  const substitute = await execute(`node -e "console.log('proof:7319')"`, "substitute");
  assert.equal(substitute.isError, true);
  assert.match(substitute.content[0].text, /operation_binding_command_out_of_scope/);
  assert.equal(verify().status, "blocked");
  const command = bound.execution.operations[0].commandMatchPolicy.command;
  const actual = await execute(command, "actual-invocation");
  assert.equal(actual.details.unifiedExec.status, "succeeded", JSON.stringify(actual));
  assert.equal(actual.details.unifiedExec.stdout.preview, "proof:7319\n");
  assert.equal(actual.details.unifiedExec.isolation.backend, "macos_seatbelt");
  assert.equal(verify().status, "verified");
  const actions = listAllExecutionActionsForRun(store, runId);
  const action = actions.find(value => value.toolCallId === "actual-invocation");
  assert.equal(action.commandEvidence.command, command);
  assert.equal(action.commandEvidence.exitCode, 0);
  assert.equal(action.participantId, participantId);
  assert.equal(action.workflowStepId, step.id);
  assert.deepEqual(verify().operationResults[0].evidenceActionIds, [action.id]);
  store.close(); store = createSqliteRunStore(cwd);
  assert.equal(verify().status, "verified", "reopening SQLite must retain the original goal and actual invocation evidence");
  assert.deepEqual(store.getRun(runId).requestSnapshot.workflowOperationExecution.plan, bound.execution);
});

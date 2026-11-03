import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { channelOperationPlanFingerprintV1 } from "@ling-stack/contracts";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";
import { compileChannelCommandInputPolicyScope } from "../dist/features/channels/channel-command-input-policy.js";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot, validateWorkflowOperationRunContext } from "../dist/features/runs/workflow-operation-snapshot.js";
import { ProtectedHostStageRegistry } from "../dist/runtime/sandbox/protected-host-staging.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";

const now = "2026-10-27T15:00:00.000Z";
const participantId = "protected-policy-qa";
const command = "node project/main.mjs";
const body = `@Policy QA 运行 ${command}，入口 project/main.mjs。`;

// Real Store/Run/Attempt/typed workflow source custody only. No child, native
// launch, model request, or packaged GUI is exercised by these regressions.
async function fixture(t, mode = "local", options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-policy-protected-source-")));
  const cwd = join(root, "workspace"), executionCwd = mode === "local" ? cwd : join(root, "execution");
  await mkdir(cwd);
  if (executionCwd !== cwd) await mkdir(executionCwd);
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.updateApprovalPolicy({ toolDecisions: { read: "allow", bash: "allow" } }, now);
  const owner = store.createAiTeammate({ id: participantId, roleKey: "qa", displayName: "Policy QA",
    description: "Isolated protected source", allowedTools: ["read", "bash"], approvalProfile: { mode: "none" } }, now);
  const channel = store.createChannel({ name: "Protected command input", boundPath: cwd, allowedTools: ["read", "bash"],
    ...(mode === "local" ? {} : { workspaceBinding: { mode, status: "ready", updatedAt: now,
      ...(mode === "managed_worktree" ? { worktreePath: executionCwd } : { executionPath: executionCwd }) } }) }, now);
  store.replaceTeammateChannelMemberships(participantId, [{ channelId: channel.id }], now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body,
    mentions: [{ kind: "ai-teammate", id: participantId, label: "Policy QA" }] }, now);
  const sourceItem = store.getConversationItem(source.id);
  const context = { channelId: channel.id, participantId, operationId: "run-main", sourceItemId: source.id, workspaceCwd: cwd };
  const scope = compileChannelCommandInputPolicyScope({ store, ...context });
  assert.ok(scope?.policyAuthority, "The real Host must compile policy before a source-custody test starts");
  const bound = bindChannelOperationPlan({ sourceItemId: source.id, sourceText: body, workspaceCwd: executionCwd,
    participants: [owner], visibleSources: [{ itemId: source.id, body, revision: sourceItem.revision, actorType: sourceItem.actorType }],
    compileCommandInputScope: input => compileChannelCommandInputPolicyScope({ store, ...context,
      operationId: input.operationId, participantId: input.participantId, sourceItemId: input.sourceItemId }),
    candidate: { schemaVersion: 2, operations: [{ id: "run-main", kind: "run_command", targetKind: "command",
      required: true, dependsOn: [], owner: { participantId, sourceQuote: "Policy QA" }, sourceQuote: body,
      command: { text: command, sourceQuote: command }, inputs: [{ path: "project/main.mjs", sourceQuote: "project/main.mjs" }] }] } });
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.deepEqual(bound.execution.operations[0].binding.commandInputScope, scope);
  if (options.tamperFrozenScope) {
    bound.execution.operations[0].binding.commandInputScope.policyAuthority.policyFingerprint = "b".repeat(64);
    bound.execution.fingerprint = channelOperationPlanFingerprintV1(bound.execution.operations);
  }
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Protected policy source", objective: body,
    status: "running", createdBy: "ling_agent" }, now);
  let step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Run bound command", prompt: body,
    toParticipantId: participantId, toParticipantLabel: "Policy QA", status: "running",
    metadata: { executionPlan: bound.execution, executionOperationIds: ["run-main"] } }, now);
  const requirement = createDelegatedStepRequirement({ workflow, step, participant: { expectedOutcome: "execution" },
    manifestFingerprint: "isolated-source-manifest" });
  step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } }, now);
  const snapshot = createWorkflowOperationExecutionSnapshot(step);
  const task = store.createTask({ channelId: channel.id, title: "Protected source task", prompt: body,
    assigneeTeammateId: participantId }, now);
  const runId = `policy-source-${step.id}`;
  const unit = store.createWorkUnit({ workspaceId: channel.workspaceId, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: runId, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "isolated-source-runtime", runnerId: "pi", status: "started", now });
  const sourceFence = toRuntimeAttemptFence(attempt);
  if (options.finalReadDecision) store.updateApprovalPolicy({ toolDecisions: { read: options.finalReadDecision } }, now);
  const policy = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    approvalProfile: owner.approvalProfile, channelBoundPath: channel.boundPath }).snapshot;
  store.createRun({ id: runId, cwd: executionCwd, workUnitId: unit.id, taskId: task.id, channelId: channel.id,
    threadId: sourceItem.threadId, workflowStepId: step.id, teammateId: participantId,
    providerName: "isolated", providerModel: "isolated", taskSnapshot: { id: task.id, title: task.title }, providerSnapshot: {},
    requestSnapshot: { effectivePolicySnapshot: policy, workflowOperationExecution: snapshot, delegatedRequirement: requirement },
    createdAt: now });
  store.linkRunToWorkUnit(runId, unit.id, now);
  store.markRunStarted(runId, now);
  store.updateChannelWorkflowStep(step.id, { taskId: task.id, runId }, now);
  const run = store.getRun(runId), registry = new ProtectedHostStageRegistry(), toolCallId = "isolated-source-call";
  assert.equal(validateWorkflowOperationRunContext({ store, run }).status, "ready");
  assert.equal(store.isCurrentRunExecutionOwner(run.id, sourceFence), true);
  const input = { command, cwd: executionCwd, policy, commandInputScope: scope,
    source: { ...sourceFence, workspaceId: channel.workspaceId, runId: run.id, toolCallId } };
  return { root, cwd, executionCwd, channel, sourceItem, scope, run, registry, input, sourceFence,
    get store() { return store; },
    capture() { return registry.captureActorSource({ store, run: store.getRun(runId), sourceFence, command, toolCallId }); },
    assert(token, overrides = {}) { registry.assertActorSource(token, { ...input, ...overrides }); },
    reopen() { store.close(); store = createSqliteRunStore(cwd); } };
}

test("external execution root retains real protected actor source custody", async t => {
  const f = await fixture(t, "external_path");
  const token = f.capture();
  f.assert(token);
});

for (const mode of ["local", "managed_worktree"]) test(`${mode} retains real protected actor source custody`, async t => {
  const f = await fixture(t, mode), token = f.capture();
  f.assert(token);
  assert.deepEqual(f.store.getRun(f.run.id).requestSnapshot.workflowOperationExecution.plan.operations[0]
    .binding.commandInputScope, f.scope);
});

const policyChanged = /restricted_command_input_policy_changed/u;
const sourceOrPolicyChanged = /protected_host_source_obsolete|restricted_command_input_policy_changed/u;

for (const mode of ["local", "external_path", "managed_worktree"]) {
  for (const [name, mutate] of [
    ["workspace read", f => f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, now)],
    ["channel read", f => f.store.updateChannel(f.channel.id, { allowedTools: ["bash"] }, now)],
    ["owner read", f => f.store.updateAiTeammate(participantId, { allowedTools: ["bash"] }, now)],
    ["membership", f => f.store.replaceTeammateChannelMemberships(participantId, [], now)],
    ["source", f => { const item = f.sourceItem; f.store.appendConversationItem({
      channelId: item.channelId, threadId: item.threadId, turnId: item.turnId, kind: item.kind,
      status: "committed", actorType: item.actorType, visibility: item.visibility,
      payload: { ...item.payload, body: `${item.payload.body} 取消。` }, domainRefs: item.domainRefs,
      supersedesItemId: item.id }, now); }],
  ]) test(`${mode}: revoking ${name} invalidates an already captured source`, async t => {
    const f = await fixture(t, mode), token = f.capture();
    mutate(f);
    assert.throws(() => f.assert(token), sourceOrPolicyChanged);
    assert.throws(() => f.capture(), sourceOrPolicyChanged, "Capturing a new token cannot refresh the frozen grant");
  });

  test(`${mode}: replacing the root at the same path invalidates source custody`, async t => {
    const f = await fixture(t, mode), token = f.capture();
    await rename(f.executionCwd, `${f.executionCwd}-previous`);
    await mkdir(f.executionCwd);
    assert.throws(() => f.assert(token), policyChanged);
    assert.throws(() => f.capture(), policyChanged);
  });

  test(`${mode}: reopening the owning Store preserves the same frozen scope`, async t => {
    const f = await fixture(t, mode);
    f.assert(f.capture());
    const frozen = structuredClone(f.scope);
    f.reopen();
    assert.deepEqual(f.store.getRun(f.run.id).requestSnapshot.workflowOperationExecution.plan.operations[0]
      .binding.commandInputScope, frozen);
    f.assert(f.capture());
    f.store.replaceTeammateChannelMemberships(participantId, [], now);
    f.reopen();
    assert.deepEqual(f.store.getRun(f.run.id).requestSnapshot.workflowOperationExecution.plan.operations[0]
      .binding.commandInputScope, frozen);
    assert.throws(() => f.capture(), policyChanged, "Store reopen must not recompile an expanded authority");
  });
}

for (const finalReadDecision of ["ask", "deny"]) test(`actual Run read=${finalReadDecision} cannot capture a policy source`, async t => {
  const f = await fixture(t, "local", { finalReadDecision });
  assert.equal(f.store.getRun(f.run.id).requestSnapshot.effectivePolicySnapshot.toolDecisions.read, finalReadDecision);
  assert.throws(() => f.capture(), /restricted_command_input_read_not_allowed/u);
});

test("source custody rejects injected scopes, cross-operation scopes, and command substitution", async t => {
  const f = await fixture(t), token = f.capture();
  for (const field of ["policyFingerprint", "participantId", "operationId", "sourceItemId", "sourceRevision"]) {
    const forged = structuredClone(f.scope);
    forged.policyAuthority[field] = field === "policyFingerprint" ? "b".repeat(64)
      : field === "sourceRevision" ? forged.policyAuthority.sourceRevision + 1 : `other-${field}`;
    assert.throws(() => f.assert(token, { commandInputScope: forged }), /protected_host_actor_binding_invalid/u, field);
  }
  const otherOperationScope = compileChannelCommandInputPolicyScope({ store: f.store,
    channelId: f.channel.id, participantId, sourceItemId: f.sourceItem.id, operationId: "other-operation", workspaceCwd: f.cwd });
  assert.ok(otherOperationScope?.policyAuthority);
  assert.throws(() => f.assert(token, { commandInputScope: otherOperationScope }), /protected_host_actor_binding_invalid/u);
  assert.throws(() => f.assert(token, { command: "node other.mjs" }), /protected_host_actor_binding_invalid/u);
});

test("a validly shaped but injected policy fingerprint in the persisted plan is not issuer authority", async t => {
  const f = await fixture(t, "local", { tamperFrozenScope: true });
  assert.equal(validateWorkflowOperationRunContext({ store: f.store, run: f.run }).status, "ready");
  assert.throws(() => f.capture(), policyChanged);
});

test("omitting caller scope does not bypass revalidation of the Run's frozen scope", async t => {
  const f = await fixture(t), token = f.capture();
  f.store.replaceTeammateChannelMemberships(participantId, [], now);
  assert.throws(() => f.assert(token, { commandInputScope: undefined }), policyChanged);
});

test("a current policy source cannot prepare an omitted or substituted user scope", async t => {
  const f = await fixture(t), token = f.capture();
  for (const commandInputScope of [undefined, { kind: "node_module_closure_v1", projectRoot: "project",
    sourceRefs: [{ itemId: f.sourceItem.id, revision: f.sourceItem.revision, actorType: "local_user", quote: "project" }] }]) {
    assert.throws(() => f.assert(token, { commandInputScope }), /protected_host_actor_binding_invalid/u);
  }
  f.assert(token);
});

test("a no-op authority callback cannot bypass private DB-backed source checks during native preparation", async t => {
  const f = await fixture(t), token = f.capture();
  const pin = path => ({ path: realpathSync(path), sha256: createHash("sha256").update(readFileSync(realpathSync(path))).digest("hex") });
  const runtime = new NativeRestrictedCommandRuntime({ inputHelper: { ...pin("/usr/bin/true"), version: "source-custody-test" },
    executables: { node: pin(process.execPath) } }, f.registry);
  f.store.replaceTeammateChannelMemberships(participantId, [], now);
  let callbackCalls = 0;
  await assert.rejects(() => runtime.prepare({ ...f.input, inputRefs: [], protectedActorSource: token,
    assertCurrentAuthority() { callbackCalls++; } }), policyChanged);
  assert.equal(callbackCalls, 0, "Private source validation must precede the replaceable caller callback");
});

test("a superseded actual Attempt fence invalidates a captured policy source", async t => {
  const f = await fixture(t), token = f.capture();
  f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "isolated-successor", runnerId: "pi", status: "started", now });
  assert.throws(() => f.assert(token), /protected_host_source_obsolete/u);
});

test("a terminal actual Run cannot reuse its previously captured policy source", async t => {
  const f = await fixture(t), token = f.capture();
  f.store.markRunSucceeded(f.run.id, now);
  assert.throws(() => f.assert(token), /protected_host_source_obsolete/u);
});

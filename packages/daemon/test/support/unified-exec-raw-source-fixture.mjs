import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { approvalSideEffectFingerprintV1, createApprovalResumeBasisV1, createSqliteRunStore,
  DEFAULT_WORKSPACE_ID, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { createApprovalCommandRuleProposal } from "../../dist/features/runs/approval-command-rules.js";
import { createDelegatedStepRequirement } from "../../dist/features/channels/workflow-step-requirement.js";
import { executeUnifiedBashTool } from "../../dist/features/runs/unified-exec.js";
import { AttemptHostOperationTracker } from "../../dist/runtime/attempt-host-operation-tracker.js";
import { ProtectedHostStageRegistry } from "../../dist/runtime/sandbox/protected-host-staging.js";
import { observeSourceHookBootstrap } from "./protected-host-source-bootstrap-observer.mjs";

/** Missing original entries remain an explicit regression, not a skipped test. */
export async function loadRawSourceModule() {
  try { return await import("../../dist/features/runs/unified-exec-raw-source.js"); }
  catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("unified-exec-raw-source.js")) throw error;
    return undefined;
  }
}

/** Real SQLite owner, current Attempt, policy and Host journal; no authority method is stubbed. */
export async function createRawSourceFixture(t, options = {}) {
  const root = realpathSync(mkdtempSync("/private/tmp/ling-unified-raw-source-"));
  const cwd = join(root, "workspace"), stagePath = join(root, "stage");
  for (const path of [cwd, stagePath]) mkdirSync(path, { mode: 0o700 });
  const store = createSqliteRunStore(cwd), registry = new ProtectedHostStageRegistry();
  let stage;
  t.after(() => {
    if (stage) registry.closeStage(stage);
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  const now = new Date().toISOString(), runId = "unified-raw-source-run";
  const delegation = options.delegated ? createUntypedRawWorkflow(store, cwd, now) : undefined;
  const task = delegation ? store.createTask({ channelId: delegation.channel.id, title: "Untyped raw delegation",
    prompt: "Isolated untyped delegated command", assigneeTeammateId: delegation.step.toParticipantId }, now)
    : { id: "unified-raw-source-task", title: "Raw source regression", prompt: "Isolated public Host entry" };
  const authorizationMode = options.authorizationMode ?? "always";
  const workspaceAccessMode = options.workspaceAccessMode ?? "workspace_write";
  const effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: store.getApprovalPolicy(),
    authorizationMode, workspaceAccessMode, channelBoundPath: cwd }).snapshot;
  const selectedSkill = options.skillApprovalProfile ? publishSelectedRawSkill(store, options.skillApprovalProfile, now) : undefined;
  const defaultSnapshot = { authorizationMode, workspaceAccessMode, effectivePolicySnapshot,
    ...(delegation ? { delegatedRequirement: delegation.requirement } : {}),
    ...(selectedSkill ? { requestedSkillId: selectedSkill.skill.id, teammateId: selectedSkill.teammate.id } : {}),
    ...(options.permissionConfirmation ? { permissionConfirmation: options.permissionConfirmation } : {}) };
  const requestSnapshot = typeof options.requestSnapshot === "function" ? options.requestSnapshot(defaultSnapshot)
    : options.requestSnapshot ?? defaultSnapshot;
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: runId,
    idempotencyKey: runId, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "raw-source-runtime", runnerId: "pi", status: "started", now });
  store.createRun({ id: runId, cwd, workUnitId: unit.id, taskId: task.id, providerName: "fixture", providerModel: "fixture",
    ...(selectedSkill ? { selectedSkillId: selectedSkill.skill.id, teammateId: selectedSkill.teammate.id } : {}),
    ...(delegation ? { channelId: delegation.channel.id, workflowStepId: delegation.step.id,
      teammateId: delegation.step.toParticipantId } : {}),
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot, createdAt: now });
  store.linkRunToWorkUnit(runId, unit.id, now); store.markRunStarted(runId, now);
  if (delegation) delegation.step = store.updateChannelWorkflowStep(delegation.step.id, { runId, taskId: task.id }, now);
  const run = store.getRun(runId), sourceFence = toRuntimeAttemptFence(attempt);
  const source = { runId, ...sourceFence };
  const tracker = options.trackHost === false ? undefined : new AttemptHostOperationTracker({ store, source });
  const handle = tracker?.beginHostCall("command", "raw-source-call"), hostOperation = handle && tracker.commandOperation(handle);
  if (options.activeStage) {
    // This is source/approval/journal placement, not native containment conformance.
    // Isolate only the dyld registration input; real raw producers and all guards
    // stay unchanged. The observer supplies no OS/profile/FD/descendant proof.
    observeSourceHookBootstrap(t);
    stage = registry.registerStage({ store, run, sourceFence, stagePath });
  }
  const module = await loadRawSourceModule();
  if (module) {
    assert.ok(module.UNIFIED_EXEC_RAW_ACTOR_ENTRY, "the actual controlled raw entry must be exported");
    assert.ok(module.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY, "the independent Full Access source entry must be exported");
    registry.bindOriginalActorEntries([module.UNIFIED_EXEC_RAW_ACTOR_ENTRY, module.UNIFIED_EXEC_FULL_ACCESS_ACTOR_ENTRY]);
  }
  const execute = (input = {}, extra = {}) => executeUnifiedBashTool({ store, run, sourceFence,
    request: { toolName: "bash", toolCallId: "raw-source-call", cwd, task,
      input: { command: "printf raw-source", timeoutMs: 3000, ...input } },
    hostOperation, appendAndMaybeStream: (type, data) => store.appendExecutionEvent(runId, sourceFence, type, data), ...extra });
  return { root, cwd, stagePath, store, registry, stage, module, now, run, sourceFence, source, task,
    tracker, handle, hostOperation, execute, effectivePolicySnapshot, selectedSkill, delegation };
}

/** Counts entry into the real child_process producer; this is placement evidence, not kernel isolation. */
export function observeRawProducer(t, replacement) {
  const calls = [], original = childProcess.spawn;
  const patch = t.mock.method(childProcess, "spawn", (...args) => {
    calls.push(args);
    return replacement ? replacement(...args) : original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { patch.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

export const commandFacts = f => f.store.listEvents(f.run.id).filter(event => event.type === "host_command_settled");
export const operationFact = f => f.store.getHostOperation(f.handle.operationId);
export const quoteShell = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** Creates actual persisted approval/checkpoint/basis, never a truthy caller authorization flag. */
export function approveRawCommand(f, command = "printf raw-source", options = {}) {
  const toolCallId = options.toolCallId ?? "raw-source-call";
  const payload = { type: "bash", cwd: f.cwd, command, riskFlags: [] };
  const proposal = options.commandRule ? createApprovalCommandRuleProposal({ command,
    requestedPrefix: undefined, risk: "medium", riskFlags: [] }) : undefined;
  if (options.commandRule) assert.ok(proposal, "fixture command must have a safe Host-derived rule proposal");
  const approval = f.store.createExecutionApprovalRequest({ runId: f.run.id, taskId: f.task.id, toolCallId,
    ...(f.run.channelId ? { channelId: f.run.channelId } : {}),
    actionType: "bash", risk: "medium", title: "Approve isolated raw command", description: command, payload,
    ...(proposal ? { proposedCommandRule: proposal, availableDecisions: ["approve_once", "approve_command_rule", "deny"] } : {}) },
  f.sourceFence, f.now);
  const checkpoint = f.store.getApprovalCheckpointForApproval(approval.id);
  const basis = createApprovalResumeBasisV1({ approvalId: approval.id, runId: f.run.id,
    workUnitId: f.sourceFence.workUnitId, priorAttemptId: options.priorAttemptId ?? f.sourceFence.attemptId,
    ...(f.run.workflowStepId ? { workflowStepId: f.run.workflowStepId } : {}),
    ...(f.delegation ? { delegatedRequirementFingerprint: f.delegation.requirement.fingerprint } : {}),
    toolCallId, actionType: "bash", sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: "bash", toolCallId, sideEffect: payload }) });
  assert.ok(f.store.updateApprovalCheckpointStatus(checkpoint.id, { status: "pending", expectedStatus: "pending",
    expectedRevision: checkpoint.revision, resumeBasis: basis }, f.now));
  const resolved = f.store.approveApprovalRequest(approval.id, { reason: "Temporary regression fixture",
    ...(proposal ? { decisionKind: "approve_command_rule", proposedRuleFingerprint: proposal.fingerprint } : {}) }, f.now);
  assert.equal(resolved.status, "approved");
  return { approval: resolved, checkpoint: f.store.getApprovalCheckpointForApproval(approval.id), basis,
    rule: proposal ? f.store.listApprovalCommandRules()[0] : undefined };
}

/** Mutates only this disposable SQLite fixture, to model persisted source churn after capture. */
export function replacePersistedRequestSnapshot(f, snapshot) {
  f.store.database.prepare("UPDATE run_sessions SET request_snapshot_json = ? WHERE id = ?")
    .run(JSON.stringify(snapshot), f.run.id);
}

export function changeWorkspacePolicy(f, toolDecisions = { bash: "deny" }) {
  return f.store.updateApprovalPolicy({ toolDecisions }, new Date(Date.parse(f.now) + 1).toISOString());
}

export function replaceRawAttempt(f) {
  return f.store.createWorkUnitAttempt({ workUnitId: f.run.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "raw-replacement-runtime", runnerId: "pi", status: "started", now: new Date().toISOString() });
}

export function mutateAfterCommandBind(f, mutate) {
  return { ...f.hostOperation, bindCommandExecution(executionId) {
    f.hostOperation.bindCommandExecution(executionId); mutate();
  } };
}

export function assertKnownNoStart(f, { requireCommandFact = true } = {}) {
  assert.equal(operationFact(f).settlementKind, "known_no_start");
  assert.deepEqual(f.store.listHostOperationBlockers(f.source), []);
  assert.deepEqual(f.store.listHostCommandWriteBlockers(f.cwd), []);
  if (requireCommandFact) assert.equal(commandFacts(f).at(-1).data.outcome, "not_started");
  else assert.ok(commandFacts(f).every(event => event.data.outcome === "not_started"));
}

/** Published Skill and executable binding use Store APIs; no runtime resolver is patched. */
function publishSelectedRawSkill(store, approvalProfile, now) {
  const definition = { id: "raw-source-regression-skill", name: "Raw source regression skill",
    summary: "Scoped source/profile fixture", roleAffinity: ["engineer"], promptFragments: ["Test only."],
    requiredTools: ["bash"], requiredProviderCapabilities: [], approvalProfile, stateEffects: [] };
  const draft = store.createSkillImportDraft({ source: "custom", name: "Raw source regression pack",
    description: "Disposable fixture", definitions: [{ definition }] }, now);
  const skill = store.publishSkillImportDraft(draft.id, now)[0];
  const teammate = store.createAiTeammate({ roleKey: "engineer", displayName: "Raw source fixture teammate",
    description: "Disposable fixture", allowedTools: ["read", "bash"], approvalProfile: { mode: "strict" } }, now);
  store.replaceTeammateSkillBindings(teammate.id, [{ skillId: skill.id, source: "user", enabled: true }], now);
  return { skill, teammate };
}

export function changeSelectedSkillProfile(f, approvalProfile) {
  const skill = f.store.getSkillRegistryEntry(f.selectedSkill.skill.id);
  const now = new Date(Date.parse(f.now) + 1).toISOString();
  const draft = f.store.createSkillImportDraft({ source: "custom", name: "Raw source regression revision",
    description: "Disposable fixture revision", definitions: [{ definition: { ...skill.definition, approvalProfile } }] }, now);
  return f.store.publishSkillRevisionDraft({ draftId: draft.id, skillId: skill.id, expectedUpdatedAt: skill.updatedAt }, now);
}

/** Test-only overrides probe factory bindings; production authority methods are never replaced. */
export function createRealRawDispatch(f, options = {}) {
  assert.equal(typeof f.module?.createUnifiedExecRawDispatch, "function", "actual source dispatch must exist");
  const approvalRequest = { toolName: "bash", toolCallId: "raw-source-call", cwd: f.cwd, task: f.task,
    ...options.approvalRequest,
    input: { command: "printf raw-source", timeoutMs: 3000, ...options.approvalRequest?.input } };
  const request = { runId: f.run.id, taskId: f.task.id, toolCallId: approvalRequest.toolCallId,
    approvalId: options.approvalId, cwd: resolve(f.cwd, approvalRequest.input.cwd ?? approvalRequest.cwd),
    command: { kind: "shell", shell: "bash", command: approvalRequest.input.command },
    timeoutMs: approvalRequest.input.timeoutMs, idleTimeoutMs: undefined, pty: false,
    environment: { mode: "inherit_minimal" }, startedBy: "run_tool", ...options.normalizedRequest };
  return f.module.createUnifiedExecRawDispatch({ store: f.store, run: f.run, sourceFence: f.sourceFence,
    approvalRequest, request, approvalId: options.approvalId });
}

/** A genuine untyped workflow requirement has no operation snapshot or executionPlanFingerprint. */
function createUntypedRawWorkflow(store, cwd, now) {
  const channel = store.createChannel({ name: "Untyped raw source fixture", boundPath: cwd }, now);
  const workflow = store.createChannelWorkflow({ channelId: channel.id, title: "Untyped raw delegation",
    objective: "Exercise approval requirement lineage", status: "running", createdBy: "ling_agent" }, now);
  let step = store.createChannelWorkflowStep({ workflowId: workflow.id, title: "Untyped raw command",
    prompt: "Execute the approved isolated command", toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer", status: "running" }, now);
  const requirement = createDelegatedStepRequirement({ workflow, step, participant: { expectedOutcome: "execution" },
    manifestFingerprint: "manifest:untyped-raw-fixture" });
  assert.equal(requirement.executionPlanFingerprint, undefined);
  assert.ok(requirement.fingerprint);
  step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } }, now);
  return { channel, workflow, step, requirement };
}

export function changeUntypedRawRequirement(f) {
  const step = f.store.getChannelWorkflowStep(f.delegation.step.id);
  const requirement = createDelegatedStepRequirement({ workflow: f.delegation.workflow, step,
    participant: { expectedOutcome: "execution" }, manifestFingerprint: "manifest:untyped-raw-replacement" });
  assert.notEqual(requirement.fingerprint, f.delegation.requirement.fingerprint);
  return f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } },
    new Date().toISOString());
}

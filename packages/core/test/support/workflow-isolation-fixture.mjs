import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { createSqliteWorkflowIsolationStore, workflowIsolationScopePlanDigest, workflowIsolationSafetyFingerprint,
  workflowIsolationStepSafetyFingerprint, workflowStepSafetyPlanDigest, toRuntimeAttemptFence } from "../../dist/index.js";
import { workflowAdmissionFixture, admissionParticipant } from "./workflow-step-admission-fixture.mjs";

export const isolationTables = ["workflow_integration_rounds", "workflow_integration_generations", "workflow_isolation_scope_plans",
  "workflow_isolation_bindings", "workflow_isolation_intents", "workflow_isolation_receipts", "workflow_isolation_commands"];
export const baseCommit = "1".repeat(40);
export const baseTree = "2".repeat(40);
export const nextCommit = "3".repeat(40);
export const nextTree = "4".repeat(40);
export const repositoryBasis = `wgr1_${"5".repeat(64)}`;

/** Real SQLite, no Git/provider/Runner effects, and physical execution roots intentionally do not exist. */
export async function workflowIsolationFixture(t, { create = true, pin = true } = {}) {
  const f = await workflowAdmissionFixture(t);
  f.scopeIsolation = f.scope("isolated-writing");
  const { workflow, step } = f.scopeIsolation;
  f.scopeIsolation.plan = f.plan({ entries: f.plan().entries.map(e => ({ ...e, limit: 1 })),
    resourceKeys: [`workflow:${workflow.id}`, "workspace:canonical-isolation", "port:17449"] });
  const safety = { sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: false, resourceKeys: ["port:17449"] } };
  const graph = { schemaVersion: 1, id: "isolation-graph", name: "Isolation", entryNodeId: "write",
    nodes: [{ id: "write", kind: "step", name: "Write", prompt: step.prompt, ...safety }], edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "fail_workflow", onApprovalDenied: "block_for_user" } };
  f.graphFingerprint = workflowGraphFingerprintV1(graph);
  f.store.updateChannelWorkflow(workflow.id, { metadata: { workflowGraph: graph, workflowGraphFingerprint: f.graphFingerprint } }, f.at(0));
  f.executionRoot = join(f.root, "isolated-step-1");
  const safetyInput = { schemaVersion: 1, profile: "serial_v1", workflowId: workflow.id, workflowStepId: step.id,
    workspaceRoot: f.cwd, executionRoot: f.executionRoot, safety, tools: ["read", "write"], runnerId: "pi",
    networkAccess: false, writeRoots: [f.executionRoot] };
  f.store.updateChannelWorkflowStep(step.id, { metadata: { ...f.current(f.scopeIsolation).metadata, ...safety,
    requestedRunnerId: "pi", requiredTools: ["read", "write"], safetyPlan: { ...safetyInput, digest: workflowStepSafetyPlanDigest(safetyInput) } } }, f.at(0));
  f.stepFingerprint = workflowIsolationStepSafetyFingerprint(f.current(f.scopeIsolation));
  const safetyPins = [{ workflowStepId: step.id, fingerprint: f.stepFingerprint }];
  f.inputs = { schemaVersion: 1, workflowId: workflow.id, canonicalWorkspaceId: f.channel.workspaceId, canonicalWorkspaceRoot: f.cwd,
    repositoryIdentity: { commonDir: join(f.cwd, ".git"), objectFormat: "sha1" },
    target: { executionRoot: f.cwd, worktreeId: "target-worktree", branchRef: "refs/heads/main", expectedHead: baseCommit,
      cleanStateDigest: repositoryBasis, inputMode: "clean_checkout" }, baseCommit,
    integration: { executionRoot: join(f.root, "isolated-integration-1"), worktreeId: "integration-worktree-1", branchRef: "refs/heads/ling/integration-1" },
    graphFingerprint: f.graphFingerprint, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins), safetyPins,
    templatePins: [], participants: [{ workflowStepId: step.id, position: step.position, required: true }], mergeOrder: [step.id],
    optionalFailurePolicy: "require_success", validationRequirements: [{ id: "tests", fingerprint: "validation-tests-v1" }], mode: "candidate_only" };
  f.roundId = "isolation-round-1";
  const planInput = { schemaVersion: 1, planId: "isolation-plan-1", workflowId: workflow.id, workflowStepId: step.id,
    canonicalWorkspaceId: f.channel.workspaceId, canonicalWorkspaceRoot: f.cwd, repositoryIdentity: f.inputs.repositoryIdentity,
    target: f.inputs.target, integrationRoundId: f.roundId, generation: 1, stepGeneration: 1, baseCommit,
    executionRoot: f.executionRoot, worktreeId: "isolated-worktree-1", branchRef: "refs/heads/ling/step-1",
    graphFingerprint: f.graphFingerprint, safetyFingerprint: f.stepFingerprint, templatePins: [], resourcePlan: f.scopeIsolation.plan };
  f.plan = { ...planInput, planDigest: workflowIsolationScopePlanDigest(planInput) };
  f.isolation = createSqliteWorkflowIsolationStore(f.store);
  f.peerIsolation = createSqliteWorkflowIsolationStore(f.peer);
  f.round = () => f.isolation.getIntegrationRound(f.roundId);
  f.binding = () => f.isolation.getExecutionBinding("isolation-binding-1");
  f.create = () => {
    assert.equal(f.isolation.createIntegrationRound({ roundId: f.roundId, inputs: f.inputs, now: f.at(0) }).status, "created");
    const result = f.isolation.createScopePlan({ plan: f.plan, now: f.at(0) });
    assert.equal(result.status, "created", JSON.stringify(result));
  };
  f.persistPin = () => f.store.updateChannelWorkflowStep(step.id, { metadata: { ...f.current(f.scopeIsolation).metadata,
    isolationScopePlan: { planId: f.plan.planId, planDigest: f.plan.planDigest } } }, f.at(0));
  if (create) f.create();
  if (pin) f.persistPin();
  f.prepare = () => {
    f.generation = f.begin(f.scopeIsolation);
    assert.equal(f.store.transitionTaskStatus({ taskId: f.generation.task.id, expectedStatus: "todo", event: "claim", actor: "system", now: f.at(3) }).ok, true);
    const task = f.store.getTask(f.generation.task.id);
    const run = f.store.createRun({ id: "isolation-run-1", cwd: f.executionRoot, taskId: task.id, channelId: f.channel.id,
      teammateId: admissionParticipant, workflowStepId: step.id, providerName: "fixture", providerModel: "fixture", taskSnapshot: task,
      providerSnapshot: {}, requestSnapshot: { cwd: f.executionRoot, workflowStartOwner: f.generation.owner,
        workflowIsolationPlan: { planId: f.plan.planId, planDigest: f.plan.planDigest } }, createdAt: f.at(3) });
    const unit = f.store.createWorkUnit({ id: "isolation-unit-1", workspaceId: f.channel.workspaceId, kind: "task_run", ownerType: "task",
      ownerId: task.id, taskId: task.id, channelId: f.channel.id, teammateId: admissionParticipant, runnerId: "pi", effectiveRunnerId: "pi",
      idempotencyKey: "isolation-unit-1", createdByActor: "system", request: {}, now: f.at(3) });
    f.store.linkRunToWorkUnit(run.id, unit.id, f.at(3));
    const attempt = f.store.createWorkUnitAttempt({ id: "isolation-attempt-1", workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: "isolation-runtime-1", runnerId: "pi", now: f.at(3) });
    f.prepared = { run: f.store.getRun(run.id), unit: f.store.getWorkUnit(unit.id), attempt, fence: toRuntimeAttemptFence(attempt) };
    f.writer = { bindingId: "isolation-binding-1", ...f.prepared.fence };
    f.bindInput = { bindingId: f.writer.bindingId, planId: f.plan.planId, planDigest: f.plan.planDigest,
      startOwner: f.generation.owner, runId: run.id, fence: f.prepared.fence, now: f.at(4) };
  };
  f.bind = () => { f.prepare(); const result = f.isolation.bindExecution(f.bindInput); assert.equal(result.status, "created", JSON.stringify(result)); return result.value; };
  f.link = () => {
    assert.equal(f.transfer(f.scopeIsolation, f.generation, f.prepared).status, "transferred");
    assert.equal(f.ready(f.scopeIsolation, f.generation, f.prepared).status, "linked");
  };
  f.gitIdentity = (exists, location = f.plan) => ({ executionRoot: location.executionRoot, worktreeId: location.worktreeId,
    branchRef: location.branchRef, commonDir: f.inputs.repositoryIdentity.commonDir, exists, headCommit: exists ? baseCommit : null,
    ...(exists ? { tree: baseTree, cleanStateDigest: repositoryBasis } : {}) });
  f.intentInput = (overrides = {}) => ({ intentId: "isolation-create-intent", commandId: "isolation-create-command",
    scope: { type: "binding", bindingId: f.writer.bindingId }, expectedRevision: f.binding().revision, writer: f.writer,
    kind: "worktree_create", before: f.gitIdentity(false), after: f.gitIdentity(true), now: f.at(7), ...overrides });
  f.intent = (overrides = {}) => { const result = f.isolation.recordIntent(f.intentInput(overrides)); assert.equal(result.status, "created", JSON.stringify(result)); return result.value; };
  f.receiptInput = (intent, overrides = {}) => {
    const observed = overrides.observed ?? intent.after;
    const artifact = f.store.createArtifact({ runId: f.prepared.run.id, type: "json", path: `harness/${intent.intentId}.json`,
      sealedPayload: { schemaVersion: 1, kind: "host_git_observation", intentId: intent.intentId, observed }, createdAt: f.at(8) });
    return { receiptId: `${intent.intentId}-receipt`, intentId: intent.intentId, expectedRevision: intent.scope.type === "binding" ? f.binding().revision : f.round().revision,
      writer: f.writer, outcome: "confirmed", observed, artifactId: artifact.id, now: f.at(9), ...overrides };
  };
  f.receipt = (intent, overrides = {}) => { const result = f.isolation.recordReceipt(f.receiptInput(intent, overrides)); assert.equal(result.status, "created", JSON.stringify(result)); return result.value; };
  f.makeReady = ({ linked = true } = {}) => {
    f.bind(); if (linked) f.link(); const intent = f.intent(), receipt = f.receipt(intent);
    const result = f.isolation.markExecutionReady({ commandId: "isolation-ready", writer: f.writer, expectedRevision: f.binding().revision,
      creationReceiptId: receipt.receiptId, now: f.at(10) });
    assert.equal(result.status, "updated", JSON.stringify(result));
    return result.value;
  };
  f.executionPayload = () => {
    const run = f.store.getRun(f.prepared.run.id), stored = run.taskSnapshot;
    const sourceTask = run.requestSnapshot.task ?? stored;
    const task = { id: sourceTask.id, title: sourceTask.title, prompt: sourceTask.prompt,
      ...(sourceTask.channelId === undefined ? {} : { channelId: sourceTask.channelId }) };
    const tools = ["read", "write"];
    const prepared = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id, systemPrompt: "Frozen fixture",
      userPrompt: task.prompt, model: { id: "fixture", provider: "fixture" }, thinkingLevel: "off",
      tools: tools.map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })) };
    return { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
      input: { cwd: f.executionRoot, task, provider: { provider: "fixture", model: "fixture" }, tools },
      preparedInput: { ...prepared, fingerprint: createHash("sha256").update(JSON.stringify(prepared)).digest("hex") } };
  };
  f.advance = (to, extra = {}) => f.isolation.advanceIntegrationRound({ commandId: `advance-${to}`, roundId: f.roundId, generation: f.round().generation,
    expectedRevision: f.round().revision, from: f.round().phase, to, writer: f.writer, now: f.at(12), ...extra });
  f.snapshotIsolation = () => ({ ...f.snapshot(), ...Object.fromEntries(isolationTables.map(table => [table,
    f.peer.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) });
  f.reopenIsolation = () => { f.reopen(); f.isolation = createSqliteWorkflowIsolationStore(f.store); return f.isolation; };
  return f;
}

export function assertIsolationNoWrites(f, action) {
  const before = f.snapshotIsolation(), result = action(); assert.deepEqual(f.snapshotIsolation(), before); return result;
}

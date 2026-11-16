import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { workflowIsolationScopePlanDigest, workflowIsolationSafetyFingerprint, workflowIsolationStepSafetyFingerprint,
  workflowStepSafetyPlanDigest, normalizeWorkflowIsolationScopePlan, toRuntimeAttemptFence } from "../../dist/index.js";
import { workflowIsolationFixture, baseCommit, baseTree, repositoryBasis } from "./workflow-isolation-fixture.mjs";
import { admissionParticipant } from "./workflow-step-admission-fixture.mjs";

/** Opt-in setup only; the shared serial fixture and its assertions remain unchanged. */
export function configureParallelIsolation(f, { count = 3, limit = 2, resources = index => [`declared:step:${index}`] } = {}) {
  f.channel = f.store.updateChannel(f.channel.id, { runtimePolicy: { ...f.channel.runtimePolicy,
    maxConcurrentRuns: 4, allowReadOnlyParallel: false, writeLockScope: "boundPath" } }, f.at(0));
  const workflow = f.store.getChannelWorkflow(f.plan.workflowId), steps = [f.current(f.scopeIsolation)];
  for (let index = 1; index < count; index++) steps.push(f.store.createChannelWorkflowStep({ workflowId: workflow.id,
    title: `Parallel ${index}`, prompt: `Write ${index}.txt`, toParticipantId: admissionParticipant,
    toParticipantLabel: "Engineer", metadata: { policy: steps[0].metadata.policy } }, f.at(0)));
  const graph = { schemaVersion: 1, id: "parallel-graph", name: "Parallel isolated siblings", entryNodeId: "write-0",
    nodes: steps.map((step, index) => ({ id: `write-${index}`, kind: "step", name: step.title, prompt: step.prompt,
      sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: true, maxParallelSiblings: limit,
        resourceKeys: resources(index) } })), edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "fail_workflow", onApprovalDenied: "block_for_user" } };
  f.graphFingerprint = workflowGraphFingerprintV1(graph);
  f.store.updateChannelWorkflow(workflow.id, { metadata: { ...workflow.metadata, workflowGraph: graph,
    workflowGraphFingerprint: f.graphFingerprint, maxParallelSteps: 4 } }, f.at(0));
  const roots = steps.map((_, index) => index ? join(f.root, `isolated-step-${index + 1}`) : f.executionRoot);
  const current = steps.map((step, index) => {
    const safety = { sideEffectClass: "workspace_write", parallelPolicy: { autoParallel: true,
      maxParallelSiblings: limit, resourceKeys: resources(index) } };
    const input = { schemaVersion: 1, profile: "pi_host_isolated_files_v1", workflowId: workflow.id, workflowStepId: step.id,
      workspaceRoot: f.cwd, executionRoot: roots[index], safety, tools: ["read", "write"], runnerId: "pi",
      networkAccess: false, writeRoots: [roots[index]] };
    return f.store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, ...safety,
      policy: { ...step.metadata.policy, onRunFailed: "fail_workflow" }, maxParallelSiblings: limit,
      requiredTools: ["read", "write"], requestedRunnerId: "pi", safetyPlan: { ...input, digest: workflowStepSafetyPlanDigest(input) } } }, f.at(0));
  });
  const safetyPins = current.map(step => ({ workflowStepId: step.id, fingerprint: workflowIsolationStepSafetyFingerprint(step) }));
  f.inputs = { ...f.inputs, graphFingerprint: f.graphFingerprint, safetyPins, safetyFingerprint: workflowIsolationSafetyFingerprint(safetyPins),
    participants: current.map(step => ({ workflowStepId: step.id, position: step.position, required: true })),
    mergeOrder: current.map(step => step.id), parallelExecution: { profile: "isolated_siblings_v1", maxConcurrentSteps: limit, writeLockScope: "boundPath" } };
  f.plans = current.map((step, index) => {
    const resourcePlan = { entries: [
      { resourceType: "provider", resourceKey: "p1c-provider", limit: 4 },
      { resourceType: "runner", resourceKey: "pi", limit: 4 },
      ...[f.channel.id, `workflow:${workflow.id}`, `workspace:${f.cwd}`].map(resourceKey =>
        ({ resourceType: "channel_parallel", resourceKey, limit })),
    ], resourceKeys: [...resources(index), `worktree:${roots[index]}`] };
    const input = { ...f.plan, planId: index ? `parallel-plan-${index}` : f.plan.planId, workflowStepId: step.id,
      executionRoot: roots[index], worktreeId: index ? basename(roots[index]) : f.plan.worktreeId,
      branchRef: index ? `refs/heads/ling/parallel-${index}` : f.plan.branchRef, graphFingerprint: f.graphFingerprint,
      safetyFingerprint: safetyPins[index].fingerprint, resourcePlan };
    return normalizeWorkflowIsolationScopePlan({ ...input, planDigest: workflowIsolationScopePlanDigest(input) });
  });
  assert.ok(f.plans.every(Boolean));
  f.plan = f.plans[0]; f.scopeIsolation.plan = f.plan.resourcePlan; f.stepFingerprint = safetyPins[0].fingerprint;
  f.members = current.map((step, index) => ({ workflow, step, plan: f.plans[index].resourcePlan, scopePlan: f.plans[index] }));
  const createFirst = f.create, pinFirst = f.persistPin;
  f.create = () => { createFirst(); for (const plan of f.plans.slice(1)) {
    const result = f.isolation.createScopePlan({ plan, now: f.at(0) }); assert.equal(result.status, "created", JSON.stringify(result));
  } };
  f.persistPin = () => { pinFirst(); for (const plan of f.plans.slice(1)) f.store.updateChannelWorkflowStep(plan.workflowStepId,
    { metadata: { ...f.store.getChannelWorkflowStep(plan.workflowStepId).metadata,
      isolationScopePlan: { planId: plan.planId, planDigest: plan.planDigest } } }, f.at(0)); };
  return f;
}

export async function workflowParallelParentFixture(t, { create = true, ...options } = {}) {
  const f = configureParallelIsolation(await workflowIsolationFixture(t, { create: false, pin: false }), options);
  f.parent = () => f.store.database.prepare("SELECT * FROM workflow_parallel_parent_fences WHERE round_id=?").get(f.roundId);
  f.reconcile = (now = f.at(30), store = f.isolation) => store.reconcileParallelParentFence({ roundId: f.roundId, generation: 1, now });
  f.noWrites = action => {
    const snapshot = () => ({ ...f.snapshotIsolation(), parents: f.peer.database.prepare("SELECT * FROM workflow_parallel_parent_fences ORDER BY rowid").all() });
    const before = snapshot(), result = action(); assert.deepEqual(snapshot(), before); return result;
  };
  f.prepareOriginal = (index = 0, { taskLease = true } = {}) => {
    const member = f.members[index], plan = member.scopePlan, generation = f.begin(member), task = f.store.getTask(generation.task.id);
    const runId = `parallel-run-${index}`, unit = f.store.createWorkUnit({ id: `parallel-unit-${index}`,
      workspaceId: f.channel.workspaceId, kind: "task_run", ownerType: "task", ownerId: task.id, taskId: task.id,
      channelId: f.channel.id, teammateId: admissionParticipant, runnerId: "pi", effectiveRunnerId: "pi",
      idempotencyKey: `run:${runId}`, createdByActor: "system", request: { task, teammateId: admissionParticipant,
        workflowStepId: member.step.id, workflowStartOwner: generation.owner,
        workflowIsolationPlan: { planId: plan.planId, planDigest: plan.planDigest }, cwd: plan.executionRoot,
        workspaceCwd: f.cwd, executionCwd: plan.executionRoot }, now: f.at(3) });
    const attempt = f.store.createWorkUnitAttempt({ id: `parallel-attempt-${index}`, workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: `parallel-host-${index}`, runnerId: "pi", now: f.at(3) });
    const prepared = { member, plan, generation, task, runId, unit: f.store.getWorkUnit(unit.id), attempt, fence: toRuntimeAttemptFence(attempt) };
    prepared.leaseInput = { workspaceId: f.channel.workspaceId, resourceType: "bound_path", resourceKey: plan.executionRoot,
      ownerType: "run", ownerId: runId, ...prepared.fence, acquiredAt: f.at(4), expiresAt: f.at(300) };
    if (taskLease) assert.ok(f.store.acquireResourceLease({ ...prepared.leaseInput, resourceType: "task", resourceKey: task.id }));
    return prepared;
  };
  f.persistOriginal = prepared => {
    const { plan, generation, task, runId, fence } = prepared;
    assert.equal(f.store.transitionTaskStatus({ taskId: task.id, expectedStatus: "todo", event: "claim", actor: "system", now: f.at(5) }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "queued", event: "claim", actor: "system", now: f.at(5) }).ok, true);
    f.store.createRun({ id: runId, cwd: plan.executionRoot, taskId: task.id, channelId: f.channel.id, teammateId: admissionParticipant,
      workflowStepId: plan.workflowStepId, providerName: "fixture", providerModel: "fixture", taskSnapshot: task,
      providerSnapshot: {}, requestSnapshot: { cwd: plan.executionRoot, workflowStartOwner: generation.owner,
        workflowIsolationPlan: { planId: plan.planId, planDigest: plan.planDigest } }, createdAt: f.at(5) });
    f.store.linkRunToWorkUnit(runId, prepared.unit.id, f.at(5));
    prepared.run = f.store.getRun(runId); prepared.unit = f.store.getWorkUnit(prepared.unit.id);
    return prepared;
  };
  f.readyOriginal = prepared => {
    const { plan, generation, runId, fence, member } = prepared, bindingId = `parallel-binding-${member.step.position}`;
    const writer = { bindingId, ...fence };
    const bound = f.isolation.bindExecution({ bindingId, planId: plan.planId, planDigest: plan.planDigest,
      startOwner: generation.owner, runId, fence, now: f.at(6) });
    assert.equal(bound.status, "created", JSON.stringify(bound));
    assert.equal(f.transfer(member, generation, prepared, { now: f.at(7) }).status, "transferred");
    assert.equal(f.ready(member, generation, prepared, { now: f.at(8) }).status, "linked");
    const before = { executionRoot: plan.executionRoot, worktreeId: plan.worktreeId, branchRef: plan.branchRef,
      commonDir: plan.repositoryIdentity.commonDir, exists: false, headCommit: null };
    const after = { ...before, exists: true, headCommit: baseCommit, tree: baseTree, cleanStateDigest: repositoryBasis };
    const intent = f.isolation.recordIntent({ intentId: `create-${bindingId}`, commandId: `create-${bindingId}`,
      scope: { type: "binding", bindingId }, expectedRevision: 0, writer, kind: "worktree_create", before, after, now: f.at(9) });
    assert.equal(intent.status, "created", JSON.stringify(intent));
    const artifact = f.store.createArtifact({ runId, type: "json", path: `sqlite:${bindingId}`,
      sealedPayload: { kind: "host_git_observation", observed: after }, createdAt: f.at(10) });
    const receipt = f.isolation.recordReceipt({ receiptId: `receipt-${bindingId}`, intentId: intent.value.intentId,
      expectedRevision: 1, writer, outcome: "confirmed", observed: after, artifactId: artifact.id, now: f.at(10) });
    assert.equal(receipt.status, "created", JSON.stringify(receipt));
    assert.equal(f.isolation.markExecutionReady({ commandId: `ready-${bindingId}`, writer, expectedRevision: 2,
      creationReceiptId: receipt.value.receiptId, now: f.at(11) }).status, "updated");
    prepared.writer = writer;
    return prepared;
  };
  f.startOriginal = prepared => {
    const { fence, runId, task } = prepared;
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", startedAt: f.at(20), now: f.at(20) }));
    assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "queued", event: "runner_started", actor: "runner", startedAt: f.at(20), now: f.at(20) }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "claimed", event: "runner_started", actor: "runner", startedAt: f.at(20), now: f.at(20) }).ok, true);
    assert.equal(f.store.transitionTaskStatus({ taskId: task.id, expectedStatus: "claimed", event: "start_run", actor: "system", currentRunId: runId, now: f.at(20) }).ok, true);
  };
  f.trackOriginal = (prepared, coverage = () => true) => {
    let finish;
    const lifetime = new Promise(resolve => { finish = resolve; });
    prepared.source = { runId: prepared.runId, ...prepared.fence };
    const completion = f.store.trackHostAttemptCompletion(prepared.source, lifetime, coverage);
    prepared.drain = async () => { finish(); return completion; };
    return prepared;
  };
  f.stopOriginal = (prepared, outcome, now = f.at(25)) => {
    const { fence, runId, task, plan } = prepared, cancelled = outcome === "cancelled";
    assert.equal(f.store.transitionRunStatus({ runId, expectedStatus: "running", event: cancelled ? "cancel" : `runner_${outcome}`,
      actor: "runner", endedAt: now, now }).ok, true);
    if (cancelled) assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: "running", event: "cancel", actor: "system", now }).ok, true);
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, expectedStatus: cancelled ? "cancelling" : "running",
      event: `runner_${outcome}`, actor: "runner", endedAt: now, now }).ok, true);
    assert.ok(f.store.updateWorkUnitAttemptStatus({ ...fence, status: outcome, endedAt: now,
      ...(cancelled ? { abortRequestedAt: now } : {}), now }));
    f.store.appendTerminalRuntimeAudit({ capability: { ...fence, attemptStatus: outcome, transitionedAt: now },
      type: `work_unit_${outcome}`, actor: "runner", data: { runId } });
    assert.equal(f.store.transitionTaskStatus({ taskId: task.id, expectedStatus: "running", event: `run_${outcome}`, actor: "system", now }).ok, true);
    assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: plan.workflowStepId, expectedStatus: "running",
      event: cancelled ? "cancel" : outcome === "failed" ? "fail" : "succeed", actor: "system", now }).ok, true);
  };
  f.stopWorkflow = (outcome, now = f.at(25)) => {
    for (const member of f.members) {
      const step = f.current(member);
      if (step.status === "queued") assert.equal(f.store.transitionChannelWorkflowStepStatus({ workflowStepId: step.id,
        expectedStatus: "queued", event: outcome === "cancelled" ? "cancel" : "skip", actor: "system", now }).ok, true);
    }
    assert.equal(f.store.transitionChannelWorkflowStatus({ workflowId: f.plan.workflowId, expectedStatus: "running",
      event: outcome === "cancelled" ? "cancel" : "step_failed", actor: "system", now }).ok, true);
    assert.equal(f.store.getChannelWorkflow(f.plan.workflowId).status, outcome);
  };
  f.releaseOriginal = (prepared, now = f.at(30)) => f.store.releaseHostAttemptResources(prepared.source, now);
  if (create) { f.create(); f.persistPin(); }
  return f;
}

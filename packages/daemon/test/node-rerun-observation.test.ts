import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyConversationModeToEffectiveRunPolicySnapshot,
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  digestHarnessToolValue,
  resolveSessionRunPolicy,
  toRuntimeAttemptFence,
  type EffectiveRunPolicySnapshot,
  type RunStore,
  type WorkflowGraph,
} from "@ling-stack/core";
import {
  createWorkflowParticipantAuthorityV1,
  createNodeRerunHostAdmissionPlanV1,
  parseNodeRerunIntent,
  workflowGraphFingerprintV1,
} from "@ling-stack/contracts";
import {
  nodeRerunGraphVersionDigestV1,
  nodeRerunNodeVersionDigestV1,
  nodeRerunPermissionFingerprintV1,
  nodeRerunSourceSnapshotDigestV1,
  observeNodeRerunAdmission,
} from "../dist/features/runs/node-rerun-observation.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { handlePostNodeRerunAdmission } from "../dist/features/runs/node-rerun-admission.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";

const NOW = "2026-11-13T00:00:00.000Z";
const STARTED_AT = "2026-11-13T00:00:01.000Z";
const ENDED_AT = "2026-11-13T00:00:02.000Z";

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type TestDatabase = {
  prepare(sql: string): {
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
};

function testDatabase(store: RunStore): TestDatabase {
  return (store as unknown as { readonly database: TestDatabase }).database;
}

async function createFixture(t: TestContext, options: { readonly targetFileEffect?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-node-rerun-observation-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  });

  const channel = store.createChannel({ name: "Node rerun observation", boundPath: cwd }, NOW);
  const policy = applyConversationModeToEffectiveRunPolicySnapshot(resolveSessionRunPolicy({
    workspacePolicy: store.getApprovalPolicy(),
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
    channelBoundPath: cwd,
  }).snapshot, "default");
  const graph: WorkflowGraph = {
    schemaVersion: 1,
    id: "graph-node-rerun",
    name: "Node rerun graph",
    entryNodeId: "upstream",
    nodes: [
      { id: "upstream", kind: "step", name: "Upstream", prompt: "Prepare input", teammateId: "teammate_builtin_engineer" },
      { id: "target", kind: "step", name: "Target", prompt: "Run target", teammateId: "teammate_builtin_engineer" },
    ],
    edges: [{ id: "upstream-target", fromNodeId: "upstream", toNodeId: "target", condition: { kind: "all_succeeded" } }],
    termination: {
      success: "all_required_succeeded",
      onFailedRequiredNode: "block_for_user",
      onApprovalDenied: "block_for_user",
    },
  };
  const workflow = store.createChannelWorkflow({
    channelId: channel.id,
    title: "Node rerun workflow",
    objective: "Observe a completed target node",
    status: "succeeded",
    createdBy: "system",
    metadata: {
      workflowGraphId: graph.id,
      workflowGraphSchemaVersion: graph.schemaVersion,
      workflowGraph: graph,
      workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
    },
  }, NOW);
  const upstreamStep = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    position: 0,
    title: "Upstream",
    prompt: "Prepare input",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "succeeded",
    metadata: { graphId: graph.id, graphNodeId: "upstream", dependsOnStepIds: [] },
  }, NOW);
  const targetStep = store.createChannelWorkflowStep({
    workflowId: workflow.id,
    position: 1,
    title: "Target",
    prompt: "Run target",
    toParticipantId: "teammate_builtin_engineer",
    toParticipantLabel: "Engineer",
    status: "succeeded",
    metadata: { graphId: graph.id, graphNodeId: "target", dependsOnStepIds: [upstreamStep.id] },
  }, NOW);

  const upstream = await createTerminalRun(store, {
    id: "run-upstream",
    taskId: "task-upstream",
    stepId: upstreamStep.id,
    channelId: channel.id,
    teammateId: "teammate_builtin_engineer",
    cwd,
    policy,
    title: "Upstream",
    prompt: "Prepare input",
  });
  const target = await createTerminalRun(store, {
    id: "run-target",
    taskId: "task-target",
    stepId: targetStep.id,
    channelId: channel.id,
    teammateId: "teammate_builtin_engineer",
    cwd,
    policy,
    title: "Target",
    prompt: "Run target",
    fileEffect: options.targetFileEffect,
  });

  const upstreamInput = store.createArtifact({
    id: "artifact-upstream-input",
    runId: upstream.run.id,
    type: "json",
    path: "fixture/upstream-input.json",
    sealedPayload: { input: "upstream" },
    createdAt: NOW,
  });
  const upstreamOutput = store.createArtifact({
    id: "artifact-upstream-output",
    runId: upstream.run.id,
    type: "json",
    path: "fixture/upstream-output.json",
    sealedPayload: { output: "upstream" },
    createdAt: NOW,
  });
  const targetInput = store.createArtifact({
    id: "artifact-target-input",
    runId: target.run.id,
    type: "json",
    path: "fixture/target-input.json",
    sealedPayload: { input: "target" },
    createdAt: NOW,
  });
  assert.ok(upstreamInput.contentSha256 && upstreamOutput.contentSha256 && targetInput.contentSha256);

  store.updateChannelWorkflowStep(upstreamStep.id, {
    taskId: upstream.task.id,
    runId: upstream.run.id,
    metadata: {
      ...upstreamStep.metadata,
      contextArtifactId: upstreamInput.id,
      outputArtifactIds: [upstreamOutput.id],
    },
  }, ENDED_AT);
  store.updateChannelWorkflowStep(targetStep.id, {
    taskId: target.task.id,
    runId: target.run.id,
    metadata: { ...targetStep.metadata, contextArtifactId: targetInput.id },
  }, ENDED_AT);

  return {
    cwd,
    store,
    activeRuns: new ActiveRunRegistry(),
    graph,
    workflow,
    upstream,
    target,
    upstreamInput,
    upstreamOutput,
    targetInput,
    upstreamStep: store.getChannelWorkflowStep(upstreamStep.id)!,
    targetStep: store.getChannelWorkflowStep(targetStep.id)!,
    policy,
  };
}

async function createTerminalRun(store: RunStore, input: {
  readonly id: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly channelId: string;
    readonly teammateId: string;
  readonly cwd: string;
  readonly policy: EffectiveRunPolicySnapshot;
  readonly title: string;
  readonly prompt: string;
  readonly fileEffect?: boolean;
}) {
  const task = store.createTask({ channelId: input.channelId, title: input.title, prompt: input.prompt }, NOW);
  const requestSnapshot = {
    cwd: input.cwd,
    workspaceCwd: input.cwd,
    executionCwd: input.cwd,
    task: { id: task.id, title: task.title, prompt: task.prompt, channelId: input.channelId },
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
    permissionMode: input.policy.mode,
    effectivePolicySnapshot: input.policy,
  };
  const unit = store.createWorkUnit({
    id: `${input.id}-unit`,
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "task",
    ownerId: task.id,
    taskId: task.id,
    channelId: input.channelId,
    teammateId: input.teammateId,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    status: "running",
    idempotencyKey: `${input.id}-unit-key`,
    createdByActor: "system",
    request: requestSnapshot,
    now: STARTED_AT,
  });
  const attempt = store.createWorkUnitAttempt({
    id: `${input.id}-attempt`,
    workUnitId: unit.id,
    attemptNumber: 1,
    runtimeInstanceId: `${input.id}-runtime`,
    runnerId: "pi",
    effectiveRunnerId: "pi",
    status: "started",
    now: STARTED_AT,
  });
  const run = store.createRun({
    id: input.id,
    cwd: input.cwd,
    taskId: task.id,
    channelId: input.channelId,
    teammateId: input.teammateId,
    workflowStepId: input.stepId,
    workUnitId: unit.id,
    providerName: "fixture-provider",
    providerModel: "fixture-model",
    taskSnapshot: { id: task.id, title: task.title, prompt: task.prompt, channelId: input.channelId },
    providerSnapshot: { provider: "fixture-provider", model: "fixture-model" },
    requestSnapshot,
    createdAt: NOW,
  });
  assert.ok(store.linkRunToWorkUnit(run.id, unit.id, STARTED_AT));
  store.markRunStarted(run.id, STARTED_AT);
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  if (input.fileEffect) recordCompletedFileEffect(store, run.id, unit.id, source, input.policy);
  await store.trackHostAttemptCompletion(source, Promise.resolve(), () => true);
  assert.equal(store.transitionRunStatus({ runId: run.id, expectedStatus: "running", event: "runner_succeeded",
    actor: "runner", now: ENDED_AT, endedAt: ENDED_AT }).ok, true);
  assert.equal(store.transitionWorkUnitStatus({ ...toRuntimeAttemptFence(attempt), expectedStatus: "running",
    event: "runner_succeeded", actor: "runner", now: ENDED_AT, endedAt: ENDED_AT }).ok, true);
  assert.ok(store.updateWorkUnitAttemptStatus({ ...toRuntimeAttemptFence(attempt), status: "succeeded", endedAt: ENDED_AT, now: ENDED_AT }));
  store.appendTerminalRuntimeAudit({ capability: { ...toRuntimeAttemptFence(attempt), attemptStatus: "succeeded", transitionedAt: ENDED_AT },
    type: "work_unit_succeeded", actor: "runner", data: { runId: run.id } });
  return { task, unit: store.getWorkUnit(unit.id)!, attempt: store.getWorkUnitAttempt(attempt.id)!, run: store.getRun(run.id)! };
}

function recordCompletedFileEffect(
  store: RunStore,
  runId: string,
  workUnitId: string,
  source: { readonly runId: string; readonly workUnitId: string; readonly attemptId: string; readonly runtimeInstanceId: string; readonly fencingToken: string },
  policy: EffectiveRunPolicySnapshot,
): void {
  const toolCallId = `${runId}-file-effect`;
  const requestDigest = "a".repeat(64);
  const sideEffectFingerprint = "b".repeat(64);
  const ticket = store.admitHostOperation({ operationId: `${runId}-file-operation`, source, kind: "file_mutation", toolCallId, admittedAt: STARTED_AT });
  const policyArtifact = store.createArtifact({ runId, type: "json", path: `harness/${toolCallId}/policy.json`, createdAt: STARTED_AT,
    sealedPayload: { schemaVersion: 1, runId, attemptId: source.attemptId, toolCallId, executorKind: "write",
      requestDigest, sideEffectFingerprint, effectivePolicySnapshot: policy } });
  const prepared = store.prepareHarnessToolExecution({ runId, workUnitId, sourceFence: source,
    toolCallId, toolName: "write", executorKind: "write", requestDigest, sideEffectFingerprint,
    policySnapshotArtifactId: policyArtifact.id, approvalState: "allowed", sandboxProfileId: "workspace_write", now: STARTED_AT }).execution;
  store.bindHostOperationEvidence(ticket, { kind: "harness_tool_execution", id: prepared.id });
  const claimAt = new Date().toISOString();
  const claim = store.claimHarnessToolExecution({ executionId: prepared.id, expectedRevision: prepared.revision, sourceFence: source,
    claimOwner: "observation-fixture", claimToken: toolCallId, claimExpiresAt: new Date(Date.now() + 60_000).toISOString(), now: claimAt });
  assert.equal(claim.ok, true);
  assert.ok(claim.ok);
  const startedAt = new Date().toISOString();
  const started = store.startHarnessToolExecution({ executionId: prepared.id, expectedRevision: claim.value.revision, sourceFence: source,
    claimOwner: "observation-fixture", claimToken: toolCallId, now: startedAt });
  assert.equal(started.ok, true);
  assert.ok(started.ok);
  store.launchHostOperation(ticket, () => true);
  const finishedAt = new Date().toISOString();
  const resultSummary = { status: "applied", outcome: "applied", touchedPaths: ["fixture.txt"], artifactCount: 1, cancelled: false };
  const resultArtifact = store.createArtifact({ runId, type: "json", path: `harness/${toolCallId}/result.json`, createdAt: finishedAt,
    sealedPayload: { status: "applied", outcome: "applied", format: "ling-apply-patch-v1", touchedPaths: ["fixture.txt"], rawPatchSha256: "c".repeat(64) } });
  const finished = store.finishHarnessToolExecution({ executionId: prepared.id, expectedRevision: started.value.revision, sourceFence: source,
    claimOwner: "observation-fixture", claimToken: toolCallId, nextState: "succeeded",
    resultDigest: digestHarnessToolValue(resultSummary), resultSummary, evidenceArtifactIds: [resultArtifact.id], now: finishedAt });
  assert.equal(finished.ok, true);
  store.settleHostOperation(ticket, { kind: "file_completed", settledAt: new Date().toISOString() });
}

function makeIntent(f: Fixture) {
  const targetRun = f.store.getRun(f.target.run.id)!;
  const targetUnit = f.store.getWorkUnit(f.target.unit.id)!;
  const targetAttempt = f.store.getWorkUnitAttempt(f.target.attempt.id)!;
  const targetStep = f.store.getChannelWorkflowStep(f.targetStep.id)!;
  const graphVersionDigest = nodeRerunGraphVersionDigestV1(f.graph);
  const sourceNode = f.graph.nodes.find(node => node.id === "target")!;
  const upstreamNode = f.graph.nodes.find(node => node.id === "upstream")!;
  const inputArtifact = { artifactId: f.targetInput.id, contentSha256: f.targetInput.contentSha256! };
  const upstreamPin = {
    nodeId: "upstream",
    nodeVersionDigest: nodeRerunNodeVersionDigestV1(graphVersionDigest, upstreamNode),
    inputArtifact: { artifactId: f.upstreamInput.id, contentSha256: f.upstreamInput.contentSha256! },
    outputArtifacts: [{ artifactId: f.upstreamOutput.id, contentSha256: f.upstreamOutput.contentSha256! }],
    permissionFingerprint: nodeRerunPermissionFingerprintV1(f.policy),
  };
  const dependencyClosure = { complete: true, upstream: [upstreamPin], downstreamNodeIds: [] } as const;
  const sourceStep = targetStep;
  const sourceSnapshot = nodeRerunSourceSnapshotDigestV1({
    run: {
      id: targetRun.id,
      status: targetRun.status,
      endedAt: targetRun.endedAt ?? null,
      taskId: targetRun.taskId,
      channelId: targetRun.channelId ?? null,
      teammateId: targetRun.teammateId ?? null,
      workflowStepId: targetRun.workflowStepId ?? null,
      workUnitId: targetRun.workUnitId ?? null,
    },
    workUnit: {
      id: targetUnit.id,
      status: targetUnit.status,
      endedAt: targetUnit.endedAt ?? null,
      linkedRunId: targetUnit.linkedRunId ?? null,
      activeAttemptId: targetUnit.activeAttemptId ?? null,
    },
    attempt: {
      id: targetAttempt.id,
      workUnitId: targetAttempt.workUnitId,
      attemptNumber: targetAttempt.attemptNumber,
      runtimeInstanceId: targetAttempt.runtimeInstanceId,
      fencingToken: targetAttempt.fencingToken,
      status: targetAttempt.status,
      createdAt: targetAttempt.createdAt,
      startedAt: targetAttempt.startedAt ?? null,
      endedAt: targetAttempt.endedAt ?? null,
    },
    workflow: {
      id: f.workflow.id,
      updatedAt: f.workflow.updatedAt,
      graphVersionDigest,
      nodeId: sourceNode.id,
    },
    workflowStep: {
      id: sourceStep.id,
      channelId: sourceStep.channelId,
      workflowId: sourceStep.workflowId,
      taskId: sourceStep.taskId ?? null,
      runId: sourceStep.runId ?? null,
      toParticipantId: sourceStep.toParticipantId,
      status: sourceStep.status,
      updatedAt: sourceStep.updatedAt,
      graphId: sourceStep.metadata?.graphId ?? null,
      graphNodeId: sourceStep.metadata?.graphNodeId ?? null,
      contextArtifactId: sourceStep.metadata?.contextArtifactId ?? null,
      outputArtifactId: sourceStep.metadata?.outputArtifactId ?? null,
      outputArtifactIds: [...(sourceStep.metadata?.outputArtifactIds ?? [])],
    },
    inputArtifact,
    dependencyClosure,
    sourcePolicyFingerprint: nodeRerunPermissionFingerprintV1(f.policy),
  });
  return {
    schemaVersion: 1,
    kind: "node_rerun_intent",
    intentId: "intent-node-rerun",
    source: {
      runId: targetRun.id,
      attemptId: targetAttempt.id,
      nodeId: sourceNode.id,
      graphVersionDigest,
      inputArtifact,
      dependencyClosure,
      sourceSnapshotDigest: sourceSnapshot,
    },
    target: { executionIdentity: "host_minted", fence: "host_minted", approval: "fresh_current_policy", graphMutation: "none" },
    requestedBy: "local-user",
    idempotencyKey: "node-rerun-idempotency",
    createdAt: NOW,
  };
}

function tableCounts(store: RunStore) {
  const tables = ["run_sessions", "work_units", "work_unit_attempts", "channel_workflows", "channel_workflow_steps", "artifacts", "runtime_events", "host_attempt_completions"];
  return Object.fromEntries(tables.map(table => [table, Number((testDatabase(store).prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]));
}

test("observes a complete SQLite source and never authorizes execution or writes", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  const before = tableCounts(f.store);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(result.evaluationInvoked, true);
  assert.equal(result.admission.decision, "eligible_for_host_admission");
  assert.equal(result.admission.executionAuthorized, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.observed?.source.graphVersionDigest, intent.source.graphVersionDigest);
  assert.deepEqual(tableCounts(f.store), before);
});

test("F5-03 emits a deterministic Host admission plan and keeps target creation closed", async t => {
  const f = await createFixture(t);
  const rawIntent = makeIntent(f);
  const intent = parseNodeRerunIntent(rawIntent);
  const before = tableCounts(f.store);
  const observed = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(observed.admission.decision, "eligible_for_host_admission");
  assert.ok(observed.observed);

  const first = createNodeRerunHostAdmissionPlanV1({ intent, observed: observed.observed, admission: observed.admission });
  const second = createNodeRerunHostAdmissionPlanV1({ intent, observed: observed.observed, admission: observed.admission });
  assert.deepEqual(second, first);
  assert.equal(first.source.sourceSnapshotDigest, intent.source.sourceSnapshotDigest);
  assert.equal(first.currentPolicyFingerprint, observed.observed.currentPolicyFingerprint);
  assert.deepEqual(first.actions, {
    workUnit: "host_minted",
    run: "host_minted",
    attempt: "host_minted",
    fence: "host_minted",
    approval: "fresh_current_policy",
    graphMutation: "none",
    providerDispatch: "disabled",
  });
  assert.equal(first.preconditions.revalidateBeforeWrite, true);
  assert.deepEqual(tableCounts(f.store), before);

  const changedKey = parseNodeRerunIntent({ ...rawIntent, idempotencyKey: "node-rerun-idempotency-2" });
  const changedPlan = createNodeRerunHostAdmissionPlanV1({ intent: changedKey, observed: observed.observed, admission: observed.admission });
  assert.notEqual(changedPlan.planId, first.planId);
});

test("F5-03 does not produce a plan after the source snapshot drifts", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  assert.ok(f.store.updateChannelWorkflowStep(f.targetStep.id, {
    status: "failed",
  }, ENDED_AT));
  const afterMutation = tableCounts(f.store);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(result.admission.decision, "blocked");
  assert.equal(result.evaluationInvoked, false);
  assert.equal(result.blockers[0]?.code, "source_snapshot_mismatch");
  assert.equal(result.admission.executionAuthorized, false);
  assert.deepEqual(tableCounts(f.store), afterMutation);
});

test("F5-03 HTTP admission returns the same plan on an idempotent retry", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  const before = tableCounts(f.store);
  const registry = new RunStoreRegistry(() => f.store, { recoverOnOpen: false });
  registry.getStore(f.cwd);
  const server = createServer((request, response) => {
    const requestedRunId = decodeURIComponent(new URL(request.url ?? "/", "http://fixture").pathname.split("/")[2] ?? "");
    void handlePostNodeRerunAdmission(
      request,
      response,
      new URL(request.url ?? "/", "http://fixture"),
      1_048_576,
      registry,
      f.activeRuns,
      requestedRunId,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = new URL(`http://127.0.0.1:${address.port}/runs/${encodeURIComponent(f.target.run.id)}/node-rerun/admission`);
  url.searchParams.set("cwd", f.cwd);
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent) };
  const firstResponse = await fetch(url, request);
  const first = await firstResponse.json() as { readonly plan: unknown; readonly admission: { readonly executionAuthorized: boolean } };
  const secondResponse = await fetch(url, request);
  const second = await secondResponse.json() as { readonly plan: unknown; readonly admission: { readonly executionAuthorized: boolean } };
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(first.admission.executionAuthorized, false);
  assert.deepEqual(second.plan, first.plan);
  assert.deepEqual(tableCounts(f.store), before);

  const missingIntent = { ...intent, source: { ...intent.source, runId: "run-missing" } };
  const missingUrl = new URL(`http://127.0.0.1:${address.port}/runs/run-missing/node-rerun/admission`);
  missingUrl.searchParams.set("cwd", f.cwd);
  const missingResponse = await fetch(missingUrl, { ...request, body: JSON.stringify(missingIntent) });
  const missingBody = await missingResponse.json();
  assert.equal(missingResponse.status, 404, JSON.stringify(missingBody));
  assert.deepEqual(missingBody, {
    error: "node_rerun_source_not_found",
    message: "The source Run was not found in the initialized workspace Store.",
  });
});

test("fails closed before evaluation when the source Run or Attempt is missing", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  const missingRunIntent = { ...intent, source: { ...intent.source, runId: "run-missing" } };
  const missingRun = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: missingRunIntent, now: ENDED_AT });
  assert.equal(missingRun.evaluationInvoked, false);
  assert.equal(missingRun.blockers[0]?.code, "run_missing");

  const f2 = await createFixture(t);
  const intent2 = makeIntent(f2);
  const missingAttemptIntent = { ...intent2, source: { ...intent2.source, attemptId: "attempt-missing" } };
  const missingAttempt = observeNodeRerunAdmission({ store: f2.store, activeRuns: f2.activeRuns, intent: missingAttemptIntent, now: ENDED_AT });
  assert.equal(missingAttempt.evaluationInvoked, false);
  assert.equal(missingAttempt.blockers[0]?.code, "attempt_missing");
});

test("rejects graph digest and materialized dependency drift", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  const changedGraph: WorkflowGraph = {
    ...f.graph,
    nodes: f.graph.nodes.map(node => node.id === "target" ? { ...node, prompt: "Changed target" } : node),
  };
  assert.ok(f.store.updateChannelWorkflow(f.workflow.id, {
    metadata: { ...f.workflow.metadata, workflowGraph: changedGraph, workflowGraphFingerprint: workflowGraphFingerprintV1(changedGraph) },
  }, ENDED_AT));
  const graphChanged = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(graphChanged.evaluationInvoked, false);
  assert.equal(graphChanged.blockers[0]?.code, "graph_fingerprint_mismatch");

  const f2 = await createFixture(t);
  const intent2 = makeIntent(f2);
  assert.ok(f2.store.updateChannelWorkflowStep(f2.upstreamStep.id, {
    metadata: { ...f2.upstreamStep.metadata, dependsOnStepIds: [f2.targetStep.id] },
  }, ENDED_AT));
  const dependencyChanged = observeNodeRerunAdmission({ store: f2.store, activeRuns: f2.activeRuns, intent: intent2, now: ENDED_AT });
  assert.equal(dependencyChanged.evaluationInvoked, false);
  assert.equal(dependencyChanged.blockers[0]?.code, "dependency_closure_incomplete");
});

test("rejects missing or digestless source and dependency artifacts", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  testDatabase(f.store).prepare("DELETE FROM artifacts WHERE id = ?").run(f.targetInput.id);
  const sourceArtifactMissing = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(sourceArtifactMissing.evaluationInvoked, false);
  assert.equal(sourceArtifactMissing.blockers[0]?.code, "source_input_artifact_missing");

  const f2 = await createFixture(t);
  const intent2 = makeIntent(f2);
  testDatabase(f2.store).prepare("UPDATE artifacts SET content_sha256 = NULL WHERE id = ?").run(f2.upstreamOutput.id);
  const dependencyArtifactDigestMissing = observeNodeRerunAdmission({ store: f2.store, activeRuns: f2.activeRuns, intent: intent2, now: ENDED_AT });
  assert.equal(dependencyArtifactDigestMissing.evaluationInvoked, false);
  assert.equal(dependencyArtifactDigestMissing.blockers[0]?.code, "dependency_output_artifact_missing");
});

test("reports current policy drift through the pure evaluator", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  f.store.updateApprovalPolicy({ allowedWritePaths: [] }, ENDED_AT);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(result.evaluationInvoked, true);
  assert.equal(result.admission.decision, "blocked");
  assert.ok(result.admission.blockers.includes("policy_drift"));
  assert.ok(result.admission.blockers.includes("permission_not_current"));
  assert.equal(result.admission.executionAuthorized, false);
});

test("fails closed when the source Attempt is no longer the WorkUnit current Attempt", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  testDatabase(f.store).prepare("UPDATE work_units SET active_attempt_id = NULL WHERE id = ?").run(f.target.unit.id);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(result.evaluationInvoked, false);
  assert.equal(result.blockers[0]?.code, "lineage_mismatch");
});

test("fails closed when the source WorkflowStep is still running or has drifted lineage", async t => {
  const running = await createFixture(t);
  const runningIntent = makeIntent(running);
  testDatabase(running.store).prepare("UPDATE channel_workflow_steps SET status = 'running' WHERE id = ?").run(running.targetStep.id);
  const runningResult = observeNodeRerunAdmission({ store: running.store, activeRuns: running.activeRuns, intent: runningIntent, now: ENDED_AT });
  assert.equal(runningResult.evaluationInvoked, false);
  assert.equal(runningResult.blockers[0]?.code, "lineage_mismatch");

  const taskDrift = await createFixture(t);
  const taskDriftIntent = makeIntent(taskDrift);
  testDatabase(taskDrift.store).prepare("UPDATE channel_workflow_steps SET task_id = ? WHERE id = ?")
    .run(taskDrift.upstream.task.id, taskDrift.targetStep.id);
  const taskDriftResult = observeNodeRerunAdmission({ store: taskDrift.store, activeRuns: taskDrift.activeRuns, intent: taskDriftIntent, now: ENDED_AT });
  assert.equal(taskDriftResult.evaluationInvoked, false);
  assert.equal(taskDriftResult.blockers[0]?.code, "lineage_mismatch");

  const participantDrift = await createFixture(t);
  const participantIntent = makeIntent(participantDrift);
  testDatabase(participantDrift.store).prepare("UPDATE channel_workflow_steps SET to_participant_id = ? WHERE id = ?")
    .run("teammate-different", participantDrift.targetStep.id);
  const participantAuthority = participantDrift.targetStep.participantAuthority;
  testDatabase(participantDrift.store).prepare("UPDATE channel_workflow_steps SET participant_authority_json = ? WHERE id = ?")
    .run(JSON.stringify(createWorkflowParticipantAuthorityV1({ kind: participantAuthority.kind, origin: participantAuthority.origin,
      participantId: "teammate-different", sourceId: participantAuthority.sourceId })), participantDrift.targetStep.id);
  const participantResult = observeNodeRerunAdmission({ store: participantDrift.store, activeRuns: participantDrift.activeRuns,
    intent: participantIntent, now: ENDED_AT });
  assert.equal(participantResult.evaluationInvoked, false);
  assert.equal(participantResult.blockers[0]?.code, "lineage_mismatch");
});

test("fails closed for future terminal timestamps and inconsistent terminal state", async t => {
  const future = await createFixture(t);
  testDatabase(future.store).prepare("UPDATE run_sessions SET ended_at = ? WHERE id = ?")
    .run("2026-11-13T00:00:03.000Z", future.target.run.id);
  const futureResult = observeNodeRerunAdmission({ store: future.store, activeRuns: future.activeRuns, intent: makeIntent(future), now: ENDED_AT });
  assert.equal(futureResult.evaluationInvoked, true);
  assert.equal(futureResult.observed?.runLifecycle, "unknown");
  assert.ok(futureResult.admission.blockers.includes("source_run_not_terminal"));

  const inconsistent = await createFixture(t);
  testDatabase(inconsistent.store).prepare("UPDATE run_sessions SET status = 'failed' WHERE id = ?").run(inconsistent.target.run.id);
  const inconsistentResult = observeNodeRerunAdmission({ store: inconsistent.store, activeRuns: inconsistent.activeRuns,
    intent: makeIntent(inconsistent), now: ENDED_AT });
  assert.equal(inconsistentResult.evaluationInvoked, true);
  assert.equal(inconsistentResult.observed?.runLifecycle, "unknown");
  assert.ok(inconsistentResult.admission.blockers.includes("source_run_not_terminal"));
});

test("sees every matching lease and semaphore row instead of trusting a capped page", async t => {
  const f = await createFixture(t);
  const database = testDatabase(f.store);
  const targetAttempt = f.target.attempt;
  for (let index = 0; index < 501; index += 1) {
    const active = index === 0;
    const acquiredAt = active ? "2026-11-12T00:00:00.000Z" : ENDED_AT;
    database.prepare(`INSERT INTO resource_leases (
      id, workspace_id, resource_type, resource_key, owner_type, owner_id, status, acquired_at, expires_at,
      last_renewed_at, released_at, release_reason, work_unit_id, attempt_id, runtime_instance_id, fencing_token
    ) VALUES (?, ?, 'bound_path', ?, 'run', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`observation-lease-${index}`, DEFAULT_WORKSPACE_ID, `observation-path-${index}`, f.target.run.id,
        active ? "active" : "released", acquiredAt, "2026-11-14T00:00:00.000Z", acquiredAt,
        active ? null : ENDED_AT, active ? null : "fixture-released", f.target.unit.id, targetAttempt.id,
        targetAttempt.runtimeInstanceId, targetAttempt.fencingToken);
    database.prepare(`INSERT INTO runtime_semaphore_slots (
      id, workspace_id, resource_type, resource_key, owner_type, owner_id, work_unit_id, attempt_id,
      runtime_instance_id, fencing_token, status, acquired_at, last_renewed_at, expires_at, released_at, release_reason
    ) VALUES (?, ?, 'workflow_resource', ?, 'work_unit_attempt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`observation-slot-${index}`, DEFAULT_WORKSPACE_ID, `observation-slot-key-${index}`, targetAttempt.id, f.target.unit.id,
        targetAttempt.id, targetAttempt.runtimeInstanceId, targetAttempt.fencingToken, active ? "active" : "released", acquiredAt,
        acquiredAt, "2026-11-14T00:00:00.000Z", active ? null : ENDED_AT, active ? null : "fixture-released");
  }
  assert.equal(f.store.listResourceLeases({ workUnitId: f.target.unit.id, complete: true }).length, 501);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ workUnitId: f.target.unit.id, complete: true }).length, 501);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: makeIntent(f), now: ENDED_AT });
  assert.equal(result.admission.decision, "blocked");
  assert.ok(result.admission.blockers.includes("source_lease_active"));
  assert.ok(result.admission.blockers.includes("source_fence_active"));
});

test("fails closed when a persisted semaphore status is unknown", async t => {
  const f = await createFixture(t);
  testDatabase(f.store).prepare(`INSERT INTO runtime_semaphore_slots (
    id, workspace_id, resource_type, resource_key, owner_type, owner_id, work_unit_id, attempt_id,
    runtime_instance_id, fencing_token, status, acquired_at, last_renewed_at, expires_at, released_at, release_reason
  ) VALUES (?, ?, 'workflow_resource', ?, 'work_unit_attempt', ?, ?, ?, ?, ?, 'corrupt', ?, ?, ?, NULL, NULL)`).run(
    "observation-corrupt-slot", DEFAULT_WORKSPACE_ID, "observation-corrupt-slot-key", f.target.attempt.id,
    f.target.unit.id, f.target.attempt.id, f.target.attempt.runtimeInstanceId, f.target.attempt.fencingToken,
    ENDED_AT, ENDED_AT, "2026-11-14T00:00:00.000Z",
  );
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: makeIntent(f), now: ENDED_AT });
  assert.equal(result.observed?.fenceStatus, "unknown");
  assert.equal(result.admission.decision, "blocked");
  assert.ok(result.admission.blockers.includes("source_fence_active"));
});

test("sees a terminal runtime audit beyond the ordinary event page", async t => {
  const f = await createFixture(t);
  const database = testDatabase(f.store);
  database.prepare("DELETE FROM runtime_events WHERE work_unit_id = ? AND attempt_id = ? AND type = 'work_unit_succeeded'")
    .run(f.target.unit.id, f.target.attempt.id);
  for (let index = 0; index < 1001; index += 1) {
    database.prepare(`INSERT INTO runtime_events (
      id, work_unit_id, attempt_id, runtime_instance_id, fencing_token, seq, ts, type, actor, data_json
    ) SELECT ?, ?, ?, ?, ?, COALESCE(MAX(seq) + 1, 1), ?, 'work_unit_progress', 'runner', '{}'
      FROM runtime_events WHERE work_unit_id = ?`).run(
      `runtime-event-page-${index}`, f.target.unit.id, f.target.attempt.id,
      f.target.attempt.runtimeInstanceId, f.target.attempt.fencingToken, ENDED_AT, f.target.unit.id,
    );
  }
  f.store.appendTerminalRuntimeAudit({ capability: { ...toRuntimeAttemptFence(f.target.attempt), attemptStatus: "succeeded", transitionedAt: ENDED_AT },
    type: "work_unit_succeeded", actor: "runner", data: { runId: f.target.run.id } });

  assert.equal(f.store.listRuntimeEvents(f.target.unit.id, { limit: 1000 }).some(event => event.type === "work_unit_succeeded"), false);
  assert.equal(f.store.listRuntimeEvents(f.target.unit.id, { complete: true }).some(event => event.type === "work_unit_succeeded"), true);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: makeIntent(f), now: ENDED_AT });
  assert.equal(result.admission.decision, "eligible_for_host_admission");
  assert.equal(result.observed?.fenceStatus, "released");
});

test("safe external file completion remains non-replayable", async t => {
  const f = await createFixture(t, { targetFileEffect: true });
  const now = new Date().toISOString();
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: makeIntent(f), now });
  assert.equal(result.evaluationInvoked, true);
  assert.equal(result.observed?.externalEffectStatus, "non_idempotent");
  assert.ok(result.admission.blockers.includes("external_effect_not_replayable"));
});

test("fails closed when an upstream WorkUnit lineage drifts", async t => {
  const f = await createFixture(t);
  const intent = makeIntent(f);
  testDatabase(f.store).prepare("UPDATE work_units SET linked_run_id = ? WHERE id = ?")
    .run(f.target.run.id, f.upstream.unit.id);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent, now: ENDED_AT });
  assert.equal(result.evaluationInvoked, false);
  assert.equal(result.blockers[0]?.code, "dependency_step_missing");
  assert.equal(result.blockers[0]?.contractCode, "dependency_evidence_missing");
});

test("invalid persisted policy selectors block current policy resolution", async t => {
  const f = await createFixture(t);
  const request = f.store.getRun(f.target.run.id)!.requestSnapshot as Record<string, unknown>;
  testDatabase(f.store).prepare("UPDATE run_sessions SET request_snapshot_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...request, permissionMode: "invalid-selector" }), f.target.run.id);
  const result = observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: makeIntent(f), now: ENDED_AT });
  assert.equal(result.evaluationInvoked, false);
  assert.equal(result.blockers[0]?.code, "current_policy_unavailable");
  assert.equal(result.blockers[0]?.contractCode, "policy_unavailable");
});

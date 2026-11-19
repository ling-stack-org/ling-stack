import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { PiRunnerAdapter, type PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { capturePreparedRunnerInput } from "../../dist/features/runs/prepared-runner-input.js";
import { ActiveRunRegistry } from "../../dist/runtime/active-runs.js";
import { applyConversationModeToEffectiveRunPolicySnapshot, SqliteRunStore, DEFAULT_WORKSPACE_ID,
  digestHarnessToolValue, resolveSessionRunPolicy, toRuntimeAttemptFence, type EffectiveRunPolicySnapshot,
  type PrepareNodeRerunIntentInput, type RunStore, type WorkflowGraph } from "@ling-stack/core";
import { createNodeRerunHostAdmissionPlanV1, parseNodeRerunIntent, workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import { nodeRerunGraphVersionDigestV1, nodeRerunNodeVersionDigestV1, nodeRerunPermissionFingerprintV1,
  nodeRerunSourceSnapshotDigestV1, observeNodeRerunAdmission } from "../../dist/features/runs/node-rerun-observation.js";
import type { RuntimeHostCapacityStoreBinding } from "@ling-stack/core/runtime-host-capacity-store-bridge";

export const NOW = "2026-11-13T00:00:00.000Z";
export const STARTED_AT = "2026-11-13T00:00:01.000Z";
export const ENDED_AT = "2026-11-13T00:00:02.000Z";

export type Fixture = Awaited<ReturnType<typeof createFixture>>;
export type TestDatabase = {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
};

export function testDatabase(store: RunStore): TestDatabase {
  return (store as unknown as { readonly database: TestDatabase }).database;
}

export async function createFixture(t: TestContext, options: { readonly targetFileEffect?: boolean; readonly preparedExecution?: boolean;
  readonly runtimeHostCapacityBinding?: RuntimeHostCapacityStoreBinding; readonly provider?: PiRunnerRunOptions["provider"] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-node-rerun-observation-"));
  const store = new SqliteRunStore({ cwd, runtimeHostCapacityBinding: options.runtimeHostCapacityBinding });
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
    provider: options.provider,
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
    preparedExecution: options.preparedExecution,
    provider: options.provider,
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

export async function createTerminalRun(store: RunStore, input: {
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
  readonly preparedExecution?: boolean;
  readonly provider?: PiRunnerRunOptions["provider"];
}) {
  const task = store.createTask({ channelId: input.channelId, title: input.title, prompt: input.prompt }, NOW);
  const thread = store.createLingThread({ kind: "task", channelId: input.channelId, taskId: task.id,
    teammateId: input.teammateId, title: input.title, objective: input.prompt }, NOW);
  const turn = store.createLingTurn({ threadId: thread.id, channelId: input.channelId, taskId: task.id,
    teammateId: input.teammateId, kind: "initial_request", title: input.title, userInstruction: input.prompt,
    createdByActor: "local-user" }, NOW);
  const provider = input.provider ?? {
    provider: "fixture-provider",
    model: "fixture-model",
    baseUrl: "https://fixture.invalid/v1",
    api: "openai-completions",
    reasoning: false,
  };
  const sdkOptions: PiRunnerRunOptions = { cwd: input.cwd,
    task: { id: task.id, title: task.title, prompt: task.prompt, channelId: input.channelId },
    provider,
    agentDir: join(input.cwd, "fixture-agent"), tools: ["read"],
    initialToolSurface: { mediaGeneration: false, toolHydration: false, userInput: false, delegation: false },
    appendSystemPrompt: ["Frozen upstream input", "Frozen memory and skill"],
  };
  const runnerExecutionInput = input.preparedExecution ? capturePreparedRunnerInput({ runnerId: "pi", options: sdkOptions,
    preparedInput: await new PiRunnerAdapter().prepareTaskInput(sdkOptions) }) : undefined;
  const requestSnapshot = {
    cwd: input.cwd,
    workspaceCwd: input.cwd,
    executionCwd: input.cwd,
    task: { id: task.id, title: task.title, prompt: task.prompt, channelId: input.channelId },
    threadId: thread.id,
    turnId: turn.id,
    authorizationMode: "smart",
    workspaceAccessMode: "workspace_write",
    permissionMode: input.policy.mode,
    effectivePolicySnapshot: input.policy,
    provider,
    ...(runnerExecutionInput ? { runnerExecutionInput } : {}),
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
    providerName: provider.provider,
    providerModel: provider.model,
    taskSnapshot: { id: task.id, title: task.title, prompt: task.prompt, channelId: input.channelId },
    providerSnapshot: provider,
    requestSnapshot,
    threadId: thread.id,
    turnId: turn.id,
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

export function makeIntent(f: Fixture, options: { readonly downstreamNodeIds?: readonly string[] } = {}) {
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
  const dependencyClosure = { complete: true, upstream: [upstreamPin], downstreamNodeIds: options.downstreamNodeIds ?? [] } as const;
  const sourceStep = targetStep;
  const sourceSnapshot = nodeRerunSourceSnapshotDigestV1({
    executionSnapshot: { taskSnapshot: targetRun.taskSnapshot, providerSnapshot: targetRun.providerSnapshot, requestSnapshot: targetRun.requestSnapshot },
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

export function tableCounts(store: RunStore) {
  const tables = ["run_sessions", "work_units", "work_unit_attempts", "channel_workflows", "channel_workflow_steps", "artifacts", "runtime_events", "host_attempt_completions", "approval_requests", "node_rerun_intents", "node_rerun_approval_requests", "node_rerun_targets", "approval_checkpoints", "approval_postcommit_effects"];
  return Object.fromEntries(tables.map(table => [table, Number((testDatabase(store).prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]));
}

export function prepareInput(f: Fixture, options: { readonly downstreamNodeIds?: readonly string[] } = {}): PrepareNodeRerunIntentInput {
  const intent = parseNodeRerunIntent(parseNodeRerunIntent(makeIntent(f, options)));
  const revalidate: PrepareNodeRerunIntentInput["revalidate"] = frozenIntent =>
    observeNodeRerunAdmission({ store: f.store, activeRuns: f.activeRuns, intent: frozenIntent, now: ENDED_AT });
  const observation = revalidate(intent);
  assert.ok(observation.observed);
  const plan = createNodeRerunHostAdmissionPlanV1({ intent, ...observation, observed: observation.observed });
  return { request: { intent, planFingerprint: plan.planFingerprint }, now: ENDED_AT, revalidate };
}

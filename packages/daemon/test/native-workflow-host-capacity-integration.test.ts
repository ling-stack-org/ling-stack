import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createCompositeSecretResolver, type ChannelWorkflowStepMetadata, type RunTool } from "@ling-stack/core";
import { createRuntimeHostCapacityStoreBinding } from "@ling-stack/core/runtime-host-capacity-store-bridge";
import { workflowAdmissionFixture, admissionParticipant } from "../../core/test/support/workflow-step-admission-fixture.mjs";
import { hostCapacityFixture } from "../../core/test/support/runtime-host-capacity-fixture.ts";
import { parseRunRequest } from "../dist/features/runs/schemas.js";
import { createWorkflowSafetyAdmission, createWorkflowSafetyPlan } from "../dist/features/runs/workflow-safety.js";
import { createNativeRunDispatcher, type NativeRunTargetDispatcher, type NativeBoundRunRequest } from "../dist/features/runs/native-run-dispatcher.js";
import { loadWorkspaceRuntimeSettings, patchWorkspaceRuntimeSettings } from "../dist/runtime/runner-settings.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { createRuntimeHostCapacityAdmission } from "../dist/runtime/run-queue.js";
import { resolveConfig } from "../dist/config.js";

type WorkflowFixture = Awaited<ReturnType<typeof workflowAdmissionFixture>>;

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

function recordingSink() {
  const errors: Array<{ readonly statusCode: number; readonly body: unknown }> = [];
  return {
    errors,
    sink: {
      kind: "detached" as const,
      onClose() {},
      isClosed() { return false; },
      writeReady() {},
      writeEvent() {},
      writeError(statusCode: number, body: unknown) { errors.push({ statusCode, body }); },
      end() {},
    },
  };
}

async function fixture(t: TestContext, target: NativeRunTargetDispatcher, maximum = 1) {
  const binding = createRuntimeHostCapacityStoreBinding();
  const workflow = await workflowAdmissionFixture(t, { runtimeHostCapacityBinding: binding.binding }) as WorkflowFixture;
  const host = hostCapacityFixture(t, { maximum });
  const admission = createRuntimeHostCapacityAdmission({ host: host.host, workspace: binding.workspace });
  const runners = createRunnerRegistry([
    { id: "pi", displayName: "Pi", status: "enabled", adapter: { async runTask() { throw new Error("native test must not call Pi"); } } },
    { id: "openclaw-acp", displayName: "OpenClaw", status: "enabled", adapter: { async runTask() { throw new Error("native test must not call Pi"); } } },
  ]);
  const settings = loadWorkspaceRuntimeSettings(workflow.store, runners);
  patchWorkspaceRuntimeSettings(workflow.store, runners, {
    schemaVersion: 2,
    confirmNativeMigration: true,
    expectedUpdatedAt: settings.updatedAt,
    defaultRunnerId: "pi",
    allowedRunnerIds: ["pi", "openclaw-acp"],
  });
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: workflow.cwd,
    concurrency: { enabled: true } }), undefined, undefined, store => {
      assert.equal(store, workflow.store, "the dispatcher must use the workflow fixture Store");
      return admission;
    });
  const activeRuns = new ActiveRunRegistry();
  const stores = new RunStoreRegistry(() => workflow.store, { trustedWorkspaceRoots: [workflow.cwd], recoverOnOpen: false });
  const dispatcher = createNativeRunDispatcher({ runnerRegistry: runners, storeRegistry: stores, activeRuns,
    runtimeSupervisor: supervisor, secretResolver: createCompositeSecretResolver({ env: {} }), target });
  t.after(async () => {
    await activeRuns.waitForIdle();
    supervisor.releaseAll();
  });
  return { workflow, host, admission, dispatcher, stores, activeRuns, supervisor, binding };
}

function prepareNativeWorkflow(workflow: WorkflowFixture, suffix: string, options: {
  readonly engineId?: "openclaw-acp";
  readonly sideEffectClass?: "analysis_readonly" | "workspace_write";
  readonly requiredTools?: readonly RunTool[];
  readonly maxParallelSiblings?: number;
  readonly autoParallel?: boolean;
  readonly safety?: boolean;
  readonly createdByActor?: "automation";
} = {}) {
  const engineId = options.engineId ?? "openclaw-acp";
  const scope = workflow.scope(`native-${suffix}`);
  if (options.safety === false) {
    const generation = workflow.begin(scope, { ...workflow.input(scope), admission: undefined });
    const executionBinding = { kind: "native_profile" as const, engineId, profileId: "fixture", profileRevision: 1 };
    const parsed = parseRunRequest({
      cwd: workflow.cwd,
      workspaceCwd: workflow.cwd,
      task: generation.task,
      teammateId: admissionParticipant,
      workflowStepId: scope.step.id,
      workflowStartOwner: generation.owner,
      executionBinding,
    });
    return { scope, generation, request: { ...parsed, workflowStartOwner: generation.owner,
      ...(options.createdByActor ? { createdByActor: options.createdByActor } : {}) } as NativeBoundRunRequest };
  }
  const baseMetadata: ChannelWorkflowStepMetadata = {
    ...scope.step.metadata,
    sideEffectClass: options.sideEffectClass ?? "workspace_write",
    requestedRunnerId: engineId,
    requiredTools: [...(options.requiredTools ?? ["read", "write"])],
    parallelPolicy: { autoParallel: options.autoParallel ?? false,
      maxParallelSiblings: options.maxParallelSiblings ?? 1, resourceKeys: [] },
  };
  const preparedStep = workflow.store.updateChannelWorkflowStep(scope.step.id, { metadata: baseMetadata }, workflow.at(1));
  assert.ok(preparedStep);
  const safetyPlan = createWorkflowSafetyPlan({ store: workflow.store, step: preparedStep,
    workspaceCwd: workflow.cwd, executionCwd: workflow.cwd, runnerId: engineId });
  assert.ok(safetyPlan);
  const pinnedStep = workflow.store.updateChannelWorkflowStep(scope.step.id,
    { metadata: { ...baseMetadata, safetyPlan } }, workflow.at(2));
  assert.ok(pinnedStep);
  const executionBinding = { kind: "native_profile" as const, engineId, profileId: "fixture", profileRevision: 1 };
  const workflowSafetySnapshot = { schemaVersion: 1 as const, plan: safetyPlan };
  const admissionPlan = createWorkflowSafetyAdmission(workflow.store, pinnedStep, {
    executionBinding, runnerId: engineId, workflowSafetySnapshot,
  });
  assert.ok(admissionPlan);
  scope.plan = { entries: [...admissionPlan.entries], resourceKeys: [...admissionPlan.resourceKeys] };
  const generation = workflow.begin(scope);
  const parsed = parseRunRequest({
    cwd: workflow.cwd,
    workspaceCwd: workflow.cwd,
    task: generation.task,
    teammateId: admissionParticipant,
    workflowStepId: scope.step.id,
    workflowStartOwner: generation.owner,
    executionBinding,
    workflowSafetySnapshot,
  });
  const request = { ...parsed, workflowStartOwner: generation.owner, workflowSafetySnapshot,
    ...(options.createdByActor ? { createdByActor: options.createdByActor } : {}) } as NativeBoundRunRequest;
  return { scope, generation, request };
}

test("Native workflow consumes workflow_start Host capacity and drains the real reservation", async t => {
  const observations: Array<{ readonly ownerKind?: string; readonly dispatchedAt?: string }> = [];
  const target: NativeRunTargetDispatcher = {
    hostCapacityAdmission: "dispatch_ack_v1",
    async assertAvailable() {},
    async dispatch(input) {
      const source = { runId: input.run.id, workUnitId: input.attempt.workUnitId, attemptId: input.attempt.id,
        runtimeInstanceId: input.attempt.runtimeInstanceId, fencingToken: input.attempt.fencingToken };
      const record = input.store.getHostAttemptCompletion(source);
      assert.equal(record?.nativeEffectStatus, "unverified", "native dispatch begins with an unverified completion record");
      const workflowAdmission = input.store.getChannelWorkflowStepStartAdmission(input.run.workflowStepId!, {
          ...input.runRequest.workflowStartOwner!,
        });
      assert.equal(workflowAdmission?.status, "transferred");
      observations.push({ ownerKind: workflowAdmission?.status });
      input.onDispatchAccepted?.(new Date().toISOString());
      return { status: "completed", events: [] };
    },
  };
  const f = await fixture(t, target);
  const prepared = prepareNativeWorkflow(f.workflow, "drain", { createdByActor: "automation" });
  const recording = recordingSink();
  const runId = await f.dispatcher.dispatch({ runRequest: prepared.request, sink: recording.sink, executionOptions: {} });
  assert.ok(runId, JSON.stringify({ errors: recording.errors, step: f.workflow.store.getChannelWorkflowStep(prepared.scope.step.id),
    task: f.workflow.store.getTask(prepared.generation.task.id), runs: f.workflow.store.listRuns() }));
  assert.equal(f.workflow.store.getRun(runId)?.status, "succeeded",
    JSON.stringify({ errors: recording.errors, run: f.workflow.store.getRun(runId), step: f.workflow.store.getChannelWorkflowStep(prepared.scope.step.id) }));
  const confirmedRunId = runId;
  const run = f.workflow.store.getRun(confirmedRunId);
  if (!run) throw new Error("Native workflow did not persist its Run.");
  if (!run.workUnitId) throw new Error("Native workflow Run has no WorkUnit.");
  const unit = f.workflow.store.getWorkUnit(run.workUnitId);
  if (!unit?.activeAttemptId) throw new Error("Native workflow did not persist its active Attempt.");
  const attempt = f.workflow.store.getWorkUnitAttempt(unit.activeAttemptId);
  if (!attempt) throw new Error("Native workflow Attempt disappeared after completion.");
  const source = { runId: confirmedRunId, workUnitId: attempt.workUnitId, attemptId: attempt.id,
    runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken };
  const journal = f.binding.workspace(f.workflow.channel.workspaceId);
  const intent = journal.getAttemptIntent(source);
  assert.equal(intent?.intent.ownerKind, "workflow_start");
  assert.ok(intent?.dispatchedAt);
  assert.equal(f.host.host.counts().held, 0);
  assert.equal(f.host.host.counts().released, 1);
  assert.equal(f.workflow.store.getWorkUnit(run.workUnitId)?.createdByActor, "scheduler");
  assert.deepEqual(observations, [{ ownerKind: "transferred" }]);
});

test("Native workflow Host capacity blocks the second target before native dispatch", async t => {
  const firstAccepted = deferred();
  const releaseFirst = deferred();
  const dispatched: string[] = [];
  const target: NativeRunTargetDispatcher = {
    hostCapacityAdmission: "dispatch_ack_v1",
    async assertAvailable() {},
    async dispatch(input) {
      dispatched.push(input.runRequest.task.id);
      if (dispatched.length === 1) {
        input.onDispatchAccepted?.(new Date().toISOString());
        firstAccepted.resolve();
        await releaseFirst.promise;
      }
      return { status: "completed", events: [] };
    },
  };
  const f = await fixture(t, target);
  const first = prepareNativeWorkflow(f.workflow, "first", { safety: false });
  const firstRecording = recordingSink();
  const firstPending = f.dispatcher.dispatch({ runRequest: first.request, sink: firstRecording.sink, executionOptions: {} });
  let firstAcceptedTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      firstAccepted.promise,
      new Promise<never>((_, reject) => {
        firstAcceptedTimer = setTimeout(() => reject(new Error(JSON.stringify({
          errors: firstRecording.errors, run: f.workflow.store.listRuns(), step: f.workflow.store.getChannelWorkflowStep(first.scope.step.id),
          result: "pending",
        }))), 2_000);
      }),
    ]);
  } finally {
    if (firstAcceptedTimer !== undefined) clearTimeout(firstAcceptedTimer);
  }
  const second = prepareNativeWorkflow(f.workflow, "second", { safety: false });
  const secondRecording = recordingSink();
  const secondRun = await f.dispatcher.dispatch({ runRequest: second.request, sink: secondRecording.sink, executionOptions: {} });
  assert.equal(secondRun, undefined, JSON.stringify(secondRecording.errors));
  assert.deepEqual(dispatched, [first.request.task.id]);
  assert.equal(f.workflow.store.getChannelWorkflowStep(second.scope.step.id)?.runId, undefined);
  releaseFirst.resolve();
  const firstRun = await firstPending;
  await f.activeRuns.waitForIdle(10_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(firstRun);
  assert.equal(f.workflow.store.getRun(firstRun)?.status, "succeeded");
  assert.deepEqual(f.host.host.counts(), { held: 0, released: 1, total: 1 });
});

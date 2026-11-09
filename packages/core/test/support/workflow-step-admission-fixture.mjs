import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SqliteRunStore, resolveStoragePaths, toRuntimeAttemptFence } from "../../dist/index.js";

export const admissionParticipant = "teammate_builtin_engineer";
const tables = ["channel_workflows", "channel_workflow_steps", "tasks", "run_sessions", "run_events", "work_units", "work_unit_attempts",
  "runtime_events", "runtime_heartbeats", "resource_leases", "runtime_semaphore_slots", "workflow_step_admissions",
  "workflow_step_admission_entries", "approval_requests", "approval_checkpoints", "approval_postcommit_effects", "state_transition_events",
  "runner_continuations", "host_attempt_completions", "host_operations", "harness_tool_executions", "native_submissions",
  "user_input_requests", "user_input_answers", "user_input_deliveries", "conversation_context_snapshots"];

export function admissionSnapshot(store) {
  return Object.fromEntries(tables.map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

/** Owned, explicitly isolated real SQLite connections. Never dispatches a Provider, Runner, or daemon recovery. */
export async function workflowAdmissionFixture(t, { runtimeHostCapacityBinding } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "ling-p1c-admission-")));
  const cwd = join(root, "workspace"), opened = new Set(), epoch = Date.now();
  await fs.mkdir(cwd);
  const paths = resolveStoragePaths(cwd, { homeDir: join(root, "home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  assert.ok(paths.databasePath.startsWith(`${root}/`));
  t.after(async () => {
    try { for (const store of opened) if (store.database.isOpen) store.close(); }
    finally {
      assert.ok(root.startsWith(`${await fs.realpath(os.tmpdir())}/ling-p1c-admission-`));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const at = tick => new Date(epoch + tick * 1_000).toISOString();
  let bindingOwner = true;
  function open() {
    const store = new SqliteRunStore({ cwd, paths,
      ...(runtimeHostCapacityBinding && bindingOwner ? { runtimeHostCapacityBinding } : {}) });
    bindingOwner = false;
    opened.add(store);
    assert.equal(typeof store.transferChannelWorkflowStepStartAdmission, "function", "P1-C tests require the current Core implementation");
    assert.equal(store.database.prepare("SELECT name FROM schema_migrations WHERE version=203").get()?.name,
      "workflow_step_preparing_admission", "P1-C admission schema must actually be installed");
    return store;
  }
  const f = { root, cwd, paths, at, store: open(), peer: open() };
  f.channel = f.store.createChannel({ name: "P1-C preparing ownership", boundPath: cwd,
    runtimePolicy: { maxConcurrentRuns: 4 }, allowedTools: ["read", "write", "bash"] }, at(0));
  f.plan = (overrides = {}) => ({ entries: [
    { resourceType: "provider", resourceKey: "p1c-provider", limit: 4 },
    { resourceType: "runner", resourceKey: "pi", limit: 4 },
    { resourceType: "channel_parallel", resourceKey: f.channel.id, limit: 4 },
  ], resourceKeys: ["repository:p1c-canonical"], ...overrides });
  f.scope = (name, { plan = f.plan(), metadata = {} } = {}) => {
    const workflow = f.store.createChannelWorkflow({ channelId: f.channel.id, title: `P1-C ${name}`,
      objective: "Reserve before preparing and transfer without releasing", status: "ready", createdBy: "local-user" }, at(0));
    const step = f.store.createChannelWorkflowStep({ workflowId: workflow.id, title: `Inspect ${name}`, prompt: `Read ${name}.txt`,
      toParticipantId: admissionParticipant, toParticipantLabel: "Engineer", metadata: { policy: {
        onRunFailed: "block_for_user", onRunCancelled: "block_for_user", onApprovalDenied: "block_for_user", retryable: true,
      }, ...metadata } }, at(0));
    return { workflow, step, plan };
  };
  f.current = scope => f.store.getChannelWorkflowStep(scope.step.id);
  f.expected = scope => {
    const step = f.current(scope);
    return { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt };
  };
  f.lease = (scope, now = at(1), store = f.store) => {
    const lease = store.acquireResourceLease({ workspaceId: f.channel.workspaceId, resourceType: "workflow_step",
      resourceKey: scope.step.id, ownerType: "workflow_step", ownerId: scope.step.id,
      acquiredAt: now, expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString() });
    assert.ok(lease);
    return lease;
  };
  f.input = (scope, lease = f.lease(scope), overrides = {}) => ({ workflowStepId: scope.step.id, expected: f.expected(scope),
    leaseId: lease.id, admission: scope.plan, task: { channelId: f.channel.id, title: scope.step.title,
      prompt: scope.step.prompt, assigneeTeammateId: admissionParticipant }, now: at(2), ...overrides });
  f.begin = (scope, input = f.input(scope), store = f.store) => {
    const result = store.beginChannelWorkflowStepStart(input);
    assert.equal(result.status, "begun", JSON.stringify(result));
    return { ...result, input };
  };
  f.prepare = (scope, generation, name = "original", { claim = true, runnerId = "pi", threadId, turnId } = {}) => {
    const task = f.store.getTask(generation.task.id);
    if (claim && task.status === "todo") assert.equal(f.store.transitionTaskStatus({ taskId: task.id,
      expectedStatus: "todo", event: "claim", actor: "system", now: at(3) }).ok, true);
    const run = f.store.createRun({ id: `p1c-run-${name}`, cwd, taskId: task.id, channelId: f.channel.id,
      teammateId: admissionParticipant, workflowStepId: scope.step.id, providerName: "fixture", providerModel: "fixture",
      taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { cwd, workflowStartOwner: generation.owner },
      threadId, turnId, contextViewId: `p1c-context-${name}`, contextViewCreatedAt: at(3), createdAt: at(3) });
    const unit = f.store.createWorkUnit({ id: `p1c-unit-${name}`, workspaceId: f.channel.workspaceId,
      kind: "task_run", ownerType: "task", ownerId: task.id, taskId: task.id, channelId: f.channel.id,
      teammateId: admissionParticipant, runnerId, effectiveRunnerId: runnerId, idempotencyKey: `p1c-unit-${name}`,
      createdByActor: "system", request: {}, now: at(3) });
    f.store.linkRunToWorkUnit(run.id, unit.id, at(3));
    const attempt = f.store.createWorkUnitAttempt({ id: `p1c-attempt-${name}`, workUnitId: unit.id,
      attemptNumber: 1, runtimeInstanceId: `p1c-runtime-${name}`, runnerId, effectiveRunnerId: runnerId, now: at(3) });
    return { run: f.store.getRun(run.id), unit: f.store.getWorkUnit(unit.id), attempt, fence: toRuntimeAttemptFence(attempt) };
  };
  f.outsider = name => {
    const unit = f.store.createWorkUnit({ id: `p1c-outside-unit-${name}`, workspaceId: f.channel.workspaceId,
      kind: "task_run", ownerType: "task", ownerId: `p1c-outside-task-${name}`, idempotencyKey: `p1c-outside-${name}`,
      createdByActor: "system", request: {}, now: at(3) });
    const attempt = f.store.createWorkUnitAttempt({ id: `p1c-outside-attempt-${name}`, workUnitId: unit.id,
      attemptNumber: 1, runtimeInstanceId: `p1c-outside-runtime-${name}`, runnerId: "pi", now: at(3) });
    return { unit, attempt, fence: toRuntimeAttemptFence(attempt) };
  };
  f.slotInput = (current, entry, overrides = {}) => ({ workspaceId: f.channel.workspaceId, ...entry, ...current.fence,
    ownerType: "work_unit_attempt", ownerId: current.attempt.id, acquiredAt: at(4), expiresAt: at(3_604), ...overrides });
  f.transferInput = (scope, generation, prepared, overrides = {}) => ({ workflowStepId: scope.step.id,
    owner: generation.owner, runId: prepared.run.id, admission: scope.plan, ...prepared.fence, now: at(5), expiresAt: at(3_605), ...overrides });
  f.transfer = (scope, generation, prepared, overrides = {}, store = f.store) =>
    store.transferChannelWorkflowStepStartAdmission(f.transferInput(scope, generation, prepared, overrides));
  f.ready = (scope, generation, prepared, overrides = {}) => f.store.commitChannelWorkflowStepRunReady({ workflowStepId: scope.step.id,
    owner: generation.owner, runId: prepared.run.id, now: at(6), ...overrides });
  f.release = (scope, generation, prepared, overrides = {}, store = f.store) => store.releaseChannelWorkflowStepStartAdmission({
    workflowStepId: scope.step.id, owner: generation.owner, dispatchState: "not_dispatched",
    ...(prepared ? { runId: prepared.run.id, fence: prepared.fence } : {}), now: at(7), reason: "P1-C proven preparation failure", ...overrides });
  f.settle = (scope, generation, overrides = {}) => f.store.settleChannelWorkflowStepStartFailure({
    workflowStepId: scope.step.id, owner: generation.owner, leaseId: generation.owner.leaseId,
    blocker: "P1-C preparation failed", now: at(8), ...overrides });
  f.admission = (scope, generation, store = f.peer) => store.getChannelWorkflowStepStartAdmission(scope.step.id, generation.owner);
  f.snapshot = () => admissionSnapshot(f.peer);
  f.count = table => Number(f.peer.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  f.reopen = (which = "store") => {
    if (f[which].database.isOpen) f[which].close();
    opened.delete(f[which]);
    return f[which] = open();
  };
  return f;
}

/** Exercises the actual yield, accepted answer, immutable seed/preparation and successor binding APIs. */
export async function workflowUserInputAdmissionFixture(t) {
  const f = await workflowAdmissionFixture(t);
  f.scopeInput = f.scope("user-input");
  f.scopeInput.plan.resourceKeys.push(`workflow:${f.scopeInput.workflow.id}`, "workspace:p1c-physical");
  f.generation = f.begin(f.scopeInput);
  f.thread = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id, teammateId: admissionParticipant,
    title: "Admission input", objective: "Resume with a complete admission" }, f.at(1));
  f.turn = f.store.appendConversationUserTurn({ threadId: f.thread.id, channelId: f.channel.id,
    teammateId: admissionParticipant, title: "Read", userInstruction: "Read safely", idempotencyKey: "p1c-input-turn",
    payload: { body: "Read safely", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, f.at(1));
  f.source = f.prepare(f.scopeInput, f.generation, "input-source", { threadId: f.thread.id, turnId: f.turn.turnId });
  assert.equal(f.transfer(f.scopeInput, f.generation, f.source).status, "transferred");
  assert.equal(f.ready(f.scopeInput, f.generation, f.source).status, "linked");
  f.sourceOwner = f.current(f.scopeInput).metadata.startOwner;
  assert.equal(f.store.transitionWorkUnitStatus({ ...f.source.fence, expectedStatus: "queued", event: "claim",
    actor: "system", now: f.at(7) }).ok, true);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...f.source.fence, status: "started", startedAt: f.at(7), now: f.at(7) }));
  assert.equal(f.store.transitionRunStatus({ runId: f.source.run.id, expectedStatus: "queued", event: "runner_started",
    actor: "runner", startedAt: f.at(7), now: f.at(7) }).ok, true);
  assert.equal(f.store.transitionWorkUnitStatus({ ...f.source.fence, expectedStatus: "claimed", event: "runner_started",
    actor: "runner", startedAt: f.at(7), now: f.at(7) }).ok, true);
  assert.equal(f.store.transitionTaskStatus({ taskId: f.generation.task.id, expectedStatus: "claimed", event: "start_run",
    actor: "system", currentRunId: f.source.run.id, now: f.at(7) }).ok, true);
  f.request = f.store.createUserInputRequest({ sourceRunId: f.source.run.id, sourceItemId: f.turn.item.id,
    sourceFence: f.source.fence, toolCallId: "p1c-question", idempotencyKey: "p1c-question", toolInput: { schemaVersion: 1,
      waitMode: "required", questions: [{ questionId: "continue", prompt: "Continue?", required: true, allowFreeText: true,
        options: [{ optionId: "yes", label: "Continue" }] }] } }, f.at(8)).request;
  f.answer = f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: { schemaVersion: 1,
    requestId: f.request.requestId, expectedVersion: 1, expectedStatusRevision: 1, idempotencyKey: "p1c-answer",
    answers: [{ questionId: "continue", kind: "option", optionId: "yes" }] } }, f.at(9));
  f.store.commitUserInputYield({ threadId: f.thread.id, requestId: f.request.requestId, expectedRequestVersion: 1,
    sourceFence: f.source.fence, quiescence: { kind: "runner_quiesced", runnerId: "pi", stoppedAt: f.at(10), lastRunEventSeq: 0 } }, f.at(11));
  f.delivery = f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: f.answer.deliveryId,
    expectedRevision: 1, ownerId: "p1c-input-host", leaseMs: 60_000 }, f.at(12));
  f.seed = f.store.getUserInputContinuationSeed(f.thread.id, f.delivery.deliveryId);
  const ref = value => ({ id: value.id, fingerprint: value.fingerprint });
  const initialClaim = { threadId: f.thread.id, deliveryId: f.delivery.deliveryId, expectedRevision: f.delivery.revision,
    ownerId: f.delivery.claim.ownerId, claimToken: f.delivery.claim.token };
  const task = { id: f.generation.task.id, channelId: f.channel.id, title: "Continue read", prompt: "Accepted answer: Continue" };
  const request = { cwd: f.cwd, threadId: f.thread.id, turnId: f.turn.turnId, task, teammateId: admissionParticipant,
    workflowStepId: f.scopeInput.step.id, parentRunId: f.source.run.id, continuationReason: "user_input_answer" };
  const preparedRequest = f.store.saveUserInputContinuationPreparation({ ...initialClaim, stage: "request",
    parentRef: ref(f.seed), payload: request }, f.at(12)).snapshot;
  const modelInput = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id, systemPrompt: "Fixture",
    userPrompt: "Accepted answer: Continue", model: { id: "fixture", provider: "fixture" }, tools: [], thinkingLevel: "off" };
  const preparedInput = { ...modelInput, fingerprint: createHash("sha256").update(JSON.stringify(modelInput)).digest("hex") };
  const executionInput = { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
    input: { cwd: f.cwd, task, provider: { provider: "fixture", model: "fixture" }, tools: [] }, preparedInput };
  const execution = f.store.saveUserInputContinuationPreparation({ ...initialClaim, stage: "execution",
    parentRef: ref(preparedRequest), payload: { schemaVersion: 1, runnerId: "pi", providerName: "fixture", providerModel: "fixture",
      taskSnapshot: task, providerSnapshot: { provider: "fixture", model: "fixture" }, requestSnapshot: request,
      runRequestSnapshot: { ...request, runnerExecutionInput: executionInput }, preparedInput,
      preparedInputFingerprint: preparedInput.fingerprint, runnerExecutionInput: executionInput } }, f.at(12)).snapshot;
  f.binding = f.store.admitUserInputContinuation({ ...initialClaim, executionRef: ref(execution),
    runtimeInstanceId: "p1c-input-target-runtime", workflowStartOwner: f.sourceOwner }, f.at(13));
  f.claimInput = { ...initialClaim, expectedRevision: f.binding.deliveryRevision };
  f.recoveryInput = (overrides = {}) => ({ claim: f.claimInput, bindingRef: ref(f.binding), sourceFence: f.binding.fence,
    runId: f.binding.runId, workflowAdmission: f.scopeInput.plan,
    leases: [{ workspaceId: f.channel.workspaceId, resourceType: "runner", resourceKey: "p1c-input-target-runner",
      ownerType: "run", ownerId: f.binding.runId, ...f.binding.fence, acquiredAt: f.at(14), expiresAt: f.at(200) }],
    semaphores: f.scopeInput.plan.entries.map(entry => ({ ...entry, ...f.binding.fence, workspaceId: f.channel.workspaceId,
      ownerType: "work_unit_attempt", ownerId: f.binding.fence.attemptId, acquiredAt: f.at(14), expiresAt: f.at(200) })),
    now: f.at(14), expiresAt: f.at(200), ...overrides });
  f.recover = (overrides = {}, store = f.store) => store.recoverUserInputContinuationPrestart(f.recoveryInput(overrides));
  return f;
}

export async function workflowResumeAdmissionFixture(t, { retainSourceSlots = false } = {}) {
  const f = await workflowAdmissionFixture(t);
  f.scopeResume = f.scope("same-run");
  f.scopeResume.plan.resourceKeys.push(`workflow:${f.scopeResume.workflow.id}`, "workspace:p1c-physical");
  f.generation = f.begin(f.scopeResume);
  f.source = f.prepare(f.scopeResume, f.generation, "resume-source");
  assert.equal(f.transfer(f.scopeResume, f.generation, f.source).status, "transferred");
  assert.equal(f.ready(f.scopeResume, f.generation, f.source).status, "linked");
  if (!retainSourceSlots) assert.equal(f.store.releaseRuntimeSemaphoreSlotsForAttempt(f.source.fence, f.at(7), "pre-dispatch confirmed stop"), 6);
  assert.ok(f.store.updateWorkUnitAttemptStatus({ ...f.source.fence, status: "failed", endedAt: f.at(7), now: f.at(7) }));
  const artifact = f.store.createArtifact({ runId: f.source.run.id, type: "json", path: "harness/p1c-context.json",
    sealedPayload: { contextViewId: f.source.run.contextViewId }, createdAt: f.at(8) });
  f.target = f.store.prepareContinuationAndAttempt({ runId: f.source.run.id, workUnitId: f.source.unit.id,
    sourceFence: f.source.fence, expectedTargetAttemptId: f.source.attempt.id, origin: "daemon_recovery",
    strategy: "deterministic_replay", runnerId: "pi", runnerCapabilityRevision: "pi:p1c",
    contextViewId: f.source.run.contextViewId, contextSnapshotArtifactId: artifact.id, idempotencyKey: "p1c-resume",
    generation: 0, targetAttempt: { runtimeInstanceId: "p1c-resume-target-runtime", runnerId: "pi", effectiveRunnerId: "pi" }, now: f.at(8) });
  const targetFence = toRuntimeAttemptFence(f.target.attempt);
  assert.equal(f.store.claimRunnerContinuation({ continuationId: f.target.continuation.id, expectedRevision: 0,
    claimOwner: "p1c-resume-host", claimToken: "p1c-resume-token", claimExpiresAt: f.at(68), targetFence, now: f.at(9) }).ok, true);
  f.resumeInput = (overrides = {}) => ({ workflowStepId: f.scopeResume.step.id, owner: f.generation.owner,
    runId: f.source.run.id, ...targetFence, admission: f.scopeResume.plan, continuationId: f.target.continuation.id,
    sourceFence: f.source.fence, expectedContinuationRevision: 1, claimOwner: "p1c-resume-host", claimToken: "p1c-resume-token",
    now: f.at(10), expiresAt: f.at(200), ...overrides });
  f.resume = (overrides = {}, store = f.store) => store.resumeChannelWorkflowStepStartAdmission(f.resumeInput(overrides));
  return f;
}

/** Barrier after both Stores open, then genuinely competing SQLite writers in independent threads. */
export async function admissionRace(t, f, operations) {
  const source = `const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      if (workerData.sourceLoaderUrl) await import(workerData.sourceLoaderUrl);
      const { createSqliteRunStore } = await import(workerData.moduleUrl);
      const store = createSqliteRunStore(workerData.cwd, workerData.paths);
      parentPort.once("message", () => {
        try { parentPort.postMessage({ type: "result", result: store[workerData.method](workerData.input) }); }
        catch (error) { parentPort.postMessage({ type: "error", message: String(error) }); }
        finally { store.close(); }
      });
      parentPort.postMessage({ type: "ready" });
    })().catch(error => parentPort.postMessage({ type: "error", message: String(error) }));`;
  const moduleUrl = import.meta.resolve("../../dist/index.js");
  const workers = operations.map(operation => new Worker(source, { eval: true, workerData: { ...operation,
    cwd: f.cwd, paths: f.paths, moduleUrl,
    ...(moduleUrl.endsWith(".ts") ? { sourceLoaderUrl: new URL("./workflow-step-admission-source-loader.mjs", import.meta.url).href } : {}) } }));
  try {
    await Promise.all(workers.map(async worker => {
      const [message] = await once(worker, "message", { signal: t.signal });
      assert.equal(message.type, "ready", JSON.stringify(message));
    }));
    const results = workers.map(worker => once(worker, "message", { signal: t.signal }));
    workers.forEach(worker => worker.postMessage("go"));
    return (await Promise.all(results)).map(([message]) => {
      assert.equal(message.type, "result", JSON.stringify(message));
      return message.result;
    });
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

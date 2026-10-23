import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { resolveRuntimePaths } from "../../core/dist/index.js";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { PiRunnerAdapter } from "../../runner-pi/dist/index.js";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import * as host from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { resolveConfig } from "../dist/config.js";
import { createDaemonServer } from "../dist/index.js";
import { UserInputDeliveryWorker } from "../dist/features/runs/user-input-delivery-worker.js";
import { channelOperationPlanFingerprintV1 } from "../../contracts/dist/index.js";
import { createDelegatedStepRequirement } from "../dist/features/channels/workflow-step-requirement.js";
import { createWorkflowOperationExecutionSnapshot } from "../dist/features/runs/workflow-operation-snapshot.js";
import { typedOperation } from "./support/workflow-operation-gate-fixture.mjs";
import { createUserInputWorkflowTerminalHook } from "../dist/features/runs/user-input-workflow-terminal.js";
import { prepareUserInputContinuationRequest } from "../dist/features/runs/user-input-prepared-request.js";

const clock = () => new Date().toISOString();
const question = { schemaVersion: 1, waitMode: "required", questions: [
  { questionId: "scope", prompt: "Choose scope", required: true, allowFreeText: true, options: [] },
] };
function response(delta, finish) {
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
}
async function fixture(t, surface = "normal", sourcePolicy = {}, { storedTask = false, workflow = false, workflowPolicy, requiredOperation = false, executionSubdir = false, media = false, autoClaim = true, shared } = {}) {
  const cwd = shared?.cwd ?? await mkdtemp(join(tmpdir(), "ling-answer-dispatch-"));
  const stores = shared?.stores ?? new RunStoreRegistry(createSqliteRunStore), active = shared?.active ?? new ActiveRunRegistry();
  const supervisor = shared?.supervisor ?? new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd,
    harness: { toolBroker: { mode: "enforce" } } }));
  const workers = shared?.workers ?? [];
  if (!shared) t.after(async () => { for (const worker of workers) await worker.close();
    await active.waitForIdle(); supervisor.releaseAll(); stores.closeAll(); await rm(cwd, { recursive: true, force: true }); });
  const store = stores.getStore(cwd), teammateId = "teammate_builtin_engineer";
  const executionCwd = executionSubdir ? join(cwd, "repository") : cwd;
  if (executionSubdir) await mkdir(executionCwd);
  const channel = surface === "channel" ? store.createChannel({ name: "Continuation", boundPath: executionCwd }, clock()) : undefined;
  let workflowRecord, step, workflowStartOwner, workflowExecution;
  let task = storedTask ? store.createTask({ channelId: channel.id, title: "Source", prompt: "SOURCE_TASK_MARKER" }, clock())
    : { id: "source-task-" + randomUUID(), title: "Source", prompt: "SOURCE_TASK_MARKER", channelId: channel?.id };
  if (workflow) {
    workflowRecord = store.createChannelWorkflow({ channelId: channel.id, title: "Question workflow", objective: "Resume one owned step",
      createdBy: "local-user", status: "running" }, clock());
    step = store.createChannelWorkflowStep({ workflowId: workflowRecord.id, title: "Source", prompt: "SOURCE_TASK_MARKER",
      toParticipantId: teammateId, toParticipantLabel: "Engineer",
      ...(workflowPolicy ? { metadata: { policy: { onRunFailed: workflowPolicy, onRunCancelled: "block_for_user",
        onApprovalDenied: "block_for_user", retryable: true } } } : {}) }, clock());
    if (requiredOperation) {
      const operation = typedOperation("file_read", "required-input.txt");
      const plan = { bindingVersion: 1, operations: [operation], fingerprint: channelOperationPlanFingerprintV1([operation]) };
      step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, executionPlan: plan,
        executionOperationIds: [operation.id] } }, clock());
      const requirement = createDelegatedStepRequirement({ workflow: workflowRecord, step,
        participant: { expectedOutcome: "verification" }, manifestFingerprint: "dispatch-fixture-manifest" });
      step = store.updateChannelWorkflowStep(step.id, { metadata: { ...step.metadata, delegatedRequirement: requirement } }, clock());
      workflowExecution = { delegatedRequirement: requirement, executionOperationBindings: [operation],
        workflowOperationExecution: createWorkflowOperationExecutionSnapshot(step) };
    }
    const lease = store.acquireResourceLease({ workspaceId: channel.workspaceId, resourceType: "workflow_step", resourceKey: step.id,
      ownerType: "workflow_step", ownerId: step.id, acquiredAt: clock(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
    assert.ok(lease);
    const begun = store.beginChannelWorkflowStepStart({ workflowStepId: step.id, expected: step, leaseId: lease.id,
      task: { channelId: channel.id, assigneeTeammateId: teammateId, title: "Source", prompt: "SOURCE_TASK_MARKER" }, now: clock() });
    assert.equal(begun.status, "begun");
    task = begun.task; workflowStartOwner = begun.owner;
  }
  const thread = store.createLingThread({ kind: surface === "private" ? "teammate_direct"
    : surface === "channel" ? "channel_discussion" : "conversation", channelId: channel?.id, teammateId,
  title: "Continuation", objective: "Resume the original task" }, clock());
  const turn = store.appendConversationUserTurn({ threadId: thread.id, channelId: channel?.id, teammateId,
    title: "Source", userInstruction: "SOURCE_TASK_MARKER", idempotencyKey: "source",
    payload: { body: "SOURCE_TASK_MARKER", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, clock());
  const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Offline fixture", providerId: "dispatch-fixture",
    model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", authHeader: false,
    reasoning: true, capabilities: ["chat", "tool_call", "reasoning"], enabled: true }, clock());
  store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Scripted transport only", checkedAt: clock() });
  const mediaPreset = media ? store.createProviderPreset({ kind: "openai", displayName: "Local media schema fixture", providerId: "openai",
    model: "gpt-image-1", api: "media-job", baseUrl: "https://fixture.invalid/v1", authHeader: false,
    capabilities: ["image_generate"], compat: { mediaVendorTransport: { mode: "live" } }, enabled: true }, clock()) : undefined;
  if (mediaPreset) {
    store.setProviderSecret(mediaPreset.id, "fixture-not-a-real-key", clock());
    store.updateProviderPreset(mediaPreset.id, { apiKeyRef: `local:${mediaPreset.id}` }, clock());
    store.recordProviderCheckResult(mediaPreset.id, { ok: true, code: "ready", message: "Schema fixture only", checkedAt: clock() });
  }
  const f = { cwd, stores, active, supervisor, store, workers, teammateId, channel, task, thread, turn, preset,
    workflow: workflowRecord, step, workflowStartOwner, mediaPreset, calls: [], errors: [], events: [], askAgain: false };
  class Runner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
        stream(model, context, { ...options, fetch: async (_url, request) => {
          const body = JSON.parse(request.body);
          if (f.calls.length > 0) {
            assert.ok(store.getUserInputContinuationReceipt(thread.id, f.delivery.deliveryId), "ACK precedes provider I/O");
            assert.equal(store.getUserInputDelivery(thread.id, f.delivery.deliveryId).status, "applied");
          }
          f.calls.push(body);
          if (f.cancelContinuation) {
            f.cancelContinuation = false;
            const binding = store.getUserInputContinuationBinding(thread.id, f.delivery.deliveryId);
            assert.ok(binding, "cancellation happens only after answer admission");
            assert.equal(active.requestStop(binding.runId, {
              kind: "user_cancel", actor: "local-user", reason: "fixture cancellation",
            }), true);
            throw new Error("cancelled continuation fixture");
          }
          if (f.calls.length === 1 || f.askAgain) {
            f.askAgain = false;
            return response({ tool_calls: [{ index: 0, id: `question-${f.calls.length}`, type: "function",
              function: { name: "request_user_input", arguments: JSON.stringify(question) } }] }, "tool_calls");
          }
          if (f.continuationBarrier) await f.continuationBarrier;
          if (f.failContinuation) return new Response(JSON.stringify({ error: { message: "Fixture provider rejection" } }), {
            status: 400, headers: { "content-type": "application/json" },
          });
          return response({ content: "Completed scripted continuation." }, "stop");
        } }) });
    }
  }
  f.adapter = new Runner();
  f.runners = createRunnerRegistry([{ id: "pi", displayName: "Real SDK fixture", status: "enabled", adapter: f.adapter }]);
  f.sink = () => ({ ...host.createDetachedRunExecutionSink(),
    writeEvent: (type, data) => f.events.push({ type, data }),
    writeError: (status, error) => f.errors.push({ status, ...error }) });
  f.options = { enableUserInputPause: true, afterRunYielded: (_run, wait) => { f.wait = wait; } };
  f.sourceId = await host.executeRunRequest({ cwd: executionCwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.turnId,
    sourceMessageId: turn.item.id, teammateId, providerPresetId: preset.id, agentDir: join(cwd, "agent"),
    workflowStepId: step?.id, workflowStartOwner, ...workflowExecution,
    task,
    tools: ["read"], idempotencyKey: "source-run-" + thread.id, createdByActor: "local-user", ...sourcePolicy },
  f.sink(), f.runners, stores, active, supervisor, { resolve: () => undefined }, {}, f.options);
  assert.equal(store.getRun(f.sourceId)?.status, "yielded", JSON.stringify({ errors: f.errors,
    errorMessage: store.getRun(f.sourceId)?.errorMessage, events: store.listEvents(f.sourceId).map(event => ({ type: event.type, data: event.data })) }));
  f.answer = (text = "ANSWER_MARKER") => {
    const request = store.getUserInputRequest(thread.id, f.wait.checkpoint.requestId);
    const answer = store.submitUserInputAnswer({ threadId: thread.id, submission: { schemaVersion: 1,
      requestId: request.requestId, expectedVersion: request.requestVersion, expectedStatusRevision: request.statusRevision,
      idempotencyKey: `answer-${request.requestId}`, answers: [{ questionId: "scope", kind: "text", text }] } }, clock());
    f.delivery = autoClaim ? store.claimUserInputDelivery({ threadId: thread.id, deliveryId: answer.deliveryId,
      expectedRevision: 1, ownerId: "host-fixture", leaseMs: 60000 }, clock()) : store.getUserInputDelivery(thread.id, answer.deliveryId);
    if (autoClaim) f.claim = { threadId: thread.id, deliveryId: f.delivery.deliveryId, expectedRevision: f.delivery.revision,
      ownerId: f.delivery.claim.ownerId, claimToken: f.delivery.claim.token };
    f.preparedRequest = undefined;
  };
  f.dispatch = () => {
    f.preparedRequest ??= prepareUserInputContinuationRequest(f.store, f.claim, clock());
    return host.executeUserInputContinuation({ request: f.preparedRequest.request,
      threadId: f.thread.id, deliveryId: f.delivery.deliveryId, claim: f.claim },
    f.sink(), f.runners, stores, active, supervisor, { resolve: () => undefined }, {}, f.options);
  };
  f.answer();
  return f;
}
function executeWorkerDelivery(f, input) {
  let accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  const completion = host.executeUserInputContinuation({ request: input.request,
    threadId: input.threadId, deliveryId: input.deliveryId,
    claim: input.claim, ...(input.binding ? { binding: input.binding } : {}) },
  f.sink(), f.runners, f.stores, f.active, f.supervisor, { resolve: () => undefined }, {}, {
    ...f.options,
    onUserInputReceiverAccepted: ({ runId }) => accept(runId),
  });
  return Promise.race([accepted, completion]);
}
function worker(f, options = {}) {
  const w = new UserInputDeliveryWorker({ activeRuns: f.active, runtimeSupervisor: f.supervisor,
    execute: input => executeWorkerDelivery(f, input), ...options });
  f.workers.push(w);
  return w;
}

function occupyProviderCapacity(f) {
  const acquiredAt = clock();
  const expiresAt = new Date(Date.parse(acquiredAt) + 60_000).toISOString();
  const attempts = [];
  for (let index = 0; index < 4; index += 1) {
    const suffix = randomUUID();
    const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "task",
      ownerId: `provider-blocker-${suffix}`, runnerId: "pi", idempotencyKey: `provider-blocker-${suffix}`,
      request: {}, createdByActor: "system", now: acquiredAt });
    const attempt = f.store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
      runtimeInstanceId: `provider-blocker-runtime-${suffix}`, runnerId: "pi", now: acquiredAt });
    const slot = f.store.acquireRuntimeSemaphoreSlot({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "provider",
      resourceKey: f.preset.id, limit: 4, ownerType: "work_unit_attempt", ownerId: attempt.id,
      ...toRuntimeAttemptFence(attempt), acquiredAt, expiresAt });
    assert.ok(slot);
    attempts.push(attempt);
  }
  return {
    release() {
      for (const attempt of attempts) {
        f.store.releaseRuntimeSemaphoreSlotsForAttempt(toRuntimeAttemptFence(attempt), clock(), "fixture-unblocked");
      }
    },
  };
}
for (const surface of ["normal", "private", "channel"]) {
  test(`answer worker discovers and dispatches the real ${surface} Host continuation`, async t => {
    const f = await fixture(t, surface, {}, { autoClaim: false }), w = worker(f);
    t.after(() => w.close());
    assert.deepEqual(await w.scanStore(f.store), { scanned: 1, dispatched: 1, deferred: 0 });
    await f.active.waitForIdle();
    const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
    assert.equal(f.store.getRun(binding.runId).status, "succeeded");
    assert.equal(f.calls.length, 2);
    assert.deepEqual(await w.scanStore(f.store), { scanned: 0, dispatched: 0, deferred: 0 });
  });
}
test("two answer workers and repeated in-process scans admit only one successor", async t => {
  const f = await fixture(t, "normal", {}, { autoClaim: false }), first = worker(f), second = worker(f);
  t.after(async () => { await first.close(); await second.close(); });
  const scan = first.scanStore(f.store);
  assert.equal(first.scanStore(f.store), scan);
  const results = await Promise.all([scan, second.scanStore(f.store)]);
  await f.active.waitForIdle();
  assert.equal(results.reduce((sum, result) => sum + result.dispatched, 0), 1);
  assert.equal(f.calls.length, 2);
});
test("answer worker persists pre-admission backoff and recovers after provider configuration repair", async t => {
  const f = await fixture(t, "normal", {}, { autoClaim: false });
  let now = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now });
  const w = worker(f); t.after(() => w.close());
  f.store.updateProviderPreset(f.preset.id, { enabled: false }, clock());
  assert.deepEqual(await w.scanStore(f.store), { scanned: 1, dispatched: 0, deferred: 1 });
  const deferred = f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId);
  assert.equal(deferred.status, "failed");
  assert.equal(deferred.retryAt, new Date(now + 5000).toISOString());
  assert.equal(f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal((await w.scanStore(f.store)).scanned, 0);
  f.store.updateProviderPreset(f.preset.id, { enabled: true }, clock());
  f.store.recordProviderCheckResult(f.preset.id, { ok: true, code: "ready", message: "Repaired scripted fixture", checkedAt: clock() });
  now += 5001; t.mock.timers.setTime(now);
  const retried = await w.scanStore(f.store);
  assert.equal(retried.dispatched, 1, JSON.stringify({ errors: f.errors, scan: retried,
    delivery: f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId) }));
  await f.active.waitForIdle();
  assert.equal(f.calls.length, 2);
});
test("answer worker reclaims expired pre-admission claims but never replays admitted executions", async t => {
  const f = await fixture(t), expiry = Date.parse(f.delivery.claim.expiresAt) + 1;
  t.mock.timers.enable({ apis: ["Date"], now: expiry });
  const w = worker(f); t.after(() => w.close());
  assert.equal((await w.scanStore(f.store)).dispatched, 1, JSON.stringify(f.errors));
  await f.active.waitForIdle();
  assert.equal(f.calls.length, 2);
  assert.equal((await worker(f, { now: () => new Date(expiry + 60001).toISOString() }).scanStore(f.store)).dispatched, 0);
  assert.equal(f.calls.length, 2);
});
test("answer worker shutdown drains an admitted scan and prevents new discovery", async t => {
  const f = await fixture(t, "normal", {}, { autoClaim: false });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const w = worker(f, { execute: async () => { entered(); await paused; return undefined; } });
  const scan = w.scanStore(f.store); await started;
  let closed = false;
  const closing = w.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); await scan; await closing;
  assert.deepEqual(await w.scanStore(f.store), { scanned: 0, dispatched: 0, deferred: 0 });
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "failed");
  assert.equal(f.calls.length, 1);
});
test("a corrupt answer record cannot block a healthy later thread", async t => {
  const f = await fixture(t, "normal", {}, { autoClaim: false });
  const later = await fixture(t, "private", {}, { autoClaim: false, shared: f });
  const db = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
  try { db.prepare("UPDATE user_input_answers SET submission_json='{}' WHERE answer_id=?").run(f.delivery.answerId); }
  finally { db.close(); }
  const w = worker(later, { pageSize: 1 });
  assert.deepEqual(await w.scanStore(f.store), { scanned: 1, dispatched: 0, deferred: 1 });
  assert.deepEqual(await w.scanStore(f.store), { scanned: 1, dispatched: 1, deferred: 0 });
  await f.active.waitForIdle();
  assert.equal(f.calls.length, 1); assert.equal(later.calls.length, 2);
  assert.equal(f.store.getUserInputContinuationReceipt(later.thread.id, later.delivery.deliveryId)?.acceptance.runId,
    f.store.getUserInputContinuationBinding(later.thread.id, later.delivery.deliveryId)?.runId);
});
for (const corruption of ["created_at", "delivery_id"]) {
  test(`a corrupt ${corruption} discovery key cannot poison later scans`, async t => {
    const f = await fixture(t, "normal", {}, { autoClaim: false });
    const later = await fixture(t, "private", {}, { autoClaim: false, shared: f });
    const db = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
    try {
      if (corruption === "created_at") {
        db.prepare("UPDATE user_input_deliveries SET created_at='2026-01-01T00:00:00Z' WHERE delivery_id=?").run(f.delivery.deliveryId);
      } else {
        db.prepare("UPDATE user_input_deliveries SET delivery_id='bad delivery id' WHERE delivery_id=?")
          .run(f.delivery.deliveryId);
      }
    } finally { db.close(); }
    if (corruption === "created_at") {
      assert.throws(() => f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId),
        error => error.code === "invalid_record");
    } else {
      assert.equal(f.store.getUserInputDelivery(f.thread.id, "bad delivery id"), undefined);
    }
    const w = worker(later, { pageSize: 1 });
    assert.deepEqual(await w.scanStore(f.store), { scanned: 1, dispatched: 0, deferred: 1 });
    assert.deepEqual(await w.scanStore(f.store), { scanned: 1, dispatched: 1, deferred: 0 });
    await f.active.waitForIdle();
    assert.equal(f.calls.length, 1);
    assert.equal(later.calls.length, 2);
    assert.deepEqual(await w.scanStore(f.store), { scanned: 0, dispatched: 0, deferred: 0 });
  });
}
for (const [column, value] of [["delivery_id", new Uint8Array([1, 2, 3])], ["created_at", new Uint8Array([1])], ["delivery_id", null]]) {
  test(`non-text ${column} discovery keys are quarantined rather than stringified`, async t => {
    const f = await fixture(t, "normal", {}, { autoClaim: false });
    const later = await fixture(t, "private", {}, { autoClaim: false, shared: f });
    const db = new DatabaseSync(resolveRuntimePaths(f.cwd).databasePath);
    try { db.prepare(`UPDATE user_input_deliveries SET ${column}=? WHERE delivery_id=?`).run(value, f.delivery.deliveryId); }
    finally { db.close(); }
    const w = worker(later, { pageSize: 1 });
    assert.deepEqual(await w.scanStore(f.store), { scanned: 1, dispatched: 1, deferred: 0 });
    await f.active.waitForIdle();
    assert.equal(f.calls.length, 1); assert.equal(later.calls.length, 2);
    assert.deepEqual(await w.scanStore(f.store), { scanned: 0, dispatched: 0, deferred: 0 });
  });
}
test("a long admitted answer does not prevent another thread from dispatching", async t => {
  const f = await fixture(t, "normal", {}, { autoClaim: false });
  const later = await fixture(t, "private", {}, { autoClaim: false, shared: f });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.continuationBarrier = barrier;
  const w = worker(f, { pageSize: 1, execute: input => {
    const current = input.threadId === f.thread.id ? f : later;
    return executeWorkerDelivery(current, input);
  } });
  try {
    assert.equal((await w.scanStore(f.store)).dispatched, 1);
    assert.equal((await w.scanStore(f.store)).dispatched, 1);
    for (let i = 0; i < 100; i += 1) {
      const binding = f.store.getUserInputContinuationBinding(later.thread.id, later.delivery.deliveryId);
      if (binding && f.store.getRun(binding.runId)?.status === "succeeded") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const first = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
    const second = f.store.getUserInputContinuationBinding(later.thread.id, later.delivery.deliveryId);
    assert.equal(f.store.getRun(first.runId).status, "running");
    assert.equal(f.store.getRun(second.runId).status, "succeeded");
    assert.equal(f.calls.length, 2); assert.equal(later.calls.length, 2);
  } finally { release(); await f.active.waitForIdle(); await w.close(); }
});
test("Daemon startup dispatches a persisted answer without a public Run request", { timeout: 20000 }, async t => {
  const f = await fixture(t, "normal", {}, { autoClaim: false });
  f.supervisor.releaseAll();
  const daemon = createDaemonServer({ defaultWorkspaceCwd: f.cwd, port: 0,
    harness: { toolBroker: { mode: "enforce" } }, channels: { terminalReports: false } }, {
    runnerRegistry: f.runners, storeFactory: createSqliteRunStore,
    secretResolver: { resolve: () => undefined, status: () => ({ status: "missing" }) },
  });
  t.after(async () => { if (daemon.server.listening) await daemon.stop(); });
  await daemon.start();
  for (let i = 0; i < 100; i += 1) {
    const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
    if (binding && f.store.getRun(binding.runId)?.status === "succeeded") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
  assert.ok(binding, "Daemon lifecycle must wire the answer worker");
  assert.equal(f.store.getRun(binding.runId).status, "succeeded");
  assert.equal(f.calls.length, 2);
  await daemon.stop();
});
test("a competing Daemon cannot mutate an active answer before workspace custody is refused", async t => {
  const f = await fixture(t);
  let release;
  f.continuationBarrier = new Promise(resolve => { release = resolve; });
  const execution = f.dispatch();
  let daemon;
  try {
    for (let i = 0; i < 100 && !f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
    assert.ok(binding);
    const snapshot = () => [f.store.getRun(binding.runId), f.store.getWorkUnit(binding.fence.workUnitId),
      f.store.getWorkUnitAttempt(binding.fence.attemptId), f.store.getLingThread(f.thread.id)]
      .map(value => createHash("sha256").update(JSON.stringify(value)).digest("hex"));
    const before = snapshot();
    await assert.rejects(async () => {
      daemon = createDaemonServer({ defaultWorkspaceCwd: f.cwd, port: 0,
        harness: { toolBroker: { mode: "enforce" } }, channels: { terminalReports: false } }, {
        runnerRegistry: f.runners, storeFactory: createSqliteRunStore,
        secretResolver: { resolve: () => undefined, status: () => ({ status: "missing" }) },
      });
      await daemon.start();
    }, error => error.code === "runtime_already_running");
    assert.deepEqual(snapshot(), before);
  } finally {
    release(); await execution;
    if (daemon?.server.listening) await daemon.stop();
  }
});

for (const scenario of ["success", "required_operation", "bound_subdirectory"]) {
test(`Daemon answer completion: ${scenario}`, { timeout: 20000 }, async t => {
  const requiredOperation = scenario === "required_operation";
  const f = await fixture(t, "channel", {}, { workflow: true, autoClaim: false, requiredOperation,
    executionSubdir: scenario === "bound_subdirectory" });
  f.store.replaceTeammateChannelMemberships(f.teammateId, [{ channelId: f.channel.id }], clock());
  const next = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, position: 2, title: "Next step",
    prompt: "NEXT_STEP_MARKER", toParticipantId: f.teammateId, toParticipantLabel: "Engineer",
    metadata: { dependsOnStepIds: [f.step.id], dependencyMode: "all_succeeded", providerPresetId: f.preset.id,
      requestedRunnerId: "pi", requiredTools: ["read"], autoStart: true } }, clock());
  assert.equal(next.status, "queued");
  f.supervisor.releaseAll();
  const daemon = createDaemonServer({ defaultWorkspaceCwd: f.cwd, port: 0,
    harness: { toolBroker: { mode: "enforce" } }, channels: { terminalReports: false } }, {
    runnerRegistry: f.runners, storeFactory: createSqliteRunStore,
    secretResolver: { resolve: () => undefined, status: () => ({ status: "missing" }) },
  });
  t.after(async () => { if (daemon.server.listening) await daemon.stop(); });
  await daemon.start();
  for (let i = 0; i < 250 && f.store.getChannelWorkflow(f.workflow.id)?.status !== (requiredOperation ? "blocked" : "succeeded"); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
  const firstStep = f.store.getChannelWorkflowStep(f.step.id), secondStep = f.store.getChannelWorkflowStep(next.id);
  assert.ok(binding);
  assert.equal(f.store.getRun(binding.runId).status, "succeeded");
  if (requiredOperation) {
    assert.equal(firstStep.status, "blocked");
    assert.equal(firstStep.metadata.executionVerification.status, "blocked");
    assert.equal(firstStep.metadata.executionVerification.operationResults[0].reasonCode, "required_operation_missing_evidence");
    assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "blocked");
    assert.equal(secondStep.status, "queued");
    assert.equal(secondStep.runId, undefined);
    assert.equal(secondStep.taskId, undefined);
    assert.equal(f.calls.length, 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.calls.length, 2);
    await daemon.stop();
    return;
  }
  assert.equal(firstStep.status, "succeeded");
  assert.equal(secondStep.status, "succeeded", JSON.stringify({ workflow: f.store.getChannelWorkflow(f.workflow.id), secondStep, calls: f.calls.length }));
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "succeeded");
  assert.equal(f.store.getRun(f.sourceId).status, "yielded");
  assert.equal(firstStep.runId, binding.runId);
  assert.equal(firstStep.taskId, f.task.id);
  assert.notEqual(secondStep.runId, firstStep.runId);
  assert.notEqual(secondStep.taskId, firstStep.taskId);
  assert.notEqual(f.store.getRun(secondStep.runId).workUnitId, binding.fence.workUnitId);
  assert.equal(f.store.getTask(secondStep.taskId).status, "done");
  assert.equal(f.store.getRun(secondStep.runId).cwd, f.channel.boundPath);
  assert.equal(f.store.getRun(secondStep.runId).requestSnapshot.workspaceCwd, f.cwd);
  assert.equal(f.calls.length, 3);
  assert.match(JSON.stringify(f.calls[1]), /ANSWER_MARKER/);
  assert.match(JSON.stringify(f.calls[2]), /NEXT_STEP_MARKER/);
  for (const step of [firstStep, secondStep]) {
    assert.equal(f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, status: "active" }).length, 0);
  }
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.calls.length, 3);
  await daemon.stop();
});
}
for (const mutation of ["step_prompt", "workflow_objective"]) {
test(`answer terminal hook rechecks ${mutation} authority after its base callback awaits`, async t => {
  const f = await fixture(t, "channel", {}, { workflow: true });
  f.store.replaceTeammateChannelMemberships(f.teammateId, [{ channelId: f.channel.id }], clock());
  const next = f.store.createChannelWorkflowStep({ workflowId: f.workflow.id, position: 2, title: "Next step",
    prompt: "NEXT_STEP_MARKER", toParticipantId: f.teammateId, toParticipantLabel: "Engineer",
    metadata: { dependsOnStepIds: [f.step.id], dependencyMode: "all_succeeded", providerPresetId: f.preset.id,
      requestedRunnerId: "pi", requiredTools: ["read"], autoStart: true } }, clock());
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  f.options.afterRunTerminal = createUserInputWorkflowTerminalHook({ runnerRegistry: f.runners, storeRegistry: f.stores,
    activeRuns: f.active, runtimeSupervisor: f.supervisor, secretResolver: { resolve: () => undefined }, mcpBroker: {},
    afterRunTerminal: async () => { entered(); await barrier; } });
  const execution = f.dispatch();
  try {
    await reached;
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "succeeded");
    if (mutation === "step_prompt") f.store.updateChannelWorkflowStep(f.step.id, { prompt: "Changed after finalization" }, clock());
    else f.store.updateChannelWorkflow(f.workflow.id, { objective: "Changed after finalization" }, clock());
  } finally { release(); await execution; }
  assert.equal(f.store.getChannelWorkflowStep(next.id).status, "queued");
  assert.equal(f.store.getChannelWorkflowStep(next.id).runId, undefined);
  assert.equal(f.calls.length, 2);
});
}

test("Daemon restart completes an optional last step interrupted after answer admission but before start", { timeout: 20000 }, async t => {
  const f = await fixture(t, "channel", {}, { workflow: true, workflowPolicy: "skip_if_optional" });
  // A real external provider-capacity conflict leaves the admitted binding
  // recoverable. Releasing it before restart simulates the interrupted Host
  // disappearing without converting a transient conflict into terminal failure.
  const blockers = occupyProviderCapacity(f);
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.store.getRun(f.delivery.successorRunId).status, "queued");
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "running");
  assert.ok(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId));
  assert.ok(f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId));
  blockers.release();
  const shortened = f.store.renewUserInputContinuationLease({ threadId: f.thread.id, deliveryId: f.delivery.deliveryId,
    ownerId: f.claim.ownerId, claimToken: f.claim.claimToken, leaseMs: 1 }, clock());
  assert.equal(shortened.status, "renewed");
  for (let i = 0; i < 100 && f.store.listDueUserInputDeliveries({ limit: 100 }, clock()).length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(f.store.listDueUserInputDeliveries({ limit: 100 }, clock()).length, 1);
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.ok(reopened.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId));
    assert.equal(reopened.listDueUserInputDeliveries({ limit: 100 }, clock()).length, 1);
  } finally { reopened.close(); }
  f.supervisor.releaseAll();
  const daemon = createDaemonServer({ defaultWorkspaceCwd: f.cwd, port: 0,
    harness: { toolBroker: { mode: "enforce" } }, channels: { terminalReports: false } }, {
    runnerRegistry: f.runners, storeFactory: createSqliteRunStore,
    secretResolver: { resolve: () => undefined, status: () => ({ status: "missing" }) },
  });
  t.after(async () => { if (daemon.server.listening) await daemon.stop(); });
  await daemon.start();
  // Daemon startup schedules durable outbox recovery; terminal settlement is
  // asynchronous and must be observed from SQLite rather than assumed at listen time.
  for (let i = 0; i < 100 && f.store.getRun(f.delivery.successorRunId).status === "queued"; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(f.store.getRun(f.delivery.successorRunId).status, "failed");
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "skipped");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "succeeded");
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  assert.equal(f.calls.length, 1);
  await daemon.stop();
});
for (const surface of ["normal", "private", "channel"]) {
  test(`production Host dispatch resumes ${surface} with a new Run and the original WorkUnit/Turn`, async t => {
    const f = await fixture(t, surface), source = f.store.getRun(f.sourceId);
    const id = await f.dispatch();
    assert.ok(id, JSON.stringify(f.errors));
    const run = f.store.getRun(id);
    assert.notEqual(id, source.id);
    assert.equal(run.status, "succeeded", run.errorMessage);
    assert.equal(run.workUnitId, source.workUnitId);
    assert.equal(f.store.getLingTurnForRun(id).id, f.turn.turnId);
    assert.equal(f.store.getRun(source.id).status, "yielded");
    assert.equal(f.calls.length, 2);
    const messages = JSON.stringify(f.calls[1].messages);
    assert.match(messages, /SOURCE_TASK_MARKER/); assert.match(messages, /ANSWER_MARKER/);
    assert.ok(run.requestSnapshot.effectivePolicySnapshot);
    assert.equal(f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId).runId, id);
    assert.equal(f.active.get(id), undefined);
  });
}
for (const seam of ["prestart", "publication"]) {
  test(`expired answer claim cannot authorize ${seam} after preparation time advances`, async t => {
    const f = await fixture(t);
    const expiredAt = Date.parse(f.delivery.claim.expiresAt) + 1;
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let checkedAt;
    const recover = f.store.recoverUserInputContinuationPrestart.bind(f.store);
    f.store.recoverUserInputContinuationPrestart = input => {
      if (seam === "prestart") checkedAt = input.now;
      const result = recover(input);
      if (seam === "publication") t.mock.timers.setTime(expiredAt);
      return result;
    };
    const publish = f.store.publishUserInputContinuationRunCreated.bind(f.store);
    f.store.publishUserInputContinuationRunCreated = (input, at) => {
      if (seam === "publication") checkedAt = at;
      return publish(input, at);
    };
    if (seam === "prestart") {
      const admit = f.store.admitUserInputContinuation.bind(f.store);
      f.store.admitUserInputContinuation = (input, at) => {
        const binding = admit(input, at);
        t.mock.timers.setTime(expiredAt);
        return binding;
      };
    }

    await f.dispatch();

    const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
    assert.ok(binding);
    assert.ok(Date.parse(checkedAt) >= expiredAt, "each authority write must obtain fresh lifecycle time");
    assert.equal(f.store.getRun(binding.runId).status, "queued");
    assert.equal(f.calls.length, 1, "expired ownership must not reach a continuation model request");
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
    assert.equal(f.store.listEvents(binding.runId).filter(event => event.type === "run_created").length, 0);
    if (seam === "prestart") {
      assert.equal(f.store.listResourceLeases({ attemptId: binding.fence.attemptId, status: "active" }).length, 0);
      assert.equal(f.store.listRuntimeSemaphoreSlots({ ownerId: binding.fence.attemptId, status: "active" }).length, 0);
    }
  });
}

test("request preparation time remains the lifecycle lower bound after a pre-admission wall-clock rollback", async t => {
  const f = await fixture(t);
  const requestTime = Date.parse(f.delivery.updatedAt) + 1000;
  t.mock.timers.enable({ apis: ["Date"], now: requestTime });
  let rolledBack = false;
  f.options.startupState = { snapshot: () => {
    if (!rolledBack) {
      rolledBack = true;
      t.mock.timers.setTime(requestTime - 500);
    }
    return { state: "ready" };
  } };

  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  const request = f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "request");
  const execution = f.store.getUserInputContinuationPreparation(f.thread.id, f.delivery.deliveryId, "execution");
  const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
  assert.equal(request.createdAt, new Date(requestTime).toISOString());
  assert.ok(Date.parse(execution.createdAt) >= Date.parse(request.createdAt));
  assert.ok(Date.parse(binding.createdAt) >= Date.parse(execution.createdAt));
});
for (const expectedStatus of ["succeeded", "failed"]) {
  test(`answer admission time remains the lifecycle lower bound after wall-clock rollback (${expectedStatus})`, async t => {
    const f = await fixture(t);
    f.failContinuation = expectedStatus === "failed";
    const originalNow = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: originalNow });
    const admit = f.store.admitUserInputContinuation.bind(f.store);
    t.mock.method(f.store, "admitUserInputContinuation", (input) => {
      const admissionNow = originalNow + 1000;
      t.mock.timers.setTime(admissionNow);
      const admitted = admit(input, clock());
      t.mock.timers.setTime(admissionNow - 500);
      return admitted;
    });

    const id = await f.dispatch();
    assert.ok(id, JSON.stringify(f.errors));
    const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
    const run = f.store.getRun(binding.runId);
    const workUnit = f.store.getWorkUnit(binding.fence.workUnitId);
    const attempt = f.store.getWorkUnitAttempt(binding.fence.attemptId);
    const runEvents = f.store.listEvents(binding.runId);
    const runtimeEvents = f.store.listRuntimeEvents(binding.fence.workUnitId, { limit: 100 });
    const heartbeatRows = f.store.database.prepare(
      "SELECT ts FROM runtime_heartbeats WHERE attempt_id=? ORDER BY ts, id",
    ).all(binding.fence.attemptId);
    const timestamps = [
      ["run.startedAt", run.startedAt],
      ["run.updatedAt", run.updatedAt],
      ["run.endedAt", run.endedAt],
      ["workUnit.startedAt", workUnit.startedAt],
      ["workUnit.updatedAt", workUnit.updatedAt],
      ["workUnit.lastEventAt", workUnit.lastEventAt],
      ["workUnit.lastHeartbeatAt", workUnit.lastHeartbeatAt],
      ["workUnit.endedAt", workUnit.endedAt],
      ["attempt.startedAt", attempt.startedAt],
      ["attempt.lastEventAt", attempt.lastEventAt],
      ["attempt.lastHeartbeatAt", attempt.lastHeartbeatAt],
      ["attempt.endedAt", attempt.endedAt],
      ...runEvents.map(event => [`runEvent.${event.type}`, event.ts]),
      ...runtimeEvents.filter(event => event.attemptId === binding.fence.attemptId)
        .map(event => [`runtimeEvent.${event.type}`, event.ts]),
      ...heartbeatRows.map(row => ["runtimeHeartbeat", row.ts]),
    ].filter(([, timestamp]) => timestamp !== undefined);
    const lowerBound = Date.parse(binding.createdAt);
    assert.equal(run.status, expectedStatus, run.errorMessage);
    assert.ok(timestamps.length > 0);
    for (const [label, timestamp] of timestamps) {
      assert.ok(Date.parse(timestamp) >= lowerBound, `${label} ${timestamp} precedes admission ${binding.createdAt}`);
    }
  });
}
test("answer cancellation keeps admission as the lifecycle lower bound after wall-clock rollback", async t => {
  const f = await fixture(t);
  f.cancelContinuation = true;
  const originalNow = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: originalNow });
  const admit = f.store.admitUserInputContinuation.bind(f.store);
  t.mock.method(f.store, "admitUserInputContinuation", (input) => {
    const admissionNow = originalNow + 1000;
    t.mock.timers.setTime(admissionNow);
    const admitted = admit(input, clock());
    t.mock.timers.setTime(admissionNow - 500);
    return admitted;
  });

  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
  const run = f.store.getRun(binding.runId);
  const workUnit = f.store.getWorkUnit(binding.fence.workUnitId);
  const attempt = f.store.getWorkUnitAttempt(binding.fence.attemptId);
  const timestamps = [
    ["run.updatedAt", run.updatedAt], ["run.endedAt", run.endedAt],
    ["workUnit.updatedAt", workUnit.updatedAt], ["workUnit.lastEventAt", workUnit.lastEventAt],
    ["workUnit.endedAt", workUnit.endedAt], ["attempt.lastEventAt", attempt.lastEventAt],
    ["attempt.endedAt", attempt.endedAt],
    ...f.store.listEvents(binding.runId).map(event => [`runEvent.${event.type}`, event.ts]),
    ...f.store.listRuntimeEvents(binding.fence.workUnitId, { limit: 100 })
      .filter(event => event.attemptId === binding.fence.attemptId)
      .map(event => [`runtimeEvent.${event.type}`, event.ts]),
  ].filter(([, timestamp]) => timestamp !== undefined);
  const lowerBound = Date.parse(binding.createdAt);
  assert.equal(run.status, "cancelled", run.errorMessage);
  assert.equal(workUnit.status, "cancelled");
  assert.equal(attempt.status, "cancelled");
  for (const [label, timestamp] of timestamps) {
    assert.ok(Date.parse(timestamp) >= lowerBound, `${label} ${timestamp} precedes admission ${binding.createdAt}`);
  }
});
test("a repeated question yields after answer admission even when the wall clock rolls back", async t => {
  const f = await fixture(t);
  f.askAgain = true;
  const originalNow = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: originalNow });
  const admit = f.store.admitUserInputContinuation.bind(f.store);
  t.mock.method(f.store, "admitUserInputContinuation", (input) => {
    const admissionNow = originalNow + 1000;
    t.mock.timers.setTime(admissionNow);
    const admitted = admit(input, clock());
    t.mock.timers.setTime(admissionNow - 500);
    return admitted;
  });

  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  const binding = f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId);
  const run = f.store.getRun(binding.runId);
  const workUnit = f.store.getWorkUnit(binding.fence.workUnitId);
  const attempt = f.store.getWorkUnitAttempt(binding.fence.attemptId);
  const nextRequest = f.store.getUserInputRequest(f.thread.id, f.wait.checkpoint.requestId);
  const lowerBound = Date.parse(binding.createdAt);
  assert.equal(run.status, "yielded", run.errorMessage);
  assert.equal(workUnit.status, "waiting_for_input");
  assert.equal(attempt.status, "yielded");
  assert.ok(nextRequest);
  for (const [label, timestamp] of [
    ["run.updatedAt", run.updatedAt], ["run.endedAt", run.endedAt],
    ["workUnit.updatedAt", workUnit.updatedAt], ["workUnit.endedAt", workUnit.endedAt],
    ["attempt.endedAt", attempt.endedAt], ["request.createdAt", nextRequest.createdAt],
  ].filter(([, timestamp]) => timestamp !== undefined)) {
    assert.ok(Date.parse(timestamp) >= lowerBound, `${label} ${timestamp} precedes admission ${binding.createdAt}`);
  }
});
test("duplicate Host dispatch cannot replay an acknowledged answer", async t => {
  const f = await fixture(t), id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.calls.length, 2);
});
test("concurrent Host dispatch creates one successor and performs one continuation request", async t => {
  const f = await fixture(t);
  const ids = await Promise.all([f.dispatch(), f.dispatch()]);
  assert.equal(ids.filter(Boolean).length, 1, JSON.stringify(f.errors));
  assert.equal(f.calls.length, 2);
});
test("production Host resumes and completes the original stored channel Task", async t => {
  const f = await fixture(t, "channel", {}, { storedTask: true });
  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  assert.equal(f.store.getRun(id).status, "succeeded");
  assert.equal(f.store.getTask(f.task.id).status, "done");
  assert.equal(f.store.getTask(f.task.id).currentRunId, id);
});
test("a canonical workflow step resumes with fresh ownership after its pause released the old lease", async t => {
  const f = await fixture(t, "channel", {}, { workflow: true });
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "waiting_for_input");
  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  assert.equal(f.store.getRun(id).status, "succeeded", JSON.stringify({ errors: f.errors, events: f.events }));
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, id);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, "succeeded");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "succeeded");
  assert.notEqual(f.store.getChannelWorkflowStep(f.step.id).metadata.startOwner.leaseId, f.workflowStartOwner.leaseId);
  assert.equal(f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: f.step.id, status: "active" }).length, 0);
  assert.equal(f.store.getTask(f.task.id).status, "done");
});
test("an acknowledged workflow continuation failure follows canonical step failure policy and releases its lease", async t => {
  const f = await fixture(t, "channel", {}, { workflow: true }); f.failContinuation = true;
  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  assert.equal(f.store.getRun(id).status, "failed");
  assert.ok(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId));
  assert.notEqual(f.store.getChannelWorkflowStep(f.step.id).status, "running");
  assert.equal(f.store.getTask(f.task.id).status, "failed");
  assert.equal(f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: f.step.id, status: "active" }).length, 0);
});
test("a workflow may ask twice while rotating and releasing only its own leases", async t => {
  const f = await fixture(t, "channel", {}, { workflow: true }); f.askAgain = true;
  const first = await f.dispatch();
  assert.equal(f.store.getRun(first)?.status, "yielded", JSON.stringify(f.errors));
  const firstOwner = f.store.getChannelWorkflowStep(f.step.id).metadata.startOwner;
  f.answer("SECOND_WORKFLOW_ANSWER");
  const second = await f.dispatch();
  assert.equal(f.store.getRun(second)?.status, "succeeded", JSON.stringify(f.errors));
  const step = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(step.status, "succeeded");
  assert.notEqual(step.metadata.startOwner.leaseId, firstOwner.leaseId);
  assert.equal(f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id, status: "active" }).length, 0);
});
test("startup semaphore conflict keeps the admitted answer recoverable without terminal settlement", async t => {
  const f = await fixture(t, "channel", {}, { storedTask: true });
  const blockers = occupyProviderCapacity(f);
  try {
    assert.equal(await f.dispatch(), undefined);
    const run = f.store.getRun(f.delivery.successorRunId);
    assert.equal(run.status, "queued");
    assert.equal(f.store.getWorkUnit(run.workUnitId).status, "claimed");
    assert.equal(f.store.getTask(f.task.id).status, "claimed");
    assert.equal(f.store.getTask(f.task.id).currentRunId, run.id);
    assert.equal(f.store.getLingThread(f.thread.id).activeRunId, run.id);
    assert.equal(f.store.getLingThread(f.thread.id).status, "running");
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
    assert.equal(f.store.getUserInputWait(f.thread.id, f.wait.checkpoint.requestId).status, "resuming");
    assert.ok(f.store.getUserInputContinuationBinding(f.thread.id, f.delivery.deliveryId));
    assert.equal(f.calls.length, 1);
  } finally {
    blockers.release();
  }
});

test("permanent startup authority loss settles Task and Thread without an ACK or automatic retry", async t => {
  const f = await fixture(t, "channel", {}, { storedTask: true });
  t.mock.method(f.store, "recoverUserInputContinuationPrestart", () => ({ status: "changed" }));
  assert.equal(await f.dispatch(), undefined);
  const run = f.store.getRun(f.delivery.successorRunId);
  assert.equal(run.status, "failed");
  assert.equal(f.store.getWorkUnit(run.workUnitId).status, "failed");
  assert.equal(f.store.getTask(f.task.id).status, "failed");
  assert.equal(f.store.getLingThread(f.thread.id).activeRunId, undefined);
  assert.equal(f.store.getLingThread(f.thread.id).status, "failed");
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "obsolete");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.wait.checkpoint.requestId).status, "cancelled");
  assert.equal(f.calls.length, 1);
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.calls.length, 1);
});
test("workflow startup failure releases only its fresh lease and settles the owned step", async t => {
  const f = await fixture(t, "channel", {}, { workflow: true, workflowPolicy: "fail_workflow" });
  t.mock.method(f.store, "recoverUserInputContinuationPrestart", () => ({ status: "changed" }));
  assert.equal(await f.dispatch(), undefined);
  const run = f.store.getRun(f.delivery.successorRunId), step = f.store.getChannelWorkflowStep(f.step.id);
  assert.equal(run.status, "failed");
  assert.equal(step.status, "failed");
  assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, "failed");
  assert.equal(f.store.getTask(f.task.id).status, "failed");
  const leases = f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: step.id });
  assert.equal(leases.find(lease => lease.id === step.metadata.startOwner.leaseId).status, "released");
  assert.equal(leases.find(lease => lease.id === f.workflowStartOwner.leaseId).releaseReason, "user_input_yielded");
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
});
for (const [policy, stepStatus, workflowStatus] of [
  [undefined, "blocked", "blocked"], ["block_for_user", "blocked", "blocked"],
  ["cancel_workflow", "cancelled", "cancelled"], ["skip_if_optional", "skipped", "succeeded"],
]) {
  test(`workflow answer startup failure respects ${policy ?? "default"} policy`, async t => {
    const f = await fixture(t, "channel", {}, { workflow: true, workflowPolicy: policy });
    t.mock.method(f.store, "recoverUserInputContinuationPrestart", () => ({ status: "changed" }));
    assert.equal(await f.dispatch(), undefined);
    assert.equal(f.store.getChannelWorkflowStep(f.step.id).status, stepStatus,
      JSON.stringify({ errors: f.errors, events: f.events }));
    assert.equal(f.store.getChannelWorkflow(f.workflow.id).status, workflowStatus);
    assert.equal(f.store.getTask(f.task.id).status, "failed");
    assert.equal(f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: f.step.id, status: "active" }).length, 0);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "obsolete");
    assert.equal(f.store.getUserInputWait(f.thread.id, f.wait.checkpoint.requestId).status, "cancelled");
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
    assert.equal(f.calls.length, 1);
  });
}
test("a changed channel authority at workflow ready settles the exact answer startup atomically", async t => {
  const f = await fixture(t, "channel", {}, { workflow: true });
  const admit = f.store.admitUserInputContinuation.bind(f.store);
  t.mock.method(f.store, "admitUserInputContinuation", (input, now) => {
    const binding = admit(input, now);
    f.store.updateChannel(f.channel.id, { allowedTools: [] }, clock());
    return binding;
  });
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getTask(f.task.id).status, "failed");
  assert.equal(f.store.getLingThread(f.thread.id).status, "failed");
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "obsolete");
  assert.equal(f.store.getUserInputWait(f.thread.id, f.wait.checkpoint.requestId).status, "cancelled");
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  assert.equal(f.store.listResourceLeases({ resourceType: "workflow_step", resourceKey: f.step.id, status: "active" }).length, 0);
});
test("human-origin media tools remain available after system dispatch without activating new tools", async t => {
  const f = await fixture(t, "normal", {}, { media: true });
  assert.ok(f.calls[0].tools.some(tool => tool.function.name === "image_generate"), "source actually has the media tool");
  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  assert.equal(f.store.getRun(id).status, "succeeded");
  assert.deepEqual(f.calls[1].tools, f.calls[0].tools);
});
test("a second system-dispatched answer retains the original human media scope", async t => {
  const f = await fixture(t, "normal", {}, { media: true }); f.askAgain = true;
  const first = await f.dispatch();
  assert.equal(f.store.getRun(first)?.status, "yielded", JSON.stringify(f.errors));
  f.answer("SECOND_ANSWER_MARKER");
  const second = await f.dispatch();
  assert.equal(f.store.getRun(second)?.status, "succeeded", JSON.stringify(f.errors));
  assert.deepEqual(f.calls[2].tools, f.calls[0].tools);
});
test("current media revocation rejects admission rather than restoring a frozen grant", async t => {
  const f = await fixture(t, "normal", {}, { media: true });
  f.store.updateProviderPreset(f.mediaPreset.id, { enabled: false }, clock());
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
  assert.equal(f.calls.length, 1);
});
test("current provider revocation fails before admission without mutating the waiting source", async t => {
  const f = await fixture(t);
  f.store.updateProviderPreset(f.preset.id, { enabled: false }, clock());
  const before = f.store.getWorkUnit(f.store.getRun(f.sourceId).workUnitId);
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
  assert.deepEqual(f.store.getWorkUnit(before.id), before);
});
test("read-only source intent is retained while the current workspace policy is recomputed", async t => {
  const f = await fixture(t, "normal", { workspaceAccessMode: "read_only", authorizationMode: "ask" });
  const id = await f.dispatch();
  assert.ok(id, JSON.stringify(f.errors));
  const policy = f.store.getRun(id).requestSnapshot.effectivePolicySnapshot;
  assert.equal(policy.workspaceAccessMode, "read_only");
  assert.equal(policy.toolDecisions.write, "deny");
  assert.deepEqual(policy.allowedWritePaths, []);
});
test("an old full-access confirmation is not a new continuation grant", async t => {
  const f = await fixture(t, "normal", { workspaceAccessMode: "full_access", authorizationMode: "always",
    permissionConfirmation: { mode: "full_access", confirmed: true, confirmedAt: clock(), reason: "Source only" } });
  const before = f.store.getWorkUnit(f.store.getRun(f.sourceId).workUnitId);
  assert.equal(await f.dispatch(), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getRun(f.delivery.successorRunId), undefined);
  assert.deepEqual(f.store.getWorkUnit(before.id), before, "pre-admission failure does not terminate the waiting source");
  assert.equal(f.errors.at(-1).error, "full_access_confirmation_required");
});
test("a second question is yielded and resumed through the same production Host path", async t => {
  const f = await fixture(t); f.askAgain = true;
  const first = await f.dispatch();
  assert.equal(f.store.getRun(first)?.status, "yielded", JSON.stringify(f.errors));
  f.answer("SECOND_ANSWER_MARKER");
  const second = await f.dispatch();
  assert.equal(f.store.getRun(second)?.status, "succeeded", JSON.stringify(f.errors));
  assert.equal(f.store.getRun(second).parentRunId, first);
  assert.equal(f.calls.length, 3);
  assert.match(JSON.stringify(f.calls[2].messages), /SECOND_ANSWER_MARKER/);
});

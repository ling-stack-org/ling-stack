import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { PiRunnerAdapter, PiRunnerYielded } from "@ling-stack/runner-pi";
import { getCurrentTools } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/index.js";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { createDetachedRunExecutionSink, executeRunRequest } from "../dist/features/runs/orchestrator.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { resolveConfig } from "../dist/config.js";
import { ensureRunCancelled } from "../dist/features/runs/cancellation.js";
import { RunControlService } from "../dist/run-control.js";

const requiredInput = Object.freeze({
  schemaVersion: 1,
  waitMode: "required",
  questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }],
});

async function productionFixture(t, makeAdapter, options = {}, requestOverrides = {}, runnerId = "runner_fixture", taskBoundSource = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-user-input-boundary-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const activeRuns = new ActiveRunRegistry();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd, harness: { toolBroker: { mode: "enforce" } } }));
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const store = stores.getStore(cwd);
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
    title: "Production boundary", objective: "Inspect the pause boundary." }, now);
  const payload = { body: "Inspect the pause boundary.", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] };
  let turn;
  if (taskBoundSource) {
    // Reviewer evidence requires a task-bound Turn. Use real Core APIs to
    // construct that source rather than weakening its lineage verifier.
    const source = store.createLingTurn({ threadId: thread.id, kind: "initial_request", taskId: "boundary-task",
      teammateId: "ling_agent", title: "Production boundary", userInstruction: payload.body,
      sourceItemId: "production-review-source", createdByActor: "local-user" }, now);
    const item = store.appendConversationItem({ id: "production-review-source", threadId: thread.id,
      turnId: source.id, kind: "user_message", actorType: "local_user", visibility: "thread_participants",
      payload, domainRefs: [], idempotencyKey: "boundary-turn" }, now);
    turn = { turnId: source.id, item };
  } else {
    turn = store.appendConversationUserTurn({ threadId: thread.id, teammateId: "ling_agent",
      title: "Production boundary", userInstruction: payload.body, idempotencyKey: "boundary-turn", payload }, now);
  }
  const runners = createRunnerRegistry([{ id: runnerId, aliases: runnerId === "pi" ? [] : ["pi"], displayName: "Boundary fixture",
    status: "enabled", adapter: makeAdapter({ supervisor, store, activeRuns, cwd }) }]);
  const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.turnId,
    sourceMessageId: turn.item.id, teammateId: "ling_agent",
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-no-network", reasoning: false },
    task: { id: "boundary-task", title: "Production boundary", prompt: "Inspect the pause boundary." },
    idempotencyKey: "boundary-run", createdByActor: "local-user", ...requestOverrides }, createDetachedRunExecutionSink(),
    runners, stores, activeRuns, supervisor, { resolve: () => undefined }, {}, options);
  assert.ok(runId);
  return { store, runId, activeRuns };
}

test("production file write binds and settles its actual Broker evidence before required input can yield", async t => {
  const admitted = [];
  const f = await productionFixture(t, ({ store }) => {
    store.updateApprovalPolicy({ toolDecisions: { write: "allow" }, allowedWritePaths: [store.paths.cwd] }, new Date().toISOString());
    const admit = store.admitHostOperation.bind(store);
    store.admitHostOperation = input => { admitted.push(structuredClone(input)); return admit(input); };
    return { async runTask(options) {
      const decision = await options.onApprovalRequired({ toolName: "write", toolCallId: "production-write",
        cwd: options.cwd, task: options.task, input: { path: "evidence.txt", content: "actual Host evidence\n" } });
      assert.equal(decision.handledResult?.isError, undefined, JSON.stringify(decision));
      assert.equal(await readFile(join(options.cwd, "evidence.txt"), "utf8"), "actual Host evidence\n");
      const receipt = await options.onUserInputRequest({ toolCallId: "after-file", input: requiredInput });
      throw new PiRunnerYielded(receipt, new Date().toISOString());
    } };
  }, { enableUserInputPause: true }, { tools: ["write"], authorizationMode: "always", workspaceAccessMode: "workspace_write" });
  assert.equal(f.store.getRun(f.runId).status, "yielded", f.store.getRun(f.runId).errorMessage);
  assert.equal(admitted.length, 1, "production effects must not drain an empty Host barrier");
  const operation = f.store.getHostOperation(admitted[0].operationId);
  assert.equal(operation.phase, "safe");
  assert.equal(operation.settlementKind, "file_completed");
  const execution = f.store.getHarnessToolExecution(operation.evidenceRef.id);
  assert.equal(execution.runId, f.runId);
  assert.equal(execution.toolCallId, "production-write");
  assert.equal(execution.state, "succeeded");
});

test("public execution keeps unfinished user-input runtime tools off by default", async t => {
  let callback;
  const f = await productionFixture(t, () => ({ async runTask(options) {
    callback = options.onUserInputRequest;
    return { taskId: options.task.id, messages: [], events: [] };
  } }));
  assert.equal(callback, undefined, "only trusted internal validation may expose the unfinished runtime tool");
  assert.equal(f.store.getRun(f.runId).status, "succeeded");
});

test("required input arriving during lock-screen await wins before a provider continuation", async t => {
  let receipt;
  let boundaryResult;
  const f = await productionFixture(t, ({ supervisor }) => ({ async runTask(options) {
    supervisor.updateLockedTaskContinuation({ desktopInstanceId: "boundary-test", leaseTtlMs: 60000,
      continueWhileLocked: false, locked: true });
    const pending = options.onTaskContinuationBoundary("before_provider_request");
    await Promise.resolve();
    receipt = await options.onUserInputRequest({ toolCallId: "ask-during-lock", input: requiredInput });
    supervisor.releaseLockedTaskContinuation("boundary-test");
    boundaryResult = await pending;
    throw new PiRunnerYielded(receipt, new Date().toISOString());
  } }), { enableUserInputPause: true });
  assert.deepEqual(boundaryResult, receipt, "a pre-await check cannot authorize a post-await provider request");
  assert.equal(f.store.getRun(f.runId).status, "yielded");
});

for (const selected of [false, true]) {
  test(`real Pi production keeps its frozen user-input tool surface: selected=${selected}`, async t => {
    let calls = 0;
    let transportTools;
    let wireTools;
    class Runner extends PiRunnerAdapter {
      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
          stream(model, context, { ...options, fetch: async (_url, request) => {
            calls++;
            transportTools = getCurrentTools(context.messages).map(tool => tool.name);
            wireTools = (JSON.parse(request.body).tools ?? []).map(tool => tool.function.name);
            const delta = selected
              ? { tool_calls: [{ index: 0, id: "real-ask", type: "function",
                  function: { name: "request_user_input", arguments: JSON.stringify(requiredInput) } }] }
              : { content: "Completed without a user-input tool." };
            return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
              + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: selected ? "tool_calls" : "stop" }] })}\n\n`
              + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
          } }) });
      }
    }
    const f = await productionFixture(t, () => new Runner(), { enableUserInputPause: selected });
    const run = f.store.getRun(f.runId);
    assert.equal(run.status, selected ? "yielded" : "succeeded", run.errorMessage);
    assert.equal(calls, 1, "actual SDK input must match before the first provider call");
    assert.deepEqual(wireTools, transportTools, "the final provider payload must keep the canonical SDK tool surface");
    assert.deepEqual(transportTools, run.requestSnapshot.runnerExecutionInput.preparedInput.tools.map(tool => tool.name),
      "the actual tool surface must exactly match the Host's frozen descriptors");
    assert.equal(transportTools.includes("request_user_input"), selected);
    assert.equal(run.requestSnapshot.runnerExecutionInput.preparedInput.tools.some(tool => tool.name === "request_user_input"), selected);
    assert.equal(f.store.listEvents(f.runId).some(event => event.type === "run_error"), false);
  });
}

test("production executeRunRequest consumes typed user-input yield without terminalizing the Run", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-user-input-production-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const activeRuns = new ActiveRunRegistry();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });

  const store = stores.getStore(cwd);
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
    title: "Production pause", objective: "Ask the user." }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, teammateId: "ling_agent",
    title: "Production pause", userInstruction: "Ask the user.", idempotencyKey: "production-pause-turn",
    payload: { body: "Ask the user.", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const observed = { events: [], yielded: [], terminals: [], errors: [] };
  const adapter = {
    async runTask(options) {
      const receipt = await options.onUserInputRequest({ toolCallId: "ask", input: requiredInput });
      assert.deepEqual(receipt, { kind: "user_input_required", requestId: receipt.requestId, requestVersion: 1 });
      throw new PiRunnerYielded(receipt, new Date().toISOString());
    },
  };
  const runners = createRunnerRegistry([{ id: "runner_fixture", aliases: ["pi"], displayName: "Pause fixture",
    status: "enabled", adapter }]);
  const sink = {
    ...createDetachedRunExecutionSink(),
    writeEvent: (type, event) => observed.events.push({ type, event }),
    writeError: (_status, body) => observed.errors.push(body),
  };
  const runId = await executeRunRequest({
    cwd,
    workspaceCwd: cwd,
    threadId: thread.id,
    turnId: turn.turnId,
    sourceMessageId: turn.item.id,
    teammateId: "ling_agent",
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1" },
    task: { id: "production-pause-task", title: "Production pause", prompt: "Ask the user." },
    idempotencyKey: "production-pause-run",
    createdByActor: "local-user",
  }, sink, runners, stores, activeRuns, supervisor, { resolve: () => undefined }, {} , {
    enableUserInputPause: true,
    afterRunYielded: (_run, wait) => { observed.yielded.push(wait); },
    afterRunTerminal: run => { observed.terminals.push(run.id); },
  });

  assert.ok(runId, JSON.stringify(observed.errors));
  const run = store.getRun(runId);
  assert.equal(run.status, "yielded");
  assert.equal(observed.errors.length, 0);
  assert.equal(observed.terminals.length, 0);
  assert.equal(observed.yielded.length, 1);
  assert.equal(observed.yielded[0].status, "waiting");
  assert.equal(store.getLingTurnForRun(runId).status, "waiting_for_input");
  assert.equal(store.getUserInputWait(thread.id, observed.yielded[0].checkpoint.requestId).status, "waiting");
  assert.equal(store.listEvents(runId).some(event => ["result", "run_end", "run_error"].includes(event.type)), false);
  assert.equal(activeRuns.get(runId), undefined);
});

test("production pause keeps the source owner when durable evidence is still unconfirmed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-user-input-blocked-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const activeRuns = new ActiveRunRegistry();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd }));
  t.after(async () => {
    supervisor.releaseAll();
    stores.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const store = stores.getStore(cwd);
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
    title: "Blocked pause", objective: "Keep the source owned." }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, teammateId: "ling_agent",
    title: "Blocked pause", userInstruction: "Keep the source owned.", idempotencyKey: "blocked-pause-turn",
    payload: { body: "Keep the source owned.", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const errors = [];
  const adapter = {
    async runTask(options) {
      const receipt = await options.onUserInputRequest({ toolCallId: "ask", input: requiredInput });
      options.onEvent({ type: "tool_start", toolCallId: "late-host", toolName: "read", args: { path: "late.txt" } });
      throw new PiRunnerYielded(receipt, new Date().toISOString());
    },
  };
  const runners = createRunnerRegistry([{ id: "runner_fixture", aliases: ["pi"], displayName: "Blocked pause fixture",
    status: "enabled", adapter }]);
  const sink = { ...createDetachedRunExecutionSink(), writeError: (_status, body) => errors.push(body) };
  const runId = await executeRunRequest({
    cwd,
    workspaceCwd: cwd,
    threadId: thread.id,
    turnId: turn.turnId,
    sourceMessageId: turn.item.id,
    teammateId: "ling_agent",
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1" },
    task: { id: "blocked-pause-task", title: "Blocked pause", prompt: "Keep the source owned." },
    idempotencyKey: "blocked-pause-run",
    createdByActor: "local-user",
  }, sink, runners, stores, activeRuns, supervisor, { resolve: () => undefined }, {}, { enableUserInputPause: true });

  assert.ok(runId, JSON.stringify(errors));
  assert.deepEqual(errors, []);
  assert.equal(store.getRun(runId).status, "running");
  assert.equal(store.getWorkUnit(store.getRun(runId).workUnitId).status, "running");
  await activeRuns.waitForIdle(100);
  const sourceAttempt = store.getWorkUnitAttempt(store.getWorkUnit(store.getRun(runId).workUnitId).activeAttemptId);
  assert.equal(activeRuns.get(runId), undefined, "SDK and local callbacks have stopped; do not retain a phantom live execution");
  assert.equal(activeRuns.getRetainedAttempt(runId, sourceAttempt.id).localDrainStatus, "drained");
  assert.equal(store.isCurrentRunExecutionOwner(runId, { workUnitId: sourceAttempt.workUnitId, attemptId: sourceAttempt.id,
    runtimeInstanceId: sourceAttempt.runtimeInstanceId, fencingToken: sourceAttempt.fencingToken }), true,
  "local cleanup cannot release durable execution authority");
  assert.equal(store.listEvents(runId).some(event => ["run_error", "result", "run_end"].includes(event.type)), false);
});

test("generic cancel cannot release a required source that lacks a safe waiting checkpoint", async t => {
  const f = await productionFixture(t, () => ({ async runTask(options) {
    const receipt = await options.onUserInputRequest({ toolCallId: "blocked-cancel", input: requiredInput });
    options.onEvent({ type: "tool_start", toolCallId: "unconfirmed-read", toolName: "read", args: { path: "input.txt" } });
    throw new PiRunnerYielded(receipt, new Date().toISOString());
  } }), { enableUserInputPause: true });
  const before = f.store.countEvents(f.runId);
  const run = f.store.getRun(f.runId);
  const work = f.store.getWorkUnit(run.workUnitId);
  assert.throws(() => ensureRunCancelled({ store: f.store, runId: run.id, taskId: run.taskId,
    reason: "user_requested", active: false }), error => error.code === "run_execution_recovery_blocked");
  assert.equal(f.store.getRun(f.runId).status, "running");
  assert.equal(f.store.getWorkUnit(work.id).activeAttemptId, work.activeAttemptId);
  assert.equal(f.store.countEvents(f.runId), before, "no cancelled event, terminal summary or resource release");
});

test("shutdown during typed yield observation retains the still-current durable source", async t => {
  const f = await productionFixture(t, ({ activeRuns }) => ({ async runTask(options) {
    const receipt = await options.onUserInputRequest({ toolCallId: "shutdown-at-yield", input: requiredInput });
    activeRuns.suspendAll("daemon_restart");
    throw new PiRunnerYielded(receipt, new Date().toISOString());
  } }), { enableUserInputPause: true });
  await f.activeRuns.waitForIdle(100);
  const run = f.store.getRun(f.runId);
  const work = f.store.getWorkUnit(run.workUnitId);
  assert.equal(run.status, "running");
  assert.equal(f.activeRuns.getRetainedAttempt(f.runId, work.activeAttemptId)?.localDrainStatus, "drained",
    "an abort intent is not owner replacement or permission for generic lease cleanup");
  const attempt = f.store.getWorkUnitAttempt(work.activeAttemptId);
  assert.equal(f.store.isCurrentRunExecutionOwner(run.id, { workUnitId: work.id, attemptId: attempt.id,
    runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken }), true);
});

test("production shutdown waits for the actual reviewer Runner after its manual fallback", { timeout: 8000 }, async t => {
  let finishReviewer, reviewerStarted, activeRegistry, sourceHandle, actualReviewerStarted = false;
  const underlyingReviewer = new Promise(resolve => { finishReviewer = resolve; });
  const dispatchedReviewer = new Promise(resolve => { reviewerStarted = resolve; });
  let approvalCompletion;
  t.after(async () => {
    sourceHandle?.abortController.abort();
    finishReviewer({ messages: [{ role: "assistant", content: '{"schemaVersion":1,"decision":"manual","reason":"Needs user decision."}' }] });
    await approvalCompletion;
    await activeRegistry?.waitForIdle(2000);
  });
  const f = await productionFixture(t, ({ store, activeRuns }) => {
    activeRegistry = activeRuns;
    store.updateApprovalPolicy({ toolDecisions: { bash: "ask" }, allowedWritePaths: [store.paths.cwd] }, new Date().toISOString());
    return { async runTask(options) {
      if (options.task.title === "Automatic approval review") {
        actualReviewerStarted = true;
        reviewerStarted();
        return await underlyingReviewer;
      }
      assert.equal(store.getLingTurnForRun(options.runId).taskId, options.task.id);
      sourceHandle = activeRuns.get(options.runId);
      // workspace_write intentionally permits in-scope file writes. Use the
      // same asked command surface as the existing production smart-review
      // tests, and interrupt during review, before any command is launched.
      approvalCompletion = options.onApprovalRequired({ toolName: "bash", toolCallId: "reviewer-production-command",
        cwd: options.cwd, task: options.task, input: { command: "echo reviewer-boundary" } })
        .catch(error => error);
      let dispatchDeadline;
      try {
        await Promise.race([dispatchedReviewer, new Promise((_, reject) => {
          dispatchDeadline = setTimeout(() => reject(new Error(`Actual reviewer was not dispatched: ${JSON.stringify({
            runStatus: store.getRun(options.runId)?.status,
            effectivePolicy: store.getRun(options.runId)?.requestSnapshot.effectivePolicySnapshot,
            eventTypes: store.listEvents(options.runId).map(event => event.type),
          })}`)), 1000);
        })]);
      } finally {
        clearTimeout(dispatchDeadline);
      }
      activeRuns.suspendAll("daemon_restart");
      await approvalCompletion;
      options.signal.throwIfAborted();
      assert.fail("shutdown must interrupt the source Runner");
    } };
  }, { enableUserInputPause: true }, { tools: ["bash"], authorizationMode: "smart", workspaceAccessMode: "workspace_write" }, "pi", true);
  const run = f.store.getRun(f.runId);
  assert.equal(actualReviewerStarted, true, run.errorMessage);
  await assert.rejects(f.activeRuns.waitForIdle(0), /cleanup is still pending/);
  const before = { run, events: f.store.listEvents(run.id) };
  finishReviewer({ messages: [{ role: "assistant", content: '{"schemaVersion":1,"decision":"manual","reason":"Needs user decision."}' }] });
  await approvalCompletion;
  await f.activeRuns.waitForIdle(1000);
  assert.deepEqual({ run: f.store.getRun(run.id), events: f.store.listEvents(run.id) }, before,
    "late reviewer settlement is local cleanup only; it cannot apply a new verdict or mutate the old source");
});

for (const entry of ["cancelRun", "cancelRunForRedirect", "cancelWorkUnit"]) {
  test(`required pause blocks independent RunControlService ${entry} without side effects`, async t => {
    const f = await productionFixture(t, () => ({ async runTask(options) {
      const receipt = await options.onUserInputRequest({ toolCallId: "blocked-service", input: requiredInput });
      options.onEvent({ type: "tool_start", toolCallId: "unknown-service-read", toolName: "read", args: { path: "input.txt" } });
      throw new PiRunnerYielded(receipt, new Date().toISOString());
    } }), { enableUserInputPause: true });
    const service = new RunControlService();
    const run = f.store.getRun(f.runId), workUnit = f.store.getWorkUnit(run.workUnitId);
    const before = f.store.countEvents(run.id);
    let releases = 0;
    f.store.releaseResourceLeasesForAttempt = () => { releases++; };
    f.store.releaseRuntimeSemaphoreSlotsForAttempt = () => { releases++; };
    const activeRun = { abortController: new AbortController(), streamEnvelope() {} };
    const call = () => entry === "cancelRun"
      ? service.cancelRun({ store: f.store, runId: run.id, reason: "cancel", activeRun })
      : entry === "cancelRunForRedirect" ? service.cancelRunForRedirect({ store: f.store, run, activeRun })
        : service.cancelWorkUnit({ store: f.store, workUnit, reason: "cancel", activeRun });
    assert.throws(call, error => error.statusCode === 409 && error.code === "run_execution_recovery_blocked");
    assert.equal(releases, 0);
    assert.equal(activeRun.abortController.signal.aborted, false);
    assert.equal(f.store.countEvents(run.id), before);
    assert.equal(f.store.getRun(run.id).summaryPath, run.summaryPath);
    assert.equal(f.store.getRun(run.id).status, "running");
  });
}

test("cancelling source conflicts map to a fail-closed domain response, never a raw 500", async t => {
  let observed;
  const f = await productionFixture(t, ({ store }) => ({ async runTask(options) {
    const run = store.getRun(options.runId);
    const work = store.getWorkUnit(run.workUnitId), attempt = store.getWorkUnitAttempt(work.activeAttemptId);
    const now = new Date().toISOString();
    store.updateWorkUnitAttemptStatus({ attemptId: attempt.id, workUnitId: work.id,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
      status: "cancelling", now, abortRequestedAt: now });
    try { ensureRunCancelled({ store, runId: run.id, taskId: run.taskId, reason: "cancel", active: true }); }
    catch (error) { observed = error; }
    return { taskId: options.task.id, events: [], messages: [] };
  } }));
  assert.ok(f.runId);
  assert.equal(observed?.statusCode, 409);
  assert.equal(observed?.code, "run_execution_recovery_blocked");
});

test("missing operation admission cannot keep the production yield observer alive forever", { timeout: 4000 }, async t => {
  const f = await productionFixture(t, ({ store }) => {
    store.admitHostOperation = () => { throw new Error("admission storage unavailable"); };
    return { async runTask(options) {
      await assert.rejects(async () => options.onApprovalRequired({ toolName: "write", toolCallId: "missing-admission",
        cwd: options.cwd, task: options.task, input: { path: "must-not-write.txt", content: "not admitted" } }), /storage unavailable/);
      const receipt = await options.onUserInputRequest({ toolCallId: "after-admission-failure", input: requiredInput });
      throw new PiRunnerYielded(receipt, new Date().toISOString());
    } };
  }, { enableUserInputPause: true });
  assert.equal(f.store.getRun(f.runId).status, "running");
  await f.activeRuns.waitForIdle(100);
  const attemptId = f.store.getWorkUnit(f.store.getRun(f.runId).workUnitId).activeAttemptId;
  assert.equal(f.activeRuns.getRetainedAttempt(f.runId, attemptId).localDrainStatus, "drained");
  assert.equal(f.store.listEvents(f.runId).some(event => ["result", "run_error", "run_end"].includes(event.type)), false);
});

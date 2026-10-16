import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, toRuntimeAttemptFence } from "@ling-stack/core";
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
import { readWorkUnitStopEvidence } from "../dist/runtime/work-unit-stop-evidence.js";
import { maybeStartNextRunInterventionContinuation } from "../dist/features/runs/interventions.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";
import { continuationSourceReady } from "../dist/runtime/continuation-source-barrier.js";

const requiredInput = Object.freeze({
  schemaVersion: 1,
  waitMode: "required",
  questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }],
});

async function productionFixture(t, makeAdapter, options = {}, requestOverrides = {}, runnerId = "runner_fixture", taskBoundSource = false, harnessMode = "enforce") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-user-input-boundary-"));
  const stores = new RunStoreRegistry(createSqliteRunStore);
  const activeRuns = new ActiveRunRegistry();
  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: cwd, harness: { toolBroker: { mode: harnessMode } } }));
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
    status: "enabled", adapter: makeAdapter({ supervisor, store, activeRuns, cwd, stores }) }]);
  const overrides = typeof requestOverrides === "function" ? requestOverrides(store) : requestOverrides;
  const runId = await executeRunRequest({ cwd, workspaceCwd: cwd, threadId: thread.id, turnId: turn.turnId,
    sourceMessageId: turn.item.id, teammateId: "ling_agent",
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture-no-network", reasoning: false },
    task: { id: "boundary-task", title: "Production boundary", prompt: "Inspect the pause boundary." },
    idempotencyKey: "boundary-run", createdByActor: "local-user", ...overrides }, createDetachedRunExecutionSink(),
    runners, stores, activeRuns, supervisor, { resolve: () => undefined }, {}, options);
  assert.ok(runId);
  return { store, runId, activeRuns };
}

test("runtime idle waits for terminal callbacks after the actual SDK execution drains", { timeout: 10000 }, async t => {
  let started, release, activeRegistry;
  const callbackStarted = new Promise(resolve => { started = resolve; });
  const callbackRelease = new Promise(resolve => { release = resolve; });
  let callbackFinished = false;
  const execution = productionFixture(t, ({ activeRuns }) => {
    activeRegistry = activeRuns;
    return new ToolFreePiRunner();
  }, { afterRunTerminal: async () => {
    started();
    await callbackRelease;
    callbackFinished = true;
  } });
  try {
    await callbackStarted;
    assert.equal(callbackFinished, false);
    await assert.rejects(activeRegistry.waitForIdle(0), /cleanup is still pending/);
  } finally {
    release();
    await execution;
  }
  await activeRegistry.waitForIdle(1000);
  assert.equal(callbackFinished, true);
});

for (const fails of [false, true]) {
  test(`an incomplete Host inventory cannot authorize continuation before or after reopen: failed=${fails}`, async t => {
    const f = await productionFixture(t, () => ({ async runTask(options) {
      // This adapter supplies no sealed SDK inventory. An empty Host group
      // cannot prove that the adapter performed no other external work.
      if (fails) throw new Error("Controlled adapter failure without complete effect coverage");
      return { taskId: options.task.id, messages: [], events: [] };
    } }));
    await f.activeRuns.waitForIdle();
    const run = f.store.getRun(f.runId), unit = f.store.getWorkUnit(run.workUnitId);
    const attempts = f.store.listWorkUnitAttempts(unit.id), attempt = attempts[0];
    assert.equal(run.status, fails ? "failed" : "succeeded");
    assert.notEqual(f.store.getHostAttemptCompletion({ runId: run.id, ...toRuntimeAttemptFence(attempt) }).effectCoverage, true);
    const reopened = createSqliteRunStore(run.cwd);
    try {
      for (const [store, registry] of [[f.store, f.activeRuns], [reopened, new ActiveRunRegistry()]]) {
        const evidence = readWorkUnitStopEvidence(store, unit, attempts, registry).attempts[0];
        assert.equal(evidence.localExecution, "drained");
        assert.equal(evidence.effects, "unverified", "a partial executor inventory is not complete effect coverage");
        assert.equal(continuationSourceReady(store, unit, registry, "uncovered-followup", () => assert.fail("no continuation")), false);
      }
    } finally { reopened.close(); }
  });
}

for (const mode of ["off", "shadow", "enforce"]) for (const toolName of ["read", "ls"]) {
  test(`actual built-in ${toolName} completion releases cancelled resources after reopen in ${mode}`, { timeout: 10000 }, async t => {
    let readCompleted = false;
    const f = await productionFixture(t, ({ store, activeRuns, cwd }) => {
      writeFileSync(join(cwd, "input.txt"), "Real read-only executor evidence.\n");
      let requests = 0;
      return new class extends PiRunnerAdapter {
        registerCustomProviderIfNeeded(runtime, provider) {
          super.registerCustomProviderIfNeeded(runtime, provider);
          runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
            stream(model, context, { ...options, fetch: async () => {
              const delta = requests++ === 0 ? { tool_calls: [{ index: 0, id: "actual_read", type: "function",
                function: { name: toolName, arguments: JSON.stringify({ path: toolName === "read" ? "input.txt" : "." }) } }] }
                : { content: "Must not continue after cancellation." };
              return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
                + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                { headers: { "content-type": "text/event-stream" } });
            } }) });
        }
        runTask(options) {
          return super.runTask({ ...options, onEvent: event => {
            options.onEvent?.(event);
            if (event.type !== "tool_end" || event.toolName !== toolName || readCompleted) return;
            assert.notEqual(event.isError, true);
            readCompleted = true;
            new RunControlService().cancelRun({ store, runId: options.runId, reason: "user_requested",
              activeRun: activeRuns.get(options.runId) });
          } });
        }
      }();
    }, {}, { tools: [toolName] }, "pi", false, mode);
    await f.activeRuns.waitForIdle();
    const run = f.store.getRun(f.runId), unit = f.store.getWorkUnit(run.workUnitId);
    assert.equal(readCompleted, true, run.errorMessage);
    assert.equal(run.status, "cancelled");
    const reopened = createSqliteRunStore(run.cwd);
    try {
      const evidence = readWorkUnitStopEvidence(reopened, unit, reopened.listWorkUnitAttempts(unit.id), new ActiveRunRegistry());
      assert.equal(evidence.attempts[0].localExecution, "drained");
      assert.equal(evidence.attempts[0].effects, "settled");
      assert.equal(reopened.listResourceLeases({ status: "active", workUnitId: unit.id }).length, 0);
      assert.equal(reopened.listRuntimeSemaphoreSlots({ status: "active", workUnitId: unit.id }).length, 0);
    } finally { reopened.close(); }
  });
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

for (const writesFile of [false, true]) {
test(`enforced-Broker production tracks actual Host effects without exposing user input: file=${writesFile}`, async t => {
  const admitted = [];
  const f = await productionFixture(t, ({ store }) => {
    store.updateApprovalPolicy({ toolDecisions: { write: "allow" }, allowedWritePaths: [store.paths.cwd] }, new Date().toISOString());
    const admit = store.admitHostOperation.bind(store);
    store.admitHostOperation = input => { admitted.push(structuredClone(input)); return admit(input); };
    return { async runTask(options) {
      assert.equal(options.onUserInputRequest, undefined);
      if (writesFile) {
        const decision = await options.onApprovalRequired({ toolName: "write", toolCallId: "default-file",
          cwd: options.cwd, task: options.task, input: { path: "default.txt", content: "tracked default effect\n" } });
        assert.equal(decision.handledResult?.isError, undefined, JSON.stringify(decision));
        assert.equal(await readFile(join(options.cwd, "default.txt"), "utf8"), "tracked default effect\n");
      }
      return { taskId: options.task.id, messages: [], events: [] };
    } };
  }, {}, { tools: [writesFile ? "write" : "read"], authorizationMode: "always", workspaceAccessMode: "workspace_write" });
  const run = f.store.getRun(f.runId);
  assert.equal(run.status, "succeeded", run.errorMessage);
  await f.activeRuns.waitForIdle();
  assert.equal(admitted.length, writesFile ? 1 : 0, "the journaled path must enroll real Host effects");
  if (writesFile) {
    const operation = f.store.getHostOperation(admitted[0].operationId);
    assert.equal(operation.phase, "safe");
    assert.equal(operation.settlementKind, "file_completed");
  }
  const attempt = f.store.listWorkUnitAttempts(run.workUnitId)[0];
  assert.deepEqual(f.activeRuns.observeAttemptStop({ runId: run.id, ...toRuntimeAttemptFence(attempt) }),
    { localExecution: "drained", effects: "settled" });
});
}

for (const toolBroker of ["off", "shadow"]) {
test(`Host stop tracking preserves the existing ${toolBroker} file path`, async t => {
  let admissions = 0;
  const f = await productionFixture(t, ({ store }) => {
    store.updateApprovalPolicy({ toolDecisions: { write: "allow" }, allowedWritePaths: [store.paths.cwd] }, new Date().toISOString());
    const admit = store.admitHostOperation.bind(store);
    store.admitHostOperation = input => { admissions++; return admit(input); };
    return { async runTask(options) {
      assert.equal(options.onUserInputRequest, undefined);
      const decision = await options.onApprovalRequired({ toolName: "write", toolCallId: "legacy-file",
        cwd: options.cwd, task: options.task, input: { path: "legacy.txt", content: "preserved effect\n" } });
      assert.equal(decision.handledResult?.isError, undefined, JSON.stringify(decision));
      assert.equal(await readFile(join(options.cwd, "legacy.txt"), "utf8"), "preserved effect\n");
      return { taskId: options.task.id, messages: [], events: [] };
    } };
  }, {}, { tools: ["write"], authorizationMode: "always", workspaceAccessMode: "workspace_write",
    harnessFeatureSnapshot: { schemaVersion: 1, continuations: "off", toolBroker, evaluations: "off",
      evaluationModelGate: "shadow", delegations: "off", delegationMaxDepth: 3 } });
  const run = f.store.getRun(f.runId);
  assert.equal(run.status, "succeeded", run.errorMessage);
  await f.activeRuns.waitForIdle();
  assert.equal(admissions, 0, "stop observation must not turn off/shadow into enforce");
  const attempt = f.store.listWorkUnitAttempts(run.workUnitId)[0];
  assert.deepEqual(f.activeRuns.observeAttemptStop({ runId: run.id, ...toRuntimeAttemptFence(attempt) }),
    { localExecution: "drained", effects: "unverified" });
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  assert.ok(f.store.getHostAttemptCompletion(source)?.drainedAt, "default paths must persist actual local completion");
  const recovered = readWorkUnitStopEvidence(f.store, f.store.getWorkUnit(run.workUnitId), [attempt], new ActiveRunRegistry());
  assert.equal(recovered.attempts[0].localExecution, "drained");
  assert.equal(recovered.attempts[0].effects, "unverified");
});
}

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
    if (!selected) {
      await f.activeRuns.waitForIdle();
      const unit = f.store.getWorkUnit(run.workUnitId);
      const attempts = f.store.listWorkUnitAttempts(unit.id);
      const evidence = readWorkUnitStopEvidence(f.store, unit, attempts, new ActiveRunRegistry());
      assert.equal(evidence.attempts[0].localExecution, "drained");
      assert.equal(evidence.attempts[0].effects, "settled", "actual SDK tool-free execution needs affirmative restart evidence");
    }
  });
}

for (const toolBroker of ["off", "shadow", "enforce"]) {
  test(`real tool-free cancellation releases its own resources and recovers after restart: ${toolBroker}`, async t => {
    let cancelled = false;
    const f = await productionFixture(t, ({ store, activeRuns }) => new class extends PiRunnerAdapter {
      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
          stream(model, context, { ...options, fetch: async () => new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"Partial output kept."},"finish_reason":null}]}\n\n'
            + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } }) }) });
      }
      runTask(options) {
        return super.runTask({ ...options, onEvent: event => {
          options.onEvent?.(event);
          if (event.type !== "message_end" || event.role !== "assistant" || cancelled) return;
          cancelled = true;
          const run = store.getRun(options.runId);
          new RunControlService().cancelRun({ store, runId: run.id, reason: "user_requested", activeRun: activeRuns.get(run.id) });
          assert.ok(store.listRuntimeSemaphoreSlots({ status: "active", workUnitId: run.workUnitId }).length,
            "the cancellation event cannot release a still-running SDK lifetime");
        } });
      }
    }(), {}, { harnessFeatureSnapshot: { schemaVersion: 1, continuations: "off", toolBroker, evaluations: "off",
      evaluationModelGate: "shadow", delegations: "off", delegationMaxDepth: 3 } });
    const run = f.store.getRun(f.runId);
    assert.equal(cancelled, true);
    assert.equal(run.status, "cancelled", run.errorMessage);
    await f.activeRuns.waitForIdle();
    const unit = f.store.getWorkUnit(run.workUnitId), attempts = f.store.listWorkUnitAttempts(unit.id);
    assert.ok(f.store.listEvents(run.id).some(event => event.type === "message_end"));
    const evidence = readWorkUnitStopEvidence(f.store, unit, attempts, new ActiveRunRegistry());
    assert.equal(evidence.attempts[0].localExecution, "drained");
    assert.equal(evidence.attempts[0].effects, "settled");
    assert.equal(f.store.listResourceLeases({ status: "active", workUnitId: unit.id }).length, 0);
    assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active", workUnitId: unit.id }).length, 0);
  });
}

test("real SDK cancellation after a settled file mutation releases resources and recovers its effect proof", async t => {
  let cancelled = false, writes = 0;
  const f = await productionFixture(t, ({ store, activeRuns }) => {
    store.updateApprovalPolicy({ toolDecisions: { write: "allow" }, allowedWritePaths: [store.paths.cwd] }, new Date().toISOString());
    return new class extends PiRunnerAdapter {
      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
          stream(model, context, { ...options, fetch: async () => {
            const delta = writes++ === 0 ? { tool_calls: [{ index: 0, id: "actual_write", type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: "completed.txt", content: "original effect\n" }) } }] }
              : { content: "Original file effect completed." };
            return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
              + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } });
          } }) });
      }
      runTask(options) {
        return super.runTask({ ...options, onEvent: event => {
          options.onEvent?.(event);
          if (event.type !== "tool_end" || cancelled) return;
          cancelled = true;
          new RunControlService().cancelRun({ store, runId: options.runId, reason: "user_requested",
            activeRun: activeRuns.get(options.runId) });
        } });
      }
    }();
  }, {}, { tools: ["write"], authorizationMode: "always", workspaceAccessMode: "workspace_write" });
  await f.activeRuns.waitForIdle();
  const run = f.store.getRun(f.runId), unit = f.store.getWorkUnit(run.workUnitId);
  assert.equal(cancelled, true, run.errorMessage);
  assert.equal(run.status, "cancelled", run.errorMessage);
  assert.equal(await readFile(join(run.cwd, "completed.txt"), "utf8"), "original effect\n");
  const evidence = readWorkUnitStopEvidence(f.store, unit, f.store.listWorkUnitAttempts(unit.id), new ActiveRunRegistry());
  assert.equal(evidence.attempts[0].localExecution, "drained");
  assert.equal(evidence.attempts[0].effects, "settled");
  assert.equal(f.store.listResourceLeases({ status: "active", workUnitId: unit.id }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active", workUnitId: unit.id }).length, 0);
});

test("actual SDK queued continuations wait for each predecessor's write lease and preserve root lineage", { timeout: 12000 }, async t => {
  let context, runner, starts = 0, sourceUnitId, previousUnitId;
  const interventionIds = [];
  class Runner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", apiKey: "fixture-no-network", streamSimple: (model, messages, options) =>
        stream(model, messages, { ...options, fetch: async () => new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"Owned completion."},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } }) }) });
    }
    runTask(options) {
      starts++;
      const run = context.store.getRun(options.runId);
      if (starts === 1) {
        sourceUnitId = run.workUnitId;
        assert.ok(context.store.listResourceLeases({ workUnitId: sourceUnitId, status: "active" }).length);
        const unit = context.store.getWorkUnit(sourceUnitId);
        for (let index = 0; index < 2; index++) interventionIds.push(context.store.createRunIntervention({ sourceRunId: run.id,
          sourceWorkUnitId: sourceUnitId, sourceAttemptId: unit.activeAttemptId, mode: "queue_followup",
          instruction: `Continue after predecessor ${index} is drained.`, idempotencyKey: `real-sdk-followup-${index}`, requestedBy: "local-user",
        }, new Date().toISOString()).id);
      } else {
        assert.equal(context.store.listResourceLeases({ workUnitId: previousUnitId, status: "active" }).length, 0);
      }
      previousUnitId = run.workUnitId;
      return super.runTask(options);
    }
  }
  const f = await productionFixture(t, ctx => { context = ctx; runner = new Runner(); return runner; }, {
    afterRunTerminal: terminalRun => maybeStartNextRunInterventionContinuation({
      ...context, terminalRun, sourceRunId: terminalRun.parentRunId ?? terminalRun.id,
      runnerRegistry: createRunnerRegistry([{ id: "pi", aliases: [], displayName: "Actual SDK", status: "enabled", adapter: runner }]),
      storeRegistry: context.stores, runtimeSupervisor: context.supervisor, secretResolver: { resolve: () => undefined },
      mcpBroker: {},
    }),
  }, store => {
    const preset = store.createProviderPreset({ kind: "openai-compatible", displayName: "Local SDK fixture", providerId: "fixture",
      model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", authHeader: false,
      reasoning: false, capabilities: ["chat"], enabled: true }, new Date().toISOString());
    store.recordProviderCheckResult(preset.id, { ok: true, code: "ready", message: "Local no-network fixture", checkedAt: new Date().toISOString() });
    return { provider: undefined, providerPresetId: preset.id, tools: ["write"], authorizationMode: "always", workspaceAccessMode: "workspace_write" };
  }, "pi");
  await f.activeRuns.waitForIdle(8000);
  const interventions = interventionIds.map(id => f.store.getRunIntervention(id));
  assert.equal(starts, 3, JSON.stringify(interventions));
  for (const intervention of interventions) {
    assert.ok(intervention.continuationRunId);
    const successor = f.store.getRun(intervention.continuationRunId);
    assert.equal(successor.parentRunId, f.runId);
    assert.equal(successor.status, "succeeded", successor.errorMessage);
    assert.notEqual(successor.workUnitId, sourceUnitId);
  }
  assert.equal(f.store.listResourceLeases({ status: "active" }).length, 0);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0);
});

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
  await activeRuns.waitForIdle(3000);
  assert.equal(store.listResourceLeases({ status: "active" }).length, 0, "a verified input yield releases its original leases");
  assert.equal(store.listRuntimeSemaphoreSlots({ status: "active" }).length, 0, "a verified input yield releases its original runner capacity");
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

for (const enableUserInputPause of [false, true]) {
test(`production shutdown waits for the actual reviewer Runner after its manual fallback: user-input=${enableUserInputPause}`, { timeout: 8000 }, async t => {
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
  }, { enableUserInputPause }, { tools: ["bash"], authorizationMode: "smart", workspaceAccessMode: "workspace_write" }, "pi", true);
  const run = f.store.getRun(f.runId);
  assert.equal(actualReviewerStarted, true, run.errorMessage);
  await assert.rejects(f.activeRuns.waitForIdle(0), /cleanup is still pending/);
  const originalAttempt = f.store.listWorkUnitAttempts(run.workUnitId)[0];
  const originalSource = { runId: run.id, ...toRuntimeAttemptFence(originalAttempt) };
  assert.equal(f.store.getHostAttemptCompletion(originalSource)?.drainedAt, undefined,
    "the main Runner exiting cannot persist drain while an actual reviewer still runs");
  assert.ok(f.store.listRuntimeSemaphoreSlots({ status: "active", workUnitId: run.workUnitId }).length,
    "main shutdown must retain original runtime resources while the reviewer is still executing");
  const before = { run, events: f.store.listEvents(run.id) };
  finishReviewer({ messages: [{ role: "assistant", content: '{"schemaVersion":1,"decision":"manual","reason":"Needs user decision."}' }] });
  await approvalCompletion;
  await f.activeRuns.waitForIdle(1000);
  assert.ok(f.store.getHostAttemptCompletion(originalSource)?.drainedAt);
  assert.equal(f.store.listRuntimeSemaphoreSlots({ status: "active", workUnitId: run.workUnitId }).length, 0);
  assert.deepEqual({ run: f.store.getRun(run.id), events: f.store.listEvents(run.id) }, before,
    "late reviewer settlement is local cleanup only; it cannot apply a new verdict or mutate the old source");
});
}

for (const phase of ["INSERT", "UPDATE"]) {
test(`completion journal ${phase} failure preserves off execution without inventing restart proof`, async t => {
  const f = await productionFixture(t, ({ store }) => {
    store.updateApprovalPolicy({ toolDecisions: { write: "allow" }, allowedWritePaths: [store.paths.cwd] }, new Date().toISOString());
    store.database.exec(`CREATE TRIGGER fail_host_completion BEFORE ${phase} ON host_attempt_completions
      BEGIN SELECT RAISE(ABORT,'controlled_journal_failure'); END`);
    return { async runTask(options) {
      const decision = await options.onApprovalRequired({ toolName: "write", toolCallId: "off-journal-failure",
        cwd: options.cwd, task: options.task, input: { path: "still-executed.txt", content: "preserved off execution\n" } });
      assert.equal(decision.handledResult?.isError, undefined, JSON.stringify(decision));
      assert.equal(await readFile(join(options.cwd, "still-executed.txt"), "utf8"), "preserved off execution\n");
      return { taskId: options.task.id, messages: [], events: [] };
    } };
  }, {}, { tools: ["write"], authorizationMode: "always", workspaceAccessMode: "workspace_write",
    harnessFeatureSnapshot: { schemaVersion: 1, continuations: "off", toolBroker: "off", evaluations: "off",
      evaluationModelGate: "shadow", delegations: "off", delegationMaxDepth: 3 } });
  const run = f.store.getRun(f.runId);
  assert.equal(run.status, "succeeded", run.errorMessage);
  await f.activeRuns.waitForIdle();
  const attempt = f.store.listWorkUnitAttempts(run.workUnitId)[0];
  const source = { runId: run.id, ...toRuntimeAttemptFence(attempt) };
  assert.equal(f.store.getHostAttemptCompletion(source)?.drainedAt, undefined);
  const recovered = readWorkUnitStopEvidence(f.store, f.store.getWorkUnit(run.workUnitId), [attempt], new ActiveRunRegistry());
  assert.equal(recovered.attempts[0].localExecution, "unverified");
  assert.equal(recovered.attempts[0].effects, "unverified");
});
}

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

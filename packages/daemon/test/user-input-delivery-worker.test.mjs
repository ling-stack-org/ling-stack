import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { PiRunnerAdapter } from "../../runner-pi/dist/index.js";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../core/dist/index.js";
import {
  acceptedAt,
  claimedAt,
  now,
  userInputTranscriptFixture,
} from "../../core/test/support/user-input-transcript-fixture.mjs";
import { createDaemonServer } from "../dist/index.js";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";
import { UserInputDeliveryWorkerRegistry } from "../dist/features/runs/user-input-delivery-worker.js";
import { resolveConfig } from "../dist/config.js";
import { RuntimeSupervisor } from "../dist/runtime/supervisor.js";
import { prepareFixtureTaskInput } from "./support/prepared-input-fixture.mjs";

const recoveredAt = "2026-09-07T00:00:05.000Z";

async function fixture(t, answerText = "深色", transcriptOptions = undefined) {
  const f = await userInputTranscriptFixture(t, { ...transcriptOptions, runnerId: "pi" });
  f.sourceTask = {
    id: f.run.taskId,
    title: "Continue fixture",
    prompt: "Preserve the existing project.",
    ...(f.channel ? { channelId: f.channel.id } : {}),
  };
  f.sourceProvider = {
    provider: "fixture",
    model: "fixture",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    authHeader: false,
    reasoning: false,
  };
  const sourceOptions = {
    cwd: f.cwd,
    task: f.sourceTask,
    provider: f.sourceProvider,
    tools: ["read", "write"],
    initialToolSurface: { userInput: true },
  };
  const preparedInput = await prepareFixtureTaskInput(sourceOptions);
  const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: f.attempt.effectiveRunnerId, options: sourceOptions, preparedInput });
  f.sourceRequest = {
    ...sourceOptions,
    workspaceCwd: f.cwd,
    threadId: f.thread.id,
    turnId: f.turn.turnId,
    teammateId: f.participantId,
    runnerId: f.attempt.effectiveRunnerId,
    sourceMessageId: f.turn.item.id,
    ...(f.channel ? { channelId: f.channel.id } : {}),
    createdByActor: "local-user",
    runnerExecutionInput,
  };
  f.db.prepare("UPDATE run_sessions SET task_snapshot_json=?,request_snapshot_json=?,provider_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(f.sourceTask), JSON.stringify(f.sourceRequest), JSON.stringify(f.sourceProvider), f.run.id);
  f.submit([{ questionId: "theme", kind: "text", text: answerText }]);
  f.store.commitUserInputYield({
    threadId: f.thread.id,
    requestId: f.request.requestId,
    expectedRequestVersion: 1,
    sourceFence: toRuntimeAttemptFence(f.attempt),
    quiescence: {
      kind: "runner_quiesced",
      runnerId: f.attempt.runnerId,
      stoppedAt: acceptedAt,
      lastRunEventSeq: 0,
    },
  }, "2026-09-07T00:00:02.000Z");
  return f;
}

async function admitClaim({ store, request, claim }, runtimeInstanceId = "worker-runtime") {
  const options = { cwd: request.cwd, task: request.task, provider: request.provider, tools: request.tools };
  const preparedInput = await prepareFixtureTaskInput(options);
  const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options, preparedInput });
  const requestPreparation = store.getUserInputContinuationPreparation(claim.threadId, claim.deliveryId, "request");
  const execution = store.saveUserInputContinuationPreparation({
    ...claim,
    stage: "execution",
    parentRef: { id: requestPreparation.id, fingerprint: requestPreparation.fingerprint },
    payload: {
      schemaVersion: 1,
      runnerId: "pi",
      providerName: options.provider.provider,
      providerModel: options.provider.model,
      taskSnapshot: request.task,
      providerSnapshot: options.provider,
      requestSnapshot: request,
      runRequestSnapshot: { ...request, runnerExecutionInput },
      preparedInput,
      preparedInputFingerprint: preparedInput.fingerprint,
      runnerExecutionInput,
    },
  }, claimedAt).snapshot;
  return store.admitUserInputContinuation({
    ...claim,
    executionRef: { id: execution.id, fingerprint: execution.fingerprint },
    runtimeInstanceId,
  }, claimedAt);
}

function acknowledge(store, threadId, deliveryId, binding, claim, accepted = recoveredAt) {
  const execution = store.getUserInputContinuationPreparation(threadId, deliveryId, "execution");
  return store.acknowledgeUserInputContinuation({
    threadId,
    deliveryId,
    bindingRef: { id: binding.id, fingerprint: binding.fingerprint },
    sourceFence: binding.fence,
    claim: { ownerId: claim.ownerId, claimToken: claim.claimToken },
    receipt: {
      schemaVersion: 1,
      boundary: "pi-session-ready",
      runId: binding.runId,
      attemptId: binding.fence.attemptId,
      taskId: store.getRun(binding.runId).taskId,
      preparedInputFingerprint: execution.payload.preparedInputFingerprint,
    },
  }, accepted);
}

function worker(t, options) {
  const value = new UserInputDeliveryWorkerRegistry({ scanIntervalMs: 60_000, leaseMs: 1_000, ...options });
  value.start();
  t.after(async () => {
    value.beginShutdown();
    await value.waitForIdle();
  });
  return value;
}

async function seedAdditionalDelivery(f, answerText) {
  const createdAt = "2026-09-07T00:00:10.000Z";
  const answerAt = "2026-09-07T00:00:11.000Z";
  const yieldedAt = "2026-09-07T00:00:12.000Z";
  const cwd = join(f.cwd, "second-project");
  await mkdir(cwd, { recursive: true });
  const participantId = "ling_agent";
  const channel = f.store.createChannel({ name: "Independent second channel", boundPath: cwd }, createdAt);
  const thread = f.store.createLingThread({
    kind: "channel_discussion",
    channelId: channel.id,
    teammateId: participantId,
    title: "Second synthetic input",
    objective: "Resume independently while another continuation is still running.",
  }, createdAt);
  const turn = f.store.appendConversationUserTurn({
    threadId: thread.id,
    channelId: channel.id,
    teammateId: participantId,
    title: "Second source",
    userInstruction: "Build the independent second result.",
    idempotencyKey: "second-source-turn",
    payload: { body: "Build the independent second result.", format: "markdown", mentions: [],
      attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, createdAt);
  const unit = f.store.createWorkUnit({
    workspaceId: DEFAULT_WORKSPACE_ID,
    kind: "task_run",
    ownerType: "run",
    ownerId: "source-run-secondary",
    idempotencyKey: "second-source-unit",
    status: "running",
    createdByActor: "system",
    request: {},
    now: createdAt,
  });
  const attempt = f.store.createWorkUnitAttempt({
    workUnitId: unit.id,
    attemptNumber: 1,
    runtimeInstanceId: "source-runtime-secondary",
    runnerId: "pi",
    status: "started",
    now: createdAt,
  });
  const task = { id: "snapshot-task-secondary", title: "Continue second fixture",
    prompt: "Preserve the independent second project.", channelId: channel.id };
  const provider = { provider: "fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", authHeader: false, reasoning: false };
  const sourceOptions = { cwd, task, provider, tools: [], initialToolSurface: { userInput: true } };
  const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: attempt.effectiveRunnerId,
    options: sourceOptions, preparedInput: await prepareFixtureTaskInput(sourceOptions) });
  const sourceRequest = { ...sourceOptions, workspaceCwd: f.cwd, threadId: thread.id, turnId: turn.turnId,
    channelId: channel.id, teammateId: participantId, runnerId: attempt.effectiveRunnerId, sourceMessageId: turn.item.id,
    createdByActor: "local-user", runnerExecutionInput };
  const run = f.store.createRun({
    id: "source-run-secondary",
    cwd,
    taskId: task.id,
    threadId: thread.id,
    turnId: turn.turnId,
    channelId: channel.id,
    teammateId: participantId,
    workUnitId: unit.id,
    providerName: provider.provider,
    providerModel: provider.model,
    taskSnapshot: task,
    providerSnapshot: provider,
    requestSnapshot: sourceRequest,
    createdAt,
  });
  f.store.transitionRunStatus({ runId: run.id, expectedStatus: "queued", event: "runner_started",
    actor: "runner", now: createdAt });
  f.store.linkRunToWorkUnit(run.id, unit.id, createdAt);
  const request = f.store.createUserInputRequest({
    sourceRunId: run.id,
    sourceItemId: turn.item.id,
    sourceFence: toRuntimeAttemptFence(attempt),
    toolCallId: "second-question",
    idempotencyKey: "second-question",
    toolInput: { schemaVersion: 1, waitMode: "required", questions: [
      { questionId: "format", prompt: "Choose the independent format", required: true,
        allowFreeText: true, options: [] },
    ] },
  }, createdAt).request;
  const receipt = f.store.submitUserInputAnswer({ threadId: thread.id, submission: {
    schemaVersion: 1,
    requestId: request.requestId,
    expectedVersion: 1,
    expectedStatusRevision: 1,
    idempotencyKey: "second-answer",
    answers: [{ questionId: "format", kind: "text", text: answerText }],
  } }, answerAt);
  f.store.commitUserInputYield({
    threadId: thread.id,
    requestId: request.requestId,
    expectedRequestVersion: 1,
    sourceFence: toRuntimeAttemptFence(attempt),
    quiescence: { kind: "runner_quiesced", runnerId: attempt.runnerId,
      stoppedAt: yieldedAt, lastRunEventSeq: 0 },
  }, yieldedAt);
  return { channel, thread, turn, unit, attempt, run, request, receipt };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(read, description, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function waitForBinding(store, threadId, deliveryId, description) {
  try {
    return await waitUntil(() => store.getUserInputContinuationBinding(threadId, deliveryId), description);
  } catch {
    const delivery = store.getUserInputDelivery(threadId, deliveryId);
    const request = store.getUserInputContinuationPreparation(threadId, deliveryId, "request");
    const execution = store.getUserInputContinuationPreparation(threadId, deliveryId, "execution");
    assert.fail(`${description} was not created: ${JSON.stringify({ delivery, request, execution })}`);
  }
}

function successfulProviderResponse(text) {
  return new Response(`data: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":null}]}\n\n`
    + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } });
}

test("two workers racing the same SQLite outbox create one successor Run and Attempt", async t => {
  const f = await fixture(t);
  const other = createSqliteRunStore(f.cwd);
  t.after(() => other.close());
  const executions = [], failures = [];
  const execute = async input => {
    executions.push(input);
    return (await admitClaim(input)).runId;
  };
  const first = worker(t, { ownerId: "delivery-worker-a", now: () => claimedAt, execute, onError: value => failures.push(value) });
  const second = worker(t, { ownerId: "delivery-worker-b", now: () => claimedAt, execute, onError: value => failures.push(value) });
  first.registerStore(f.store);
  second.registerStore(other);
  await Promise.all([first.waitForIdle(), second.waitForIdle()]);

  assert.equal(executions.length, 1, JSON.stringify(failures));
  const delivery = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
  const binding = f.store.getUserInputContinuationBinding(f.thread.id, delivery.deliveryId);
  assert.ok(binding);
  assert.equal(binding.runId, delivery.successorRunId);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
  assert.equal(f.store.getRun(binding.runId).status, "queued");
  assert.equal(f.store.getWorkUnit(binding.fence.workUnitId).status, "claimed");
  assert.equal(f.store.getWorkUnitAttempt(binding.fence.attemptId).status, "created");
});

test("binding without ACK survives a worker Store close and resumes without allocating another successor", async t => {
  const f = await fixture(t);
  const firstStore = createSqliteRunStore(f.cwd);
  let firstBinding;
  const first = worker(t, {
    ownerId: "delivery-worker-before-restart",
    now: () => claimedAt,
    retryDelayMs: 2_000,
    execute: async input => {
      firstBinding = await admitClaim(input, "runtime-before-restart");
      throw new Error("receiver initialization failed");
    },
  });
  first.registerStore(firstStore);
  await first.waitForIdle();
  first.beginShutdown();
  firstStore.close();

  const reopened = createSqliteRunStore(f.cwd);
  t.after(() => reopened.close());
  const recovered = [];
  let recoveryNow = claimedAt;
  const second = worker(t, {
    ownerId: "delivery-worker-after-restart",
    now: () => recoveryNow,
    execute: async input => {
      recovered.push(input);
      acknowledge(input.store, input.threadId, input.deliveryId, input.binding, input.claim);
      return input.binding.runId;
    },
  });
  second.registerStore(reopened);
  await second.waitForIdle();

  assert.equal(recovered.length, 0, "restart must honor the durable retry backoff");
  const deferred = reopened.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
  assert.equal(deferred.claim, null);
  assert.equal(deferred.retryAt, recoveredAt);
  recoveryNow = recoveredAt;
  await second.scanStore(reopened);
  await second.waitForIdle();

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].claim.expectedRevision, firstBinding.deliveryRevision);
  assert.equal(recovered[0].claim.ownerId, "delivery-worker-after-restart");
  assert.deepEqual(recovered[0].binding, firstBinding);
  assert.equal(reopened.listWorkUnitAttempts(f.unit.id).length, 2);
  assert.equal(reopened.getUserInputDelivery(f.thread.id, f.receipt.deliveryId).status, "applied");
  assert.equal(reopened.getRun(firstBinding.runId).status, "running");
});

test("a stale initial worker cannot defer the replacement recovery lease after admission", async t => {
  const f = await fixture(t);
  let currentTime = claimedAt;
  let binding, replacement;
  const failures = [];
  const first = worker(t, {
    ownerId: "delivery-worker-stale-after-admission",
    now: () => currentTime,
    onError: failure => failures.push(failure),
    execute: async input => {
      binding = await admitClaim(input);
      currentTime = recoveredAt;
      replacement = input.store.claimUserInputContinuationRecovery({
        threadId: input.threadId, deliveryId: input.deliveryId,
        bindingRef: { id: binding.id, fingerprint: binding.fingerprint },
        sourceFence: binding.fence, ownerId: "replacement-recovery-worker", leaseMs: 1_000,
      }, currentTime);
      assert.equal(replacement.status, "claimed");
      throw new Error("original receiver no longer owns the delivery");
    },
  });
  first.registerStore(f.store);
  await first.waitForIdle();
  const delivery = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
  assert.equal(delivery.claim.ownerId, replacement.claim.ownerId);
  assert.equal(delivery.claim.token, replacement.claim.claimToken);
  assert.equal(delivery.retryAt, null);
  assert.equal(delivery.lastErrorCode, null);
  assert.equal(delivery.successorRunId, binding.runId);
  assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
  assert.ok(failures.some(failure => failure.phase === "retry" && failure.code === "retry_lost"));
});

test("runtime startup reconciliation preserves an admitted binding until its real receiver ACK", async t => {
  const f = await fixture(t);
  let binding;
  const first = worker(t, {
    ownerId: "delivery-worker-before-runtime-restart",
    now: () => claimedAt,
    execute: async input => {
      binding = await admitClaim(input, "runtime-before-restart");
      throw new Error("receiver did not reach pi-session-ready");
    },
  });
  first.registerStore(f.store);
  await first.waitForIdle();

  const supervisor = new RuntimeSupervisor(resolveConfig({ defaultWorkspaceCwd: f.cwd, port: 0 }));
  try {
    supervisor.getRuntime(f.cwd, f.store);

    assert.equal(f.store.getRun(binding.runId).status, "queued");
    assert.equal(f.store.getWorkUnit(binding.fence.workUnitId).status, "claimed");
    assert.equal(f.store.getWorkUnitAttempt(binding.fence.attemptId).status, "created");
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.receipt.deliveryId), undefined);
    const deferred = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
    assert.equal(deferred.claim, null);
    assert.ok(deferred.retryAt > recoveredAt, "fixture must cross the durable receiver backoff before recovery");
    const restartedAt = new Date(Date.parse(deferred.retryAt) + 1).toISOString();

    const recovered = [];
    const second = worker(t, {
      ownerId: "delivery-worker-after-runtime-restart",
      now: () => restartedAt,
      execute: async input => {
        recovered.push(input);
        acknowledge(input.store, input.threadId, input.deliveryId, input.binding, input.claim, restartedAt);
        return input.binding.runId;
      },
    });
    second.registerStore(f.store);
    await second.waitForIdle();

    assert.equal(recovered.length, 1);
    assert.deepEqual(recovered[0].binding, binding);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId).status, "applied");
  } finally {
    // Release while the fixture directory and runtime.lock still exist. The
    // shared fixture's cleanup hook runs later and must not race owner cleanup.
    supervisor.releaseAll();
  }
});

test("real daemon restart reuses admitted bindings and frees the single worker slot at durable ACK", { timeout: 20_000 }, async t => {
  const f = await fixture(t, "FIRST_LONG_ANSWER_MARKER", { surface: "channel" });
  const second = await seedAdditionalDelivery(f, "SECOND_FAST_ANSWER_MARKER");
  class PreAckFailureRunner extends PiRunnerAdapter {
    async runTask(options) {
      assert.ok(options.signal, "daemon execution must provide an abort signal");
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          options.signal.removeEventListener("abort", onAbort);
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      });
    }
  }

  let firstDaemon = createDaemonServer({ defaultWorkspaceCwd: f.cwd, host: "127.0.0.1", port: 0,
    channels: { terminalReports: false } }, { runner: new PreAckFailureRunner() });
  let restartedDaemon;
  const releaseFirstProvider = deferred();
  let firstFetchCount = 0;
  let secondFetchCount = 0;
  const prestartEvidence = [];
  try {
    await firstDaemon.start();
    const firstBinding = await waitForBinding(
      f.store, f.thread.id, f.receipt.deliveryId,
      "the first pre-ACK binding",
    );
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.receipt.deliveryId), undefined);
    assert.equal(f.store.getUserInputContinuationReceipt(second.thread.id, second.receipt.deliveryId), undefined);
    assert.equal(f.store.getUserInputContinuationBinding(second.thread.id, second.receipt.deliveryId), undefined,
      "the single worker slot must remain occupied until the first durable ACK");
    assert.equal(f.store.getRun(firstBinding.runId).status, "queued");
    await firstDaemon.stop();

    const deferred = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
    assert.equal(deferred.claim, null, "stopped pre-ACK execution must release only its own recovery claim");
    assert.ok(deferred.retryAt);
    // Advance only the fixture wall clock beyond the persisted backoff. Real
    // worker timers and the existing bounded provider observation stay intact.
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(deferred.retryAt) + 1 });

    class RestartedFixtureRunner extends PiRunnerAdapter {
      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, {
          api: "openai-completions",
          streamSimple: (model, context, options) => stream(model, context, { ...options,
            fetch: async (_url, request) => {
              const messages = JSON.stringify(JSON.parse(request.body).messages);
              if (messages.includes("FIRST_LONG_ANSWER_MARKER")) {
                firstFetchCount += 1;
                await releaseFirstProvider.promise;
                return successfulProviderResponse("First continuation completed.");
              }
              if (messages.includes("SECOND_FAST_ANSWER_MARKER")) {
                secondFetchCount += 1;
                return successfulProviderResponse("Second continuation completed.");
              }
              assert.fail(`Unexpected continuation input: ${messages}`);
            },
          }),
        });
      }
    }
    restartedDaemon = createDaemonServer({ defaultWorkspaceCwd: f.cwd, host: "127.0.0.1", port: 0,
      channels: { terminalReports: false } }, { runner: new RestartedFixtureRunner(), storeFactory: cwd => {
        const store = createSqliteRunStore(cwd);
        const recover = store.recoverUserInputContinuationPrestart.bind(store);
        t.mock.method(store, "recoverUserInputContinuationPrestart", input => {
          const result = recover(input);
          prestartEvidence.push({ result, attempt: store.getWorkUnitAttempt(input.sourceFence.attemptId),
            slots: store.listRuntimeSemaphoreSlots({ ownerId: input.sourceFence.attemptId }),
            runtimeEvents: store.listRuntimeEvents(input.sourceFence.workUnitId) });
          return result;
        });
        return store;
      } });
    await restartedDaemon.start();

    try {
      await waitUntil(() => firstFetchCount === 1, "the restarted first provider request");
    } catch {
      const recoveredBinding = f.store.getUserInputContinuationBinding(f.thread.id, f.receipt.deliveryId);
      const recoveredRun = recoveredBinding ? f.store.getRun(recoveredBinding.runId) : undefined;
      assert.fail(`the restarted first provider request was not made: ${JSON.stringify({
        delivery: f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId),
        binding: recoveredBinding,
        receipt: f.store.getUserInputContinuationReceipt(f.thread.id, f.receipt.deliveryId),
        run: recoveredRun && { status: recoveredRun.status, errorMessage: recoveredRun.errorMessage },
        prestartEvidence,
        workUnit: recoveredBinding ? f.store.getWorkUnit(recoveredBinding.fence.workUnitId) : undefined,
        attempts: recoveredBinding ? f.store.listWorkUnitAttempts(recoveredBinding.fence.workUnitId) : [],
        events: recoveredBinding ? f.store.listEvents(recoveredBinding.runId, { limit: 100 }) : [],
        secondDelivery: f.store.getUserInputDelivery(second.thread.id, second.receipt.deliveryId),
        secondBinding: f.store.getUserInputContinuationBinding(second.thread.id, second.receipt.deliveryId),
      })}`);
    }
    await waitUntil(() => f.store.getUserInputContinuationReceipt(f.thread.id, f.receipt.deliveryId),
      "the first durable receiver ACK");
    const secondBinding = await waitForBinding(
      f.store, second.thread.id, second.receipt.deliveryId,
      "the second binding after the first durable ACK",
    );
    await waitUntil(() => f.store.getUserInputContinuationReceipt(second.thread.id, second.receipt.deliveryId),
      "the second durable receiver ACK while the first Run is still blocked");
    await waitUntil(() => f.store.getRun(secondBinding.runId).status === "succeeded",
      "the second continuation terminal state");

    assert.equal(f.store.getRun(firstBinding.runId).status, "running",
      "the first Run must still be active when the second continuation completes");
    assert.equal(firstFetchCount, 1);
    assert.equal(secondFetchCount, 1);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2,
      "restart must reuse the admitted first Attempt");
    assert.equal(f.store.listWorkUnitAttempts(second.unit.id).length, 2,
      "restart must reuse the admitted second Attempt");
    assert.equal(f.store.getUserInputContinuationBinding(f.thread.id, f.receipt.deliveryId).id, firstBinding.id);
    assert.equal(f.store.getUserInputContinuationBinding(second.thread.id, second.receipt.deliveryId).id, secondBinding.id);

    releaseFirstProvider.resolve();
    await waitUntil(() => f.store.getRun(firstBinding.runId).status === "succeeded",
      "the released first continuation terminal state");
    for (const [binding, channelId] of [[firstBinding, f.channel.id], [secondBinding, second.channel.id]]) {
      const run = f.store.getRun(binding.runId);
      assert.equal(run.channelId, channelId);
      assert.equal(run.status, "succeeded");
      assert.ok(f.store.listEvents(run.id, { limit: 100 }).some(event => event.type === "result"),
        "channel terminal consumers receive durable result evidence, not worker batch counts");
    }
  } finally {
    releaseFirstProvider.resolve();
    if (restartedDaemon?.server.listening) await restartedDaemon.stop();
    if (firstDaemon.server.listening) await firstDaemon.stop();
  }
});

for (const mirrorFailure of ["directory", "symlink_loop"]) {
test(`real daemon retries a committed run_created mirror ${mirrorFailure} I/O failure without ACK or duplicate model execution`, { timeout: 20_000 }, async t => {
  const f = await fixture(t, "MIRROR_RECOVERY_ANSWER", { surface: "channel" });
  let mirrorPath;
  let providerCalls = 0;
  class MirrorRecoveryRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, { ...options, fetch: async () => {
          providerCalls += 1;
          return successfulProviderResponse("Mirror recovery completed.");
        } }),
      });
    }
  }
  const daemonConfig = { defaultWorkspaceCwd: f.cwd, host: "127.0.0.1", port: 0,
    channels: { terminalReports: false } };
  const dependencies = { runner: new MirrorRecoveryRunner(), storeFactory: cwd => {
      const store = createSqliteRunStore(cwd);
      const publish = store.publishUserInputContinuationRunCreated.bind(store);
      t.mock.method(store, "publishUserInputContinuationRunCreated", (input, now) => {
        if (!mirrorPath) {
          mirrorPath = store.getRun(input.runId).eventLogPath;
          // Real filesystem failure after SQLite commit, not a fake Store outcome.
          mkdirSync(dirname(mirrorPath), { recursive: true });
          if (mirrorFailure === "directory") mkdirSync(mirrorPath);
          else {
            symlinkSync(mirrorPath, mirrorPath);
            assert.throws(() => readFileSync(mirrorPath), error => error.code === "ELOOP");
          }
        }
        return publish(input, now);
      });
      return store;
    } };
  let daemon = createDaemonServer(daemonConfig, dependencies);
  try {
    await daemon.start();
    const binding = await waitForBinding(f.store, f.thread.id, f.receipt.deliveryId, "the mirror recovery binding");
    await waitUntil(() => {
      const delivery = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
      return delivery.retryAt || delivery.status === "failed" || f.store.getRun(binding.runId).status === "failed";
    }, "durable backoff or a terminal startup failure after mirror I/O");
    const deferred = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
    assert.equal(deferred.status, "claimed");
    assert.equal(deferred.claim, null);
    assert.ok(deferred.retryAt, "mirror I/O must preserve the binding with durable backoff, not fail startup");
    assert.equal(f.store.getRun(binding.runId).status, "queued");
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.receipt.deliveryId), undefined);
    assert.equal(providerCalls, 0, "mirror must finish before ACK and model execution");
    const committed = f.store.listEvents(binding.runId).filter(event => event.type === "run_created");
    assert.equal(committed.length, 1);
    await daemon.stop();
    if (mirrorFailure === "directory") rmdirSync(mirrorPath);
    else unlinkSync(mirrorPath);
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(deferred.retryAt) + 1 });
    // A real fresh daemon supplies a deterministic discovery wake after the
    // persisted due time; do not race the production 5s poll with a 5s assert.
    daemon = createDaemonServer(daemonConfig, dependencies);
    await daemon.start();
    try {
      await waitUntil(() => f.store.getRun(binding.runId).status === "succeeded", "mirror recovery terminal state");
    } catch {
      assert.fail(`Mirror recovery did not finish: ${JSON.stringify({ providerCalls,
        delivery: f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId),
        run: { status: f.store.getRun(binding.runId).status, errorMessage: f.store.getRun(binding.runId).errorMessage },
        eventTypes: f.store.listEvents(binding.runId).map(event => event.type) })}`);
    }
    assert.equal(providerCalls, 1);
    assert.equal(f.store.getUserInputContinuationBinding(f.thread.id, f.receipt.deliveryId).id, binding.id);
    assert.equal(f.store.listWorkUnitAttempts(f.unit.id).length, 2);
    assert.deepEqual(f.store.listEvents(binding.runId).filter(event => event.type === "run_created"), committed);
    assert.deepEqual(readFileSync(mirrorPath, "utf8").trim().split("\n").map(JSON.parse)
      .filter(event => event.type === "run_created"), committed);
  } finally {
    if (daemon.server.listening) await daemon.stop();
  }
});
}

test("delivery execution is detached from SSE and retries a pre-admission receiver failure", async t => {
  const f = await fixture(t);
  const failures = [];
  const registry = worker(t, {
    ownerId: "delivery-worker-detached",
    now: () => claimedAt,
    retryDelayMs: 2_000,
    execute: async () => { throw new Error("receiver offline"); },
    onError: failure => failures.push(failure),
  });
  registry.registerStore(f.store);
  await registry.waitForIdle();

  const delivery = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
  assert.equal(delivery.status, "failed", JSON.stringify(failures));
  assert.equal(delivery.lastErrorCode, "receiver_unavailable");
  assert.equal(delivery.retryAt, "2026-09-07T00:00:05.000Z");
  assert.deepEqual(failures, [{ cwd: f.cwd, deliveryId: delivery.deliveryId, phase: "execute", code: "receiver_unavailable" }]);
});

test("detached pre-admission resolve without a binding is an explicit retry, not false success", async t => {
  const f = await fixture(t);
  const failures = [];
  const registry = worker(t, {
    ownerId: "delivery-worker-detached-resolve",
    now: () => claimedAt,
    retryDelayMs: 2_000,
    execute: async () => undefined,
    onError: failure => failures.push(failure),
  });
  registry.registerStore(f.store);
  await registry.waitForIdle();

  const delivery = f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId);
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.lastErrorCode, "receiver_unavailable");
  assert.equal(delivery.retryAt, "2026-09-07T00:00:05.000Z");
  assert.deepEqual(failures, [{ cwd: f.cwd, deliveryId: delivery.deliveryId, phase: "execute", code: "receiver_unavailable" }]);
});

test("cancelled required input is made obsolete and never dispatched", async t => {
  const f = await fixture(t);
  f.store.cancelUserInputWait({ threadId: f.thread.id, sourceRunId: f.run.id }, claimedAt);
  let calls = 0;
  const registry = worker(t, {
    ownerId: "delivery-worker-cancelled",
    now: () => claimedAt,
    execute: async () => { calls += 1; },
  });
  registry.registerStore(f.store);
  await registry.waitForIdle();
  assert.equal(calls, 0);
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.receipt.deliveryId).status, "obsolete");
});

test("worker failures never retain or report the sensitive answer body", async t => {
  const secret = "QA-ANSWER-SECRET-7f31";
  const f = await fixture(t, secret);
  const failures = [];
  const registry = worker(t, {
    ownerId: "delivery-worker-redaction",
    now: () => claimedAt,
    execute: async input => { throw new Error(`transport leaked ${input.request.task.prompt}`); },
    onError: failure => failures.push(failure),
  });
  registry.registerStore(f.store);
  await registry.waitForIdle();

  assert.ok(!JSON.stringify(failures).includes(secret));
  assert.ok(!JSON.stringify(registry.snapshot()).includes(secret));
});

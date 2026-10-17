import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { PiRunnerAdapter } from "../../runner-pi/dist/index.js";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { userInputTranscriptFixture, claimedAt } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { withUserInputContinuationReceiver } from "../dist/features/runs/user-input-continuation-receiver.js";
import { prepareUserInputContinuationRequest, readUserInputContinuationPreparedRequest } from "../dist/features/runs/user-input-prepared-request.js";
import { capturePreparedRunnerInput } from "../dist/features/runs/prepared-runner-input.js";

const now = "2026-09-07T00:00:05.000Z";
const ref = record => ({ id: record.id, fingerprint: record.fingerprint });
function messageText(message) {
  if (typeof message.content === "string") return message.content;
  assert.ok(Array.isArray(message.content));
  assert.ok(message.content.every(block => block.type === "text" && typeof block.text === "string"), "this fixture expects text-only SDK blocks");
  return message.content.map(block => block.text).join("");
}
async function fixture(t, surface = "normal", sourceOptions = {}, answers) {
  const f = await userInputTranscriptFixture(t, { surface, ...sourceOptions });
  f.wire = [];
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
        stream(model, context, { ...options, fetch: async (_url, request) => {
          assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "applied");
          assert.ok(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId));
          f.wire.push(JSON.parse(request.body));
          return new Response('data: {"choices":[{"index":0,"delta":{"content":"Continued fixture."},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
        } }) });
    }
  }
  f.adapter = new FixtureRunner();
  f.options = { cwd: f.cwd, agentDir: join(f.cwd, "fixture-agent"),
    task: { id: f.run.taskId, title: "Continue", prompt: "Build the fixture while preserving existing files.", ...(f.channel ? { channelId: f.channel.id } : {}) },
    provider: { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture-only-not-a-credential", reasoning: false }, tools: [],
    onEvent: event => {
      if (event.type !== "run_start") return;
      f.runStartState = {
        run: f.store.getRun(f.binding.runId).status,
        unit: f.store.getWorkUnit(f.binding.fence.workUnitId).status,
        attempt: f.store.getWorkUnitAttempt(f.binding.fence.attemptId).status,
      };
    } };
  // Only the original Run is seeded. The actual builder must obtain the answer
  // from SQLite; no answer-only request or hand-written continuation prompt.
  const sourceRequest = { cwd: f.cwd, workspaceCwd: f.cwd, threadId: f.thread.id, turnId: f.turn.turnId,
    task: f.options.task, provider: f.options.provider, runnerId: "pi", tools: [],
    teammateId: f.participantId, workflowStepId: f.step?.id,
    runnerExecutionInput: capturePreparedRunnerInput({ runnerId: f.attempt.effectiveRunnerId, options: f.options,
      preparedInput: await f.adapter.prepareTaskInput(f.options) }) };
  f.db.prepare("UPDATE run_sessions SET task_snapshot_json=?,request_snapshot_json=?,provider_snapshot_json=? WHERE id=?")
    .run(JSON.stringify(f.options.task), JSON.stringify(sourceRequest), JSON.stringify(f.options.provider), f.run.id);
  f.submit(answers); f.delivery = f.claim();
  const claim = { threadId: f.thread.id, deliveryId: f.delivery.deliveryId, expectedRevision: f.delivery.revision,
    ownerId: f.delivery.claim.ownerId, claimToken: f.delivery.claim.token };
  f.preparedRequest = prepareUserInputContinuationRequest(f.store, claim, claimedAt);
  const request = f.preparedRequest.request;
  f.options = { ...f.options, task: request.task };
  f.preparedInput = await f.adapter.prepareTaskInput(f.options);
  const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options: f.options, preparedInput: f.preparedInput });
  // Execution preparation/coordinator is still a fixture: this tests the real
  // request builder through SDK/ACK, not the unfinished product dispatch entry.
  const prepared = f.store.saveUserInputContinuationPreparation({ ...claim, stage: "execution", parentRef: f.preparedRequest.ref, payload: {
    schemaVersion: 1, runnerId: "pi", providerName: f.options.provider.provider, providerModel: f.options.provider.model,
    taskSnapshot: f.options.task, requestSnapshot: request,
    runRequestSnapshot: { ...request, runnerExecutionInput }, providerSnapshot: runnerExecutionInput.input.provider,
    preparedInput: f.preparedInput, preparedInputFingerprint: f.preparedInput.fingerprint,
    runnerExecutionInput,
  } }, claimedAt).snapshot;
  f.binding = f.store.admitUserInputContinuation({ ...claim, executionRef: ref(prepared), runtimeInstanceId: "receiver-runtime" }, claimedAt);
  f.attach = (changes = {}) => withUserInputContinuationReceiver({ store: f.store, threadId: f.thread.id, binding: f.binding,
    adapter: f.adapter, options: f.options, now: () => f.receiverNow ?? now, ...changes });
  return f;
}
for (const surface of ["normal", "private", "channel"]) {
  test(`real SDK ${surface} receipt commits SQLite ACK before fixture transport`, async t => {
    const f = await fixture(t, surface);
    await f.adapter.runTask(f.attach());
    assert.deepEqual(f.runStartState, { run: "queued", unit: "claimed", attempt: "created" });
    assert.equal(f.wire.length, 1);
    const userMessages = f.wire[0].messages.filter(message => message.role === "user");
    assert.equal(userMessages.length, 1);
    const text = messageText(userMessages[0]);
    assert.equal(text, f.preparedInput.userPrompt);
    assert.match(text, /Build the fixture while preserving existing files/);
    assert.match(text, /选择主题\n保留换行/);
    assert.match(text, /深色/);
    assert.equal(f.store.getLingTurnForRun(f.binding.runId).id, f.turn.turnId);
    assert.equal(f.store.getRun(f.binding.runId).teammateId, f.participantId);
    assert.equal(f.binding.fence.workUnitId, f.unit.id);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "applied");
    assert.equal(f.read().find(item => item.kind === "user_input_answer").delivery.status, "applied");
    assert.throws(() => f.attach(), error => error.code === "user_input_already_received");
  });
}
for (const surface of ["normal", "private", "channel"]) {
  test(`actual ${surface} builder preserves multiline answers through the first model request`, async t => {
    const answer = "深色主题\n\n```js\nconst chosen = 'dark';\n```\n保留这段格式。";
    const f = await fixture(t, surface, {}, [{ questionId: "theme", kind: "text", text: answer }]);
    await f.adapter.runTask(f.attach());
    const text = messageText(f.wire[0].messages.find(message => message.role === "user"));
    assert.ok(text.includes(answer));
    assert.equal(text.split(answer).length - 1, 1, "the saved answer is not duplicated");
    const receipt = f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId);
    assert.equal(receipt.acceptance.preparedInputFingerprint, f.preparedInput.fingerprint);
  });
}
test("reopened Host uses the frozen answer without importing a newer conversation turn", async t => {
  const f = await fixture(t);
  f.store.appendConversationUserTurn({ threadId: f.thread.id, title: "New topic", userInstruction: "LATER-TURN-MARKER", idempotencyKey: "later",
    payload: { body: "LATER-TURN-MARKER", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, claimedAt);
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(readUserInputContinuationPreparedRequest(reopened, f.thread.id, f.delivery.deliveryId), f.preparedRequest);
    await f.adapter.runTask(f.attach({ store: reopened }));
    const text = messageText(f.wire[0].messages.find(message => message.role === "user"));
    assert.match(text, /深色/);
    assert.doesNotMatch(text, /LATER-TURN-MARKER/);
    assert.throws(() => f.attach({ store: reopened }), error => error.code === "user_input_already_received");
    assert.equal(f.wire.length, 1);
  } finally { reopened.close(); }
});
for (const changed of ["systemPrompt", "provider"]) {
  test(`SDK input drift in ${changed} blocks ACK and transport after actual request preparation`, async t => {
    const f = await fixture(t);
    const options = changed === "systemPrompt" ? { ...f.options, systemPrompt: "A different instruction" }
      : { ...f.options, provider: { ...f.options.provider, baseUrl: "https://changed-fixture.invalid/v1" } };
    await assert.rejects(f.adapter.runTask(f.attach({ options })), /Pi prepared input changed/);
    assert.equal(f.wire.length, 0);
    assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
    assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
  });
}
test("receiver rejects an adapter that only shares the options shape", async t => {
  const f = await fixture(t);
  assert.throws(() => f.attach({ adapter: { runTask: async () => { throw new Error("must not dispatch"); } } }), error => error.code === "user_input_receiver_unverified");
  assert.equal(f.wire.length, 0);
});
test("real SDK resumes the stored channel Task/step without changing its independent sibling", async t => {
  const f = await fixture(t, "channel", { storedTask: true, workflow: true });
  const sibling = f.store.getChannelWorkflowStep(f.siblingStep.id);
  await f.adapter.runTask(f.attach());
  assert.equal(f.wire.length, 1);
  assert.equal(f.store.getTask(f.storedTask.id).currentRunId, f.binding.runId);
  assert.equal(f.store.getChannelWorkflowStep(f.step.id).runId, f.binding.runId);
  assert.deepEqual(f.store.getChannelWorkflowStep(f.siblingStep.id), sibling);
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "applied");
});
test("two prebuilt receivers cannot dispatch the accepted input twice", async t => {
  const f = await fixture(t), a = f.attach(), b = f.attach();
  const results = await Promise.allSettled([f.adapter.runTask(a), f.adapter.runTask(b)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "user_input_already_received");
  assert.equal(f.wire.length, 1);
});
test("a replacement Attempt fences an already prepared receiver before transport", async t => {
  const f = await fixture(t), options = f.attach();
  // Replace the prepared fence before the receiver has durably accepted it.
  f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 3, runtimeInstanceId: "other-runtime", runnerId: "pi", now });
  await assert.rejects(f.adapter.runTask(options), error => error.code === "source_conflict");
  assert.equal(f.wire.length, 0);
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
});
test("Host ACK persistence failure prevents the first model transport", async t => {
  const f = await fixture(t), options = f.attach();
  f.db.exec("CREATE TRIGGER ack_failure BEFORE UPDATE ON user_input_deliveries WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'host ACK failed'); END");
  await assert.rejects(f.adapter.runTask(options), /host ACK failed/);
  assert.equal(f.wire.length, 0);
  assert.equal(f.store.getUserInputContinuationReceipt(f.thread.id, f.delivery.deliveryId), undefined);
  assert.equal(f.store.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "claimed");
});

for (const surface of ["normal", "private", "channel"]) {
  test(`second ${surface} question resumes from its own admitted SDK input after SQLite reopen`, async t => {
    const f = await fixture(t, surface, surface === "channel" ? { storedTask: true, workflow: true } : {},
      [{ questionId: "theme", kind: "text", text: "FIRST_ANSWER_MARKER" }]);
    await f.adapter.runTask(f.attach());
    const firstBinding = f.binding, firstDelivery = f.delivery;
    const firstInput = f.store.getRun(firstBinding.runId).requestSnapshot.runnerExecutionInput;
    const sourceBefore = f.store.getRun(f.run.id);
    // The real SDK/SQLite input path is under test. Host yield/start scheduling
    // still uses explicit fixture transitions, not the unfinished coordinator.
    const question = f.store.createUserInputRequest({ sourceRunId: firstBinding.runId, sourceItemId: f.turn.item.id,
      sourceFence: firstBinding.fence, toolCallId: "second-question", idempotencyKey: "second-question",
      toolInput: { schemaVersion: 1, waitMode: "required", questions: [
        { questionId: "format", prompt: "Choose a format", required: true, allowFreeText: true, options: [] },
      ] } }, "2026-09-07T00:00:06.000Z").request;
    const answer = f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: {
      schemaVersion: 1, requestId: question.requestId, expectedVersion: 1, expectedStatusRevision: 1,
      idempotencyKey: "second-answer", answers: [{ questionId: "format", kind: "text", text: "SECOND_ANSWER_MARKER" }],
    } }, "2026-09-07T00:00:07.000Z");
    f.store.commitUserInputYield({ threadId: f.thread.id, requestId: question.requestId, expectedRequestVersion: 1,
      sourceFence: firstBinding.fence, quiescence: { kind: "runner_quiesced",
        runnerId: f.store.getWorkUnitAttempt(firstBinding.fence.attemptId).runnerId,
        stoppedAt: "2026-09-07T00:00:08.000Z", lastRunEventSeq: 0 } }, "2026-09-07T00:00:09.000Z");
    const reopened = createSqliteRunStore(f.cwd);
    try {
      const at = "2026-09-07T00:00:10.000Z";
      f.delivery = reopened.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: answer.deliveryId,
        expectedRevision: 1, ownerId: "second-worker", leaseMs: 1000 }, at);
      const claim = { threadId: f.thread.id, deliveryId: f.delivery.deliveryId, expectedRevision: f.delivery.revision,
        ownerId: f.delivery.claim.ownerId, claimToken: f.delivery.claim.token };
      const preparedRequest = prepareUserInputContinuationRequest(reopened, claim, at), request = preparedRequest.request;
      assert.equal(request.parentRunId, firstBinding.runId);
      assert.equal(request.task.prompt.split("FIRST_ANSWER_MARKER").length - 1, 1);
      assert.equal(request.task.prompt.split("SECOND_ANSWER_MARKER").length - 1, 1);
      f.options = { ...f.options, task: request.task, systemPrompt: request.systemPrompt, appendSystemPrompt: request.appendSystemPrompt };
      f.preparedInput = await f.adapter.prepareTaskInput(f.options);
      const runnerExecutionInput = capturePreparedRunnerInput({ runnerId: "pi", options: f.options, preparedInput: f.preparedInput });
      const execution = reopened.saveUserInputContinuationPreparation({ ...claim, stage: "execution", parentRef: preparedRequest.ref,
        payload: { schemaVersion: 1, runnerId: "pi", providerName: f.options.provider.provider, providerModel: f.options.provider.model,
          taskSnapshot: request.task, requestSnapshot: request,
          runRequestSnapshot: { ...request, runnerExecutionInput }, providerSnapshot: runnerExecutionInput.input.provider,
          preparedInput: f.preparedInput, preparedInputFingerprint: f.preparedInput.fingerprint, runnerExecutionInput } }, at).snapshot;
      f.binding = reopened.admitUserInputContinuation({ ...claim, executionRef: ref(execution), runtimeInstanceId: "second-runtime" }, at);
      f.executionNow = at; f.receiverNow = "2026-09-07T00:00:11.000Z";
      await f.adapter.runTask(f.attach({ store: reopened }));
      assert.equal(f.wire.length, 2);
      assert.equal(messageText(f.wire[1].messages.find(message => message.role === "user")), f.preparedInput.userPrompt);
      assert.equal(reopened.getUserInputDelivery(f.thread.id, f.delivery.deliveryId).status, "applied");
      assert.equal(reopened.getUserInputDelivery(f.thread.id, firstDelivery.deliveryId).status, "applied");
      assert.equal(reopened.getLingTurnForRun(f.binding.runId).id, f.turn.turnId);
      assert.equal(f.binding.fence.workUnitId, firstBinding.fence.workUnitId);
      assert.notEqual(f.binding.fence.attemptId, firstBinding.fence.attemptId);
      assert.deepEqual(reopened.getRun(firstBinding.runId).requestSnapshot.runnerExecutionInput, firstInput);
      assert.deepEqual(reopened.getRun(f.run.id), sourceBefore);
      assert.equal(reopened.listWorkUnitAttempts(f.unit.id).length, 3);
    } finally { reopened.close(); }
  });
}

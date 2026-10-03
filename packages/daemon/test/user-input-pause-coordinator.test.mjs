import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence } from "../../core/dist/index.js";
import { PiRunnerAdapter, PiRunnerYielded } from "../../runner-pi/dist/index.js";
import { stream } from "../../runner-pi/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { AttemptExecutorGroup } from "../dist/runtime/attempt-execution-quiescence.js";

const input = (waitMode = "required") => ({ schemaVersion: 1, waitMode, questions: [{ questionId: "choice",
  prompt: "Choose", required: waitMode === "required", allowFreeText: true, options: [] }] });
async function fixture(t, surface = "normal") {
  const { UserInputPauseCoordinator } = await import("../dist/features/runs/user-input-pause-coordinator.js");
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-pause-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const channel = surface === "channel" ? store.createChannel({ name: "Pause fixture", boundPath: cwd }, now) : undefined;
  const participant = surface === "private" ? "teammate_builtin_engineer" : "ling_agent";
  const thread = store.createLingThread({ kind: surface === "private" ? "teammate_direct" : channel ? "channel_discussion" : "conversation",
    teammateId: participant, channelId: channel?.id, title: "Pause fixture", objective: "Ask" }, now);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, channelId: channel?.id, teammateId: participant,
    title: "Ask", userInstruction: "Ask", idempotencyKey: "turn", payload: { body: "Ask", format: "markdown",
      mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, now);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "source",
    idempotencyKey: "source", status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "pause-runtime",
    runnerId: "pi", status: "started", now });
  const fence = toRuntimeAttemptFence(attempt);
  const run = store.createRun({ id: "source", cwd, taskId: "snapshot-task", threadId: thread.id, turnId: turn.turnId,
    channelId: channel?.id, teammateId: participant, workUnitId: unit.id, providerName: "pause-fixture", providerModel: "fixture",
    taskSnapshot: {}, requestSnapshot: {}, providerSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  store.markRunStarted(run.id, now);
  const signal = new AbortController();
  const facts = new Map();
  const group = new AttemptExecutorGroup({ source: { runId: run.id, ...fence },
    isCurrentExecutionOwner: source => store.isCurrentRunExecutionOwner(source.runId, source),
    verifySettlement: (_ticket, proof) => facts.get(proof.evidenceRef) === proof.kind,
    persistBlockedOperation: () => false });
  const coordinator = new UserInputPauseCoordinator({ store, runId: run.id, sourceItemId: turn.item.id,
    sourceFence: fence, runnerId: "pi", executorGroup: group, signal: signal.signal });
  return { cwd, store, thread, turn, unit, run, attempt, fence, signal, facts, group, coordinator };
}

for (const surface of ["normal", "private", "channel"]) {
  test(`real SDK and pause coordinator preserve ${surface} source Turn without a terminal result`, { timeout: 10000 }, async t => {
    const f = await fixture(t, surface);
    let providerCalls = 0;
    class Runner extends PiRunnerAdapter {
      registerCustomProviderIfNeeded(runtime, provider) {
        super.registerCustomProviderIfNeeded(runtime, provider);
        runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) =>
          stream(model, context, { ...options, fetch: async () => {
            providerCalls++;
            const delta = { tool_calls: [{ index: 0, id: "ask", type: "function",
              function: { name: "request_user_input", arguments: JSON.stringify(input()) } }] };
            return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
              + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } });
          } }) });
      }
    }
    let yielded;
    try {
      await new Runner().runTask({ cwd: f.cwd, agentDir: join(f.cwd, "agent"), task: { id: f.run.taskId, title: "Ask", prompt: "Ask" },
        provider: { provider: "pause-fixture", model: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
          apiKey: "fixture-no-network", reasoning: false }, tools: [], signal: f.signal.signal,
        onUserInputRequest: request => f.coordinator.request(request.toolCallId, request.input),
        onEvent: event => f.store.appendExecutionEvent(f.run.id, f.fence, event.type, event) });
      assert.fail("required input must yield");
    } catch (error) { assert.ok(error instanceof PiRunnerYielded); yielded = error; }
    assert.equal(providerCalls, 1);
    const result = await f.coordinator.completeYield(yielded);
    assert.equal(result.kind, "committed");
    assert.equal(result.result.wait.status, "waiting");
    assert.equal(f.store.getRun(f.run.id).status, "yielded");
    assert.equal(f.store.getLingTurnForRun(f.run.id).id, f.turn.turnId);
    assert.equal(f.store.getLingTurn(f.turn.turnId).status, "waiting_for_input");
    assert.equal(f.store.getWorkUnit(f.unit.id).status, "waiting_for_input");
    assert.equal(result.result.wait.checkpoint.source.participantId, f.run.teammateId);
    assert.equal(f.store.listEvents(f.run.id).some(event => ["run_end", "run_error", "result"].includes(event.type)), false);
    assert.equal(f.signal.signal.aborted, false);
    assert.equal(await f.coordinator.completeYield(yielded), result, "physical result is returned idempotently, never committed twice");
  });
}

test("optional question leaves Host admission open and produces no safe checkpoint", async t => {
  const f = await fixture(t);
  const receipt = f.coordinator.request("optional", input("optional"));
  assert.equal(receipt.kind, "user_input_optional");
  assert.equal(f.group.isAdmissionOpen(), true);
  assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
});

test("required request synchronously closes Host admission before returning", async t => {
  const f = await fixture(t);
  const receipt = f.coordinator.request("ask", input());
  assert.equal(receipt.kind, "user_input_required");
  assert.throws(() => f.group.beginHostCall("file_mutation", "late"));
  assert.equal(f.coordinator.beforeBoundary().requestId, receipt.requestId);
  assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
});

test("a pre-effect admitted operation delays checkpoint until its independently verified settlement", async t => {
  const f = await fixture(t);
  const ticket = f.group.beginHostCall("hydration", "reserved");
  const receipt = f.coordinator.request("ask", input());
  let completed = false;
  const pending = f.coordinator.completeYield(new PiRunnerYielded(receipt, new Date().toISOString())).then(result => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
  f.facts.set("host-no-start", "known_no_start");
  f.group.settleHostCall(ticket, { schemaVersion: 1, source: f.group.source, operationId: ticket.id,
    kind: "known_no_start", evidenceRef: "host-no-start", settledAt: new Date().toISOString() });
  assert.equal((await pending).kind, "committed");
});

test("observation timeout retains the original authority and permits only later proven drain", async t => {
  const f = await fixture(t);
  f.group.beginHostCall("mcp", "remote");
  const receipt = f.coordinator.request("ask", input());
  const result = await f.coordinator.completeYield(new PiRunnerYielded(receipt, new Date().toISOString()), 0);
  assert.equal(result.kind, "quiescence_blocked");
  assert.equal(result.drain.status, "blocked");
  assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, f.attempt.id);
  assert.equal(f.store.getRun(f.run.id).status, "running");
});

test("cancelled and replaced source cannot commit a waiting checkpoint", async t => {
  for (const action of ["cancel", "replace"]) {
    const f = await fixture(t);
    const receipt = f.coordinator.request("ask", input());
    if (action === "cancel") f.signal.abort();
    else f.store.createWorkUnitAttempt({ workUnitId: f.unit.id, attemptNumber: 2, runtimeInstanceId: "successor", runnerId: "pi",
      status: "created", now: new Date().toISOString() });
    const result = await f.coordinator.completeYield(new PiRunnerYielded(receipt, new Date().toISOString()));
    assert.equal(result.kind, "source_obsolete");
    assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
  }
});

test("forged textual yield and another question identity cannot certify SDK settlement", async t => {
  const f = await fixture(t);
  f.coordinator.request("ask", input());
  await assert.rejects(f.coordinator.completeYield({ name: "PiRunnerYielded", request: {} }));
  await assert.rejects(f.coordinator.completeYield(new PiRunnerYielded({ kind: "user_input_required", requestId: "other", requestVersion: 1 }, new Date().toISOString())));
  assert.equal(f.store.getRun(f.run.id).status, "running");
});

test("early answer is saved but cannot claim before coordinator proves and commits yield", async t => {
  const f = await fixture(t);
  const receipt = f.coordinator.request("ask", input());
  const answer = f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: { schemaVersion: 1,
    requestId: receipt.requestId, expectedVersion: 1, expectedStatusRevision: 1, idempotencyKey: "early-answer",
    answers: [{ questionId: "choice", kind: "text", text: "Use A" }] } }, new Date().toISOString());
  const claim = () => f.store.claimUserInputDelivery({ threadId: f.thread.id, deliveryId: answer.deliveryId,
    expectedRevision: 1, ownerId: "worker", leaseMs: 1000 }, new Date().toISOString());
  assert.throws(claim, error => error.code === "delivery_not_ready");
  assert.equal(f.store.getUserInputDelivery(f.thread.id, answer.deliveryId).status, "pending");
  assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
  assert.equal((await f.coordinator.completeYield(new PiRunnerYielded(receipt, new Date().toISOString()))).kind, "committed");
  assert.equal(claim().status, "claimed");
  assert.equal(f.store.getLingTurnForRun(f.run.id).id, f.turn.turnId);
});

test("late unpaired tool evidence vetoes an empty in-memory drain without releasing source", async t => {
  const f = await fixture(t);
  const receipt = f.coordinator.request("ask", input());
  f.store.appendExecutionEvent(f.run.id, f.fence, "tool_start", { toolCallId: "late", toolName: "read", input: {} });
  const result = await f.coordinator.completeYield(new PiRunnerYielded(receipt, new Date().toISOString()));
  assert.equal(result.kind, "quiescence_blocked");
  assert.equal(result.code, "durable_evidence_unconfirmed");
  assert.equal(f.store.getRun(f.run.id).status, "running");
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, f.attempt.id);
  assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
});

test("an observation deadline can be retried only after real no-start evidence, not by resetting admission", async t => {
  const f = await fixture(t);
  const ticket = f.group.beginHostCall("hydration", "reserved");
  const receipt = f.coordinator.request("ask", input());
  const yielded = new PiRunnerYielded(receipt, new Date().toISOString());
  assert.equal((await f.coordinator.completeYield(yielded, 0)).kind, "quiescence_blocked");
  assert.equal(f.group.getSnapshot().admission, "closed");
  f.facts.set("verified-no-start", "known_no_start");
  f.group.settleHostCall(ticket, { schemaVersion: 1, source: f.group.source, operationId: ticket.id,
    kind: "known_no_start", evidenceRef: "verified-no-start", settledAt: new Date().toISOString() });
  assert.equal((await f.coordinator.completeYield(yielded, 0)).kind, "committed");
});

test("SDK stop timestamps before the question or in the future cannot establish a checkpoint", async t => {
  for (const stoppedAt of ["2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"]) {
    const f = await fixture(t);
    const receipt = f.coordinator.request("ask", input());
    await assert.rejects(f.coordinator.completeYield(new PiRunnerYielded(receipt, stoppedAt)), error => error.code === "user_input_stop_time_invalid");
    assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
    assert.equal(f.store.getRun(f.run.id).status, "running");
  }
});

for (const mode of ["required", "optional"]) {
  test(`cancelled ${mode} request replay cannot close a reconstructed coordinator`, async t => {
    const f = await fixture(t);
    const receipt = f.coordinator.request("same-tool", input(mode));
    f.store.cancelUserInputRequest({ threadId: f.thread.id, requestId: receipt.requestId,
      expectedStatusRevision: 1 }, new Date().toISOString());
    const group = new AttemptExecutorGroup({ source: f.group.source,
      isCurrentExecutionOwner: source => f.store.isCurrentRunExecutionOwner(source.runId, source),
      verifySettlement: () => false, persistBlockedOperation: () => false });
    const reopened = new (f.coordinator.constructor)({ store: f.store, runId: f.run.id, sourceItemId: f.turn.item.id,
      sourceFence: f.fence, runnerId: f.attempt.runnerId, executorGroup: group });
    assert.throws(() => reopened.request("same-tool", input(mode)), error => error.code === "user_input_request_not_active");
    assert.equal(group.isAdmissionOpen(), true);
    assert.equal(group.getSnapshot().requiredInput, undefined);
    assert.equal(f.store.getUserInputWait(f.thread.id, receipt.requestId), undefined);
    assert.equal(f.store.getRun(f.run.id).status, "running");
    assert.equal(f.store.getUserInputRequest(f.thread.id, receipt.requestId).status, "cancelled");
  });
}

for (const answered of [false, true]) {
  test(`recovered required expiry checks pending only, preserving accepted answers: answered=${answered}`, async t => {
    const f = await fixture(t);
    const start = Date.now();
    const at = offset => new Date(start + offset).toISOString();
    const request = f.store.createUserInputRequest({ sourceRunId: f.run.id, sourceItemId: f.turn.item.id,
      sourceFence: f.fence, toolCallId: "expiry", idempotencyKey: "expiry", toolInput: input(), expiresAt: at(1000) }, at(0)).request;
    if (answered) f.store.submitUserInputAnswer({ threadId: f.thread.id, submission: { schemaVersion: 1, requestId: request.requestId,
      expectedVersion: 1, expectedStatusRevision: 1, idempotencyKey: "before-expiry", answers: [{ questionId: "choice", kind: "text", text: "A" }] } }, at(500));
    const coordinator = new (f.coordinator.constructor)({ store: f.store, runId: f.run.id, sourceItemId: f.turn.item.id,
      sourceFence: f.fence, runnerId: f.attempt.runnerId, executorGroup: f.group, now: () => at(2000) });
    if (!answered) {
      assert.throws(() => coordinator.beforeBoundary(), error => error.code === "user_input_request_not_active");
      assert.equal(f.group.isAdmissionOpen(), true);
      assert.equal(f.group.getSnapshot().requiredInput, undefined);
      assert.equal(f.store.getUserInputWait(f.thread.id, request.requestId), undefined);
    } else {
      const directive = coordinator.beforeBoundary();
      assert.equal(directive.requestId, request.requestId);
      assert.equal((await coordinator.completeYield(new PiRunnerYielded(directive, at(2000)))).kind, "committed");
      assert.equal(f.store.getUserInputRequest(f.thread.id, request.requestId).status, "answered");
    }
  });
}

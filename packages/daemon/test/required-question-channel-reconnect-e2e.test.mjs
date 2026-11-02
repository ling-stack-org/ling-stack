import assert from "node:assert/strict";
import test from "node:test";
import { createRequiredQuestionChannelFixture } from "./support/required-question-channel-e2e-fixture.mjs";

test("required channel answer and completion survive SSE disconnect and a fresh Daemon without duplicate execution", { timeout: 45_000 }, async (t) => {
  const fixture = await createRequiredQuestionChannelFixture(t);
  const created = await fixture.postChannelTurn();
  const question = await fixture.waitForQuestion();
  const stream = await openControlPlaneReplay(fixture, 0);
  t.after(() => stream.close());
  const initial = await stream.readReplay();
  assert.ok(initial.events.some((event) => event.entityType === "user_input_request"
    && event.entityId === question.request.requestId && event.action === "pending"));
  const cursor = initial.window.nextAfterSeq;
  assert.ok(Number.isSafeInteger(cursor) && cursor > 0);
  await stream.close();

  // The real HTTP observer is disconnected before acceptance, Runner ACK,
  // tool evidence and terminal fan-in. None of those are synthesized by replay.
  const accepted = await fixture.answerQuestion();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.receipt.replayed, false);
  const { deliveryId } = accepted.receipt;
  await fixture.waitForCondition(() => {
    const delivery = fixture.store.getUserInputDelivery(question.sourceThread.id, deliveryId);
    const receipt = fixture.store.getUserInputContinuationReceipt(question.sourceThread.id, deliveryId);
    return delivery?.status === "applied" && receipt?.acceptance.boundary === "pi-session-ready";
  }, "real answer receiver acknowledgment while SSE is disconnected");
  await fixture.waitForCondition(() => fixture.transport.barrierReached,
    "QA read to reach its terminal barrier while SSE is disconnected");
  const beforeRelease = fixture.store.getChannelWorkflow(fixture.workflow.id);
  assert.notEqual(beforeRelease.status, "succeeded");
  assert.equal(fixture.store.listTerminalReports({ sourceKind: "workflow", sourceId: beforeRelease.id, limit: 20 }).length, 0);
  fixture.releaseParticipant("teammate_builtin_qa");
  await fixture.waitForCondition(() => {
    const workflow = fixture.store.getChannelWorkflow(fixture.workflow.id);
    const reports = fixture.store.listTerminalReports({ sourceKind: "workflow", sourceId: workflow.id, limit: 20 });
    return workflow.status === "succeeded" && workflow.metadata.completionGate?.status === "verified"
      && fixture.store.getLingTurn(fixture.turn.id)?.status === "succeeded" && reports.length === 1
      && Boolean(reports[0].resultItemId);
  }, "terminal fan-in to commit while SSE is disconnected");

  const beforeRestart = captureDurableCompletion(fixture, question, accepted.receipt);
  const callsBeforeRestart = structuredClone(fixture.providerCalls);
  assert.equal(fixture.daemonGeneration, 1);
  await fixture.restartDaemon();
  assert.equal(fixture.daemonGeneration, 2);
  assert.deepEqual(captureDurableCompletion(fixture, question, accepted.receipt), beforeRestart,
    "fresh SQLite reader must recover exact canonical facts, not create substitutes");

  const reconnected = await openControlPlaneReplay(fixture, cursor);
  t.after(() => reconnected.close());
  const replay = await reconnected.readReplay();
  await reconnected.close();
  const recoveryFailures = fixture.store.listControlPlaneEvents({
    workspaceId: fixture.channel.workspaceId,
    entityType: "terminal_report",
    action: "terminal_report.recovery_failed",
    limit: 100,
  });
  assert.deepEqual(recoveryFailures, [],
    `reopening an unchanged completed workflow must not report a publication conflict: ${JSON.stringify(recoveryFailures.map((event) => event.data))}`);
  assert.ok(replay.window.nextAfterSeq > cursor);
  assert.equal(replay.window.disposition, "complete");
  const sequences = replay.events.map((event) => event.seq);
  assert.equal(new Set(sequences).size, sequences.length, "one reconnect must not duplicate durable event sequences");
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
  assert.ok(sequences.every((sequence) => sequence > cursor));
  assert.ok(replay.events.some((event) => event.entityType === "user_input_request"
    && event.entityId === question.request.requestId && event.action === "answered"));
  assert.ok(replay.events.some((event) => event.entityType === "user_input_wait"
    && event.entityId === question.request.requestId && event.action === "resumed"));
  assert.ok(replay.events.some((event) => event.entityType === "user_input_delivery"
    && event.entityId === deliveryId && event.action === "applied"));
  const projected = await fixture.readWorkflowSteps();
  assert.deepEqual(projected.map((step) => ({ id: step.id, runId: step.runId, status: step.status })),
    beforeRestart.steps.map(({ id, runId, status }) => ({ id, runId, status })));

  // Reuse the original visible authority and idempotency key after restart.
  // A saved receipt must remain a replay even though its source is no longer pending.
  const repeated = await fixture.answerQuestion();
  assert.equal(repeated.accepted, true);
  assert.equal(repeated.receipt.replayed, true);
  assert.deepEqual({ ...repeated.receipt, replayed: false }, accepted.receipt);
  assert.deepEqual(captureDurableCompletion(fixture, question, accepted.receipt), beforeRestart);
  assert.deepEqual(fixture.providerCalls, callsBeforeRestart,
    "restart, SSE replay and a duplicate answer must not make another model request or tool execution");

  // An unavailable cursor is a typed fallback, never successful replay.
  const unavailable = await openControlPlaneReplay(fixture, replay.window.upperBoundSeq + 1);
  t.after(() => unavailable.close());
  const required = await unavailable.nextEvent();
  assert.equal(required.event, "control_plane_snapshot_required");
  assert.equal(required.data.reason, "cursor_unavailable");
  await unavailable.close();
  assert.equal(created.autoStartedWorkflow.workflowSteps.length, 2);
});

function captureDurableCompletion(fixture, question, accepted) {
  const store = fixture.store;
  const binding = store.getUserInputContinuationBinding(question.sourceThread.id, accepted.deliveryId);
  const receipt = store.getUserInputContinuationReceipt(question.sourceThread.id, accepted.deliveryId);
  const delivery = store.getUserInputDelivery(question.sourceThread.id, accepted.deliveryId);
  const wait = store.getUserInputWait(question.sourceThread.id, question.request.requestId);
  assert.ok(binding && receipt && delivery && wait);
  assert.equal(delivery.status, "applied");
  assert.equal(wait.status, "resumed");
  assert.equal(receipt.acceptance.runId, binding.runId);
  assert.equal(receipt.acceptance.attemptId, binding.fence.attemptId);
  const items = store.listConversationItemsForTurn({ turnId: question.sourceTurn.id })
    .filter((item) => item.kind === "user_input_request" || item.kind === "user_input_answer");
  assert.equal(items.filter((item) => item.kind === "user_input_request").length, 1);
  assert.equal(items.filter((item) => item.kind === "user_input_answer").length, 1);
  assert.equal(items.find((item) => item.kind === "user_input_request").id, question.item.id);
  assert.equal(items.find((item) => item.kind === "user_input_answer").id, accepted.answerItemId);
  const transcript = store.readUserInputTranscript({ threadId: question.sourceThread.id, itemIds: items.map((item) => item.id) });
  assert.ok(transcript.every((record) => record.availability === "available"));
  assert.equal(transcript.find((record) => record.kind === "user_input_answer").delivery.status, "applied");
  const runs = store.listRuns({ workflowStepId: question.sourceStep.id, limit: 200 });
  assert.equal(runs.filter((run) => run.parentRunId === question.sourceRun.id && run.continuationReason === "user_input_answer").length, 1);
  const steps = fixture.steps.map((seed) => store.getChannelWorkflowStep(seed.id));
  const actions = steps.map((step) => {
    assert.equal(step.status, "succeeded");
    const rows = fixture.actionsForRun(step.runId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actionType, "read");
    assert.equal(rows[0].status, "succeeded");
    return rows;
  });
  const reports = store.listTerminalReports({ sourceKind: "workflow", sourceId: fixture.workflow.id, limit: 20 });
  assert.equal(reports.length, 1);
  const turnSuccess = store.listStateTransitionEvents({ entityType: "turn", entityId: fixture.turn.id })
    .filter((event) => event.toStatus === "succeeded");
  assert.equal(turnSuccess.length, 1);
  return { binding, receipt, delivery, wait, items, transcript, runs, steps, actions, reports, turnSuccess };
}

async function openControlPlaneReplay(fixture, afterSeq) {
  const controller = new AbortController();
  const timeoutMs = 10_000;
  const response = await bounded(fetch(`${fixture.url}/control-plane/stream?cwd=${encodeURIComponent(fixture.cwd)}&afterSeq=${afterSeq}&domains=runs,work_units`, {
    signal: controller.signal,
  }), timeoutMs, "SSE connection", () => controller.abort());
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type")?.startsWith("text/event-stream"));
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;
  const stream = {
    async nextEvent() {
      const read = async () => {
        for (;;) {
          const index = buffer.indexOf("\n\n");
          if (index >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const lines = block.split("\n");
            const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
            if (data.length) return { event: lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message",
              data: JSON.parse(data.join("\n")) };
            continue;
          }
          const { value, done } = await reader.read();
          assert.equal(done, false, "SSE ended before its expected replay event");
          buffer += decoder.decode(value, { stream: true });
        }
      };
      return await bounded(read(), timeoutMs, "SSE replay event", () => controller.abort());
    },
    async readReplay() {
      const events = [];
      for (let count = 0; count < 2_000; count += 1) {
        const event = await stream.nextEvent();
        assert.notEqual(event.event, "control_plane_snapshot_required", "the saved cursor must remain replayable after restart");
        if (event.event === "control_plane_replay_ready") return { events, window: event.data };
        if (event.event === "control_plane_event") events.push(event.data);
        else assert.equal(event.event, "heartbeat");
      }
      assert.fail("SSE replay exceeded its bounded event budget");
    },
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      await bounded(reader.cancel().catch(() => {}), timeoutMs, "SSE close", () => controller.abort());
    },
  };
  return stream;
}

async function bounded(promise, timeoutMs, label, onTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error(`Timed out waiting for ${label}`)); }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

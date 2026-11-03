import assert from "node:assert/strict";
import test from "node:test";
import { createDelegationRunnerToolHandler } from "../dist/features/harness/delegations/runner-tools.js";

const observation = (changes = {}) => ({
  reservationId: "reservation-1",
  stepId: "step-1",
  childRunId: "child-run-1",
  rootRunId: "root-run-private",
  state: "running",
  stepRevision: 2,
  runStatus: "running",
  attemptId: "attempt-private",
  classification: "active",
  ...changes,
});

function fixture() {
  const calls = [];
  const waitSignal = new AbortController().signal;
  const tools = {
    spawn(input) { calls.push(["spawn", input]); return { ...observation(), replayed: false }; },
    message(input) { calls.push(["message", input]); return { status: "durable_queued", messageId: "message-1", replayed: false }; },
    async wait(input) { calls.push(["wait", input]); return { timedOut: false, observation: observation({ classification: "terminal", state: "succeeded", runStatus: "succeeded" }) }; },
    interrupt(input) { calls.push(["interrupt", input]); return { ...observation({ state: "interrupting" }), replayed: false }; },
    resume(input) { calls.push(["resume", input]); return { ...observation({ state: "resuming", stepRevision: 3 }), replayed: false }; },
  };
  return { calls, waitSignal, handler: createDelegationRunnerToolHandler({ tools, signal: waitSignal }) };
}

test("maps all five model tools to the exact Host call identity and bounded input", async () => {
  const f = fixture();
  const spawned = await f.handler({ toolName: "spawn_agent", toolCallId: "call-spawn",
    input: { objective: "Inspect the isolated target.", required: true, participantId: "engineer",
      requestedBudget: { tokenBudget: 100, costBudgetMicros: 200, wallTimeBudgetMs: 300 } } });
  const messaged = await f.handler({ toolName: "send_message", toolCallId: "call-message",
    input: { reservationId: "reservation-1", text: "Use the current evidence." } });
  const waited = await f.handler({ toolName: "wait_agent", toolCallId: "call-wait",
    input: { reservationId: "reservation-1", timeoutMs: 500 } });
  const interrupted = await f.handler({ toolName: "interrupt_agent", toolCallId: "call-interrupt",
    input: { reservationId: "reservation-1" } });
  const resumed = await f.handler({ toolName: "resume_agent", toolCallId: "call-resume",
    input: { reservationId: "reservation-1", expectedStepRevision: 2 } });

  assert.deepEqual(f.calls.map(([name]) => name), ["spawn", "message", "wait", "interrupt", "resume"]);
  assert.equal(f.calls[0][1].spawnCallId, "call-spawn");
  assert.equal(f.calls[1][1].messageCallId, "call-message");
  assert.equal(f.calls[2][1].signal, f.waitSignal);
  assert.equal(f.calls[3][1].callId, "call-interrupt");
  assert.equal(f.calls[4][1].expectedStepRevision, 2);
  assert.equal(spawned.status, "accepted");
  assert.deepEqual(messaged, { status: "durable_queued", messageId: "message-1" });
  assert.equal(waited.status, "terminal");
  assert.equal(waited.timedOut, false);
  assert.equal(interrupted.status, "interrupt_requested");
  assert.equal(resumed.status, "resume_requested");
});

test("public receipts expose lineage observations without private root or Attempt identity", async () => {
  const f = fixture();
  const result = await f.handler({ toolName: "spawn_agent", toolCallId: "call-spawn",
    input: { objective: "Inspect.", required: false, requestedBudget: {} } });
  assert.deepEqual(Object.keys(result).sort(),
    ["childRunId", "reservationId", "state", "status", "stepId", "stepRevision"].sort());
  assert.doesNotMatch(JSON.stringify(result), /root-run-private|attempt-private/);
});

test("rejects malformed, accessor, oversized and zero-budget model input before Host tools", async () => {
  const f = fixture();
  const accessor = { required: true, requestedBudget: {} };
  Object.defineProperty(accessor, "objective", { enumerable: true, get() { throw new Error("getter must not run"); } });
  const cases = [
    { toolName: "spawn_agent", toolCallId: "call", input: { objective: "x", required: true, requestedBudget: {}, extra: true } },
    { toolName: "spawn_agent", toolCallId: "call", input: accessor },
    { toolName: "spawn_agent", toolCallId: "x".repeat(1_025), input: { objective: "x", required: true, requestedBudget: {} } },
    { toolName: "spawn_agent", toolCallId: "call", input: { objective: "x", required: true, requestedBudget: { tokenBudget: 0 } } },
    { toolName: "send_message", toolCallId: "call", input: { reservationId: "r", text: "x".repeat(16_001) } },
    { toolName: "wait_agent", toolCallId: "call", input: { reservationId: "r", timeoutMs: 60_001 } },
    { toolName: "resume_agent", toolCallId: "call", input: { reservationId: "r", expectedStepRevision: 0 } },
  ];
  for (const candidate of cases) await assert.rejects(() => f.handler(candidate), { code: "delegation.invalid_input" });
  assert.equal(f.calls.length, 0);
});

test("blocked and timed-out observations remain explicit and never become success", async () => {
  const calls = [];
  const tools = {
    spawn() { return { ...observation({ code: "delegation.dispatch_blocked" }), replayed: false }; },
    message() { return { status: "durable_queued", messageId: "message-1", replayed: false }; },
    async wait(input) { calls.push(input); return { timedOut: true, observation: observation() }; },
    interrupt() { return { ...observation({ code: "delegation.source_attempt_stale" }), replayed: false }; },
    resume() { return { ...observation({ code: "delegation.source_attempt_stale" }), replayed: false }; },
  };
  const handler = createDelegationRunnerToolHandler({ tools, signal: new AbortController().signal });
  const spawned = await handler({ toolName: "spawn_agent", toolCallId: "spawn",
    input: { objective: "Inspect.", required: true, requestedBudget: {} } });
  const waited = await handler({ toolName: "wait_agent", toolCallId: "wait",
    input: { reservationId: "reservation-1", timeoutMs: 0 } });
  assert.equal(spawned.status, "blocked");
  assert.equal(spawned.code, "delegation.dispatch_blocked");
  assert.equal(waited.status, "timed_out");
  assert.equal(waited.timedOut, true);
  assert.equal(calls.length, 1);
});

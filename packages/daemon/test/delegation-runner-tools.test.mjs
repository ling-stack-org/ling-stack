import assert from "node:assert/strict";
import test from "node:test";
import { DelegationLifecycleError, DelegationWriteError } from "@ling-stack/core";
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

function fixture(overrides = {}) {
  const calls = [];
  const waitSignal = new AbortController().signal;
  const tools = {
    spawn(input) { calls.push(["spawn", input]); return { ...observation(), replayed: false }; },
    message(input) { calls.push(["message", input]); return { status: "durable_queued", messageId: "message-1", replayed: false }; },
    async wait(input) { calls.push(["wait", input]); return { timedOut: false, observation: observation({ classification: "terminal", state: "succeeded", runStatus: "succeeded" }) }; },
    interrupt(input) { calls.push(["interrupt", input]); return { ...observation({ state: "interrupting" }), replayed: false }; },
    resume(input) { calls.push(["resume", input]); return { ...observation({ state: "resuming", stepRevision: 3 }), replayed: false }; },
    ...overrides,
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

const capacityCode = "delegation.capacity_exhausted";
const admissionRequests = [
  ["spawn", { toolName: "spawn_agent", toolCallId: "spawn-capacity",
    input: { objective: "Inspect.", required: true, requestedBudget: {} } }, "accepted"],
  ["resume", { toolName: "resume_agent", toolCallId: "resume-capacity",
    input: { reservationId: "reservation-1", expectedStepRevision: 2 } }, "resume_requested"],
];

for (const [method, request, successStatus] of admissionRequests) {
  for (const ErrorClass of [DelegationWriteError, DelegationLifecycleError]) {
    test(`${method} returns an ID-free blocked receipt for ${ErrorClass.name} capacity exhaustion`, async () => {
      const failure = Object.assign(new ErrorClass(capacityCode), {
        reservationId: "uncommitted-reservation", childRunId: "uncommitted-child", stepId: "uncommitted-step",
      });
      const calls = [];
      const f = fixture({ [method](input) {
        calls.push(input);
        if (calls.length === 1) throw failure;
        return { ...observation(), replayed: false };
      } });
      const result = await f.handler(request);
      assert.deepEqual(result, { status: "blocked", code: capacityCode });
      assert.ok(Object.isFrozen(result));
      assert.equal(calls.length, 1);
      assert.equal(calls[0][method === "spawn" ? "spawnCallId" : "callId"], request.toolCallId);
      const accepted = await f.handler({ ...request, toolCallId: `${request.toolCallId}-retry` });
      assert.equal(accepted.status, successStatus);
      assert.equal(accepted.childRunId, "child-run-1");
      assert.equal(calls.length, 2);
    });
  }

  test(`${method} rethrows non-capacity and untrusted errors without changing their identity`, async () => {
    const failures = [
      new DelegationWriteError("delegation.budget_exhausted"),
      new DelegationWriteError("delegation.source_attempt_stale"),
      new DelegationLifecycleError("delegation.lifecycle_conflict"),
      new DelegationLifecycleError("delegation.authority_invalid"),
      Object.assign(new DelegationWriteError(capacityCode), { code: `${capacityCode}.retry` }),
      Object.assign(new DelegationLifecycleError(capacityCode), { code: `${capacityCode} ` }),
      new Error("SQLite admission failed"),
      Object.assign(new Error(capacityCode), { code: capacityCode, name: "DelegationWriteError" }),
      { code: capacityCode, name: "DelegationLifecycleError" },
      capacityCode, null, undefined,
    ];
    for (const failure of failures) {
      let calls = 0;
      const f = fixture({ [method]() { calls++; throw failure; } });
      await assert.rejects(() => f.handler(request), error => error === failure);
      assert.equal(calls, 1);
    }
  });
}

for (const [method, request] of [
  ["message", { toolName: "send_message", toolCallId: "message-capacity",
    input: { reservationId: "reservation-1", text: "Continue." } }],
  ["wait", { toolName: "wait_agent", toolCallId: "wait-capacity",
    input: { reservationId: "reservation-1", timeoutMs: 0 } }],
  ["interrupt", { toolName: "interrupt_agent", toolCallId: "interrupt-capacity",
    input: { reservationId: "reservation-1" } }],
]) {
  test(`${method} does not reinterpret capacity errors as admission results`, async () => {
    for (const ErrorClass of [DelegationWriteError, DelegationLifecycleError]) {
      const failure = new ErrorClass(capacityCode);
      const fail = () => { throw failure; };
      const f = fixture({ [method]: method === "wait" ? async () => fail() : fail });
      await assert.rejects(() => f.handler(request), error => error === failure);
    }
  });
}

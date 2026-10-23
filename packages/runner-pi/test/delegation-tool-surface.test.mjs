import assert from "node:assert/strict";
import test from "node:test";
import { createLingStackDelegationExtension, DELEGATION_TOOL_NAMES } from "../dist/extensions/delegation.js";
import { createPiTaskBoundary } from "../dist/task-boundary.js";

const base = extra => ({ cwd: process.cwd(), task: { id: "task", title: "Task", prompt: "Delegate" },
  provider: { provider: "fixture", model: "fixture" }, ...extra });
function toolsFor(options) {
  const tools = [];
  createLingStackDelegationExtension(options)({ registerTool: tool => tools.push(tool) });
  return tools;
}
const surface = { mediaGeneration: false, toolHydration: false, delegation: true };

test("delegation is absent by default and requires an explicit prepared schema selection", () => {
  assert.deepEqual(toolsFor(base({ onDelegationToolCall: () => ({ status: "blocked" }) })), []);
  assert.deepEqual(toolsFor(base({ initialToolSurface: { ...surface, delegation: false } })), []);
  assert.deepEqual(toolsFor(base({ initialToolSurface: surface })).map(tool => tool.name), DELEGATION_TOOL_NAMES);
});

test("schema-only delegation execution cannot run without a live Host handler", async () => {
  const tools = toolsFor(base({ initialToolSurface: surface }));
  for (const tool of tools) {
    assert.equal(tool.executionMode, "sequential");
    assert.equal(tool.parameters.additionalProperties, false);
    await assert.rejects(tool.execute("call", {}), /delegation_host_handler_missing/);
  }
});

test("model parameters cannot declare parent, fence, provider or permission identity", () => {
  for (const tool of toolsFor(base({ initialToolSurface: surface }))) {
    for (const name of ["parentRunId", "sourceFence", "store", "provider", "permissions", "cwd", "runtimeInstanceId"]) {
      assert.equal(Object.hasOwn(tool.parameters.properties, name), false);
    }
  }
});

test("delegation forwards untrusted arguments and SDK call identity, not a second identity supplied by model", async () => {
  const calls = [];
  const boundary = createPiTaskBoundary(base({ initialToolSurface: surface,
    onDelegationToolCall: request => { calls.push(request); return { status: "queued", reservationId: "reservation-1" }; } }));
  const [spawn] = toolsFor(boundary.options);
  const input = { objective: "Read the dedicated QA file", required: true, requestedBudget: { tokenBudget: 5000 } };
  const result = await spawn.execute("sdk-call-1", input);
  assert.deepEqual(calls, [{ toolName: "spawn_agent", toolCallId: "sdk-call-1", input }]);
  assert.deepEqual(result.details, { status: "queued", reservationId: "reservation-1" });
  assert.doesNotMatch(result.content[0].text, /completed|succeeded|delivered/);
});

test("a newly spawning child exposes its production zero-based step revision", async () => {
  const receipt = { status: "accepted", reservationId: "reservation-1", childRunId: "child-1",
    stepId: "step-1", state: "spawning", stepRevision: 0 };
  const [spawn] = toolsFor(base({ initialToolSurface: surface, onDelegationToolCall: () => receipt }));
  const result = await spawn.execute("sdk-spawn-1", {
    objective: "Read the dedicated QA file", required: true, requestedBudget: { tokenBudget: 5000 },
  });
  assert.deepEqual(result.details, receipt);
  assert.deepEqual(JSON.parse(result.content[0].text), receipt);
  assert.equal(Object.isFrozen(result.details), true);
});

test("observation revisions retain positive safe-integer support", async () => {
  for (const stepRevision of [1, Number.MAX_SAFE_INTEGER]) {
    const [spawn] = toolsFor(base({ initialToolSurface: surface,
      onDelegationToolCall: () => ({ status: "accepted", stepRevision }) }));
    const result = await spawn.execute("call", {});
    assert.equal(result.details.stepRevision, stepRevision);
    assert.equal(JSON.parse(result.content[0].text).stepRevision, stepRevision);
  }
});

for (const [label, stepRevision] of [
  ["negative", -1], ["fraction", 0.5], ["positive fraction", 1.5], ["NaN", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY], ["negative infinity", Number.NEGATIVE_INFINITY],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["string", "0"], ["null", null], ["boolean", false],
]) test(`observation rejects an invalid step revision: ${label}`, async () => {
  const [spawn] = toolsFor(base({ initialToolSurface: surface,
    onDelegationToolCall: () => ({ status: "accepted", stepRevision }) }));
  await assert.rejects(spawn.execute("call", {}), /delegation_host_result_invalid/);
});

test("resume still requires a positive expected step revision rather than an observation's zero-based bound", () => {
  const resume = toolsFor(base({ initialToolSurface: surface })).find(tool => tool.name === "resume_agent");
  assert.deepEqual(resume.parameters.properties.expectedStepRevision,
    { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
  assert.ok(resume.parameters.required.includes("expectedStepRevision"));
});

test("cancellation and a required question close delegation dispatch before any Host callback", async () => {
  let calls = 0;
  const stop = new AbortController();
  const boundary = createPiTaskBoundary(base({ signal: stop.signal, initialToolSurface: surface,
    onDelegationToolCall: () => { calls++; return { status: "queued" }; } }));
  stop.abort(new Error("cancelled"));
  await assert.rejects(toolsFor(boundary.options)[0].execute("cancelled-call", {}));
  assert.equal(calls, 0);
  const paused = createPiTaskBoundary(base({ initialToolSurface: surface,
    onUserInputRequest: () => ({ kind: "user_input_required", requestId: "question", requestVersion: 1 }),
    onDelegationToolCall: () => { calls++; return { status: "queued" }; } }));
  await paused.options.onUserInputRequest({ toolCallId: "ask", input: { schemaVersion: 1, waitMode: "required", questions: [] } });
  await assert.rejects(toolsFor(paused.options)[0].execute("paused-call", {}), /Required user input/);
  assert.equal(calls, 0);
});

test("a Host receipt arriving after cancellation is not exposed as a successful delegation result", async () => {
  const stop = new AbortController();
  const boundary = createPiTaskBoundary(base({ signal: stop.signal, initialToolSurface: surface,
    onDelegationToolCall: () => { stop.abort(new Error("cancelled")); return { status: "queued" }; } }));
  await assert.rejects(toolsFor(boundary.options)[0].execute("late-call", {}));
});

test("tool result accepts only the closed public receipt, never Host custody or a whole private Run", async () => {
  for (const result of [{ status: "queued", store: {} }, { status: "queued", runtime: { privateText: "private" } },
    { status: "queued", childRunId: "x".repeat(1025) }, { status: "queued", timedOut: "false" }]) {
    const [tool] = toolsFor(base({ initialToolSurface: surface, onDelegationToolCall: () => result }));
    await assert.rejects(tool.execute("call", {}), /delegation_host_result_invalid/);
  }
});

test("unexpected Host failures latch closed even when SDK treats a tool failure as recoverable", async () => {
  const failure = new Error("delegation write outcome unknown");
  let calls = 0;
  const boundary = createPiTaskBoundary(base({ initialToolSurface: surface,
    onDelegationToolCall: () => { calls++; throw failure; } }));
  const [tool] = toolsFor(boundary.options);
  await assert.rejects(tool.execute("first", {}), error => error === failure);
  assert.equal(boundary.failure, failure);
  await assert.rejects(tool.execute("second", {}), error => error === failure);
  assert.equal(calls, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createPiTaskBoundary } from "../dist/task-boundary.js";

const required = { kind: "user_input_required", requestId: "request_1", requestVersion: 1 };
const optional = { kind: "user_input_optional", requestId: "request_1", requestVersion: 1 };
const params = { schemaVersion: 1, waitMode: "required", questions: [{ questionId: "q", prompt: "Choose", required: true,
  allowFreeText: true, options: [{ optionId: "a", label: "A" }] }] };
function base(extra = {}) {
  return { cwd: process.cwd(), task: { id: "task", title: "Task", prompt: "Ask" },
    provider: { provider: "test", model: "test" }, ...extra };
}
async function toolFor(options) {
  const { createLingStackUserInputExtension } = await import("../dist/extensions/user-input.js");
  const tools = [];
  createLingStackUserInputExtension(options)({ registerTool: tool => tools.push(tool) });
  return tools;
}

test("required request closes the shared Runner latch before its callback resolves to SDK", async () => {
  let effects = 0;
  const boundary = createPiTaskBoundary(base({ onUserInputRequest: () => required,
    onMcpToolCall: () => { effects++; } }));
  const response = await boundary.options.onUserInputRequest({ toolCallId: "ask", input: params });
  assert.deepEqual(response, required);
  assert.deepEqual(boundary.yieldRequest, required);
  assert.throws(() => boundary.options.onMcpToolCall({}), /Required user input/);
  assert.equal(effects, 0);
  assert.equal(boundary.failure, undefined);
});

test("all actual Host callback dispatches reject after required input, including a second question", async () => {
  const names = ["onToolBefore", "onApprovalRequired", "onPermissionRequired", "onToolHydrationRequest",
    "onMcpToolCall", "onHostCapabilityCall", "onMediaGenerationToolCall"];
  let calls = 0;
  const options = base({ onUserInputRequest: () => required });
  for (const name of names) options[name] = () => { calls++; };
  const boundary = createPiTaskBoundary(options);
  await boundary.options.onUserInputRequest({ toolCallId: "ask", input: params });
  for (const name of names) assert.throws(() => boundary.options[name]({}), /Required user input/);
  await assert.rejects(boundary.options.onUserInputRequest({ toolCallId: "ask2", input: params }), /Required user input/);
  assert.equal(calls, 0);
});

test("optional question stays open and freezes a closed Host receipt", async () => {
  const mutable = { ...optional };
  const boundary = createPiTaskBoundary(base({ onUserInputRequest: () => mutable }));
  const response = await boundary.options.onUserInputRequest({ toolCallId: "ask", input: { ...params, waitMode: "optional" } });
  mutable.requestId = "mutated";
  assert.equal(response.requestId, "request_1");
  assert.ok(Object.isFrozen(response));
  assert.equal(boundary.yieldRequest, undefined);
  boundary.assertOpen();
});

test("Host request failure closes execution even if SDK treats it as tool error", async () => {
  const failure = new Error("request persistence unavailable");
  const boundary = createPiTaskBoundary(base({ onUserInputRequest: () => { throw failure; } }));
  await assert.rejects(boundary.options.onUserInputRequest({ toolCallId: "ask", input: params }), error => error === failure);
  assert.equal(boundary.failure, failure);
  assert.throws(boundary.assertOpen, error => error === failure);
});

test("invalid or mismatched Host receipts fail closed without retaining authority fields", async () => {
  for (const response of [{ ...required, fence: "forged" }, { ...required, requestVersion: 0 }, optional]) {
    const boundary = createPiTaskBoundary(base({ onUserInputRequest: () => response }));
    await assert.rejects(boundary.options.onUserInputRequest({ toolCallId: "ask", input: params }), /Invalid user input/);
    assert.ok(boundary.failure);
    assert.equal(boundary.yieldRequest, undefined);
    assert.throws(boundary.assertOpen);
  }
});

test("user cancellation wins over a late question receipt", async () => {
  const abort = new AbortController();
  const reason = new Error("user cancelled");
  const boundary = createPiTaskBoundary(base({ signal: abort.signal, onUserInputRequest: () => { abort.abort(reason); return required; } }));
  await assert.rejects(boundary.options.onUserInputRequest({ toolCallId: "ask", input: params }));
  assert.equal(boundary.yieldRequest, undefined);
  assert.equal(boundary.failure, undefined);
});

test("question tool is absent by default, internal Host callback opts it in sequentially", async () => {
  assert.equal((await toolFor(base())).length, 0);
  const [tool] = await toolFor(base({ onUserInputRequest: () => required }));
  assert.equal(tool.name, "request_user_input");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ["schemaVersion", "waitMode", "questions"]);
  assert.equal(tool.parameters.properties.questions.maxItems, 3);
  assert.equal(tool.parameters.properties.questions.items.additionalProperties, false);
  assert.equal(tool.parameters.properties.questions.items.properties.options.maxItems, 4);
});

test("tool forwards only toolCallId and untrusted questions to Host; result is not an answer or success", async () => {
  const calls = [];
  const boundary = createPiTaskBoundary(base({ onUserInputRequest: request => { calls.push(request); return required; } }));
  const [tool] = await toolFor(boundary.options);
  const result = await tool.execute("ask", params);
  assert.deepEqual(calls, [{ toolCallId: "ask", input: params }]);
  assert.deepEqual(result.details, required);
  assert.match(result.content[0].text, /saved/i);
  assert.doesNotMatch(result.content[0].text, /task completed|approved|received/i);
  assert.deepEqual(boundary.yieldRequest, required);
});

test("provider cannot dispatch after required input even when a tool was already prepared", async () => {
  let modelCalls = 0;
  const runtime = { streamSimple: () => { modelCalls++; } };
  const boundary = createPiTaskBoundary(base({ onUserInputRequest: () => required }));
  boundary.bindModelRuntime(runtime);
  await boundary.options.onUserInputRequest({ toolCallId: "ask", input: params });
  assert.throws(() => runtime.streamSimple({}, { messages: [] }, {}), /Required user input/);
  assert.equal(modelCalls, 0);
});

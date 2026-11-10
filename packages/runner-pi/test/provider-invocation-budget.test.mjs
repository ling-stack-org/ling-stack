import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore,
  InMemoryModelsStore, normalizeContext } from "@earendil-works/pi-ai";
import { generateSummaryWithUsage, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiTaskBoundary } from "../dist/task-boundary.js";
import { assertPiModelContextCapacity, estimatePiModelContextBudget } from "../dist/prepared-input.js";
import { createPiProviderInvocation } from "../dist/provider-invocation.js";

const selectedModel = {
  provider: "invocation-budget-fixture", id: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 8_192, maxTokens: 1_024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const privateMarker = "synthetic-private-budget-marker";
const context = () => ({ systemPrompt: `${privateMarker}-system`, tools: [{ name: "fixture_tool",
  description: `${privateMarker}-tool`, parameters: { type: "object", properties: { value: { type: "string" } } } }],
messages: [{ role: "user", content: `${privateMarker}-user 汉字🙂`, timestamp: 0 }] });
const finalMessage = (model) => ({ role: "assistant", content: [{ type: "text", text: "Fixture result." }],
  api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "stop" });

/** Actual SDK preparation/composed dispatch with an isolated, non-network provider. */
async function fixture(controls = {}) {
  const model = { ...selectedModel, ...controls.model };
  const admitted = [], settled = [], requests = [];
  const options = {
    cwd: process.cwd(), task: { id: "budget-task", title: "Budget fixture", prompt: "Fixture prompt." },
    runId: "budget-run", runnerAttemptId: "budget-attempt",
    provider: { provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, apiKey: `${privateMarker}-key` },
    onProviderInvocationAdmitted: (receipt) => admitted.push(receipt),
    onProviderInvocationSettled: (receipt) => settled.push(receipt),
    ...controls.options,
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(model.provider, { api: model.api, apiKey: options.provider.apiKey,
    streamSimple: (requestModel, requestContext, requestOptions) => {
      const stream = createAssistantMessageEventStream();
      requests.push({ model: requestModel, context: requestContext, options: requestOptions });
      void (async () => {
        try {
          await controls.beforePayload?.(requestContext);
          await requestOptions.onPayload({}, requestModel);
          await controls.beforeResult?.(requestContext);
          stream.push({ type: "done", reason: "stop", message: finalMessage(requestModel) });
        } catch (error) {
          stream.push({ type: "error", reason: "error", error: { ...finalMessage(requestModel), stopReason: "error", errorMessage: error.message } });
        }
      })();
      return stream;
    } });
  const boundary = createPiTaskBoundary(options);
  boundary.bindModelRuntime(runtime);
  return { runtime, model, options, boundary, admitted, settled, requests };
}

/** Independent code-point oracle, applied only to synthetic fixture data. */
function tokens(text) {
  const characters = Array.from(text);
  const nonAscii = characters.filter(character => character.codePointAt(0) > 0x7f).length;
  return Math.ceil((characters.length - nonAscii) / 3.5 + nonAscii / 1.6);
}
function expectedBudget(model, requestContext) {
  const transcript = normalizeContext(requestContext);
  return { schemaVersion: 1, basis: "pi_projected_context_estimate",
    estimatedInputTokens: tokens(getCurrentSystemPrompt(transcript.messages)) + tokens(JSON.stringify(getCurrentTools(transcript.messages)))
      + tokens(JSON.stringify(transcript.messages.filter(message => message.role !== "system"))),
    contextWindowTokens: model.contextWindow, reservedOutputTokens: model.maxTokens,
    reservedRuntimeOverheadTokens: 512, inputBudgetTokens: model.contextWindow - model.maxTokens - 512 };
}

test("actual projected SDK input carries a safe immutable budget through admission and settlement", async () => {
  const f = await fixture();
  assert.equal((await f.runtime.streamSimple(f.model, context(), { maxTokens: 64 }).result()).stopReason, "stop");
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled.length, 1);
  const budget = f.admitted[0].contextBudget;
  assert.deepEqual(budget, expectedBudget(f.model, f.requests[0].context));
  assert.deepEqual(f.settled[0].contextBudget, budget);
  assert.equal(Object.isFrozen(budget), true);
  assert.equal(Object.isFrozen(f.settled[0].contextBudget), true);
  assert.equal(budget.reservedOutputTokens, 1_024, "selected-model output reservation is conservative, not the wire maxTokens=64");
  assert.deepEqual(Object.keys(budget).sort(), ["basis", "contextWindowTokens", "estimatedInputTokens", "inputBudgetTokens",
    "reservedOutputTokens", "reservedRuntimeOverheadTokens", "schemaVersion"]);
  assert.equal(JSON.stringify([...f.admitted, ...f.settled]).includes(privateMarker), false);
  assert.throws(() => { budget.estimatedInputTokens = 0; }, TypeError);
});

test("the shared estimator counts ASCII, CJK and emoji code points with the existing rounding", () => {
  assert.equal(estimatePiModelContextBudget(selectedModel, { systemPrompt: "abcd", tools: [], messages: [] }).estimatedInputTokens, 4);
  assert.equal(estimatePiModelContextBudget(selectedModel, { systemPrompt: "汉字🙂", tools: [], messages: [] }).estimatedInputTokens, 4);
  assert.equal(estimatePiModelContextBudget(selectedModel, { systemPrompt: "abcd汉🙂", tools: [], messages: [] }).estimatedInputTokens, 5);
  assert.equal(estimatePiModelContextBudget(selectedModel, { systemPrompt: "", tools: [], messages: [] }).estimatedInputTokens, 2);
});

test("shorthand and normalized SDK contexts share one estimator and do not double-count system authority", () => {
  const shorthand = context();
  const normalized = normalizeContext(shorthand);
  assert.deepEqual(estimatePiModelContextBudget(selectedModel, shorthand), estimatePiModelContextBudget(selectedModel, normalized));
  assert.deepEqual(estimatePiModelContextBudget(selectedModel, normalized), expectedBudget(selectedModel, normalized));
  assert.ok(estimatePiModelContextBudget(selectedModel, normalized).estimatedInputTokens
    < tokens(JSON.stringify(normalized.messages)) + tokens(shorthand.systemPrompt) + tokens(JSON.stringify(shorthand.tools)));
});

test("replayed system and tool updates are estimated from current SDK authority", () => {
  const transcript = { messages: [
    { role: "system", content: "old", toolsAdded: [{ name: "old_tool", description: "old", parameters: { type: "object" } }], timestamp: 0 },
    { role: "user", content: "request", timestamp: 1 },
    { role: "system", content: "new 汉", toolsRemoved: [{ name: "old_tool" }],
      toolsAdded: [{ name: "new_tool", description: "new", parameters: { type: "object" } }], timestamp: 2 },
  ] };
  assert.deepEqual(getCurrentTools(transcript.messages).map(tool => tool.name), ["new_tool"]);
  assert.deepEqual(estimatePiModelContextBudget(selectedModel, transcript), expectedBudget(selectedModel, transcript));
});

test("tool fitting emits the projected input budget while preserving complete Host messages", async () => {
  const f = await fixture({ model: { contextWindow: 1_800, maxTokens: 256 } });
  const original = context();
  original.messages.push({ role: "toolResult", toolCallId: "fixture-call", toolName: "fixture_tool", isError: false,
    content: [{ type: "text", text: "x".repeat(10_000) }], timestamp: 1 });
  const before = structuredClone(original);
  assert.equal((await f.runtime.streamSimple(f.model, original, {}).result()).stopReason, "stop");
  const projected = f.requests[0].context;
  const projectedTool = projected.messages.find(message => message.role === "toolResult");
  assert.match(projectedTool.content[0].text, /truncated/u);
  assert.ok(projectedTool.content[0].text.length < 10_000);
  assert.deepEqual(original, before);
  assert.deepEqual(f.admitted[0].contextBudget, expectedBudget(f.model, projected));
  assert.ok(f.admitted[0].contextBudget.estimatedInputTokens <= f.admitted[0].contextBudget.inputBudgetTokens);
  assert.ok(f.admitted[0].contextBudget.estimatedInputTokens < expectedBudget(f.model, original).estimatedInputTokens);
  assert.doesNotThrow(() => assertPiModelContextCapacity(f.model, projected));
});

for (const [name, capacity] of [["NaN window", { contextWindow: NaN }], ["infinite window", { contextWindow: Infinity }],
  ["fractional window", { contextWindow: 8_192.5 }], ["zero window", { contextWindow: 0 }],
  ["negative window", { contextWindow: -1 }], ["unsafe window", { contextWindow: Number.MAX_SAFE_INTEGER + 1 }],
  ["NaN output", { maxTokens: NaN }], ["fractional output", { maxTokens: 1.5 }],
  ["zero output", { maxTokens: 0 }], ["negative output", { maxTokens: -1 }],
  ["unsafe output", { maxTokens: Number.MAX_SAFE_INTEGER + 1 }], ["no remaining input", { contextWindow: 1_536 }]]) {
  test(`invalid ${name} preserves the capacity exception and emits no numeric receipt`, async () => {
    const f = await fixture({ model: capacity });
    const expectedMessage = name === "no remaining input" ? "Pi model context exceeds selected model budget (0/0 estimated input tokens)"
      : "Pi prepared input model context capacity is unknown";
    assert.throws(() => f.runtime.streamSimple(f.model, context(), {}), error => error.message === expectedMessage);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.admitted, []);
    assert.deepEqual(f.settled, []);
  });
}

test("required tool omission markers still fail closed before any budget receipt", async () => {
  const f = await fixture({ model: { contextWindow: 1_000_000, maxTokens: 512 } });
  const oversized = { systemPrompt: "system", messages: [{ role: "user", content: "request", timestamp: 0 },
    ...Array.from({ length: 9_000 }, () => ({ role: "toolResult", content: [{ type: "text", text: "x".repeat(20) }], timestamp: 1 }))] };
  assert.throws(() => f.runtime.streamSimple(f.model, oversized, {}), /tool result markers exceed/u);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
});

test("each task and real SDK summary request owns a distinct numeric budget snapshot", async () => {
  const f = await fixture();
  await f.runtime.streamSimple(f.model, context(), {}).result();
  const nextContext = context();
  nextContext.messages.push(finalMessage(f.model), { role: "user", content: "follow-up 汉字 ".repeat(20), timestamp: 2 });
  await f.runtime.streamSimple(f.model, nextContext, {}).result();
  const summary = await generateSummaryWithUsage(nextContext.messages, f.model, 256, f.options.provider.apiKey, undefined,
    undefined, undefined, undefined, "off", f.runtime.streamSimple);
  assert.equal(summary.text, "Fixture result.");
  assert.equal(f.admitted.length, 3);
  assert.equal(new Set(f.admitted.map(receipt => receipt.invocationId)).size, 3);
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(f.admitted[index].contextBudget, expectedBudget(f.model, f.requests[index].context));
    assert.deepEqual(f.settled[index].contextBudget, f.admitted[index].contextBudget);
  }
  assert.notEqual(f.admitted[0].contextBudget.estimatedInputTokens, f.admitted[1].contextBudget.estimatedInputTokens);
  assert.notStrictEqual(f.admitted[0].contextBudget, f.admitted[1].contextBudget);
});

test("concurrent request budgets do not borrow another stream's projected context", async () => {
  const f = await fixture();
  const longer = context();
  longer.messages[0].content += "concurrent longer message ".repeat(100);
  await Promise.all([f.runtime.streamSimple(f.model, context(), {}).result(),
    f.runtime.streamSimple(f.model, longer, {}).result()]);
  assert.equal(f.admitted.length, 2);
  assert.deepEqual(f.admitted.map(receipt => receipt.contextBudget.estimatedInputTokens).sort((a, b) => a - b),
    f.requests.map(request => expectedBudget(f.model, request.context).estimatedInputTokens).sort((a, b) => a - b));
  for (const receipt of f.settled) assert.deepEqual(receipt.contextBudget,
    f.admitted.find(admitted => admitted.invocationId === receipt.invocationId).contextBudget);
});

test("late context mutation and a failed Host payload hook still emit no budget receipts", async () => {
  let dispatched;
  const mutated = await fixture({ beforePayload: requestContext => { dispatched = requestContext; } });
  await mutated.runtime.streamSimple(mutated.model, context(), { onPayload: async () => {
    dispatched.messages.push({ role: "user", content: "late mutation", timestamp: 3 });
  } }).result();
  assert.match(mutated.boundary.failure.message, /changed after model context projection/u);
  assert.deepEqual(mutated.admitted, []);
  assert.deepEqual(mutated.settled, []);
  const rejected = await fixture();
  await rejected.runtime.streamSimple(rejected.model, context(), { onPayload: async () => { throw new Error("Host rejection"); } }).result();
  assert.deepEqual(rejected.admitted, []);
  assert.deepEqual(rejected.settled, []);
});

test("cancellation before admission cannot publish an earlier numeric snapshot", async () => {
  const abort = new AbortController();
  const f = await fixture({ options: { signal: abort.signal }, beforePayload: () => abort.abort() });
  await f.runtime.streamSimple(f.model, context(), {}).result();
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
});

test("missing or malformed numeric evidence stays unknown without changing logical settlement", async () => {
  const f = await fixture();
  const valid = expectedBudget(f.model, context());
  const invalidBudgets = [undefined, { ...valid, estimatedInputTokens: NaN }, { ...valid, inputBudgetTokens: -1 },
    { ...valid, reservedRuntimeOverheadTokens: 0 }, { ...valid, inputBudgetTokens: valid.inputBudgetTokens + 1 },
    { ...valid, estimatedInputTokens: valid.inputBudgetTokens + 1 }, { ...valid, rawPrompt: privateMarker }];
  for (const invalid of invalidBudgets) {
    const invocation = createPiProviderInvocation(f.options, () => undefined, invalid);
    invocation.captureResolvedTuple(f.model, { apiKey: f.options.provider.apiKey });
    invocation.admit(f.model);
    invocation.observe({ result: async () => finalMessage(f.model) });
    await Promise.resolve();
  }
  assert.equal(f.admitted.length, invalidBudgets.length);
  assert.equal(f.settled.length, invalidBudgets.length);
  for (const receipt of [...f.admitted, ...f.settled]) assert.equal("contextBudget" in receipt, false);
  assert.equal(JSON.stringify([...f.admitted, ...f.settled]).includes(privateMarker), false);
});

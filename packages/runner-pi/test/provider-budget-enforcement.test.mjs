import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { generateSummaryWithUsage, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiTaskBoundary } from "../dist/task-boundary.js";
import { createPiProviderBudgetInvocation } from "../dist/provider-budget.js";

const model = { provider: "hard-budget-fixture", id: "budget-model", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 8_192, maxTokens: 1_024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const context = () => ({ messages: [{ role: "user", content: "Synthetic budget QA only", timestamp: 0 }] });
const actualUsage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (overrides = {}) => ({ role: "assistant", content: [{ type: "text", text: "Synthetic QA result" }],
  provider: model.provider, model: model.id, api: model.api, timestamp: 0, stopReason: "stop", usage: actualUsage, ...overrides });

/** Real SDK preparation/auth/summary paths with an isolated, non-network Provider. */
async function fixture(controls = {}) {
  const reserved = [], settled = [], unknown = [], order = [];
  let wire = 0;
  const providerBudget = { requiresTokenUpperBound: true, requiresCostUpperBound: true,
    reserve(request) {
      reserved.push(request); order.push("reserve");
      return { reservationId: `reservation-${reserved.length}`, reservedTokens: 9_216, reservedCostMicros: 500 };
    },
    settle(receipt) { settled.push(receipt); order.push("settle"); },
    settleUnknown(receipt) { unknown.push(receipt); order.push("unknown"); },
    ...controls.port };
  const options = { cwd: process.cwd(), task: { id: "hard-budget-task", title: "QA", prompt: "Synthetic QA" },
    runId: "hard-budget-run", runnerAttemptId: "hard-budget-attempt", providerBudget,
    provider: { provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, apiKey: "synthetic-never-log-this-key" }, ...controls.options };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(model.provider, { api: model.api, apiKey: options.provider.apiKey,
    streamSimple: (requestModel, requestContext, requestOptions) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          await controls.beforePayload?.(requestContext);
          for (let index = 0; index < (controls.payloadCalls ?? 1); index += 1) {
            const payload = controls.payload?.(index) ?? { messages: ["synthetic private QA payload"], max_tokens: 64 };
            const returned = await requestOptions.onPayload(payload, requestModel);
            controls.readReservedPayload?.(returned);
          }
          wire += 1; order.push("wire");
          await controls.beforeResult?.();
          const result = message(controls.result);
          stream.push(result.stopReason === "error" || result.stopReason === "aborted"
            ? { type: "error", reason: result.stopReason, error: result }
            : { type: "done", reason: "stop", message: result });
        } catch (error) {
          stream.push({ type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: error.message, usage: undefined }) });
        }
      })();
      return stream;
    } });
  const boundary = createPiTaskBoundary(options);
  boundary.bindModelRuntime(runtime);
  return { runtime, boundary, options, reserved, settled, unknown, order, get wire() { return wire; } };
}

test("hard gate reserves actual immutable payload before wire and synchronously settles actual final usage", async () => {
  const f = await fixture({ readReservedPayload: payload => assert.equal(Object.isFrozen(payload), true) });
  const result = await f.runtime.streamSimple(model, context(), { maxTokens: 64 }).result();
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(f.order, ["reserve", "wire", "settle"]);
  assert.equal(f.reserved[0].contextWindowTokens, 8_192);
  assert.equal(f.reserved[0].maxOutputTokens, 64);
  assert.match(f.reserved[0].payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(f.reserved[0].payload.messages), true);
  assert.equal(f.settled[0].invocationId, f.reserved[0].invocationId);
  assert.equal(f.settled[0].reservationId, "reservation-1");
  assert.deepEqual(f.settled[0].usage, { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13 });
  assert.equal(JSON.stringify(f.reserved[0]).includes(f.options.provider.apiKey), false);
  assert.deepEqual(f.unknown, []);
  f.boundary.assertOpen();
});

test("same logical payload replay is one reservation even when object property order changes", async () => {
  const f = await fixture({ payloadCalls: 3, payload: index => index % 2 ? { max_tokens: 64, messages: ["same"] } : { messages: ["same"], max_tokens: 64 } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.reserved.length, 1);
  assert.equal(f.settled.length, 1);
  assert.equal(f.wire, 1);
});

test("repeated hook cannot change the budgeted payload or send after reservation", async () => {
  const f = await fixture({ payloadCalls: 2, payload: index => ({ messages: [`version-${index}`] }) });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.reserved.length, 1);
  assert.equal(f.wire, 0);
  assert.deepEqual(f.settled, []);
  assert.equal(f.unknown[0].outcome, "local_rejected");
  assert.throws(() => f.boundary.assertOpen(), /provider_budget_payload_changed/);
});

for (const [name, reservation] of [
  ["token bound absent", { reservationId: "id", reservedCostMicros: 5 }],
  ["cost bound absent", { reservationId: "id", reservedTokens: 10 }],
  ["negative bound", { reservationId: "id", reservedTokens: -1, reservedCostMicros: 5 }],
  ["fractional bound", { reservationId: "id", reservedTokens: 10.5, reservedCostMicros: 5 }],
  ["invalid receipt", undefined],
]) {
  test(`${name} fails closed before wire`, async () => {
    const f = await fixture({ port: { reserve: () => reservation } });
    await f.runtime.streamSimple(model, context(), {}).result();
    assert.equal(f.wire, 0);
    assert.deepEqual(f.settled, []);
    assert.throws(() => f.boundary.assertOpen(), /provider_budget_(upper_bound_unavailable|reservation_invalid)/);
  });
}

test("token/time-only accounting can proceed without a cost upper bound", async () => {
  const f = await fixture({ port: { requiresCostUpperBound: false,
    reserve: () => ({ reservationId: "token-only", reservedTokens: 9_216 }) } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.wire, 1);
  assert.equal(f.settled[0].reservationId, "token-only");
  f.boundary.assertOpen();
});

test("a reserve write exception blocks the request and future admission, regardless of best-effort observers", async () => {
  const error = new Error("synthetic durable reserve write failure");
  const f = await fixture({ port: { reserve: () => { throw error; } }, options: {
    onProviderInvocationAdmitted() { throw new Error("observer must never grant a budget"); },
  } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.wire, 0);
  assert.throws(() => f.boundary.assertOpen(), candidate => candidate === error);
  assert.throws(() => f.runtime.streamSimple(model, context(), {}), candidate => candidate === error);
});

test("async reserve cannot race a request onto the wire", async () => {
  const f = await fixture({ port: { reserve: async () => ({ reservationId: "late", reservedTokens: 100, reservedCostMicros: 1 }) } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.wire, 0);
  assert.throws(() => f.boundary.assertOpen(), /provider_budget_async_port_rejected/);
});

test("actual SDK credential/header overrides cannot borrow another budget tuple", async () => {
  for (const requestOptions of [{ apiKey: "synthetic-other-key" }, { transformHeaders: async headers => ({ ...headers, "X-Other": "other" }) }]) {
    const f = await fixture();
    await f.runtime.streamSimple(model, context(), requestOptions).result();
    assert.equal(f.wire, 0);
    assert.equal(f.reserved.length, 0);
    assert.throws(() => f.boundary.assertOpen(), /provider_budget_(credential|headers)_mismatch/);
  }
});

test("unknown SDK resolution cannot degrade a hard gate into an observation-only path", () => {
  const options = { cwd: process.cwd(), task: { id: "x", title: "x", prompt: "x" }, runId: "r", runnerAttemptId: "a",
    provider: { provider: model.provider, model: model.id },
    providerBudget: { requiresTokenUpperBound: true, requiresCostUpperBound: false, reserve() {}, settle() {}, settleUnknown() {} } };
  const boundary = createPiTaskBoundary(options);
  assert.throws(() => boundary.bindModelRuntime({ streamSimple() { assert.fail("must not enter unproven provider"); } }), /provider_budget_resolution_unavailable/);
});

for (const [name, result] of [
  ["missing usage", { usage: undefined }],
  ["SDK zero placeholder", { usage: { ...actualUsage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }],
  ["inconsistent total", { usage: { ...actualUsage, totalTokens: 999 } }],
  ["different model", { model: "different-model" }],
  ["deferred task", { stopReason: "deferred" }],
]) {
  test(`${name} retains unresolved liability instead of fabricating measured usage or a refund`, async () => {
    const f = await fixture({ result });
    await f.runtime.streamSimple(model, context(), {}).result();
    assert.equal(f.wire, 1);
    assert.deepEqual(f.settled, []);
    assert.equal(f.unknown.length, 1);
    assert.equal(f.unknown[0].outcome, "unknown");
    assert.equal("usage" in f.unknown[0], false);
  });
}

test("cancellation after wire retains liability even if an uncooperative SDK returns successful text", async () => {
  const abort = new AbortController();
  const f = await fixture({ options: { signal: abort.signal }, beforeResult: () => abort.abort() });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.wire, 1);
  assert.deepEqual(f.settled, []);
  assert.equal(f.unknown[0].outcome, "cancelled");
  assert.notEqual(f.unknown[0].outcome, "cancelled_before_dispatch");
});

test("synchronous measured-settlement failure rejects the final promise and closes later admission", async () => {
  const error = new Error("synthetic settlement commit failure");
  const f = await fixture({ port: { settle: () => { throw error; } } });
  await assert.rejects(f.runtime.streamSimple(model, context(), {}).result(), candidate => candidate === error);
  assert.equal(f.wire, 1);
  assert.throws(() => f.runtime.streamSimple(model, context(), {}), candidate => candidate === error);
});

test("unknown-settlement write failure cannot be silently swallowed", async () => {
  const error = new Error("synthetic unknown write failure");
  const f = await fixture({ result: { usage: undefined }, port: { settleUnknown: () => { throw error; } } });
  await assert.rejects(f.runtime.streamSimple(model, context(), {}).result(), candidate => candidate === error);
  assert.throws(() => f.boundary.assertOpen(), candidate => candidate === error);
});

test("actual task and SDK summary requests share one hard port and obtain distinct reservations", async () => {
  const f = await fixture();
  await f.runtime.streamSimple(model, context(), {}).result();
  const summary = await generateSummaryWithUsage(context().messages, model, 256, f.options.provider.apiKey, undefined,
    undefined, undefined, undefined, "off", f.runtime.streamSimple);
  assert.equal(summary.text, "Synthetic QA result");
  assert.equal(f.reserved.length, 2);
  assert.equal(f.settled.length, 2);
  assert.notEqual(f.reserved[0].invocationId, f.reserved[1].invocationId);
  assert.equal(f.reserved[0].runId, f.reserved[1].runId);
  assert.equal(f.reserved[0].attemptId, f.reserved[1].attemptId);
});

test("SDK summary cannot bypass a depleted shared hard budget", async () => {
  let count = 0;
  const f = await fixture({ port: { reserve: () => {
    if (++count > 1) throw new Error("synthetic shared budget exhausted");
    return { reservationId: "shared-first", reservedTokens: 9_216, reservedCostMicros: 5 };
  } } });
  await f.runtime.streamSimple(model, context(), {}).result();
  await assert.rejects(generateSummaryWithUsage(context().messages, model, 256, f.options.provider.apiKey, undefined,
    undefined, undefined, undefined, "off", f.runtime.streamSimple), /synthetic shared budget exhausted/);
  assert.equal(count, 2);
  assert.equal(f.wire, 1);
  assert.throws(() => f.boundary.assertOpen(), /synthetic shared budget exhausted/);
});

test("a rejected final Promise settles unknown, preserving the original rejection and outstanding reservation", async () => {
  const unknown = [], failures = [];
  const options = { cwd: process.cwd(), task: { id: "qa", title: "qa", prompt: "qa" }, runId: "run", runnerAttemptId: "attempt",
    provider: { provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, apiKey: "synthetic-key" },
    providerBudget: { requiresTokenUpperBound: true, requiresCostUpperBound: false,
      reserve: () => ({ reservationId: "held", reservedTokens: 9_216 }), settle() { assert.fail("no measured usage exists"); },
      settleUnknown: receipt => unknown.push(receipt) } };
  const gate = createPiProviderBudgetInvocation(options, () => undefined, error => failures.push(error));
  gate.captureResolvedTuple(model, { apiKey: options.provider.apiKey });
  gate.authorize({ messages: ["qa"] }, model);
  const error = new Error("synthetic final rejection");
  const stream = gate.guardResult({ result: async () => { throw error; } });
  await assert.rejects(stream.result(), candidate => candidate === error);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].outcome, "unknown");
  assert.equal(unknown[0].reservationId, "held");
  assert.deepEqual(failures, [error]);
});

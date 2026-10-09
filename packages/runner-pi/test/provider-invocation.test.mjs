import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { generateSummaryWithUsage, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { createPiTaskBoundary } from "../dist/task-boundary.js";

const model = {
  provider: "invocation-fixture", id: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = () => ({ messages: [{ role: "user", content: [{ type: "text", text: "Fixture prompt." }], timestamp: 0 }] });
const finalMessage = (overrides = {}) => ({ role: "assistant", content: [{ type: "text", text: "Fixture result." }],
  api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", ...overrides });

/** Bare provider fixture; the SDK fixture below supplies actual request resolution. */
function fixture(overrides = {}, controls = {}) {
  const admitted = [], settled = [], order = [];
  const options = {
    cwd: process.cwd(), task: { id: "fixture-task", title: "Fixture", prompt: "Fixture prompt." },
    runId: "fixture-run", runnerAttemptId: "fixture-attempt",
    provider: { provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, apiKey: "synthetic-key-never-public",
      headers: { "X-Fixture": "synthetic-header-never-public" } },
    onProviderInvocationAdmitted: (receipt) => { admitted.push(receipt); order.push("admitted"); },
    onProviderInvocationSettled: (receipt) => { settled.push(receipt); order.push("settled"); },
    ...overrides,
  };
  const boundary = createPiTaskBoundary(options);
  const runtime = {
    streamSimple: (requestModel, requestContext, requestOptions) => {
      const result = createAssistantMessageEventStream();
      controls.observeRequest?.(requestModel, requestOptions);
      void (async () => {
        try {
          if (controls.failBeforePayload) throw new Error("Local preparation failure.");
          controls.beforePayload?.(requestContext);
          for (let index = 0; index < (controls.payloadCalls ?? 1); index += 1) {
            controls.beforePayloadIteration?.(index, requestModel);
            await requestOptions.onPayload(controls.payload?.() ?? { input: "synthetic-payload-never-public" }, requestModel);
          }
          if (controls.emitResponse) await requestOptions.onResponse?.({ status: 200, headers: {} }, requestModel);
          if (controls.emitStreamEvent) await requestOptions.onProviderStreamEvent?.({}, requestModel);
          controls.afterPayload?.(requestContext);
          await controls.beforeResult?.();
          const message = finalMessage(controls.result);
          result.push(message.stopReason === "error" || message.stopReason === "aborted"
            ? { type: "error", reason: message.stopReason, error: message }
            : { type: "done", reason: "stop", message });
        } catch (error) {
          result.push({ type: "error", reason: "error", error: finalMessage({ stopReason: "error", errorMessage: error.message }) });
        }
      })();
      return result;
    },
  };
  const providerStream = runtime.streamSimple;
  boundary.bindModelRuntime(runtime);
  return { boundary, runtime, providerStream, admitted, settled, order, options };
}

/** Actual SDK auth/header preparation and composed-provider dispatch, without I/O. */
async function sdkFixture(overrides = {}, controls = {}, registration = {}) {
  const f = fixture(overrides, controls);
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  for (const provider of [model.provider, "different-provider"]) {
    runtime.registerProvider(provider, { api: model.api, apiKey: f.options.provider.apiKey,
      headers: f.options.provider.headers, streamSimple: f.providerStream, ...registration });
  }
  f.boundary.bindModelRuntime(runtime);
  return { ...f, runtime, credentials };
}

test("SDK post-resolution header changes cannot borrow the original Host observation scope", async () => {
  let effectiveHeader;
  const f = await sdkFixture({}, { observeRequest: (_model, options) => { effectiveHeader = options.headers["X-Fixture"]; } });
  assert.equal((await f.runtime.streamSimple(model, context(), { transformHeaders: async (headers) => {
    return { ...headers, "X-Fixture": "synthetic-transformed-header-never-public" };
  } }).result()).stopReason, "stop");
  assert.equal(effectiveHeader, "synthetic-transformed-header-never-public");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

test("an unproven runtime still executes, but cannot produce trusted invocation receipts", async () => {
  const f = fixture();
  assert.equal((await f.runtime.streamSimple(model, context(), {}).result()).stopReason, "stop");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

test("default identity header transformation and deterministic authHeader preserve matching attribution", async () => {
  const f = await sdkFixture({ provider: { provider: model.provider, model: model.id, api: model.api,
    baseUrl: model.baseUrl, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    apiKey: "synthetic-key-never-public", headers: { "X-Fixture": "synthetic-header-never-public" }, authHeader: true } },
  {}, { authHeader: true });
  assert.equal((await f.runtime.streamSimple(model, context(), { transformHeaders: async (headers) => headers }).result()).stopReason, "stop");
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled[0]?.outcome, "succeeded");
});

test("deleting a configured resolved header is unknown rather than matching a subset", async () => {
  const f = await sdkFixture();
  assert.equal((await f.runtime.streamSimple(model, context(), { transformHeaders: async () => ({}) }).result()).stopReason, "stop");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

test("SDK configured header environment expressions are resolved before attribution", async () => {
  let effectiveHeader;
  const f = await sdkFixture({}, { observeRequest: (_model, options) => { effectiveHeader = options.headers["X-Fixture"]; } },
    { headers: { "X-Fixture": "${LING_SYNTHETIC_TENANT}" } });
  await f.credentials.modify(model.provider, async () => ({ type: "api_key", key: f.options.provider.apiKey,
    env: { LING_SYNTHETIC_TENANT: "synthetic-resolved-header-never-public" } }));
  assert.equal((await f.runtime.streamSimple(model, context(), {}).result()).stopReason, "stop");
  assert.equal(effectiveHeader, "synthetic-resolved-header-never-public");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

test("an SDK runtime key override cannot borrow the registered Host key scope", async () => {
  const f = await sdkFixture();
  await f.runtime.setRuntimeApiKey(model.provider, "synthetic-sdk-runtime-key-never-public");
  assert.equal((await f.runtime.streamSimple(model, context(), {}).result()).stopReason, "stop");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

test("resolved options mutated before a payload hook cannot retain an earlier proof", async () => {
  const f = await sdkFixture({}, { observeRequest: (_model, options) => { options.apiKey = "synthetic-late-sdk-key-never-public"; } });
  assert.equal((await f.runtime.streamSimple(model, context(), {}).result()).stopReason, "stop");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

test("concurrent streams use private hook identity, not a shared current invocation", async () => {
  const f = await sdkFixture();
  const [matching, independent] = await Promise.all([
    f.runtime.streamSimple(model, context(), { transformHeaders: async (headers) => {
      await new Promise((resolve) => setImmediate(resolve));
      return headers;
    } }).result(),
    f.runtime.streamSimple(model, context(), { transformHeaders: async (headers) => ({ ...headers, "X-Fixture": "synthetic-independent" }) }).result(),
  ]);
  assert.equal(matching.stopReason, "stop");
  assert.equal(independent.stopReason, "stop");
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0].invocationId, f.admitted[0].invocationId);
});

test("one validated logical request reports private lineage, not payload or credentials", async () => {
  const f = await sdkFixture();
  const stream = f.runtime.streamSimple(model, context(), {});
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal((await stream.result()).stopReason, "stop");
  assert.deepEqual(f.order, ["admitted", "settled"]);
  assert.equal(events.length, 1, "observation must not consume the SDK iterator");
  assert.equal(f.admitted.length, 1);
  assert.match(f.admitted[0].invocationId, /\S+/u);
  assert.ok(Number.isFinite(Date.parse(f.admitted[0].admittedAt)));
  assert.equal(f.admitted[0].taskId, "fixture-task");
  assert.equal(f.admitted[0].runId, "fixture-run");
  assert.equal(f.admitted[0].attemptId, "fixture-attempt");
  assert.deepEqual(f.settled[0], { ...f.admitted[0], settledAt: f.settled[0].settledAt, outcome: "succeeded" });
  assert.ok(Date.parse(f.settled[0].settledAt) >= Date.parse(f.admitted[0].admittedAt));
  assert.deepEqual(Object.keys(f.admitted[0]).sort(), ["admittedAt", "attemptId", "invocationId", "runId", "taskId"]);
  assert.equal(JSON.stringify([...f.admitted, ...f.settled]).includes("never-public"), false);
});

test("repeated payload hooks admit at most once, while each stream gets its own identity", async () => {
  const f = await sdkFixture({}, { payloadCalls: 2 });
  await f.runtime.streamSimple(model, context(), {}).result();
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.admitted.length, 2);
  assert.equal(f.settled.length, 2);
  assert.notEqual(f.admitted[0].invocationId, f.admitted[1].invocationId);
  assert.deepEqual(f.settled.map((r) => r.invocationId), f.admitted.map((r) => r.invocationId));
});

test("standalone summary requests without the Agent extension hook are still observed", async () => {
  const f = await sdkFixture();
  await f.runtime.streamSimple(model, context(), { sessionId: "standalone-summary-routing-id" }).result();
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled[0].outcome, "succeeded");
});

test("real SDK summarization dispatch uses the same logical invocation observer", async () => {
  const f = await sdkFixture();
  const summary = await generateSummaryWithUsage(context().messages, model, 256, f.options.provider.apiKey, undefined,
    undefined, undefined, undefined, "off", f.runtime.streamSimple);
  assert.equal(summary.text, "Fixture result.");
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled[0]?.outcome, "succeeded");
});

test("real SDK summary with independent credentials is unknown, not attributed to the main provider", async () => {
  const f = await sdkFixture();
  const summary = await generateSummaryWithUsage(context().messages, model, 256, "synthetic-summary-override-key", undefined,
    undefined, undefined, undefined, "off", f.runtime.streamSimple);
  assert.equal(summary.text, "Fixture result.");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

for (const [field, value] of [["provider", "different-provider"], ["id", "different-model"], ["api", "openai-responses"],
  ["baseUrl", "https://different-fixture.invalid/v1"], ["contextWindow", 256_000], ["maxTokens", 2048]]) {
  test(`actual model ${field} mismatch is unknown without rejecting normal execution`, async () => {
    const f = await sdkFixture({}, {}, field === "api" ? { api: value } : {});
    assert.equal((await f.runtime.streamSimple({ ...model, [field]: value }, context(), {}).result()).stopReason, "stop");
    assert.deepEqual(f.admitted, []);
    assert.deepEqual(f.settled, []);
    f.boundary.assertOpen();
  });
}

for (const [name, overrides] of [["key", { apiKey: "synthetic-override-never-public" }],
  ["header", { headers: { "X-Fixture": "synthetic-override-header-never-public" } }],
  ["additional header", { headers: { "X-Extra": "synthetic-extra-header-never-public" } }],
  ["deleted header", { headers: { "X-Fixture": null } }],
  ["environment", { env: { OPENAI_API_KEY: "synthetic-env-override-never-public" } }]]) {
  test(`explicit ${name} override cannot borrow the original provider receipt`, async () => {
    const f = await sdkFixture();
    assert.equal((await f.runtime.streamSimple(model, context(), overrides).result()).stopReason, "stop");
    assert.deepEqual(f.admitted, []);
    assert.deepEqual(f.settled, []);
    f.boundary.assertOpen();
  });
}

test("explicit matching key and case-insensitive matching headers retain invocation attribution", async () => {
  const f = await sdkFixture();
  await f.runtime.streamSimple(model, context(), { apiKey: f.options.provider.apiKey,
    headers: { "x-fixture": f.options.provider.headers["X-Fixture"] } }).result();
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled[0]?.outcome, "succeeded");
});

test("a model-owned header override cannot borrow the original connection scope", async () => {
  const f = await sdkFixture();
  assert.equal((await f.runtime.streamSimple({ ...model, headers: { "X-Fixture": "synthetic-model-header-override" } },
    context(), {}).result()).stopReason, "stop");
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  f.boundary.assertOpen();
});

test("later repeated payload model drift invalidates observation without changing execution", async () => {
  const f = await sdkFixture({}, { payloadCalls: 2, beforePayloadIteration: (index, requestModel) => {
    if (index === 1) requestModel.id = "different-later-model";
  } });
  assert.equal((await f.runtime.streamSimple({ ...model }, context(), {}).result()).stopReason, "stop");
  assert.equal(f.admitted.length, 1);
  assert.deepEqual(f.settled, [], "the original admission cannot prove the later changed tuple");
  f.boundary.assertOpen();
});

test("settlement exports only bounded diagnostics even when live credentials rotate after admission", async () => {
  const f = await sdkFixture({}, { result: { stopReason: "error", errorMessage:
    '400 {"error":{"code":"context_length_exceeded","message":"synthetic-key-never-public synthetic-header-never-public synthetic-payload-never-public"}}' },
  afterPayload: () => { f.options.provider.apiKey = "synthetic-new-key"; f.options.provider.headers = { "X-Fixture": "synthetic-new-header" }; } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.settled[0]?.outcome, "provider_error");
  assert.equal("errorMessage" in f.settled[0], false);
  assert.deepEqual(f.settled[0].errorDiagnostic, { schemaVersion: 1, category: "context_limit", basis: "sdk_error_marker",
    httpStatus: 400, code: "context_length_exceeded" });
  assert.equal(JSON.stringify(f.settled).includes("never-public"), false);
});

test("a failed logical Provider request reports only its own bounded diagnostic", async () => {
  const f = await sdkFixture({}, { result: { stopReason: "error", errorMessage:
    '400 {"error":{"code":"context_length_exceeded","message":"synthetic-key-never-public synthetic-header-never-public"}}' } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.settled[0]?.outcome, "provider_error");
  assert.equal(f.settled[0].invocationId, f.admitted[0].invocationId);
  assert.equal("errorMessage" in f.settled[0], false);
  assert.equal(f.settled[0].errorDiagnostic.category, "context_limit");
  assert.equal(JSON.stringify(f.settled[0]).includes("never-public"), false);
});

test("successful narrative mentioning a context error is not Provider failure", async () => {
  const f = await sdkFixture({}, { result: { content: [{ type: "text", text: "Here is what context_length_exceeded means." }] } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.settled[0]?.outcome, "succeeded");
  assert.equal("errorMessage" in f.settled[0], false);
});

test("pre-payload preparation and first Host gate rejection produce no invocation receipt", async () => {
  const preparation = await sdkFixture({}, { failBeforePayload: true });
  await preparation.runtime.streamSimple(model, context(), {}).result();
  assert.deepEqual(preparation.admitted, []);
  assert.deepEqual(preparation.settled, []);
  const rejected = await sdkFixture();
  await rejected.runtime.streamSimple(model, context(), { onPayload: async () => { throw new Error("Host gate rejected"); } }).result();
  assert.deepEqual(rejected.admitted, []);
  assert.deepEqual(rejected.settled, []);
});

test("admission waits for the upstream hook; cancellation during that await is not Provider failure", async () => {
  const abort = new AbortController();
  let release;
  const hook = new Promise((resolve) => { release = resolve; });
  const f = await sdkFixture({ signal: abort.signal });
  const stream = f.runtime.streamSimple(model, context(), { onPayload: async () => { await hook; } });
  await Promise.resolve();
  assert.deepEqual(f.admitted, []);
  abort.abort(); release();
  await stream.result();
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
});

test("cancellation after admission wins over a Provider-shaped error", async () => {
  const abort = new AbortController();
  const f = await sdkFixture({ signal: abort.signal }, { afterPayload: () => abort.abort(),
    result: { stopReason: "error", errorMessage: "context_length_exceeded" } });
  await f.runtime.streamSimple(model, context(), {}).result();
  assert.equal(f.settled[0]?.outcome, "cancelled");
  assert.equal("errorMessage" in f.settled[0], false);
});

test("Host rejection after an earlier repeated payload admission is local_rejected", async () => {
  let calls = 0;
  const f = await sdkFixture({}, { payloadCalls: 2 });
  await f.runtime.streamSimple(model, context(), { onPayload: async () => {
    if (++calls === 2) throw new Error("Host gate closed after admission");
  } }).result();
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled[0]?.outcome, "local_rejected");
  assert.equal("errorMessage" in f.settled[0], false);
});

test("context-capacity rejection cannot be reported as a Provider request", async () => {
  const f = await sdkFixture();
  assert.throws(() => f.runtime.streamSimple({ ...model, contextWindow: 8 }, context(), {}), /selected model budget/u);
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
});

test("late payload context mutation rejects before logical admission", async () => {
  let dispatchedContext;
  const f = await sdkFixture({}, { beforePayload: (value) => { dispatchedContext = value; } });
  await f.runtime.streamSimple(model, context(), { onPayload: async () => {
    dispatchedContext.messages.push({ role: "user", content: [{ type: "text", text: "Injected drift." }], timestamp: 1 });
  } }).result();
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
  assert.match(f.boundary.failure.message, /changed after model context projection/u);
});

test("reasoning transformation must succeed before logical admission", async () => {
  const f = await sdkFixture({ reasoningSummary: "none" }, { payload: () => ({
    get reasoning() { throw new Error("Local reasoning payload failure"); },
  }) }, { api: "openai-responses" });
  await f.runtime.streamSimple({ ...model, api: "openai-responses" }, context(), {}).result();
  assert.deepEqual(f.admitted, []);
  assert.deepEqual(f.settled, []);
});

for (const [hook, control] of [["onResponse", "emitResponse"], ["onProviderStreamEvent", "emitStreamEvent"]]) {
  test(`${hook} failure after admission is local_rejected, not Provider failure`, async () => {
    const f = await sdkFixture({}, { [control]: true });
    await f.runtime.streamSimple(model, context(), { [hook]: async () => { throw new Error("Local Host observer failure"); } }).result();
    assert.equal(f.admitted.length, 1);
    assert.equal(f.settled[0]?.outcome, "local_rejected");
    assert.equal("errorMessage" in f.settled[0], false);
  });
}

test("throwing admission observer is unknown, while Provider execution still completes", async () => {
  let settled = 0;
  const f = await sdkFixture({ onProviderInvocationAdmitted: () => { throw new Error("Observer storage failure"); },
    onProviderInvocationSettled: () => { settled += 1; } });
  assert.equal((await f.runtime.streamSimple(model, context(), {}).result()).stopReason, "stop");
  assert.equal(settled, 0);
  f.boundary.assertOpen();
});

test("rejected async observers do not leak unhandled promises or change Provider settlement", async () => {
  let settled = 0;
  const f = await sdkFixture({ onProviderInvocationAdmitted: async () => { throw new Error("Async observer failure"); },
    onProviderInvocationSettled: () => { settled += 1; } });
  assert.equal((await f.runtime.streamSimple(model, context(), {}).result()).stopReason, "stop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, 0);
  const terminal = await sdkFixture({ onProviderInvocationSettled: async () => { throw new Error("Async terminal observer failure"); } });
  assert.equal((await terminal.runtime.streamSimple(model, context(), {}).result()).stopReason, "stop");
  await new Promise((resolve) => setImmediate(resolve));
  terminal.boundary.assertOpen();
});

test("SDK preparation has no invocation; real SDK model execution reports one", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-provider-invocation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const admitted = [], settled = [], publicEvents = [];
  let requests = 0;
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      const registeredProvider = runtime.getProvider(provider.provider);
      const composedStream = registeredProvider.streamSimple.bind(registeredProvider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (m, c, o) =>
        composedStream(m, c, { ...o, fetch: async (_url, init) => {
          requests += 1;
          const headers = new Headers(init.headers);
          assert.equal(headers.get("authorization"), null, "existing Host authHeader=false wrapper must remain active");
          assert.equal(headers.get("x-fixture"), "synthetic-only-header");
          return new Response('data: {"choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
        } }) });
    }
  }
  const runner = new FixtureRunner();
  const options = { cwd, agentDir: join(cwd, "agent"), tools: [],
    task: { id: "real-sdk-fixture", title: "Fixture", prompt: "Finish." },
    provider: { provider: model.provider, model: model.id, baseUrl: model.baseUrl, api: model.api, apiKey: "synthetic-only",
      authHeader: false, headers: { "X-Fixture": "synthetic-only-header" }, reasoning: false },
    onProviderInvocationAdmitted: (r) => admitted.push(r), onProviderInvocationSettled: (r) => settled.push(r),
    onEvent: (event) => publicEvents.push(event) };
  const preparedInput = await runner.prepareTaskInput(options);
  assert.deepEqual(admitted, []); assert.deepEqual(settled, []); assert.equal(requests, 0);
  await runner.runTask({ ...options, preparedInput, runId: "sdk-run", runnerAttemptId: "sdk-attempt" });
  assert.equal(requests, 1); assert.equal(admitted.length, 1); assert.equal(settled.length, 1);
  assert.equal(settled[0].outcome, "succeeded");
  assert.equal(JSON.stringify(publicEvents).includes(admitted[0].invocationId), false, "receipt must not become a RunEvent");
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { resolvePiProviderRequestAuth } from "../dist/provider-request-auth.js";

const fixtureKey = "fixture-provider-key-not-a-secret";
const customAuthorization = "Basic fixture-custom-auth-only";
const fixtureBaseUrl = "http://127.0.0.1:9/v1";
const testOptions = { timeout: 15_000 };

function completion() {
  const records = [
    { choices: [{ index: 0, delta: { content: "Fixture complete." }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 16, total_tokens: 116 } },
  ];
  return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function responsesCompletion() {
  const item = { id: "msg_auth_fixture", type: "message", status: "completed", role: "assistant",
    content: [{ type: "output_text", text: "Responses fixture complete.", annotations: [] }] };
  const response = { id: "resp_auth_fixture", object: "response", created_at: 0, model: "fixture",
    status: "completed", output: [item], usage: { input_tokens: 100, output_tokens: 16, total_tokens: 116 } };
  const records = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0,
      delta: item.content[0].text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(records.map((record, index) => `event: ${record.type}\ndata: ${JSON.stringify({
    ...record, sequence_number: index,
  })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

/** Real adapter/Session/provider parser; preserve its auth wrapper and replace only fetch. */
async function fixture(t, providerOverrides, optionOverrides = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-provider-auth-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests = [], contexts = [], events = [], hostCalls = [], approvalCalls = [], sdkKeys = [];
  class TransportFixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      sdkKeys.push(runtime.getRegisteredProviderConfig(provider.provider)?.apiKey);
      const registered = runtime.models.getProvider(provider.provider);
      assert.ok(registered?.streamSimple, "capture the production-registered real provider, including its auth policy");
      runtime.registerProvider(provider.provider, {
        api: provider.api,
        streamSimple: (model, context, options) => {
          contexts.push({ messages: structuredClone(context.messages),
            systemPrompt: getCurrentSystemPrompt(context.messages),
            tools: structuredClone(getCurrentTools(context.messages)),
            hasResolvedApiKey: Boolean(options?.apiKey) });
          return registered.streamSimple(model, context, { ...options, maxRetries: 0,
            fetch: async (url, request) => {
              const headers = new Headers(request.headers);
              requests.push({ url: String(url), authorization: headers.get("authorization"),
                headers: Object.fromEntries(headers), body: JSON.parse(request.body) });
              return provider.api === "openai-responses" ? responsesCompletion() : completion();
            },
          });
        },
      });
    }
  }
  const provider = { provider: "ling-provider-auth-fixture", model: "fixture",
    api: "openai-completions", baseUrl: fixtureBaseUrl, reasoning: false, ...providerOverrides };
  if (provider.headers) Object.freeze(provider.headers);
  Object.freeze(provider);
  const originalProvider = structuredClone(provider);
  const runner = new TransportFixtureRunner();
  const options = {
    cwd, agentDir: join(cwd, "agent"), provider, tools: [],
    task: { id: "provider-request-auth", title: "Verify request auth", prompt: "Complete this isolated fixture once." },
    onEvent: event => events.push(event),
    onApprovalRequired: async request => { approvalCalls.push(request.toolCallId); return { approved: true }; },
    onMcpToolCall: async request => {
      hostCalls.push(request.toolCallId);
      throw new Error("Historical approved effects must not execute in the auth fixture.");
    },
    ...optionOverrides,
  };
  return { runner, options, provider, originalProvider, requests, contexts, events, hostCalls, approvalCalls, sdkKeys };
}

function assertPrivateCredentialsStayPrivate(f, preparedInput, result) {
  assert.equal(f.options.provider, f.provider, "auth setup must not replace the provider on the caller's original options");
  assert.deepEqual(f.provider, f.originalProvider, "SDK-only credentials and header edits must not mutate the external provider");
  assert.equal("apiKey" in preparedInput.model, false);
  assert.equal("headers" in preparedInput.model, false);
  assert.equal(JSON.stringify([preparedInput, f.events, result?.messages]).includes(fixtureKey), false);
  assert.equal(JSON.stringify([preparedInput, f.events, result?.messages]).includes(customAuthorization), false);
  for (const key of f.sdkKeys.filter(value => typeof value === "string" && value.length > 0)) {
    assert.equal(JSON.stringify([preparedInput, f.events, result?.messages]).includes(key), false,
      "the SDK's private registration credential must never enter prepared input or public evidence");
  }
}

test("custom auth keeps the SDK-resolved value and never resurrects a deleted config expression", () => {
  const policy = resolvePiProviderRequestAuth({ provider: "resolved-auth-fixture", model: "fixture",
    authHeader: false, api: "openai-completions", headers: { Authorization: "config-reference" } });
  const headers = { Authorization: "resolved-custom-value", "X-Proxy": "keep" };
  const originalHeaders = structuredClone(headers);
  assert.deepEqual(policy.requestHeaders(headers), originalHeaders,
    "the SDK-resolved value, not the original configuration expression, is the request authority");
  assert.deepEqual(headers, originalHeaders, "request header normalization must not mutate the SDK's input object");
  assert.deepEqual(policy.requestHeaders({ Authorization: null }), { Authorization: null },
    "explicit deletion must not revive the original provider configuration value");
});

for (const [label, provider, expectedAuthorization] of [
  ["anonymous without a key", { authHeader: false }, null],
  ["anonymous with a supplied key", { authHeader: false, apiKey: fixtureKey,
    headers: { "X-Auth-Fixture": "preserved-fixture-header" } }, null],
  ["anonymous with empty Authorization", { authHeader: false, headers: { Authorization: "" } }, null],
  ["anonymous with whitespace Authorization", { authHeader: false, apiKey: fixtureKey,
    headers: { authorization: " \t " } }, null],
  ["explicit Authorization without a key", { authHeader: false, headers: { Authorization: customAuthorization } }, customAuthorization],
  ["mixed-case explicit Authorization with a key", { authHeader: false, apiKey: fixtureKey,
    headers: { aUtHoRiZaTiOn: customAuthorization, "X-Auth-Fixture": "preserved-fixture-header" } }, customAuthorization],
  ["authenticated with a key", { authHeader: true, apiKey: fixtureKey }, `Bearer ${fixtureKey}`],
]) {
  test(`Pi 1.1 ${label} preserves its configured wire-auth contract`, testOptions, async t => {
    const f = await fixture(t, provider);
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    const originalPrepared = structuredClone(preparedInput);
    assert.equal(f.requests.length, 0, "input preparation must never enter the transport");
    const result = await f.runner.runTask({ ...f.options, preparedInput });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, `${fixtureBaseUrl}/chat/completions`);
    assert.equal(f.requests[0].authorization, expectedAuthorization,
      "inspect the final OpenAI fetch headers, not an intermediate auth object");
    if (expectedAuthorization === null) assert.equal("authorization" in f.requests[0].headers, false);
    if (provider.headers?.["X-Auth-Fixture"]) {
      assert.equal(f.requests[0].headers["x-auth-fixture"], provider.headers["X-Auth-Fixture"],
        "rewriting Authorization must preserve unrelated provider headers");
    }
    assert.equal(f.contexts.length, 1);
    assert.equal(f.contexts[0].hasResolvedApiKey, true, "SDK auth is resolved even when the wire request is anonymous");
    assert.equal(f.contexts[0].systemPrompt, preparedInput.systemPrompt);
    assert.deepEqual(f.contexts[0].tools, preparedInput.tools);
    assert.equal(result.messages.at(-1).stopReason, "stop");
    assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
    assert.equal(f.events.filter(event => event.type === "run_error").length, 0);
    assert.deepEqual(f.hostCalls, []);
    assert.deepEqual(f.approvalCalls, []);
    assert.deepEqual(preparedInput, originalPrepared, "auth policy must not alter frozen model-visible input");
    assertPrivateCredentialsStayPrivate(f, preparedInput, result);
  });
}

for (const [label, headers, expectedAuthorization] of [
  ["anonymous without a key", undefined, null],
  ["explicit custom Authorization without a key", { authorization: customAuthorization,
    "X-Auth-Fixture": "responses-fixture-header" }, customAuthorization],
]) {
  test(`Pi 1.1 Responses ${label} preserves actual wire auth through the registered SDK parser`, testOptions, async t => {
    const f = await fixture(t, { api: "openai-responses", authHeader: false, ...(headers ? { headers } : {}) });
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    const originalPrepared = structuredClone(preparedInput);
    assert.equal(f.requests.length, 0);
    assert.equal(preparedInput.model.api, "openai-responses");
    const result = await f.runner.runTask({ ...f.options, preparedInput });
    assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.equal(request.url, `${fixtureBaseUrl}/responses`);
    assert.equal(request.authorization, expectedAuthorization);
    if (expectedAuthorization === null) assert.equal("authorization" in request.headers, false);
    if (headers) assert.equal(request.headers["x-auth-fixture"], headers["X-Auth-Fixture"]);
    assert.equal(request.body.model, "fixture");
    assert.equal("messages" in request.body, false, "the wire body must use the Responses API, not Completions");
    assert.ok(Array.isArray(request.body.input));
    assert.equal(request.body.input.filter(message => message.role === "user").length, 1);
    assert.equal(f.contexts.length, 1);
    assert.equal(f.contexts[0].hasResolvedApiKey, true);
    assert.equal(f.contexts[0].systemPrompt, preparedInput.systemPrompt);
    assert.deepEqual(f.contexts[0].tools, preparedInput.tools);
    const assistant = result.messages.at(-1);
    assert.equal(assistant.api, "openai-responses");
    assert.equal(assistant.responseId, "resp_auth_fixture");
    assert.equal(assistant.stopReason, "stop");
    assert.ok(assistant.content.some(block => block.type === "text" && block.text === "Responses fixture complete."),
      "the official Responses parser must consume its terminal response and text events");
    assert.equal(assistant.usage.input, 100);
    assert.equal(assistant.usage.output, 16);
    assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
    assert.equal(f.events.filter(event => event.type === "run_error").length, 0);
    assert.deepEqual(f.hostCalls, []);
    assert.deepEqual(f.approvalCalls, []);
    assert.deepEqual(preparedInput, originalPrepared);
    assertPrivateCredentialsStayPrivate(f, preparedInput, result);
  });
}

test("Pi 1.1 authHeader true without a key fails before the wire and never reports success", testOptions, async t => {
  const f = await fixture(t, { authHeader: true });
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.runner.runTask({ ...f.options, preparedInput }), /Provider message ended with an error|No API key|Provider is not configured/u);
  assert.equal(f.requests.length, 0, "the anonymous placeholder must not grant credentials to an authenticated provider");
  assert.equal(f.contexts.length, 0, "required-auth failure precedes invocation of the registered provider transport");
  assert.equal(f.events.filter(event => event.type === "run_end").length, 0);
  assert.equal(f.events.filter(event => event.type === "run_error").length, 1);
  assert.deepEqual(f.hostCalls, []);
  assert.deepEqual(f.approvalCalls, []);
  assertPrivateCredentialsStayPrivate(f, preparedInput);
});

test("Pi 1.1 anonymous approval recovery sends one unauthenticated request and never replays its completed effect", testOptions, async t => {
  const tool = { registeredName: "auth_fixture_effect", serverId: "fixture", rawName: "auth_fixture_effect",
    displayName: "Auth fixture effect", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    sideEffectLevel: "write", defaultApproval: "allow" };
  const f = await fixture(t, { authHeader: false }, { mcpTools: [tool] });
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const continuation = { schemaVersion: 1, kind: "approved_tool_result", approvalId: "approval-auth-fixture",
    sideEffectFingerprint: "auth-fixture-approved-once", toolCallId: "auth-fixture-historical-effect",
    toolName: tool.registeredName, args: {},
    result: { content: [{ type: "text", text: "Durable approved effect already completed." }],
      details: { durableEvidenceId: "auth-fixture-sealed-result" }, isError: false } };
  const originalEvidence = structuredClone(continuation);
  const result = await f.runner.runTask({ ...f.options, preparedInput,
    runId: "run-auth-recovery", runnerAttemptId: "attempt-auth-recovery", approvedToolContinuation: continuation });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].authorization, null);
  assert.equal("authorization" in f.requests[0].headers, false);
  assert.equal(f.contexts[0].systemPrompt, preparedInput.systemPrompt);
  assert.deepEqual(f.contexts[0].tools, preparedInput.tools);
  const history = f.contexts[0].messages.filter(message => message.role !== "system");
  assert.deepEqual(history.map(message => message.role), ["user", "assistant", "toolResult"]);
  assert.deepEqual(history[1].content, [{ type: "toolCall", id: continuation.toolCallId,
    name: continuation.toolName, arguments: continuation.args }]);
  assert.equal(history[2].toolCallId, continuation.toolCallId);
  assert.deepEqual(history[2].content, continuation.result.content);
  assert.deepEqual(history[2].details, continuation.result.details);
  assert.equal(f.requests[0].body.messages.filter(message => message.role === "user").length, 1);
  assert.equal(f.requests[0].body.messages.filter(message => message.role === "tool"
    && message.tool_call_id === continuation.toolCallId).length, 1);
  assert.equal(JSON.stringify(f.requests).includes("ling_host_resume"), false);
  assert.equal(f.events.filter(event => event.type === "message_end" && event.role === "custom").length, 0);
  assert.deepEqual(f.hostCalls, []);
  assert.deepEqual(f.approvalCalls, []);
  assert.deepEqual(continuation, originalEvidence);
  assert.equal(result.messages.at(-1).stopReason, "stop");
  assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
  assert.equal(f.events.filter(event => event.type === "run_error").length, 0);
  assertPrivateCredentialsStayPrivate(f, preparedInput, result);
});

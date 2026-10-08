import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { createInitializedPiSession } from "../dist/session-factory.js";

const historicalCallId = "historical-approved-effect";
const privateError = "PRIVATE_110_PROVIDER_BODY sk-fixture-only";
const fixtureTool = {
  registeredName: "fixture_effect", serverId: "fixture", rawName: "fixture_effect",
  displayName: "Fixture effect", inputSchema: { type: "object", properties: {}, additionalProperties: false },
  sideEffectLevel: "write", defaultApproval: "allow",
};
const names = tools => tools.map(tool => typeof tool === "string" ? tool : tool.name).sort();

function completion({ text = "Completed after recovery.", toolCallId, toolName = "fixture_effect" } = {}) {
  const delta = toolCallId ? {
    tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: toolName, arguments: "{}" } }],
  } : { content: text };
  const records = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolCallId ? "tool_calls" : "stop" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 16, total_tokens: 116 } },
  ];
  return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function unavailable() {
  return new Response(JSON.stringify({ error: { message: privateError } }), {
    status: 503, headers: { "content-type": "application/json" },
  });
}

function approvedEvidence() {
  return {
    schemaVersion: 1, kind: "approved_tool_result", approvalId: "approval-110",
    sideEffectFingerprint: "approved-fingerprint-110", toolCallId: historicalCallId,
    toolName: "fixture_effect", args: {},
    result: { content: [{ type: "text", text: "Durable approved effect already completed." }],
      details: { durableEvidenceId: "sealed-result-110" }, isError: false },
  };
}

/** Actual adapter/session/parser; only this provider's transport is replaced. */
async function fixture(t, overrides = {}, transport = () => completion(), onEvent) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-110-contract-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const contexts = [], wireRequests = [], events = [], hostCalls = [], approvalCalls = [];
  const controller = new AbortController();
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => {
          contexts.push({ messages: structuredClone(context.messages),
            systemPrompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages) });
          return stream(model, context, { ...options, maxRetries: 0,
            fetch: async (_url, request) => {
              wireRequests.push(JSON.parse(request.body));
              return transport({ index: wireRequests.length - 1, context, signal: options?.signal });
            },
          });
        },
      });
    }
  }
  const runner = new FixtureRunner();
  const options = {
    cwd, agentDir: join(cwd, "agent"),
    task: { id: "pi-110-recovery-contract", title: "Recover safely", prompt: "Finish without replaying the approved effect." },
    provider: { provider: "pi-110-contract", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture-no-network", reasoning: false },
    tools: [], signal: controller.signal,
    onApprovalRequired: async request => { approvalCalls.push(request.toolCallId); return { approved: true }; },
    onMcpToolCall: async request => {
      hostCalls.push(request.toolCallId);
      throw new Error("Historical approved effects must not enter a Host callback.");
    },
    ...overrides,
    onEvent: event => { events.push(event); overrides.onEvent?.(event); onEvent?.(event, controller); },
  };
  return { runner, options, controller, contexts, wireRequests, events, hostCalls, approvalCalls };
}

for (const [label, selection, mcpTools, expected] of [
  ["empty", [], [], []],
  ["read-only", ["read"], [], ["read"]],
  ["explicit MCP", ["read"], [{ ...fixtureTool, registeredName: "mcp__authorized" }], ["mcp__authorized", "read"]],
]) {
  test(`Pi 1.1 ${label} surface pins cache warming off and its registered/active/callable allowlist`, async t => {
    const f = await fixture(t, { tools: selection, mcpTools });
    const session = await createInitializedPiSession(f.options,
      runtime => f.runner.registerCustomProviderIfNeeded(runtime, f.options.provider));
    try {
      assert.equal(session.settingsManager.getCacheWarmingMode(), "off",
        "false or an omitted setting falls back to Pi's paid streaming cache warming");
      assert.deepEqual(names(session.getAllTools()), expected);
      assert.deepEqual(names(session.getActiveToolNames()), expected);
      assert.deepEqual(names(session.getCallableToolNames()), expected);
      for (const name of ["codemode", "tool_search", "mcp__unrequested", "request_permission", "write", "bash"]) {
        assert.equal(session.getAllTools().some(tool => tool.name === name), false, name);
        assert.equal(session.getCallableToolNames().includes(name), false, name);
      }
      const prepared = await f.runner.prepareTaskInput(f.options);
      assert.deepEqual(names(prepared.tools), expected);
      assert.equal(f.contexts.length, 0);
      assert.equal(f.wireRequests.length, 0);
      assert.deepEqual(f.hostCalls, []);
    } finally { session.dispose(); }
  });
}

for (const enabled of [false, true]) {
  test(`Pi 1.1 requestPermissions ${enabled ? "on" : "off"} uses the exact request_permission allowlist`, async t => {
    let permissionCalls = 0;
    const f = await fixture(t, {
      tools: ["read"], runtimeToolFeatures: { requestPermissions: enabled },
      onPermissionRequired: async () => { permissionCalls += 1; return { approved: false, reason: "Fixture only." }; },
    });
    const expected = enabled ? ["read", "request_permission"] : ["read"];
    const session = await createInitializedPiSession(f.options,
      runtime => f.runner.registerCustomProviderIfNeeded(runtime, f.options.provider));
    try {
      assert.deepEqual(names(session.getAllTools()), expected);
      assert.deepEqual(names(session.getActiveToolNames()), expected);
      assert.deepEqual(names(session.getCallableToolNames()), expected);
      assert.equal(session.getAllTools().some(tool => tool.name === "request_permissions"), false);
      const preparedInput = await f.runner.prepareTaskInput(f.options);
      assert.deepEqual(names(preparedInput.tools), expected);
      await f.runner.runTask({ ...f.options, preparedInput });
      assert.equal(f.contexts.length, 1);
      assert.deepEqual(names(f.contexts[0].tools), expected);
      assert.equal(f.contexts[0].systemPrompt, preparedInput.systemPrompt);
      assert.equal(permissionCalls, 0, "declaring a permission schema is not permission execution");
    } finally { session.dispose(); }
  });
}

function assertRecoveredContext(context, preparedInput, continuation) {
  assert.equal(context.systemPrompt, preparedInput.systemPrompt);
  assert.deepEqual(names(context.tools), names(preparedInput.tools));
  for (const tool of context.tools) {
    const expected = preparedInput.tools.find(candidate => candidate.name === tool.name);
    assert.equal(tool.description, expected.description);
    assert.deepEqual(tool.parameters, expected.parameters);
    assert.deepEqual(tool.constrainedSampling, expected.constrainedSampling);
  }
  const history = context.messages.filter(message => message.role !== "system");
  assert.deepEqual(history.map(message => message.role), ["user", "assistant", "toolResult"]);
  assert.deepEqual(history[0].content, [{ type: "text", text: preparedInput.userPrompt }]);
  assert.deepEqual(history[1].content, [{ type: "toolCall", id: continuation.toolCallId,
    name: continuation.toolName, arguments: continuation.args }]);
  assert.equal(history[2].toolCallId, continuation.toolCallId);
  assert.equal(history[2].toolName, continuation.toolName);
  assert.deepEqual(history[2].content, continuation.result.content);
  assert.deepEqual(history[2].details, continuation.result.details);
  assert.equal(history[2].isError, false);
  assert.equal(JSON.stringify(context.messages).includes("ling_host_resume"), false);
}

for (const outcome of ["succeeded", "failed", "cancelled"]) {
  test(`Pi 1.1 approved recovery provider retry ${outcome} preserves canonical evidence and terminal authority`,
    { timeout: 15_000 }, async t => {
      const f = await fixture(t, { mcpTools: [fixtureTool] },
        ({ index }) => outcome === "succeeded" && index === 1 ? completion() : unavailable(),
        (event, controller) => {
          if (outcome === "cancelled" && event.type === "provider_retry" && event.phase === "scheduled") {
            // Let Pi register its retry controller before stopping its whole Session driver.
            queueMicrotask(() => controller.abort());
          }
        });
      const preparedInput = await f.runner.prepareTaskInput(f.options);
      const continuation = approvedEvidence(), originalEvidence = structuredClone(continuation);
      const pending = f.runner.runTask({ ...f.options, preparedInput,
        runId: "run-approved-110", runnerAttemptId: "attempt-approved-110", approvedToolContinuation: continuation });
      let result;
      if (outcome === "succeeded") result = await pending;
      else if (outcome === "cancelled") await assert.rejects(pending, { name: "AbortError" });
      else await assert.rejects(pending, /Provider message ended with an error/);
      assert.equal(f.wireRequests.length, outcome === "cancelled" ? 1 : 2);
      assert.equal(f.contexts.length, f.wireRequests.length);
      for (const context of f.contexts) assertRecoveredContext(context, preparedInput, continuation);
      for (const request of f.wireRequests) {
        assert.equal(request.messages.filter(message => message.role === "user").length, 1,
          "the private Session driver control must not become an extra empty user prompt");
        assert.equal(request.messages.filter(message => message.role === "tool" && message.tool_call_id === historicalCallId).length, 1);
        assert.equal(JSON.stringify(request).includes("ling_host_resume"), false);
      }
      assert.deepEqual(f.hostCalls, []);
      assert.deepEqual(f.approvalCalls, []);
      assert.deepEqual(continuation, originalEvidence);
      assert.equal(f.events.filter(event => event.type === "message_end" && event.role === "custom").length, 0,
        "the private Session driver control must not publish a public custom message_end");
      assert.equal(f.events.filter(event => event.type === "run_end").length, outcome === "succeeded" ? 1 : 0);
      assert.equal(f.events.filter(event => event.type === "run_error").length, outcome === "succeeded" ? 0 : 1);
      const retry = f.events.filter(event => event.type === "provider_retry");
      assert.deepEqual(retry.map(event => event.phase), ["scheduled", "settled"]);
      assert.equal(retry.at(-1).outcome, outcome);
      assert.equal(JSON.stringify(f.events).includes(privateError), false);
      if (result) {
        assert.equal(result.messages.some(message => message.role === "custom"), false,
          "the internal driver control is omitted from the public finalized transcript");
        assert.equal(JSON.stringify(result.messages).includes("ling_host_resume"), false);
        assert.equal(result.messages.filter(message => message.role === "toolResult" && message.toolCallId === historicalCallId).length, 1);
      }
    });
}

test("Pi 1.1 approved recovery cancellation waits for its new in-flight Host effect and never reports success",
  { timeout: 15_000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    const effects = [];
    let toolSignal, cleaned = false;
    const f = await fixture(t, { mcpTools: [fixtureTool], onMcpToolCall: async request => {
      effects.push(request.toolCallId);
      toolSignal = request.signal;
      entered.resolve();
      // Deliberately ignore abort until release: settlement must prove actual cleanup.
      await release.promise;
      cleaned = true;
      return { content: [{ type: "text", text: "New effect settled once." }] };
    } }, ({ index }) => index === 0 ? completion({ toolCallId: "new-effect-after-restore" }) : completion());
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    const continuation = approvedEvidence(), originalEvidence = structuredClone(continuation);
    let settled = false;
    const pending = f.runner.runTask({ ...f.options, preparedInput,
      runId: "run-cancel-110", runnerAttemptId: "attempt-cancel-110", approvedToolContinuation: continuation });
    const rejected = assert.rejects(pending, { name: "AbortError" }).then(() => { settled = true; });
    try {
      await Promise.race([entered.promise, pending.then(() => {
        throw new Error("The restored run completed without entering its new Host effect.");
      })]);
      f.controller.abort();
      await nextTick();
      assert.equal(toolSignal.aborted, true);
      assert.equal(settled, false, "cancellation must not publish terminal state while the effect is still running");
      assert.equal(cleaned, false);
      assert.equal(f.events.some(event => event.type === "run_end"), false);
    } finally {
      release.resolve();
      await rejected;
    }
    assert.equal(cleaned, true);
    assert.deepEqual(effects, ["new-effect-after-restore"]);
    assert.deepEqual(f.approvalCalls, ["new-effect-after-restore"]);
    assert.equal(f.wireRequests.length, 1, "cancel closes admission before another provider request");
    assertRecoveredContext(f.contexts[0], preparedInput, continuation);
    assert.deepEqual(continuation, originalEvidence);
    assert.equal(f.events.filter(event => event.type === "message_end" && event.role === "custom").length, 0,
      "cancelled recovery must not publish its private Session driver control");
    assert.equal(f.events.filter(event => event.type === "run_end").length, 0);
    assert.equal(f.events.filter(event => event.type === "run_error").length, 1);
  });

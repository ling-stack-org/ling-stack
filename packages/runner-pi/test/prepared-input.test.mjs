import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { assertPiModelContextCapacity } from "../dist/prepared-input.js";
import { hostCapabilityToolsFixture as hostCapabilityToolsV1 } from "./support/host-capability-fixture.mjs";

async function fixture(t, overrides = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-n03-runner-prepared-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const contexts = [], events = [], wireRequests = [];
  const controls = {};
  let hostCalls = 0;
  const host = async () => { hostCalls += 1; throw new Error("No tool should execute in this fixture"); };
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) => {
        contexts.push(structuredClone({ systemPrompt: getCurrentSystemPrompt(context.messages),
          messages: context.messages.filter(message => message.role !== "system"),
          tools: getCurrentTools(context.messages).map(({ name, description, parameters, constrainedSampling }) =>
          ({ name, description, parameters, ...(constrainedSampling !== undefined ? { constrainedSampling } : {}) })) }));
        controls.beforePayload?.(model, context);
        return stream(model, context, { ...options, fetch: async (_url, request) => {
          wireRequests.push(JSON.parse(request.body));
          const response = controls.response?.();
          if (response) return response;
          return new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"Fixture done."},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
        } });
      } });
    }
  }
  const options = { cwd, agentDir: join(cwd, "agent"), task: { id: "prepared_task", title: "Prepared", prompt: "Current input." },
    provider: { provider: "prepared-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1", api: "openai-completions",
      apiKey: "fixture-not-real", headers: { "X-Test-Credential": "fixture-header-not-real" }, reasoning: false },
    tools: ["read", "bash"], runtimeToolFeatures: { unifiedExec: true },
    appendSystemPrompt: ["FIRST MEMORY", "FIRST SKILL"], onEvent: (event) => events.push(event),
    onApprovalRequired: host, onMcpToolCall: host, onMediaGenerationToolCall: host, onToolHydrationRequest: host,
    mcpTools: [{ registeredName: "fixture_mcp", serverId: "fixture", rawName: "read", displayName: "Fixture MCP",
      inputSchema: { type: "object", properties: { path: { type: "string" } } }, sideEffectLevel: "read", defaultApproval: "allow" }],
    mediaGenerationTools: [{ name: "image_generate", targets: [{ id: "fixture-image", displayName: "Image fixture" }] }], ...overrides };
  return { cwd, runner: new FixtureRunner(), options, contexts, events, controls, wireRequests, hostCalls: () => hostCalls };
}

test("preparation uses real SDK prompt and schemas without a Run, network, callbacks or files", async (t) => {
  const f = await fixture(t);
  const prepared = await f.runner.prepareTaskInput(f.options);
  assert.equal(prepared.schemaVersion, 1);
  assert.equal(prepared.boundary, "pi-model-context");
  assert.ok(prepared.systemPrompt.includes(`<cwd>\n${f.cwd}\n</cwd>`));
  assert.ok(prepared.systemPrompt.includes("FIRST MEMORY\n\nFIRST SKILL"));
  assert.equal(prepared.userPrompt, "Task: Prepared\n\nCurrent input.");
  assert.equal(prepared.tools.some((tool) => tool.name === "image_generate"), true, "media schema is prepared before a Run exists");
  assert.equal(prepared.tools.some((tool) => tool.name === "fixture_mcp"), true);
  assert.equal(prepared.tools.some((tool) => tool.name === "load_tools"), true);
  assert.equal(prepared.tools.some((tool) => tool.name === "hydrated_tool_call"), true);
  assert.equal(prepared.thinkingLevel, "off");
  assert.ok(Object.isFrozen(prepared.tools[0].parameters));
  assert.equal(JSON.stringify(prepared).includes("fixture-not-real"), false);
  assert.equal(JSON.stringify(prepared).includes("fixture-header-not-real"), false);
  assert.equal(f.contexts.length, 0); assert.equal(f.events.length, 0); assert.equal(f.hostCalls(), 0);
  assert.deepEqual(await readdir(f.cwd), []);
  assert.deepEqual(await f.runner.prepareTaskInput(f.options), prepared);
});

test("actual first model context equals the prepared snapshot with current credentials", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const result = await f.runner.runTask({ ...f.options, provider: { ...f.options.provider, apiKey: "rotated-fixture-not-real" },
    runId: "real-fixture-run", runnerAttemptId: "real-fixture-attempt", preparedInput });
  assert.equal(result.taskId, f.options.task.id);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].systemPrompt, preparedInput.systemPrompt);
  assert.deepEqual(f.contexts[0].tools, preparedInput.tools);
  assert.deepEqual(f.contexts[0].messages[0].content, [{ type: "text", text: preparedInput.userPrompt }]);
  assert.equal(f.wireRequests.length, 1);
  assert.deepEqual(f.wireRequests[0].messages, [
    { role: "system", content: preparedInput.systemPrompt },
    { role: "user", content: [{ type: "text", text: preparedInput.userPrompt }] },
  ]);
  assert.equal(f.hostCalls(), 0);
});

// Regression: C01-R10 — typed creates must not advertise the rejected patch protocol.
// Found by /qa on 2026-10-25; report: docs/design/c01-native-create-tool-surface-2026-10-25.md
test("exclusive-create schema is native-only in prepared and actual SDK model input", async t => {
  const f = await fixture(t, { tools: ["write", "edit"], initialToolSurface: {
    mediaGeneration: false, toolHydration: false, nativeFileCreate: true,
  } });
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const write = preparedInput.tools.find(tool => tool.name === "write");
  assert.deepEqual(write.parameters.required, ["path", "content"]);
  assert.deepEqual(Object.keys(write.parameters.properties).sort(), ["content", "path"]);
  assert.equal(write.parameters.additionalProperties, false);
  assert.equal(write.parameters.anyOf, undefined);
  assert.match(write.description, /exclusive|overwrite/i);
  assert.doesNotMatch(write.description, /patchText|apply-patch/);
  assert.ok(preparedInput.tools.find(tool => tool.name === "edit").parameters.properties.patchText,
    "the edit schema is unchanged; the Host still decides authorized effects");
  await f.runner.runTask({ ...f.options, preparedInput, runId: "native-create-run", runnerAttemptId: "native-create-attempt" });
  assert.deepEqual(f.contexts[0].tools, preparedInput.tools);
  assert.equal(f.hostCalls(), 0, "schema selection is not execution authority");
  const ordinary = await f.runner.prepareTaskInput({ ...f.options, initialToolSurface: {
    ...f.options.initialToolSurface, nativeFileCreate: false,
  } });
  assert.ok(ordinary.tools.find(tool => tool.name === "write").parameters.properties.patchText);
  assert.notEqual(ordinary.fingerprint, preparedInput.fingerprint);
  await assert.rejects(f.runner.runTask({ ...f.options, initialToolSurface: {
    ...f.options.initialToolSurface, nativeFileCreate: false,
  }, preparedInput }), /prepared.*input|input.*prepar/i);
  assert.equal(f.contexts.length, 1, "schema drift must fail before any later provider request");
  const withoutWrite = await f.runner.prepareTaskInput({ ...f.options, tools: ["read"] });
  assert.equal(withoutWrite.tools.some(tool => tool.name === "write"), false,
    "native-create selection never activates a tool outside the Host's selection");
});

test("approved tool continuation resumes from the durable Host result without executing the tool again", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const resultBeforeToolCalls = f.hostCalls();
  const result = await f.runner.runTask({
    ...f.options,
    runId: "approved-fixture-run",
    runnerAttemptId: "resume-fixture-attempt",
    preparedInput,
    approvedToolContinuation: {
      schemaVersion: 1,
      kind: "approved_tool_result",
      approvalId: "approval-1",
      sideEffectFingerprint: "fingerprint-1",
      toolCallId: "call-approved",
      toolName: "bash",
      args: { command: "printf approved" },
      result: { content: [{ type: "text", text: "approved output" }], isError: false },
    },
  });
  assert.equal(result.taskId, f.options.task.id);
  assert.equal(f.contexts.length, 1, "resume must make only the post-tool provider request");
  assert.deepEqual(f.contexts[0].messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
  assert.deepEqual(f.contexts[0].messages[1].content, [{
    type: "toolCall",
    id: "call-approved",
    name: "bash",
    arguments: { command: "printf approved" },
  }]);
  assert.deepEqual(f.contexts[0].messages[2], {
    role: "toolResult",
    toolCallId: "call-approved",
    toolName: "bash",
    content: [{ type: "text", text: "approved output" }],
    details: undefined,
    isError: false,
    timestamp: 0,
  });
  assert.equal(f.hostCalls(), resultBeforeToolCalls, "historical approved evidence must not re-enter a tool handler");
  assert.equal(f.wireRequests.length, 1);
});

test("approved continuation sends a bounded large result without changing Host evidence", async (t) => {
  const f = await fixture(t);
  const provider = { ...f.options.provider, contextWindow: 5_000, maxTokens: 512 };
  const options = { ...f.options, provider };
  const preparedInput = await f.runner.prepareTaskInput(options);
  const fullResult = "tool evidence ".repeat(3_000);
  await f.runner.runTask({ ...options, preparedInput,
    approvedToolContinuation: {
      schemaVersion: 1, kind: "approved_tool_result", approvalId: "large-result-approval",
      sideEffectFingerprint: "large-result-fingerprint", toolCallId: "large-result-call",
      toolName: "bash", args: { command: "fixture" },
      result: { content: [{ type: "text", text: fullResult }], isError: false },
    },
  });
  assert.equal(f.contexts.length, 1);
  assert.match(f.contexts[0].messages.at(-1).content[0].text, /truncated/);
  assert.ok(f.contexts[0].messages.at(-1).content[0].text.length < fullResult.length);
  assert.equal(f.wireRequests.length, 1);
  assert.equal(f.hostCalls(), 0);
});

for (const change of ["prompt", "system", "tool-schema", "tool-set", "model", "fingerprint"]) {
  test(`prepared ${change} drift fails before any model transport`, async (t) => {
    const f = await fixture(t);
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    let receipts = 0;
    const changed = { ...f.options, preparedInput, runId: "fixture-run", runnerAttemptId: "fixture-attempt",
      onPreparedInputAccepted: () => { receipts += 1; } };
    if (change === "prompt") changed.task = { ...changed.task, prompt: "DRIFT" };
    if (change === "system") changed.appendSystemPrompt = ["DRIFT"];
    if (change === "tool-schema") changed.mcpTools = [{ ...changed.mcpTools[0], inputSchema: { type: "string" } }];
    if (change === "tool-set") changed.tools = ["read"];
    if (change === "model") changed.provider = { ...changed.provider, model: "changed" };
    if (change === "fingerprint") changed.preparedInput = { ...preparedInput, fingerprint: "invalid" };
    await assert.rejects(f.runner.runTask(changed), /prepared.*input|input.*prepar/i);
    assert.equal(receipts, 0);
    assert.equal(f.contexts.length, 0);
    assert.equal(f.hostCalls(), 0);
    assert.equal(f.events.some((event) => event.type === "run_end"), false);
  });
}

test("cancelled preparation cannot become a prepared input", async (t) => {
  const f = await fixture(t, { signal: AbortSignal.abort() });
  await assert.rejects(f.runner.prepareTaskInput(f.options), { name: "AbortError" });
  assert.equal(f.contexts.length, 0); assert.equal(f.hostCalls(), 0);
});

test("initial schema capabilities prepare without fake handlers or a Run", async (t) => {
  const f = await fixture(t, { onToolHydrationRequest: undefined, onMediaGenerationToolCall: undefined,
    initialToolSurface: { mediaGeneration: true, toolHydration: true } });
  const prepared = await f.runner.prepareTaskInput(f.options);
  for (const name of ["image_generate", "load_tools", "hydrated_tool_call"]) assert.ok(prepared.tools.some((tool) => tool.name === name));
  assert.equal(f.hostCalls(), 0); assert.equal(f.contexts.length, 0);
  assert.deepEqual(await readdir(f.cwd), []);
});

for (const changed of ["system", "messages", "model", "tools"]) {
  test(`late ${changed} drift after initial SDK validation is blocked before transport`, async (t) => {
    const f = await fixture(t);
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    f.controls.beforePayload = (model, context) => {
      if (changed === "system") context.messages[0].content += "\nLATE_DRIFT";
      if (changed === "messages") context.messages.find(message => message.role === "user").content = "LATE_DRIFT";
      if (changed === "model") model.contextWindow += 1;
      if (changed === "tools") getCurrentTools(context.messages)[0].description += " LATE_DRIFT";
    };
    let receipts = 0;
    await assert.rejects(f.runner.runTask({ ...f.options, runId: "fixture-run", runnerAttemptId: "fixture-attempt", preparedInput,
      onPreparedInputAccepted: () => { receipts += 1; } }), /prepared.*input|input.*prepar/i);
    assert.equal(receipts, 1, "receiver acceptance is not later provider transport or task success");
    assert.equal(f.contexts.length, 1, "initial validation did reach the provider assembly");
    assert.equal(f.wireRequests.length, 0, "the changed payload never reached transport");
    assert.equal(f.hostCalls(), 0);
    assert.equal(f.events.some((event) => event.type === "run_end"), false);
  });
}

test("prepared receipt is immutable, minimal, and precedes model execution", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const receipts = [];
  await f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: (receipt, signal) => {
      assert.equal(f.contexts.length, 0);
      assert.equal(f.wireRequests.length, 0);
      assert.equal(f.hostCalls(), 0);
      assert.ok(Object.isFrozen(receipt));
      assert.ok(signal instanceof AbortSignal);
      receipts.push(receipt);
    } });
  assert.deepEqual(receipts, [{ schemaVersion: 1, boundary: "pi-session-ready", runId: "receipt-run",
    attemptId: "receipt-attempt", taskId: f.options.task.id, preparedInputFingerprint: preparedInput.fingerprint }]);
  assert.equal(f.wireRequests.length, 1);
});

test("preparation never emits a prepared receipt even when a callback is present", async (t) => {
  const f = await fixture(t);
  let received = 0;
  await f.runner.prepareTaskInput({ ...f.options, onPreparedInputAccepted: () => { received += 1; } });
  assert.equal(received, 0);
  assert.equal(f.contexts.length, 0);
});

test("final prepared-input gate rejects oversized prompt before transport, with or without a snapshot", async t => {
  const f = await fixture(t);
  const options = { ...f.options,
    task: { ...f.options.task, prompt: "oversized ".repeat(20_000) },
    provider: { ...f.options.provider, contextWindow: 4_096, maxTokens: 512 } };
  const prepared = await f.runner.prepareTaskInput(options);
  assert.ok(prepared.fingerprint);
  await assert.rejects(f.runner.runTask(options), /model context exceeds selected model budget/);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.wireRequests.length, 0);
  assert.equal(f.hostCalls(), 0);
});

test("final prepared-input gate includes tool schemas and reserved output", async t => {
  const f = await fixture(t);
  const options = { ...f.options,
    provider: { ...f.options.provider, contextWindow: 4_096, maxTokens: 512 },
    mcpTools: [{ ...f.options.mcpTools[0], inputSchema: { type: "object", description: "schema ".repeat(20_000) } }] };
  const prepared = await f.runner.prepareTaskInput(options);
  assert.ok(prepared.fingerprint);
  await assert.rejects(f.runner.runTask({ ...options, preparedInput: prepared }), /model context exceeds selected model budget/);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.wireRequests.length, 0);
});

test("post-tool model context gate counts cumulative projected results", () => {
  const model = { contextWindow: 6_000, maxTokens: 512 };
  const context = { systemPrompt: "system", tools: [], messages: [
    { role: "user", content: "request" },
    { role: "toolResult", content: [{ type: "text", text: "x".repeat(8_000) }] },
    { role: "toolResult", content: [{ type: "text", text: "y".repeat(8_000) }] },
  ] };
  assert.doesNotThrow(() => assertPiModelContextCapacity(model, context));
  context.messages.push({ role: "toolResult", content: [{ type: "text", text: "z".repeat(8_000) }] });
  const projected = assertPiModelContextCapacity(model, context);
  const results = projected.messages.filter(message => message.role === "toolResult");
  assert.ok(results[0].content[0].text.length < 8_000);
  assert.match(results[0].content[0].text, /truncated/);
  assert.equal(context.messages[1].content[0].text.length, 8_000, "Host/SDK evidence remains complete");
});

test("provider capacity gate uses remaining model space instead of a fixed tool-result allowance", () => {
  const model = { contextWindow: 1_800, maxTokens: 256 };
  const context = { systemPrompt: "system", tools: [], messages: [
    { role: "user", content: "request" },
    { role: "toolResult", content: [{ type: "text", text: "x".repeat(10_000) }] },
  ] };
  const projected = assertPiModelContextCapacity(model, context);
  const result = projected.messages.find(message => message.role === "toolResult");
  assert.match(result.content[0].text, /truncated/);
  assert.ok(result.content[0].text.length < 10_000);
  assert.equal(context.messages[1].content[0].text.length, 10_000);
  assert.doesNotThrow(() => assertPiModelContextCapacity(model, projected));
});

test("provider boundary refuses a tool history whose required omission markers exceed the model-view budget", () => {
  const model = { contextWindow: 1_000_000, maxTokens: 512 };
  const context = { systemPrompt: "system", tools: [], messages: [
    { role: "user", content: "request" },
    ...Array.from({ length: 9_000 }, () => ({ role: "toolResult", content: [{ type: "text", text: "x".repeat(20) }] })),
  ] };
  assert.throws(() => assertPiModelContextCapacity(model, context), /tool result markers exceed/);
});

test("Host schemas are prepared without handlers and frozen through the real SDK", async t => {
  const f = await fixture(t, { tools: [], mcpTools: [], mediaGenerationTools: [],
    hostCapabilityTools: hostCapabilityToolsV1, onHostCapabilityCall: undefined });
  const prepared = await f.runner.prepareTaskInput(f.options);
  assert.ok(prepared.tools.some(tool => tool.name === "host_open_local_target"));
  assert.ok(prepared.tools.some(tool => tool.name === "host_local_network_info"));
  assert.equal(f.hostCalls(), 0); assert.equal(f.wireRequests.length, 0);
  for (const hostCapabilityTools of [[], [{ ...hostCapabilityToolsV1[0], description: "changed" }]]) {
    await assert.rejects(f.runner.runTask({ ...f.options, preparedInput: prepared, hostCapabilityTools }), /prepared.*input|input.*prepar/i);
  }
  assert.equal(f.wireRequests.length, 0);
});
test("reserved Host names fail before SDK resource loading even with no Host schema selected", async t => {
  const f = await fixture(t, { hostCapabilityTools: [], mcpTools: [{ registeredName: "host_open_local_target", serverId: "fixture",
    rawName: "impersonation", displayName: "Not a Host tool", inputSchema: { type: "object" }, sideEffectLevel: "read", defaultApproval: "allow" }] });
  await assert.rejects(f.runner.prepareTaskInput(f.options), /Host capability names are reserved/);
  await assert.rejects(f.runner.runTask(f.options), /Host capability names are reserved/);
  assert.equal(f.wireRequests.length, 0); assert.equal(f.hostCalls(), 0);
});

for (const missing of ["preparedInput", "runId", "runnerAttemptId"]) {
  test(`prepared receipt requires ${missing} before model execution`, async (t) => {
    const f = await fixture(t);
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    let received = 0;
    const options = { ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
      onPreparedInputAccepted: () => { received += 1; } };
    delete options[missing];
    await assert.rejects(f.runner.runTask(options), /prepared.*receipt|receipt.*prepared/i);
    assert.equal(received, 0);
    assert.equal(f.contexts.length, 0);
    assert.equal(f.wireRequests.length, 0);
  });
}

for (const rejected of [new Error("Host receipt rejected"), "Host rejection", undefined]) {
  test(`prepared receipt rejection (${typeof rejected}) cannot execute or report success`, async (t) => {
    const f = await fixture(t);
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    let failure = { notRejected: true };
    try {
      await f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
        onPreparedInputAccepted: async () => { throw rejected; } });
    } catch (error) { failure = error; }
    assert.equal(failure, rejected);
    assert.equal(f.contexts.length, 0);
    assert.equal(f.wireRequests.length, 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });
}

test("prepared receipt waits for Host acceptance before the first model call", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const running = f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: async () => { entered.resolve(); await release.promise; } });
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error("Run bypassed prepared receipt"); })]);
    assert.equal(f.contexts.length, 0);
    assert.equal(f.wireRequests.length, 0);
  } finally { release.resolve(); await running; }
  assert.equal(f.wireRequests.length, 1);
});

for (const settlement of ["resolve", "reject"]) {
  test(`cancelled prepared receipt ignores late ${settlement} and never dispatches`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t);
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    const entered = Promise.withResolvers(), pending = Promise.withResolvers(), abort = new AbortController();
    // The red implementation may never invoke the callback; still observe fixture cleanup.
    void pending.promise.catch(() => {});
    let receiverSignal;
    const running = f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
      signal: abort.signal, onPreparedInputAccepted: (_receipt, signal) => {
        receiverSignal = signal; entered.resolve(); return pending.promise;
      } });
    try {
      await Promise.race([entered.promise, running.then(() => { throw new Error("Run bypassed prepared receipt"); })]);
      abort.abort();
      await assert.rejects(running, { name: "AbortError" });
      assert.equal(receiverSignal.aborted, true);
    } finally {
      pending[settlement](settlement === "reject" ? new Error("Late Host rejection") : undefined);
      await running.catch(() => {});
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.contexts.length, 0);
    assert.equal(f.wireRequests.length, 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });
}

test("prepared receipt callback cannot silently replace the accepted task input", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  let received = 0;
  await assert.rejects(f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: () => { received += 1; f.options.task.prompt = "Changed during Host acceptance"; } }),
  /prepared.*input|input.*prepar/i);
  assert.equal(received, 1);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.wireRequests.length, 0);
});

test("prepared receipt synchronous Host exception survives SDK cleanup", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options), rejected = new Error("Synchronous receipt rejection");
  await assert.rejects(f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: () => { throw rejected; } }), error => error === rejected);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

test("prepared receipt is not emitted for a Run cancelled before initialization", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  let receipts = 0;
  await assert.rejects(f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    signal: AbortSignal.abort(), onPreparedInputAccepted: () => { receipts += 1; } }), { name: "AbortError" });
  assert.equal(receipts, 0);
  assert.equal(f.contexts.length, 0);
});

test("prepared receipt is once per execution, not per model/tool round", async (t) => {
  let receipts = 0, tools = 0;
  const f = await fixture(t, { onApprovalRequired: async () => ({ approved: true }), onMcpToolCall: async () => {
    assert.equal(receipts, 1); tools += 1; return { content: [{ type: "text", text: "Read fixture." }] };
  } });
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  f.controls.response = () => f.wireRequests.length !== 1 ? undefined : new Response(
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"fixture-call","type":"function","function":{"name":"fixture_mcp","arguments":"{}"}}]},"finish_reason":null}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } });
  await f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: () => { receipts += 1; } });
  assert.equal(receipts, 1);
  assert.equal(tools, 1);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.wireRequests.length, 2);
});

test("prepared receipt does not mask a subsequent provider failure", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  f.controls.response = () => new Response(JSON.stringify({ error: { message: "fixture_failure", type: "invalid_request_error" } }),
    { status: 400, headers: { "content-type": "application/json" } });
  let receipts = 0;
  await assert.rejects(f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: () => { receipts += 1; } }), /Provider message ended with an error/);
  assert.equal(receipts, 1);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
  assert.ok(f.events.some(event => event.type === "run_error"));
});

test("parallel prepared receipt rejection does not close another execution", async (t) => {
  const a = await fixture(t), b = await fixture(t);
  const [pa, pb] = await Promise.all([a.runner.prepareTaskInput(a.options), b.runner.prepareTaskInput(b.options)]);
  const receipts = [];
  const outcomes = await Promise.allSettled([
    a.runner.runTask({ ...a.options, runId: "rejected-run", runnerAttemptId: "rejected-attempt", preparedInput: pa,
      onPreparedInputAccepted: receipt => { receipts.push(receipt); throw new Error("Only A rejected"); } }),
    b.runner.runTask({ ...b.options, runId: "accepted-run", runnerAttemptId: "accepted-attempt", preparedInput: pb,
      onPreparedInputAccepted: receipt => { receipts.push(receipt); } }),
  ]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "fulfilled");
  assert.deepEqual(receipts.map(receipt => receipt.runId).sort(), ["accepted-run", "rejected-run"]);
  assert.equal(a.wireRequests.length, 0);
  assert.equal(b.wireRequests.length, 1);
});

test("recreated Runner reports the same receipt identity for Host idempotency", async (t) => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options), receipts = [];
  const options = { ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: receipt => { receipts.push(receipt); throw new Error("No durable Host ACK in this fixture"); } };
  for (let i = 0; i < 2; i += 1) await assert.rejects(new f.runner.constructor().runTask(options), /No durable Host ACK/);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(f.wireRequests.length, 0);
});

for (const invalid of ["callback", "blank-run", "blank-attempt", "task"]) {
  test(`prepared receipt rejects malformed ${invalid} before initialization`, async (t) => {
    const f = await fixture(t);
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    let receipts = 0;
    const options = { ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
      onPreparedInputAccepted: () => { receipts += 1; } };
    if (invalid === "callback") options.onPreparedInputAccepted = null;
    if (invalid === "blank-run") options.runId = "  ";
    if (invalid === "blank-attempt") options.runnerAttemptId = "  ";
    if (invalid === "task") options.task = { ...options.task, id: "another-task" };
    await assert.rejects(f.runner.runTask(options), /prepared.*receipt/i);
    assert.equal(receipts, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.contexts.length, 0);
  });
}

test("prepared receipt pins input even if the caller mutates and rehashes its snapshot", async (t) => {
  const f = await fixture(t);
  const preparedInput = JSON.parse(JSON.stringify(await f.runner.prepareTaskInput(f.options)));
  const expectedFingerprint = preparedInput.fingerprint;
  let receipt;
  await assert.rejects(f.runner.runTask({ ...f.options, runId: "receipt-run", runnerAttemptId: "receipt-attempt", preparedInput,
    onPreparedInputAccepted: received => {
      receipt = received;
      f.options.task.prompt = "Changed and rehashed";
      preparedInput.userPrompt = "Task: Prepared\n\nChanged and rehashed";
      const { fingerprint: _old, ...body } = preparedInput;
      preparedInput.fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    } }), /prepared.*input|input.*prepar/i);
  assert.equal(receipt.preparedInputFingerprint, expectedFingerprint);
  assert.notEqual(preparedInput.fingerprint, expectedFingerprint);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.wireRequests.length, 0);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { assertHostReadonlyToolSurface, createLingStackHostReadonlyExtension } from "../dist/extensions/host-readonly.js";
import { createPiTaskBoundary } from "../dist/task-boundary.js";
import { readPiCompletedBuiltinReads, readPiCompletedTools, readPiProviderBoundaryInventory,
  readPiSettledBoundaryInventory } from "../dist/tool-boundary-observation.js";

const names = ["read", "grep", "find", "ls"];
const handled = { content: [{ type: "text", text: "HOST_HANDLED_ONLY" }], details: { profile: "host_readonly_v1" } };
function baseOptions(changes = {}) {
  return { cwd: process.cwd(), task: { id: "readonly", title: "Readonly", prompt: "Inspect bounded inputs." },
    provider: { provider: "fixture", model: "fixture" }, readonlyToolsProfile: "host_readonly_v1",
    onToolBefore: () => ({ allowed: true }), onReadonlyToolCall: () => handled, ...changes };
}
function install(changes = {}) {
  const tools = new Map(), hooks = new Map();
  const options = baseOptions(changes);
  createLingStackHostReadonlyExtension(options)({ on: (event, handler) => hooks.set(event, handler), registerTool: tool => tools.set(tool.name, tool) });
  return { tools, hooks, options };
}

test("Host readonly overrides all four core definitions and advertises literal-only grep", () => {
  const f = install();
  assert.deepEqual([...f.tools.keys()], names);
  for (const [name, tool] of f.tools) {
    assert.equal(tool.label, name);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
  const grep = f.tools.get("grep");
  assert.equal(grep.parameters.properties.literal.const, true);
  assert.ok(grep.parameters.required.includes("literal"));
  assert.match(grep.description, /regex is unsupported/i);
});

for (const toolName of names) {
  test(`${toolName} dispatches only the exact Host request and preserves handled error status`, async () => {
    const requests = [], before = [];
    const f = install({ onToolBefore: request => { before.push(request); return { allowed: true }; },
      onReadonlyToolCall: request => { requests.push(request); return { ...handled, isError: true }; } });
    const input = { path: "nonexistent-no-sdk-fallback", ...(toolName === "grep" ? { pattern: "needle", literal: true } : {}),
      ...(toolName === "find" ? { pattern: "*.ts" } : {}) };
    const result = await f.tools.get(toolName).execute("call-1", input);
    assert.equal(requests.length, 1);
    assert.equal(before.length, 1);
    assert.equal(requests[0].toolName, toolName);
    assert.equal(requests[0].toolCallId, "call-1");
    assert.equal(requests[0].input, input);
    assert.equal(requests[0].cwd, process.cwd());
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(result.content[0].text, "HOST_HANDLED_ONLY");
    assert.equal(f.hooks.get("tool_result")({ ...result, toolCallId: "call-1", toolName, isError: false }).isError, true);
  });
}

test("producer-level gate denial, cancellation and missing results never fall back", async () => {
  let calls = 0;
  const denied = install({ onToolBefore: () => ({ allowed: false, code: "fixture_denied", reason: "Blocked by Host" }),
    onReadonlyToolCall: () => { calls++; return handled; } });
  const result = await denied.tools.get("read").execute("denied", { path: "secret" });
  assert.equal(result.details.code, "fixture_denied");
  assert.equal(calls, 0);
  const aborted = new AbortController();
  aborted.abort(new Error("cancelled before dispatch"));
  const f = install({ onReadonlyToolCall: () => { calls++; return handled; } });
  await assert.rejects(f.tools.get("read").execute("cancelled", { path: "secret" }, aborted.signal), /cancelled before dispatch/);
  assert.equal(calls, 0);
  const missing = install({ onReadonlyToolCall: () => undefined });
  await assert.rejects(missing.tools.get("find").execute("missing", { pattern: "*" }), /workflow_readonly_host_result_missing/);
  const broken = install({ onReadonlyToolCall: () => { throw new Error("Host unavailable"); } });
  await assert.rejects(broken.tools.get("grep").execute("broken", { pattern: "x", literal: true }), /Host unavailable/);
});

test("profile validation rejects missing handlers, invalid profiles and builtin name impersonation", () => {
  for (const [changes, message] of [
    [{ onToolBefore: undefined }, "workflow_readonly_tool_before_missing"],
    [{ onReadonlyToolCall: undefined }, "workflow_readonly_host_handler_missing"],
    [{ readonlyToolsProfile: "unverified" }, "workflow_readonly_profile_invalid"],
    [{ mcpTools: [{ registeredName: "read" }] }, "workflow_readonly_tool_name_collision"],
  ]) assert.throws(() => assertHostReadonlyToolSurface(baseOptions(changes)), { message });
  assert.doesNotThrow(() => assertHostReadonlyToolSurface(baseOptions({ readonlyToolsProfile: undefined, onToolBefore: undefined, onReadonlyToolCall: undefined })));
});

test("task boundary forwards its cancellation signal and rejects late Host results", async () => {
  let resolveHost, request, calls = 0;
  const controller = new AbortController();
  const boundary = createPiTaskBoundary(baseOptions({ signal: controller.signal, onReadonlyToolCall: next => {
    calls++; request = next; return new Promise(resolve => { resolveHost = resolve; });
  } }));
  const promise = boundary.options.onReadonlyToolCall({ toolCallId: "late", toolName: "read", input: {}, cwd: process.cwd() });
  controller.abort(new Error("cancelled while waiting"));
  assert.equal(request.signal.aborted, true);
  resolveHost(handled);
  await assert.rejects(promise, { name: "AbortError" });
  await assert.rejects(boundary.options.onReadonlyToolCall({ toolCallId: "next", toolName: "ls", input: {}, cwd: process.cwd() }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("unexpected readonly Host failure closes future model/tool admission", async () => {
  let calls = 0;
  const failure = new Error("Host fence changed");
  const boundary = createPiTaskBoundary(baseOptions({ onReadonlyToolCall: () => { calls++; throw failure; } }));
  const request = { toolCallId: "stale", toolName: "read", input: {}, cwd: process.cwd() };
  await assert.rejects(boundary.options.onReadonlyToolCall(request), error => error === failure);
  assert.equal(boundary.options.signal.aborted, true);
  assert.throws(boundary.assertOpen, error => error === failure);
  await assert.rejects(boundary.options.onReadonlyToolCall(request), error => error === failure);
  assert.equal(calls, 1);
});

function response(call) {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: "Readonly complete." };
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
  ].map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

/** Actual SDK tools/events/continuation; only this fixture's provider transport is replaced. */
async function fixture(t, calls = [], changes = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-host-readonly-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests = [], events = [], hostCalls = [], gates = [], points = [];
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) => stream(model, context, {
        ...options, fetch: async () => {
          requests.push(structuredClone(context));
          return response(calls[requests.length - 1]);
        },
      }) });
    }
  }
  const options = baseOptions({ cwd, agentDir: join(cwd, "agent"), tools: names,
    runId: "readonly-run", runnerAttemptId: "readonly-attempt", hostCompactionEnabled: true,
    provider: { provider: "readonly-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture-not-real", reasoning: false }, ...changes,
    onEvent: event => { events.push(event); changes.onEvent?.(event); },
    onToolBefore: request => { gates.push(request); return changes.onToolBefore?.(request) ?? { allowed: true }; },
    onReadonlyToolCall: request => { hostCalls.push(request); return changes.onReadonlyToolCall?.(request) ?? handled; },
    onTaskContinuationBoundary: async (...args) => { points.push(args[0]); return changes.onTaskContinuationBoundary?.(...args); },
  });
  return { runner: new FixtureRunner(), options, cwd, requests, events, hostCalls, gates, points };
}

test("prepare and run fail closed without both Host handlers before model dispatch", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  for (const [key, message] of [["onToolBefore", "workflow_readonly_tool_before_missing"], ["onReadonlyToolCall", "workflow_readonly_host_handler_missing"]]) {
    const options = { ...f.options, [key]: undefined };
    await assert.rejects(f.runner.prepareTaskInput(options), { message });
    await assert.rejects(f.runner.runTask(options), { message });
  }
  assert.equal(f.requests.length, 0);
});

test("observation cannot disguise a missing Host gate as an authorized readonly profile", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let observations = 0;
  for (const onToolBefore of [undefined, null, false, {}, "not-a-function"]) {
    await assert.rejects(f.runner.runTask({ ...f.options, onToolBefore,
      onToolBoundaryObservation() { observations++; } }),
      { message: "workflow_readonly_tool_before_missing" });
  }
  assert.equal(observations, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.points.length, 0);
});

test("actual SDK Host reads retain paired results, observation and continuation", { timeout: 15_000 }, async t => {
  const calls = names.map((name, index) => ({ name, id: `readonly-${index}`, input: name === "grep" ? { pattern: "x", literal: true }
    : name === "find" ? { pattern: "*.ts" } : { path: "not-read-by-sdk" } }));
  let receipt, settled;
  const inventories = [];
  const f = await fixture(t, calls, {
    onToolBoundaryObservation: value => { receipt = value; },
    onTaskContinuationBoundary: point => {
      if (point === "before_provider_request") inventories.push(readPiProviderBoundaryInventory(receipt, "readonly-run", "readonly-attempt"));
    },
    onTaskSettledBoundary: () => { settled = readPiSettledBoundaryInventory(receipt, "readonly-run", "readonly-attempt"); },
  });
  await writeFile(join(f.cwd, "not-read-by-sdk"), "RAW_SDK_FILE_MUST_NOT_REACH_MODEL");
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  assert.deepEqual(preparedInput.tools.map(tool => tool.name).sort(), [...names].sort());
  assert.equal(f.requests.length, 0);
  await f.runner.runTask({ ...f.options, preparedInput });
  assert.equal(f.hostCalls.length, 4);
  assert.equal(f.requests.length, 5);
  assert.equal(f.points.filter(point => point === "tool_call").length, 4);
  for (const call of calls) {
    assert.equal(f.gates.filter(gate => gate.toolCallId === call.id).length, 2, "event gate and actual producer recheck");
    assert.equal(f.events.find(event => event.type === "tool_end" && event.toolCallId === call.id).result.content[0].text, "HOST_HANDLED_ONLY");
  }
  const results = f.requests.at(-1).messages.filter(message => message.role === "toolResult");
  assert.equal(results.length, 4);
  assert.ok(results.every(result => result.content[0].text === "HOST_HANDLED_ONLY"));
  const expectedReads = calls.map(call => ({ toolCallId: call.id, toolName: call.name }));
  assert.deepEqual(settled.settledBuiltinReads, expectedReads);
  assert.deepEqual(readPiCompletedBuiltinReads(receipt, "readonly-run", "readonly-attempt"), expectedReads);
  assert.deepEqual(readPiCompletedTools(receipt, "readonly-run", "readonly-attempt"), expectedReads);
  assert.deepEqual(inventories.map(value => value.toolCallIds.length), [0, 1, 2, 3, 4]);
});

test("Host handled failure stays failed in the real SDK model continuation", { timeout: 15_000 }, async t => {
  const f = await fixture(t, [{ name: "grep", id: "denied", input: { pattern: "x", literal: true } }], {
    onReadonlyToolCall: () => ({ ...handled, isError: true, details: { code: "workflow_readonly_fs_denied" } }),
  });
  await f.runner.runTask(f.options);
  assert.equal(f.events.find(event => event.type === "tool_end").isError, true);
  const result = f.requests[1].messages.find(message => message.role === "toolResult");
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "workflow_readonly_fs_denied");
});

test("local extensions and context cannot replace the Host readonly producers", { timeout: 15_000 }, async t => {
  const f = await fixture(t, [{ name: "read", id: "host-only", input: { path: "notes.txt" } }]);
  await mkdir(join(f.cwd, "agent", "extensions"), { recursive: true });
  await mkdir(join(f.cwd, ".pi", "extensions"), { recursive: true });
  const extension = 'export default function () { throw new Error("LOCAL_EXTENSION_MUST_NOT_LOAD"); }';
  await writeFile(join(f.cwd, "agent", "extensions", "escape.js"), extension);
  await writeFile(join(f.cwd, ".pi", "extensions", "escape.js"), extension);
  await writeFile(join(f.cwd, "AGENTS.md"), "LOCAL_CONTEXT_MUST_NOT_LOAD");
  await writeFile(join(f.cwd, "agent", "AGENTS.md"), "USER_CONTEXT_MUST_NOT_LOAD");
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  assert.doesNotMatch(preparedInput.systemPrompt, /LOCAL_CONTEXT_MUST_NOT_LOAD|USER_CONTEXT_MUST_NOT_LOAD/);
  await f.runner.runTask({ ...f.options, preparedInput });
  assert.equal(f.hostCalls.length, 1);
  assert.equal(f.events.find(event => event.type === "tool_end").result.content[0].text, "HOST_HANDLED_ONLY");
});

test("readonly Host gate blocks shell and file mutation before their actual producers", { timeout: 15_000 }, async t => {
  const calls = [{ name: "bash", id: "shell", input: { command: "touch escaped" } },
    { name: "write", id: "write", input: { path: "escaped", content: "forbidden" } },
    { name: "edit", id: "edit", input: { path: "notes.txt", edits: [{ oldText: "original", newText: "forbidden" }] } }];
  let mutationCalls = 0;
  const f = await fixture(t, calls, { tools: [...names, "bash", "write", "edit"],
    onToolBefore: request => names.includes(request.toolName) ? { allowed: true }
      : { allowed: false, code: "workflow_readonly_tool_denied", reason: "Not in frozen readonly tool plan" },
    onApprovalRequired: () => { mutationCalls++; throw new Error("mutation producer must not run"); },
  });
  await writeFile(join(f.cwd, "notes.txt"), "original");
  await f.runner.runTask(f.options);
  assert.equal(mutationCalls, 0);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(await readFile(join(f.cwd, "notes.txt"), "utf8"), "original");
  await assert.rejects(readFile(join(f.cwd, "escaped")), { code: "ENOENT" });
  assert.equal(f.events.filter(event => event.type === "tool_end").length, 3);
  assert.ok(f.events.filter(event => event.type === "tool_end").every(event => event.isError));
});

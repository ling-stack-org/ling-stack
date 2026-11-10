import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { assertHostIsolatedFilesToolSurface, createLingStackHostIsolatedFilesExtension,
  withHostIsolatedFilesToolSurface } from "../dist/extensions/host-isolated-files.js";
import { createPiTaskBoundary } from "../dist/task-boundary.js";
import { createInitializedPiSession } from "../dist/session-factory.js";
import { readPiCompletedBuiltinReads, readPiCompletedTools } from "../dist/tool-boundary-observation.js";

const names = ["read", "grep", "find", "ls", "write", "edit"];
const profile = "host_isolated_files_v1";
const surface = { mediaGeneration: false, toolHydration: false, userInput: false, delegation: false, nativeFileCreate: false };
const handled = { content: [{ type: "text", text: "HOST_ISOLATED_HANDLED" }], details: { profile } };
const testOptions = { timeout: 15_000 };
const inputFor = name => name === "grep" ? { pattern: "x", literal: true }
  : name === "find" ? { pattern: "*.txt" }
  : name === "write" ? { path: "missing-parent/new.txt", content: "SDK_MUST_NOT_WRITE" }
  : name === "edit" ? { path: "existing.txt", edits: [{ oldText: "original", newText: "SDK_MUST_NOT_EDIT" }] }
  : { path: "existing.txt" };

function baseOptions(changes = {}) {
  return { cwd: process.cwd(), task: { id: "isolated", title: "Isolated files", prompt: "Complete bounded file work." },
    provider: { provider: "fixture", model: "fixture" }, isolatedToolsProfile: profile,
    initialToolSurface: { ...surface }, onToolBefore: () => ({ allowed: true }), onIsolatedToolCall: () => handled, ...changes };
}

function install(changes = {}) {
  const tools = new Map(), hooks = new Map();
  const options = baseOptions(changes);
  createLingStackHostIsolatedFilesExtension(options)({ on: (event, handler) => hooks.set(event, handler), registerTool: tool => tools.set(tool.name, tool) });
  return { tools, hooks, options };
}

test("isolated profile overrides all six definitions with native file schemas and no SDK producers", () => {
  const f = install();
  assert.deepEqual([...f.tools.keys()], names);
  for (const [name, tool] of f.tools) {
    assert.equal(tool.label, name);
    assert.equal(tool.executionMode, "sequential");
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
    assert.equal(tool.prepareArguments, undefined, "no SDK legacy mutation argument adapter");
    assert.match(tool.description, /Host isolated-files handler/);
  }
  assert.deepEqual(f.tools.get("write").parameters.required, ["path", "content"]);
  assert.deepEqual(f.tools.get("edit").parameters.required, ["path", "edits"]);
  const edits = f.tools.get("edit").parameters.properties.edits;
  assert.equal(edits.type, "array");
  assert.equal(edits.minItems, 1);
  assert.deepEqual(edits.items.required, ["oldText", "newText"]);
  assert.equal(edits.items.properties.oldText.type, "string");
  assert.equal(edits.items.properties.newText.type, "string");
  for (const name of ["write", "edit"]) {
    assert.equal(f.tools.get(name).parameters.properties.patchText, undefined);
    assert.equal(f.tools.get(name).parameters.properties.patch, undefined);
    assert.equal(f.tools.get(name).parameters.anyOf, undefined);
  }
  assert.equal(f.tools.get("grep").parameters.properties.literal.const, true);
  assert.ok(f.tools.get("grep").parameters.required.includes("literal"));
  assert.match(f.tools.get("write").description, /not created/);
  assert.match(f.tools.get("edit").description, /exactly once/);
});

for (const toolName of names) {
  test(`${toolName} uses only the Host request and preserves async handled errors`, async () => {
    const before = [], requests = [];
    const f = install({ onToolBefore: async request => { before.push(request); return { allowed: true }; },
      onIsolatedToolCall: async request => { requests.push(request); return { ...handled, isError: true }; } });
    const input = inputFor(toolName);
    const result = await f.tools.get(toolName).execute("call-1", input);
    assert.equal(before.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0], before[0]);
    assert.equal(requests[0].input, input);
    assert.equal(requests[0].toolName, toolName);
    assert.equal(requests[0].toolCallId, "call-1");
    assert.equal(requests[0].cwd, process.cwd());
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(result.content[0].text, handled.content[0].text);
    assert.equal(f.hooks.get("tool_result")({ ...result, toolCallId: "call-1", toolName, isError: false }).isError, true);
  });
}

test("selection defaults are isolated-only, snapshot initial surface, and never trim explicit required tools", () => {
  const original = baseOptions();
  const selected = withHostIsolatedFilesToolSurface(original);
  assert.deepEqual(selected.tools, names);
  assert.deepEqual(selected.initialToolSurface, surface);
  assert.notEqual(selected.initialToolSurface, original.initialToolSurface);
  assert.ok(Object.isFrozen(selected.tools));
  assert.ok(Object.isFrozen(selected.initialToolSurface));
  const tools = ["read", "edit"];
  const subset = withHostIsolatedFilesToolSurface(baseOptions({ tools }));
  tools.push("bash");
  assert.deepEqual(subset.tools, ["read", "edit"]);
  for (const tool of ["bash", "mcp_fixture", "cua_click", "image_generate", "spawn_agent", "tool_search", "request_user_input"]) {
    const requiredTools = ["read", tool];
    assert.throws(() => withHostIsolatedFilesToolSurface(baseOptions({ tools: requiredTools })), { message: "workflow_isolated_tool_selection_invalid" });
    assert.deepEqual(requiredTools, ["read", tool]);
  }
  const legacy = baseOptions({ isolatedToolsProfile: undefined, onToolBefore: undefined, onIsolatedToolCall: undefined, tools: ["bash"] });
  assert.equal(withHostIsolatedFilesToolSurface(legacy), legacy);
  const readonly = { ...legacy, readonlyToolsProfile: "host_readonly_v1" };
  assert.equal(withHostIsolatedFilesToolSurface(readonly), readonly);
});

test("profile validation is fail-closed and mutually exclusive with readonly", () => {
  for (const [changes, message] of [
    [{ isolatedToolsProfile: "unverified" }, "workflow_isolated_profile_invalid"],
    [{ readonlyToolsProfile: "host_readonly_v1" }, "workflow_isolated_profile_conflict"],
    [{ onToolBefore: undefined }, "workflow_isolated_tool_before_missing"],
    [{ onIsolatedToolCall: undefined }, "workflow_isolated_host_handler_missing"],
  ]) {
    assert.throws(() => assertHostIsolatedFilesToolSurface(baseOptions(changes)), { message });
    assert.throws(() => createPiTaskBoundary(baseOptions(changes)), { message });
  }
  assert.throws(() => install({ isolatedToolsProfile: undefined }), { message: "workflow_isolated_profile_required" });
});

const forbiddenSurfaces = [
  ["MCP selection", { mcpTools: [{ registeredName: "mcp_fixture" }] }],
  ["builtin MCP impersonation", { mcpTools: [{ registeredName: "write" }] }],
  ["Host/CUA selection", { hostCapabilityTools: [{ name: "cua_click" }] }],
  ["media selection", { mediaGenerationTools: [{ name: "image_generate", targets: [] }] }],
  ...Object.keys(surface).map(key => [`${key} surface`, { initialToolSurface: { ...surface, [key]: true } }]),
  ...["requestPermissions", "unifiedExec", "shellSnapshot"].map(key => [key, { runtimeToolFeatures: { [key]: true } }]),
  ...["onMcpToolCall", "onHostCapabilityCall", "onMediaGenerationToolCall", "onToolHydrationRequest",
    "onDelegationToolCall", "onUserInputRequest", "onPermissionRequired"].map(key => [key, { [key]: () => assert.fail("forbidden Host surface") }]),
];
for (const [label, changes] of forbiddenSurfaces) {
  test(`isolated profile rejects ${label} instead of hiding the requested capability`, () => {
    assert.throws(() => assertHostIsolatedFilesToolSurface(baseOptions(changes)), { message: "workflow_isolated_external_surface_forbidden" });
  });
}

test("extension rejects unselected tools even if the Host gate would allow them", async () => {
  let calls = 0;
  const f = install({ tools: ["read"], onIsolatedToolCall: () => { calls++; return handled; } });
  assert.equal(f.hooks.get("tool_call")({ toolName: "read" }), undefined);
  for (const toolName of ["bash", "write", "mcp_fixture", "cua_click", "image_generate", "spawn_agent", "tool_search"]) {
    assert.equal(f.hooks.get("tool_call")({ toolName }).block, true);
  }
  await assert.rejects(f.tools.get("edit").execute("unselected", inputFor("edit")), /workflow_isolated_tool_denied/);
  assert.equal(calls, 0);
});

test("producer rechecks current gate and profile; denial, invalid result and cancellation cannot fall back", async () => {
  let calls = 0;
  const f = install({ onToolBefore: () => ({ allowed: false, code: "revoked", reason: "Host scope revoked" }),
    onIsolatedToolCall: () => { calls++; return handled; } });
  const result = await f.tools.get("write").execute("revoked", inputFor("write"));
  assert.equal(result.details.code, "revoked");
  assert.equal(calls, 0);
  const invalid = install({ onToolBefore: () => ({ allowed: "yes" }) });
  await assert.rejects(invalid.tools.get("write").execute("invalid", inputFor("write")), /workflow_isolated_tool_before_result_invalid/);
  const missing = install({ onIsolatedToolCall: () => undefined });
  await assert.rejects(missing.tools.get("edit").execute("missing", inputFor("edit")), /workflow_isolated_host_result_missing/);
  const broken = install({ onIsolatedToolCall: () => { throw new Error("Host failed after intent"); } });
  await assert.rejects(broken.tools.get("write").execute("broken", inputFor("write")), /Host failed after intent/);
  const abort = new AbortController();
  const cancelled = install({ signal: abort.signal, onToolBefore: () => { abort.abort(new Error("revoked at actual producer")); return { allowed: true }; },
    onIsolatedToolCall: () => { calls++; return handled; } });
  await assert.rejects(cancelled.tools.get("write").execute("cancelled", inputFor("write")), /revoked at actual producer/);
  const changed = install({ onIsolatedToolCall: () => { calls++; return handled; } });
  changed.options.onToolBefore = () => { changed.options.isolatedToolsProfile = undefined; return { allowed: true }; };
  await assert.rejects(changed.tools.get("edit").execute("changed", inputFor("edit")), /workflow_isolated_profile_required/);
  assert.equal(calls, 0);
});

test("boundary merges cancellation, rejects late results and closes the next actual producer", async () => {
  const caller = new AbortController(), tool = new AbortController();
  let resolveHost, request, calls = 0;
  const boundary = createPiTaskBoundary(baseOptions({ signal: caller.signal, onIsolatedToolCall: next => {
    calls++; request = next; return new Promise(resolve => { resolveHost = resolve; });
  } }));
  assert.equal(boundary.options.isolatedToolsProfile, profile);
  assert.deepEqual(boundary.options.initialToolSurface, surface);
  const pending = boundary.options.onIsolatedToolCall({ toolCallId: "late", toolName: "write", input: inputFor("write"), cwd: process.cwd(), signal: tool.signal });
  caller.abort(new Error("cancelled while Host was writing"));
  assert.equal(request.signal.aborted, true);
  resolveHost(handled);
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(boundary.options.onIsolatedToolCall({ ...request, toolCallId: "next" }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("tool-specific cancellation reaches the Host independently of caller cancellation", async () => {
  const caller = new AbortController(), tool = new AbortController();
  let request;
  const boundary = createPiTaskBoundary(baseOptions({ signal: caller.signal, onIsolatedToolCall: next => { request = next; return handled; } }));
  await boundary.options.onIsolatedToolCall({ toolCallId: "merged", toolName: "read", input: {}, cwd: process.cwd(), signal: tool.signal });
  tool.abort();
  assert.equal(request.signal.aborted, true);
  assert.equal(caller.signal.aborted, false);
});

test("Host failure or missing receipt latches failure instead of becoming SDK retry narration", async () => {
  for (const missing of [false, true]) {
    let calls = 0;
    const failure = new Error("Host effect outcome unknown");
    const boundary = createPiTaskBoundary(baseOptions({ onIsolatedToolCall: () => { calls++; if (missing) return undefined; throw failure; } }));
    const request = { toolCallId: "unknown", toolName: "write", input: inputFor("write"), cwd: process.cwd() };
    const expected = missing ? /workflow_isolated_host_result_missing/ : error => error === failure;
    await assert.rejects(boundary.options.onIsolatedToolCall(request), expected);
    assert.equal(boundary.options.signal.aborted, true);
    assert.throws(boundary.assertOpen, expected);
    await assert.rejects(boundary.options.onIsolatedToolCall(request), expected);
    assert.equal(calls, 1);
  }
});

test("unexpected gate failure closes admission even when the SDK tool-call hook catches it", async () => {
  const failure = new Error("Host authority fence unavailable");
  const boundary = createPiTaskBoundary(baseOptions({ onToolBefore: () => { throw failure; } }));
  await assert.rejects(boundary.options.onToolBefore({ toolCallId: "gate", toolName: "write", input: {}, cwd: process.cwd() }), error => error === failure);
  assert.throws(boundary.assertOpen, error => error === failure);
  assert.equal(boundary.options.signal.aborted, true);
});

function response(call) {
  const delta = call ? { tool_calls: [{ index: 0, id: call.id, type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: "Bounded file task complete." };
  return new Response([
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
  ].map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

/** Real SDK schema, event hooks, tools and recovery; only the provider transport is scripted. */
async function fixture(t, calls = [], changes = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-host-isolated-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests = [], events = [], hostCalls = [], gates = [], points = [];
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) => stream(model, context, {
        ...options, fetch: async () => { requests.push(structuredClone(context)); return response(calls[requests.length - 1]); },
      }) });
    }
  }
  const options = baseOptions({ cwd, agentDir: join(cwd, "agent"), runId: "isolated-run", runnerAttemptId: "isolated-attempt", hostCompactionEnabled: true,
    provider: { provider: "isolated-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-not-real", reasoning: false },
    ...changes,
    onEvent: event => { events.push(event); changes.onEvent?.(event); },
    onToolBefore: request => { gates.push(request); return changes.onToolBefore?.(request) ?? { allowed: true }; },
    onIsolatedToolCall: request => { hostCalls.push(request); return changes.onIsolatedToolCall ? changes.onIsolatedToolCall(request) : handled; },
    onTaskContinuationBoundary: async (...args) => { points.push(args[0]); return changes.onTaskContinuationBoundary?.(...args); },
  });
  return { runner: new FixtureRunner(), options, cwd, requests, events, hostCalls, gates, points };
}

test("prepare/run reject missing real Host handlers before observation, SDK or provider work", testOptions, async t => {
  const f = await fixture(t);
  let observations = 0;
  for (const [key, message] of [["onToolBefore", "workflow_isolated_tool_before_missing"], ["onIsolatedToolCall", "workflow_isolated_host_handler_missing"]]) {
    for (const value of [undefined, null, false, {}, "not-a-function"]) {
      const options = { ...f.options, [key]: value, onToolBoundaryObservation: () => { observations++; } };
      await assert.rejects(f.runner.prepareTaskInput(options), { message });
      await assert.rejects(f.runner.runTask(options), { message });
    }
  }
  assert.equal(observations, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.events.length, 0);
  assert.equal(f.points.length, 0);
});

test("real SDK preparation never silently drops required tools or requested external surfaces", testOptions, async t => {
  const f = await fixture(t);
  for (const changes of [{ tools: ["read", "bash"] }, ...forbiddenSurfaces.map(([, value]) => value), { readonlyToolsProfile: "host_readonly_v1" }]) {
    await assert.rejects(f.runner.prepareTaskInput({ ...f.options, ...changes }), /workflow_isolated_/);
    await assert.rejects(f.runner.runTask({ ...f.options, ...changes }), /workflow_isolated_/);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.events.length, 0);
});

test("lower-level SDK initialization refuses unresolved default tools instead of exposing default bash", testOptions, async t => {
  const f = await fixture(t);
  await assert.rejects(createInitializedPiSession(f.options, runtime => f.runner.registerCustomProviderIfNeeded(runtime, f.options.provider)),
    { message: "workflow_isolated_tool_selection_missing" });
  assert.equal(f.requests.length, 0);
});

test("actual SDK dispatches exactly six Host tools, paired results and producer rechecks without default writes", testOptions, async t => {
  let receipt, approvals = 0;
  const calls = names.map((name, index) => ({ name, id: `isolated-${index}`, input: inputFor(name) }));
  const f = await fixture(t, calls, { onToolBoundaryObservation: value => { receipt = value; },
    onApprovalRequired: () => { approvals++; throw new Error("Legacy approval producer must not be installed"); } });
  await writeFile(join(f.cwd, "existing.txt"), "original");
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  assert.deepEqual(preparedInput.tools.map(tool => tool.name).sort(), [...names].sort());
  assert.match(preparedInput.systemPrompt, /host_isolated_files_v1/);
  assert.equal(f.requests.length, 0);
  await f.runner.runTask({ ...f.options, preparedInput });
  assert.equal(f.hostCalls.length, 6);
  assert.equal(f.requests.length, 7);
  assert.equal(approvals, 0);
  assert.equal(f.points.filter(point => point === "tool_call").length, 6);
  assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt"), calls.map(call => ({ toolCallId: call.id, toolName: call.name })));
  assert.deepEqual(readPiCompletedBuiltinReads(receipt, "isolated-run", "isolated-attempt"), calls.slice(0, 4).map(call => ({ toolCallId: call.id, toolName: call.name })));
  for (const call of calls) {
    assert.equal(f.gates.filter(gate => gate.toolCallId === call.id).length, 2, "event admission and actual Host producer recheck");
    assert.equal(f.events.find(event => event.type === "tool_end" && event.toolCallId === call.id).result.content[0].text, handled.content[0].text);
  }
  const results = f.requests.at(-1).messages.filter(message => message.role === "toolResult");
  assert.equal(results.length, 6);
  assert.ok(results.every(result => result.content[0].text === handled.content[0].text));
  assert.deepEqual(getCurrentTools(f.requests.at(-1).messages).map(tool => tool.name).sort(), [...names].sort());
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), "original");
  await assert.rejects(readFile(join(f.cwd, "missing-parent", "new.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.cwd, "missing-parent")), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify(f.requests), /SDK_MUST_NOT_READ_THIS/);
});

test("readonly calls cannot reach SDK reads when the Host returns a handled error", testOptions, async t => {
  const f = await fixture(t, [{ name: "read", id: "denied-read", input: { path: "secret.txt" } }], {
    onIsolatedToolCall: () => ({ ...handled, isError: true, details: { code: "host_path_denied" } }),
  });
  await writeFile(join(f.cwd, "secret.txt"), "SDK_MUST_NOT_READ_THIS");
  await f.runner.runTask(f.options);
  assert.equal(f.events.find(event => event.type === "tool_end").isError, true);
  const result = f.requests[1].messages.find(message => message.role === "toolResult");
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "host_path_denied");
  assert.doesNotMatch(JSON.stringify(f.requests), /SDK_MUST_NOT_READ_THIS/);
});

test("SDK does not execute bash, MCP, CUA, media, delegation or hydration even with a permissive Host gate", testOptions, async t => {
  const forbidden = ["bash", "mcp_fixture", "cua_click", "image_generate", "video_generate", "spawn_agent", "send_message", "resume_agent", "tool_search", "tool_call", "request_user_input", "request_permission"];
  const calls = forbidden.map((name, index) => ({ name, id: `forbidden-${index}`, input: { command: "touch escaped", path: "escaped" } }));
  const f = await fixture(t, calls);
  await f.runner.runTask(f.options);
  assert.equal(f.hostCalls.length, 0);
  await assert.rejects(readFile(join(f.cwd, "escaped")), { code: "ENOENT" });
  const toolEnds = f.events.filter(event => event.type === "tool_end");
  assert.equal(toolEnds.length, forbidden.length);
  assert.ok(toolEnds.every(event => event.isError));
  assert.ok(f.requests.every(context => getCurrentTools(context.messages).every(tool => names.includes(tool.name))));
});

test("a narrower frozen selection cannot dispatch registered but unselected Host file tools", testOptions, async t => {
  const f = await fixture(t, ["write", "edit"].map(name => ({ name, id: `unselected-${name}`, input: inputFor(name) })), { tools: ["read"] });
  await writeFile(join(f.cwd, "existing.txt"), "original");
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  await f.runner.runTask({ ...f.options, preparedInput });
  assert.deepEqual(preparedInput.tools.map(tool => tool.name), ["read"]);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.events.filter(event => event.type === "tool_end" && event.isError).length, 2);
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), "original");
  await assert.rejects(readFile(join(f.cwd, "missing-parent", "new.txt")), { code: "ENOENT" });
});

test("actual SDK native schemas reject patch/legacy edit inputs without invoking a Host or default writer", testOptions, async t => {
  const calls = [
    { name: "write", id: "patch-write", input: { patchText: "*** Begin Patch\n*** Add File: escaped\n+escape\n*** End Patch" } },
    { name: "edit", id: "legacy-edit", input: { path: "existing.txt", oldText: "original", newText: "escape" } },
    { name: "grep", id: "regex-grep", input: { pattern: ".*", literal: false } },
    ...[[], { oldText: "original", newText: "escape" }, '[{"oldText":"original","newText":"escape"}]',
      [{ oldText: "original" }]].map((edits, index) => ({ name: "edit", id: `invalid-edits-${index}`, input: { path: "existing.txt", edits } })),
  ];
  const f = await fixture(t, calls);
  await writeFile(join(f.cwd, "existing.txt"), "original");
  await f.runner.runTask(f.options);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.events.filter(event => event.type === "tool_end").length, calls.length);
  assert.ok(f.events.filter(event => event.type === "tool_end").every(event => event.isError));
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), "original");
  await assert.rejects(readFile(join(f.cwd, "escaped")), { code: "ENOENT" });
});

test("real SDK passes native multi-edit arrays unchanged to the sole Host handler", testOptions, async t => {
  const input = { path: "existing.txt", edits: [{ oldText: "alpha", newText: "beta" }, { oldText: "beta", newText: "gamma" }] };
  const f = await fixture(t, [{ name: "edit", id: "multi-edit", input }]);
  await writeFile(join(f.cwd, input.path), "alpha beta");
  await f.runner.runTask(f.options);
  assert.equal(f.hostCalls.length, 1);
  assert.deepEqual(f.hostCalls[0].input, input);
  assert.deepEqual(Object.keys(f.hostCalls[0].input), ["path", "edits"]);
  assert.equal(await readFile(join(f.cwd, input.path), "utf8"), "alpha beta", "no SDK edit producer or normalization");
  assert.equal(f.requests[1].messages.find(message => message.role === "toolResult").content[0].text, handled.content[0].text);
});

test("Host may delegate isolated mutations to one approval handledResult without installing a second writer", testOptions, async t => {
  const approvals = [];
  const onApprovalRequired = async request => { approvals.push(request); return { approved: true, approvalId: "host-approval", handledResult: handled }; };
  const f = await fixture(t, ["write", "edit"].map(name => ({ name, id: `approved-${name}`, input: inputFor(name) })), {
    onApprovalRequired,
    onIsolatedToolCall: async request => {
      const decision = await onApprovalRequired({ ...request, task: { id: "isolated", title: "Isolated files", prompt: "Complete bounded file work." } });
      assert.equal(decision.approved, true);
      return decision.handledResult;
    },
  });
  await writeFile(join(f.cwd, "existing.txt"), "original");
  await f.runner.runTask(f.options);
  assert.deepEqual(approvals.map(request => request.toolName), ["write", "edit"]);
  assert.equal(f.hostCalls.length, 2);
  assert.ok(f.requests[2].messages.filter(message => message.role === "toolResult").every(result => result.content[0].text === handled.content[0].text));
  assert.equal(await readFile(join(f.cwd, "existing.txt"), "utf8"), "original");
  await assert.rejects(readFile(join(f.cwd, "missing-parent", "new.txt")), { code: "ENOENT" });
});

test("current Host revocation at actual producer prevents the write admitted by the SDK event hook", testOptions, async t => {
  let gate = 0;
  const f = await fixture(t, [{ name: "write", id: "write-revoked", input: inputFor("write") }], {
    onToolBefore: () => ++gate === 1 ? { allowed: true } : { allowed: false, code: "authority_revoked", reason: "Host admission changed" },
  });
  await f.runner.runTask(f.options);
  assert.equal(gate, 2);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.events.find(event => event.type === "tool_end").isError, true);
  assert.equal(f.requests[1].messages.find(message => message.role === "toolResult").details.code, "authority_revoked");
});

test("a continuation refusal keeps the full SDK inventory but never claims a Host write dispatch", testOptions, async t => {
  let receipt, boundaries = 0;
  const calls = ["first-write", "revoked-write"].map(id => ({ name: "write", id, input: inputFor("write") }));
  const failure = new Error("Host source authority was revoked");
  const f = await fixture(t, calls, {
    onToolBoundaryObservation: value => { receipt = value; },
    onTaskContinuationBoundary: point => { if (point === "tool_call" && ++boundaries === 2) throw failure; },
  });
  await assert.rejects(f.runner.runTask(f.options), error => error === failure);
  assert.deepEqual(f.hostCalls.map(call => call.toolCallId), ["first-write"]);
  assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt"),
    calls.map(call => ({ toolCallId: call.id, toolName: call.name })));
  assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt", "isolated_host_effects"),
    [{ toolCallId: "first-write", toolName: "write" }]);
  assert.equal(readPiCompletedTools({ ...receipt }, "isolated-run", "isolated-attempt", "isolated_host_effects"), undefined);
  assert.equal(readPiCompletedTools(receipt, "other-run", "isolated-attempt", "isolated_host_effects"), undefined);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

for (const refusal of ["event-gate", "producer-gate", "schema", "unselected", "unknown-tool"]) {
  test(`closed isolated Host inventory excludes ${refusal} only when no producer ran`, testOptions, async t => {
    let receipt, gates = 0;
    const call = { name: refusal === "unknown-tool" ? "bash" : "write", id: "not-dispatched",
      input: refusal === "schema" ? { path: "new.txt" } : inputFor("write") };
    const f = await fixture(t, [call], {
      ...(refusal === "unselected" ? { tools: ["read"] } : {}),
      onToolBoundaryObservation: value => { receipt = value; },
      onToolBefore: () => ++gates === (refusal === "event-gate" ? 1 : refusal === "producer-gate" ? 2 : -1)
        ? { allowed: false, code: "revoked", reason: "Host rejected before dispatch" } : { allowed: true },
      onTaskContinuationBoundary: () => {
        assert.equal(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt", "isolated_host_effects"), undefined,
          "a live SDK inventory is never a closed producer inventory");
      },
    });
    await f.runner.runTask(f.options);
    assert.equal(f.hostCalls.length, 0);
    assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt"),
      [{ toolCallId: call.id, toolName: call.name }]);
    assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt", "isolated_host_effects"), []);
    assert.equal(f.events.find(event => event.type === "tool_end").isError, true);
  });
}

test("an error-looking Host result cannot be mistaken for a pre-dispatch refusal", testOptions, async t => {
  let receipt;
  const f = await fixture(t, [{ name: "write", id: "host-error", input: inputFor("write") }], {
    onToolBoundaryObservation: value => { receipt = value; },
    onIsolatedToolCall: () => ({ isError: true, content: [{ type: "text", text: "workflow_start_owner_stale" }],
      details: { code: "authority_revoked" } }),
  });
  await f.runner.runTask(f.options);
  assert.equal(f.hostCalls.length, 1);
  assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt", "isolated_host_effects"),
    [{ toolCallId: "host-error", toolName: "write" }]);
});

test("legacy SDK observation cannot opt into isolated Host-only coverage", testOptions, async t => {
  let receipt;
  const f = await fixture(t, [], { tools: [], isolatedToolsProfile: undefined,
    onToolBoundaryObservation: value => { receipt = value; } });
  await f.runner.runTask(f.options);
  assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt"), []);
  assert.equal(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt", "isolated_host_effects"), undefined);
});

for (const missing of [false, true]) {
  test(`real SDK stops after ${missing ? "missing Host receipt" : "unexpected Host write failure"} without retrying the effect`, testOptions, async t => {
    let receipt;
    const failure = new Error("Host outcome unknown after durable intent");
    const f = await fixture(t, [{ name: "write", id: "unknown-write", input: inputFor("write") }], {
      onToolBoundaryObservation: value => { receipt = value; },
      onIsolatedToolCall: async request => {
        await writeFile(join(request.cwd, "host-effect.txt"), "Host already performed this effect");
        if (missing) return undefined;
        throw failure;
      },
    });
    await assert.rejects(f.runner.runTask(f.options), missing ? /workflow_isolated_host_result_missing/ : error => error === failure);
    assert.equal(f.hostCalls.length, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
    assert.deepEqual(readPiCompletedTools(receipt, "isolated-run", "isolated-attempt", "isolated_host_effects"),
      [{ toolCallId: "unknown-write", toolName: "write" }], "unknown effects remain in Core's receipt requirements");
    assert.equal(await readFile(join(f.cwd, "host-effect.txt"), "utf8"), "Host already performed this effect");
    await assert.rejects(readFile(join(f.cwd, "missing-parent", "new.txt")), { code: "ENOENT" });
  });
}

test("local extensions, context and skills cannot replace the isolated Host producers", testOptions, async t => {
  const f = await fixture(t, [{ name: "write", id: "host-only", input: inputFor("write") }]);
  for (const root of [join(f.cwd, "agent"), join(f.cwd, ".pi")]) {
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "escape.js"), 'export default function () { throw new Error("LOCAL_EXTENSION_MUST_NOT_LOAD"); }');
    await mkdir(join(root, "skills", "escape"), { recursive: true });
    await writeFile(join(root, "skills", "escape", "SKILL.md"), "LOCAL_SKILL_MUST_NOT_LOAD");
    await writeFile(join(root, "AGENTS.md"), "LOCAL_CONTEXT_MUST_NOT_LOAD");
  }
  await writeFile(join(f.cwd, "AGENTS.md"), "LOCAL_CONTEXT_MUST_NOT_LOAD");
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  assert.doesNotMatch(JSON.stringify(preparedInput), /LOCAL_(?:SKILL|CONTEXT)_MUST_NOT_LOAD/);
  await f.runner.runTask({ ...f.options, preparedInput });
  assert.equal(f.hostCalls.length, 1);
});

for (const tools of [[], ["read"], names]) {
  test(`frozen input pins isolated profile with ${tools.length} selected tools and rejects legacy/readonly downgrade`, testOptions, async t => {
    const f = await fixture(t, [], { tools });
    const preparedInput = await f.runner.prepareTaskInput(f.options);
    for (const changes of [{ isolatedToolsProfile: undefined }, { isolatedToolsProfile: undefined, readonlyToolsProfile: "host_readonly_v1", onReadonlyToolCall: () => handled }]) {
      await assert.rejects(f.runner.runTask({ ...f.options, ...changes, preparedInput }), /prepared input changed/);
    }
    assert.equal(f.requests.length, 0);
    assert.equal(f.hostCalls.length, 0);
  });
}

test("caller mutation after observation cannot widen the frozen isolated selection or initial surface", testOptions, async t => {
  const tools = ["read"], initialToolSurface = { ...surface };
  const f = await fixture(t, [], { tools, initialToolSurface,
    onToolBoundaryObservation: () => { tools.push("bash"); initialToolSurface.delegation = true; } });
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  await f.runner.runTask({ ...f.options, preparedInput });
  assert.deepEqual(getCurrentTools(f.requests[0].messages).map(tool => tool.name), ["read"]);
  assert.deepEqual(preparedInput.tools.map(tool => tool.name), ["read"]);
  assert.equal(f.hostCalls.length, 0);
});

test("ordinary recovery retains the isolated schema and initial surface without replaying historical write/edit", testOptions, async t => {
  let acknowledgements = 0;
  const f = await fixture(t, [{ name: "read", id: "fresh-read", input: { path: "fresh.txt" } }]);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  const modelView = [
    { role: "user", content: [{ type: "text", text: preparedInput.userPrompt }], timestamp: 0 },
    { role: "assistant", content: ["write", "edit"].map((name, index) => ({ type: "toolCall", id: `historical-${index}`, name, arguments: inputFor(name) })), timestamp: 1 },
    ...["write", "edit"].map((name, index) => ({ role: "toolResult", toolCallId: `historical-${index}`, toolName: name,
      isError: false, ...handled, timestamp: index + 2 })),
  ];
  await f.runner.runTask({ ...f.options, preparedInput, ordinaryProgressRecovery: { schemaVersion: 1, modelView },
    onPreparedInputAccepted: () => { acknowledgements++; } });
  assert.equal(acknowledgements, 1);
  assert.deepEqual(f.hostCalls.map(call => call.toolName), ["read"]);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(getCurrentTools(f.requests[0].messages).map(tool => tool.name).sort(), [...names].sort());
  assert.equal(f.events.filter(event => event.type === "tool_start").length, 1);
  await assert.rejects(readFile(join(f.cwd, "missing-parent", "new.txt")), { code: "ENOENT" });
  for (const changes of [{ isolatedToolsProfile: undefined }, { initialToolSurface: { ...surface, toolHydration: true } }]) {
    await assert.rejects(f.runner.runTask({ ...f.options, ...changes, preparedInput, ordinaryProgressRecovery: { schemaVersion: 1, modelView } }),
      /prepared input changed|workflow_isolated_external_surface_forbidden/);
  }
  assert.equal(f.requests.length, 2);
  assert.equal(f.hostCalls.length, 1);
});

test("approved tool-result continuation keeps isolated producers and never replays the durable write", testOptions, async t => {
  const f = await fixture(t);
  const preparedInput = await f.runner.prepareTaskInput(f.options);
  await writeFile(join(f.cwd, "already-written.txt"), "Durable Host content");
  await f.runner.runTask({ ...f.options, preparedInput, approvedToolContinuation: {
    schemaVersion: 1, kind: "approved_tool_result", approvalId: "isolated-approval", sideEffectFingerprint: "isolated-effect",
    toolCallId: "historical-write", toolName: "write", args: { path: "already-written.txt", content: "MUST_NOT_REPLAY" }, result: handled,
  } });
  assert.equal(f.requests.length, 1);
  assert.equal(f.hostCalls.length, 0);
  assert.equal(f.gates.length, 0);
  assert.equal(f.events.filter(event => event.type === "tool_start" || event.type === "tool_end").length, 0);
  assert.deepEqual(getCurrentTools(f.requests[0].messages).map(tool => tool.name).sort(), [...names].sort());
  assert.equal(f.requests[0].messages.find(message => message.role === "toolResult").toolCallId, "historical-write");
  assert.equal(await readFile(join(f.cwd, "already-written.txt"), "utf8"), "Durable Host content");
});

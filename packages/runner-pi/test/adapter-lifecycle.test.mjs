import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { createInitializedPiSession } from "../dist/session-factory.js";
import { response as compactionResponse } from "./support/pi-compaction-fixture.mjs";
import { formatTaskPrompt } from "../dist/utils.js";

const requiredInput = { kind: "user_input_required", requestId: "input_fixture", requestVersion: 1 };
const acceptedTaskAnchor = options => ({ role: "user", content: [{ type: "text", text: formatTaskPrompt(options.task) }], timestamp: 0 });

test("Host compaction opt-in enables SDK compaction only for the admitted Run", { timeout: 10000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-host-compaction-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const provider = { provider: "host-compaction-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
    api: "openai-completions", apiKey: "fixture-no-network", reasoning: false };
  const adapter = new PiRunnerAdapter();
  for (const [hostCompactionEnabled, expected] of [[undefined, false], [true, true]]) {
    const session = await createInitializedPiSession({ cwd, task: { id: "host-compaction", title: "Host", prompt: "Test" },
      provider, tools: [], hostCompactionEnabled }, (runtime) => adapter.registerCustomProviderIfNeeded(runtime, provider));
    try {
      assert.equal(session.autoCompactionEnabled, expected);
    } finally {
      session.dispose();
    }
  }
});

test("Host compaction cannot start without durable identity and provider admission", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.runner.runTask({ ...f.options, hostCompactionEnabled: true }),
    /Host compaction requires Run\/Attempt identity, durable events, and a provider admission fence/);
  assert.equal(f.requestCount(), 0);
});

test("required input retains the captured request when a caller mutates its directive", { timeout: 10000 }, async (t) => {
  const directive = { ...requiredInput };
  const f = await fixture(t, {
    onTaskContinuationBoundary: async () => directive,
    onEvent: (event) => {
      if (event.type === "message_end" && event.role === "assistant") directive.requestId = "mutated_late";
    },
  });
  await assert.rejects(f.runner.runTask(f.options), (error) => {
    assert.equal(error.name, "PiRunnerYielded");
    assert.deepEqual(error.request, requiredInput);
    assert.ok(Object.isFrozen(error.request));
    return true;
  });
  assert.equal(directive.requestId, "mutated_late", "fixture mutated after admission closed");
});

test("user cancellation while a requested yield settles takes precedence over checkpoint creation", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, {
    onTaskContinuationBoundary: async () => requiredInput,
    onEvent: (event) => {
      if (event.type === "message_end" && event.role === "assistant") f.controller.abort();
    },
  });
  await assert.rejects(f.runner.runTask(f.options), { name: "AbortError" });
  assert.equal(f.controller.signal.aborted, true);
  assert.equal(f.requestCount(), 0);
});

test("yield directives reject extra fields and accessors without evaluating them", { timeout: 10000 }, async (t) => {
  let getterCalls = 0;
  const accessor = { kind: "user_input_required", requestVersion: 1,
    get requestId() { getterCalls += 1; return "getter_request"; } };
  for (const directive of [null, { ...requiredInput, extra: "not accepted" }, accessor]) {
    const f = await fixture(t, { onTaskContinuationBoundary: async () => directive });
    await assert.rejects(f.runner.runTask(f.options), /Invalid user input yield directive/);
    assert.equal(f.requestCount(), 0);
  }
  assert.equal(getterCalls, 0);
});

for (const boundary of ["before_agent_start", "before_provider_request", "tool_call"]) {
  test(`required input at ${boundary} yields without success or failure publication`, { timeout: 10000 }, async (t) => {
    let tools = 0;
    const f = await fixture(t, {
      onTaskContinuationBoundary: async (current) => current === boundary ? requiredInput : undefined,
      onMcpToolCall: async () => { tools += 1; return { content: [] }; },
    }, boundary === "tool_call" ? ["fixture_read"] : []);
    await assert.rejects(f.runner.runTask(f.options), (error) => {
      assert.equal(error.name, "PiRunnerYielded");
      assert.deepEqual(error.request, requiredInput);
      assert.ok(Number.isFinite(Date.parse(error.sdkStoppedAt)));
      return true;
    });
    assert.equal(f.requestCount(), boundary === "tool_call" ? 1 : 0);
    assert.equal(tools, 0);
    assert.equal(f.controller.signal.aborted, false, "yield must not impersonate user cancellation");
    assert.equal(f.events.some((event) => ["run_end", "run_error"].includes(event.type)), false);
  });
}

test("required input closes already prepared parallel MCP calls before actual dispatch", { timeout: 10000 }, async (t) => {
  let checks = 0;
  let tools = 0;
  const f = await fixture(t, {
    onTaskContinuationBoundary: async (boundary) => {
      if (boundary === "tool_call" && ++checks === 2) return requiredInput;
    },
    onMcpToolCall: async () => { tools += 1; return { content: [] }; },
  }, ["fixture_read", "fixture_second_read"]);
  await assert.rejects(f.runner.runTask(f.options), { name: "PiRunnerYielded" });
  assert.equal(checks, 2);
  assert.equal(tools, 0, "SDK preparation is not execution admission");
  assert.equal(f.requestCount(), 1);
  const starts = f.events.filter((event) => event.type === "tool_start").map((event) => event.toolCallId).sort();
  const ends = f.events.filter((event) => event.type === "tool_end").map((event) => event.toolCallId).sort();
  assert.deepEqual(ends, starts, "every started SDK action is closed before yielding");
  assert.equal(f.events.some((event) => ["run_end", "run_error"].includes(event.type)), false);
});

test("a rejected second preparation also blocks earlier prepared Host dispatch", { timeout: 10000 }, async (t) => {
  let checks = 0;
  let tools = 0;
  const f = await fixture(t, {
    onTaskContinuationBoundary: async (boundary) => {
      if (boundary === "tool_call" && ++checks === 2) throw new Error("second preparation rejected");
    },
    onMcpToolCall: async () => { tools += 1; return { content: [] }; },
  }, ["fixture_read", "fixture_second_read"]);
  await assert.rejects(f.runner.runTask(f.options), /second preparation rejected/);
  assert.equal(tools, 0);
  assert.equal(f.requestCount(), 1);
});

test("a malformed yield directive fails closed instead of becoming ordinary completion", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, {
    onTaskContinuationBoundary: async () => ({ ...requiredInput, requestVersion: 0 }),
  });
  await assert.rejects(f.runner.runTask(f.options), /Invalid user input yield directive/);
  assert.equal(f.requestCount(), 0);
  assert.equal(f.events.some((event) => event.type === "run_end"), false);
});

test("user cancellation before a yield directive wins and cannot become a checkpoint", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, {
    onTaskContinuationBoundary: async () => { f.controller.abort(); return requiredInput; },
  });
  await assert.rejects(f.runner.runTask(f.options), { name: "AbortError" });
  assert.equal(f.requestCount(), 0);
});

test("yielding one run cannot stop an independent SDK session", { timeout: 10000 }, async (t) => {
  const yielding = await fixture(t, { onTaskContinuationBoundary: async () => requiredInput });
  const continuing = await fixture(t);
  await Promise.all([
    assert.rejects(yielding.runner.runTask(yielding.options), { name: "PiRunnerYielded" }),
    continuing.runner.runTask(continuing.options),
  ]);
  assert.equal(yielding.requestCount(), 0);
  assert.equal(continuing.requestCount(), 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function sseResponse(toolNames = [], toolInputs = {}) {
  const delta = toolNames.length > 0 ? {
    tool_calls: toolNames.map((name, index) => ({
      index, id: `call_${index}`, type: "function",
      function: { name, arguments: JSON.stringify(toolInputs[name] ?? {}) },
    })),
  } : { content: "Completed fixture." };
  const records = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolNames.length ? "tool_calls" : "stop" }] },
  ];
  return new Response(records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(t, changes = {}, toolNames = [], toolInputs = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-lifecycle-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  const events = [];
  let requestCount = 0;
  // Keep the actual adapter, SDK session, provider parser and Ling extensions.
  // Replace only this instance's provider transport; never read credentials or
  // send a network request, and never patch process-global fetch/SDK state.
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, {
        api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, {
          ...options,
          fetch: async () => {
            requestCount += 1;
            return sseResponse(requestCount === 1 ? toolNames : [], toolInputs);
          },
        }),
      });
    }
  }
  const runner = new FixtureRunner();
  const options = {
    cwd, agentDir: join(cwd, "agent"),
    task: { id: "lifecycle_fixture", title: "Lifecycle fixture", prompt: "Execute the fixture." },
    provider: {
      provider: "lifecycle-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture-no-network", reasoning: false,
    },
    tools: [], signal: controller.signal, onEvent: (event) => events.push(event),
    mcpTools: toolNames.filter(name => name !== "request_user_input").map((name) => ({
      registeredName: name, serverId: "fixture", rawName: name, displayName: name,
      inputSchema: { type: "object", properties: {} }, sideEffectLevel: "read", defaultApproval: "allow",
    })),
    ...changes,
  };
  return { runner, options, controller, events, requestCount: () => requestCount };
}

test("adapter completes a real SDK session with an in-memory provider response", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.runner.runTask(f.options);
  assert.equal(f.requestCount(), 1);
  assert.equal(f.events.filter((event) => event.type === "run_end").length, 1);
  assert.equal(f.events.filter((event) => event.type === "run_error").length, 0);
  assert.ok(result.messages.some((message) => message.role === "assistant"));
});

const questionToolInput = mode => ({ schemaVersion: 1, waitMode: mode, questions: [{
  questionId: "selection", prompt: "Which path?", required: mode === "required", allowFreeText: true,
  options: [{ optionId: "a", label: "A" }],
}] });

test("real question tool yields after SDK closes the action without another provider or Host dispatch", { timeout: 10000 }, async t => {
  let asks = 0;
  let calls = 0;
  const f = await fixture(t, {
    onUserInputRequest: request => {
      asks++;
      assert.deepEqual(request, { toolCallId: "call_0", input: questionToolInput("required") });
      return requiredInput;
    },
    onMcpToolCall: () => { calls++; return { content: [] }; },
  }, ["request_user_input", "fixture_read"], { request_user_input: questionToolInput("required") });
  await assert.rejects(f.runner.runTask(f.options), error => {
    assert.equal(error.name, "PiRunnerYielded");
    assert.deepEqual(error.request, requiredInput);
    return true;
  });
  assert.equal(asks, 1);
  assert.equal(calls, 0);
  assert.equal(f.requestCount(), 1);
  assert.equal(f.controller.signal.aborted, false);
  const starts = f.events.filter(event => event.type === "tool_start").map(event => event.toolCallId).sort();
  const ends = f.events.filter(event => event.type === "tool_end").map(event => event.toolCallId).sort();
  assert.deepEqual(ends, starts);
  assert.equal(f.events.some(event => ["run_end", "run_error"].includes(event.type)), false);
});

test("real optional question continues execution without pretending an answer arrived", { timeout: 10000 }, async t => {
  let asks = 0;
  const f = await fixture(t, { onUserInputRequest: () => {
    asks++;
    return { kind: "user_input_optional", requestId: "optional_fixture", requestVersion: 1 };
  } }, ["request_user_input"], { request_user_input: questionToolInput("optional") });
  await f.runner.runTask(f.options);
  assert.equal(asks, 1);
  assert.equal(f.requestCount(), 2);
  assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
  assert.equal(f.events.some(event => event.type === "run_error"), false);
});

test("real question Host persistence failure cannot become an SDK error-and-continue success", { timeout: 10000 }, async t => {
  const f = await fixture(t, { onUserInputRequest: () => { throw new Error("Host persistence failed"); } },
    ["request_user_input"], { request_user_input: questionToolInput("required") });
  await assert.rejects(f.runner.runTask(f.options), /Host persistence failed/);
  assert.equal(f.requestCount(), 1);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

test("completed compaction recovery installs the sealed assistant view without a provider request", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.runner.runTask({
    ...f.options,
    compactionRecovery: {
      schemaVersion: 1,
      modelView: [
        { role: "compactionSummary", summary: "Already complete." },
        acceptedTaskAnchor(f.options),
        { role: "assistant", content: [{ type: "text", text: "Already complete." }] },
      ],
    },
  });
  assert.equal(f.requestCount(), 0, "an assistant-terminated sealed view must not call the provider");
  assert.equal(result.messages.at(-1).role, "assistant");
  assert.equal(f.events.filter((event) => event.type === "run_end").length, 1);
});

test("tool-result compaction recovery continues exactly once from the sealed tool result", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.runner.runTask({
    ...f.options,
    compactionRecovery: {
      schemaVersion: 1,
      modelView: [
        { role: "compactionSummary", summary: "The tool was admitted; continue the task." },
        acceptedTaskAnchor(f.options),
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "fixture_read", arguments: {} }] },
        { role: "toolResult", toolCallId: "call-1", toolName: "fixture_read",
          content: [{ type: "text", text: "durable result" }], isError: false },
      ],
    },
  });
  assert.equal(f.requestCount(), 1, "a tool-result-terminated sealed view must continue with one provider request");
  assert.equal(result.messages.at(-1).role, "assistant");
  assert.equal(f.events.filter((event) => event.type === "run_end").length, 1);
});

for (const [sealKind, summaryMetadata] of [
  ["minimal", {}],
  ["complete legacy metadata", { timestamp: 1, tokensBefore: 1200 }],
]) test(`provider admission exposes the task-constrained settled tool view after compacted recovery: ${sealKind}`, { timeout: 10000 }, async (t) => {
  const views = [];
  const f = await fixture(t, {
    runId: "run_progress_fixture", runnerAttemptId: "attempt_progress_fixture", hostCompactionEnabled: true,
    onTaskContinuationBoundary: async (boundary, modelView) => {
      if (boundary === "before_provider_request") views.push(modelView);
    },
    onMcpToolCall: async () => ({ content: [{ type: "text", text: "settled read" }] }),
  }, ["fixture_read"]);
  const initialView = [
    { role: "compactionSummary", summary: "Continue after the completed earlier tool.", ...summaryMetadata },
    acceptedTaskAnchor(f.options),
    { role: "assistant", content: [{ type: "toolCall", id: "earlier", name: "fixture_read", arguments: {} }] },
    { role: "toolResult", toolCallId: "earlier", toolName: "fixture_read",
      content: [{ type: "text", text: "earlier result" }], isError: false },
  ];
  const frozenInitialView = structuredClone(initialView);
  await f.runner.runTask({ ...f.options, compactionRecovery: { schemaVersion: 1, modelView: initialView } });
  assert.equal(f.requestCount(), 2);
  assert.ok(views.length >= 2);
  assert.deepEqual(views[0], initialView,
    "public checkpoint projection preserves the original Host-sealed summary metadata and exact tail");
  for (const view of views) assert.deepEqual(view.slice(0, initialView.length), initialView,
    "each subsequent settled tool round must extend the exact original seal prefix");
  assert.deepEqual(initialView, frozenInitialView, "projection must not mutate the installed recovery evidence");
  assert.equal(views.at(-1).at(-1).role, "toolResult");
  assert.equal(views.at(-1).at(-1).toolCallId, "call_0");
  assert.ok(f.events.some((event) => event.type === "tool_end" && event.toolCallId === "call_0"));
});

test("a compacted recovery without its own sealed task anchor is rejected before model or tool execution", { timeout: 10000 }, async t => {
  for (const anchor of [undefined, { role: "user", content: [{ type: "text", text: "Another task's instructions" }], timestamp: 0 }]) {
    let effects = 0;
    const f = await fixture(t, { onMcpToolCall: async () => { effects += 1; return { content: [] }; } }, ["fixture_read"]);
    await assert.rejects(f.runner.runTask({ ...f.options, compactionRecovery: { schemaVersion: 1, modelView: [
      { role: "compactionSummary", summary: "A view that did not seal this task." },
      ...(anchor ? [anchor] : []),
      { role: "assistant", content: [{ type: "toolCall", id: "saved-read", name: "fixture_read", arguments: {} }] },
      { role: "toolResult", toolCallId: "saved-read", toolName: "fixture_read", content: [{ type: "text", text: "saved" }], isError: false },
    ] } }), /accepted task anchor/iu);
    assert.equal(f.requestCount(), 0);
    assert.equal(effects, 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  }
});

test("Host-enabled Pi auto-compaction can resume a long SDK tool loop with a sealed view boundary", { timeout: 20000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-host-long-compaction-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let compacting = false;
  let taskRequests = 0;
  let toolEffects = 0;
  const events = [];
  const postCompactionViews = [];
  class LongRunFixture extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions",
        streamSimple: (model, context, options) => stream(model, context, { ...options,
          fetch: async () => compacting
            ? compactionResponse({ text: "## Goal\nComplete every read.\n## Progress\nDo not repeat completed calls." })
            : compactionResponse(taskRequests++ < 14
              ? { toolCallId: `long-effect-${taskRequests}`, inputTokens: 120_000 }
              : { text: "All reads complete.", inputTokens: 120_000 }),
        }),
      });
    }
  }
  const runner = new LongRunFixture();
  await runner.runTask({
    cwd, agentDir: join(cwd, "agent"), task: { id: "long-compaction", title: "Long", prompt: "Read repeatedly." },
    provider: { provider: "long-compaction-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture-no-network", reasoning: false, contextWindow: 128_000 },
    tools: [], runId: "run_long_compaction", runnerAttemptId: "attempt_long_compaction",
    hostCompactionEnabled: true,
    mcpTools: [{ registeredName: "fixture_effect", serverId: "fixture", rawName: "fixture_effect",
      displayName: "Fixture effect", inputSchema: { type: "object", properties: {} },
      sideEffectLevel: "read", defaultApproval: "allow" }],
    onMcpToolCall: async () => { toolEffects += 1; return { content: [{ type: "text", text: "r".repeat(12_000) }] }; },
    onEvent: (event) => {
      events.push(event);
      if (event.type === "context_compaction_start") compacting = true;
      if (event.type === "context_compaction_end") compacting = false;
    },
    onTaskContinuationBoundary: async (boundary, modelView) => {
      if (boundary === "before_provider_request" && events.some((event) =>
        event.type === "context_compaction_end" && event.outcome === "sdk_installed")) {
        postCompactionViews.push(modelView);
      }
    },
  });
  const firstCompaction = events.findIndex((event) => event.type === "context_compaction_end" && event.outcome === "sdk_installed");
  assert.ok(firstCompaction >= 0, `the long loop must actually auto-compact: ${JSON.stringify({ taskRequests,
    toolEffects, events: events.filter((event) => event.type.startsWith("context_compaction") || event.type === "run_error") })}`);
  assert.ok(events.slice(firstCompaction + 1).some((event) => event.type === "tool_end"),
    "tools must continue after SDK compaction");
  assert.equal(toolEffects, 14);
  assert.ok(postCompactionViews.some((view) => view?.[0]?.role === "compactionSummary"));
});

test("cancelling a recovered compacted tool loop waits for its one in-flight effect", { timeout: 10000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let effects = 0;
  const f = await fixture(t, {
    runId: "run_compacted_cancel", runnerAttemptId: "attempt_compacted_cancel", hostCompactionEnabled: true,
    onTaskContinuationBoundary: async () => undefined,
    onMcpToolCall: async () => {
      effects += 1;
      entered.resolve();
      await release.promise;
      return { content: [{ type: "text", text: "settled once" }] };
    },
  }, ["fixture_read"]);
  const pending = f.runner.runTask({ ...f.options, compactionRecovery: { schemaVersion: 1, modelView: [
    { role: "compactionSummary", summary: "The previous read completed." },
    acceptedTaskAnchor(f.options),
    { role: "assistant", content: [{ type: "toolCall", id: "prior-read", name: "fixture_read", arguments: {} }] },
    { role: "toolResult", toolCallId: "prior-read", toolName: "fixture_read",
      content: [{ type: "text", text: "saved" }], isError: false },
  ] } });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise;
  f.controller.abort();
  release.resolve();
  await rejected;
  assert.equal(effects, 1);
  assert.equal(f.requestCount(), 1, "cancellation must close admission before a second provider request");
  assert.equal(f.events.some((event) => event.type === "run_end"), false);
});

for (const boundary of ["before_agent_start", "before_provider_request", "tool_call"]) {
  test(`cancelling during ${boundary} prevents further model/tool admission`, { timeout: 10000 }, async (t) => {
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const f = await fixture(t, {
      onTaskContinuationBoundary: async (current) => {
        if (current === boundary) { entered.resolve(); await release.promise; }
      },
    }, boundary === "tool_call" ? ["fixture_read"] : []);
    const pending = f.runner.runTask(f.options);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await entered.promise;
    f.controller.abort();
    release.resolve();
    await rejected;
    assert.equal(f.requestCount(), boundary === "tool_call" ? 1 : 0);
    assert.equal(f.events.filter((event) => event.type === "run_end").length, 0);
  });

  test(`a rejected ${boundary} fails closed despite SDK extension error handling`, { timeout: 10000 }, async (t) => {
    let toolCalls = 0;
    const f = await fixture(t, {
      onTaskContinuationBoundary: async (current) => {
        if (current === boundary) throw new Error("fixture boundary rejected");
      },
      onMcpToolCall: async () => { toolCalls += 1; return { content: [] }; },
    }, boundary === "tool_call" ? ["fixture_read", "fixture_second_read"] : []);
    await assert.rejects(f.runner.runTask(f.options), /fixture boundary rejected/);
    assert.equal(f.requestCount(), boundary === "tool_call" ? 1 : 0);
    assert.equal(toolCalls, 0);
    assert.equal(f.events.filter((event) => event.type === "run_end").length, 0);
  });
}

test("adapter cancellation waits for an already running tool to finish cleanup", { timeout: 10000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let cleaned = false;
  let toolSignal;
  const f = await fixture(t, {
    onMcpToolCall: async ({ signal }) => {
      toolSignal = signal;
      entered.resolve();
      await release.promise;
      cleaned = true;
      return { content: [{ type: "text", text: "fixture cleaned" }] };
    },
  }, ["fixture_read"]);
  let settled = false;
  const pending = f.runner.runTask(f.options);
  const rejected = assert.rejects(pending, { name: "AbortError" }).then(() => { settled = true; });
  await entered.promise;
  f.controller.abort();
  await nextTick();
  assert.equal(toolSignal.aborted, true);
  assert.equal(settled, false);
  assert.equal(cleaned, false);
  release.resolve();
  await rejected;
  assert.equal(cleaned, true);
  assert.equal(f.requestCount(), 1);
  assert.equal(f.events.filter((event) => event.type === "run_end").length, 0);
});

test("cancelling while a tool admission check is pending does not invoke the tool", { timeout: 10000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let toolCalls = 0;
  const f = await fixture(t, {
    onToolBefore: async () => { entered.resolve(); await release.promise; return { allowed: true }; },
    onMcpToolCall: async () => { toolCalls += 1; return { content: [{ type: "text", text: "unexpected" }] }; },
  }, ["fixture_read"]);
  const pending = f.runner.runTask(f.options);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise;
  f.controller.abort();
  release.resolve();
  await rejected;
  assert.equal(toolCalls, 0);
  assert.equal(f.requestCount(), 1);
});

test("one rejected run cannot cancel an independent concurrent run", { timeout: 10000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const waiting = await fixture(t, {
    onTaskContinuationBoundary: async (boundary) => {
      if (boundary === "before_agent_start") { entered.resolve(); await release.promise; }
    },
  });
  const running = waiting.runner.runTask(waiting.options);
  await entered.promise;
  const rejected = await fixture(t, {
    onTaskContinuationBoundary: async () => { throw new Error("only this run is rejected"); },
  });
  await assert.rejects(rejected.runner.runTask(rejected.options), /only this run is rejected/);
  assert.equal(rejected.requestCount(), 0);
  assert.equal(waiting.controller.signal.aborted, false);
  release.resolve();
  await running;
  assert.equal(waiting.requestCount(), 1);
  assert.equal(waiting.events.filter((event) => event.type === "run_end").length, 1);
});

test("a latched Host failure survives a later user cancellation", { timeout: 10000 }, async (t) => {
  const hostError = new Error("first Host failure");
  let cancellationObserved = false;
  const f = await fixture(t, {
    onTaskContinuationBoundary: async () => { throw hostError; },
    onEvent: (event) => {
      if (event.type === "message_end" && event.role === "assistant") {
        cancellationObserved = true;
        f.controller.abort();
      }
    },
  });
  await assert.rejects(f.runner.runTask(f.options), (error) => error === hostError);
  assert.equal(cancellationObserved, true);
  assert.equal(f.requestCount(), 0);
});

test("user cancellation before a Host callback failure keeps cancellation semantics", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, {
    onTaskContinuationBoundary: async () => {
      f.controller.abort();
      throw new Error("late Host failure must not replace cancellation");
    },
  });
  await assert.rejects(f.runner.runTask(f.options), { name: "AbortError" });
  assert.equal(f.requestCount(), 0);
  assert.equal(f.events.filter((event) => event.type === "run_end").length, 0);
});

test("cancellation waits for every parallel tool cleanup, not just the first", { timeout: 10000 }, async (t) => {
  const entered = deferred();
  const releases = [deferred(), deferred()];
  t.after(() => releases.forEach((release) => release.resolve()));
  let calls = 0;
  let cleaned = 0;
  const f = await fixture(t, {
    onMcpToolCall: async () => {
      const index = calls++;
      if (calls === 2) entered.resolve();
      await releases[index].promise;
      cleaned += 1;
      return { content: [] };
    },
  }, ["fixture_read", "fixture_second_read"]);
  let settled = false;
  const pending = f.runner.runTask(f.options);
  const rejected = assert.rejects(pending, { name: "AbortError" }).then(() => { settled = true; });
  await entered.promise;
  f.controller.abort();
  releases[0].resolve();
  await nextTick();
  assert.equal(cleaned, 1);
  assert.equal(settled, false);
  releases[1].resolve();
  await rejected;
  assert.equal(cleaned, 2);
  assert.equal(f.requestCount(), 1);
  assert.equal(f.events.filter((event) => event.type === "run_end").length, 0);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";

const requiredInput = { kind: "user_input_required", requestId: "input_fixture", requestVersion: 1 };

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

function sseResponse(toolNames = []) {
  const delta = toolNames.length > 0 ? {
    tool_calls: toolNames.map((name, index) => ({
      index, id: `call_${index}`, type: "function",
      function: { name, arguments: "{}" },
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

async function fixture(t, changes = {}, toolNames = []) {
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
            return sseResponse(requestCount === 1 ? toolNames : []);
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
    mcpTools: toolNames.map((name) => ({
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

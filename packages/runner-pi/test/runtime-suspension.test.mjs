import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { createPiTaskBoundary } from "../dist/task-boundary.js";
import { PiRunnerSuspended, readRuntimeSuspensionDirective } from "../dist/runtime-suspension.js";
import * as observation from "../dist/tool-boundary-observation.js";

const testOptions = { timeout: 15_000 };
const directive = (changes = {}) => ({ schemaVersion: 1, kind: "runtime_suspension",
  runId: "suspension-run", attemptId: "suspension-attempt", suspensionId: "suspension-1",
  checkpointId: "checkpoint-1", checkpointSha256: "a".repeat(64), ...changes });

/** Real SDK/session/extensions/provider parser; only the network transport is replaced. */
async function fixture(t, changes = {}, withRead = false, finishReason = "stop", responseText = "Completed from actual evidence.") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-runtime-suspension-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "evidence.txt"), "Actual SDK read evidence.");
  const controller = new AbortController();
  const events = [], contexts = [], admitted = [], settled = [];
  let requests = 0;
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) => {
        contexts.push(structuredClone(context));
        return stream(model, context, { ...options, fetch: async () => {
          requests += 1;
          const read = withRead && requests === 1;
          const delta = read ? { tool_calls: [{ index: 0, id: "read-1", type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "evidence.txt" }) } }] }
            : { content: responseText };
          const records = [{ choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: read ? "tool_calls" : finishReason }] }];
          return new Response(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } });
        } });
      } });
    }
  }
  const runner = new FixtureRunner();
  const options = { cwd, agentDir: join(cwd, "agent"), runId: "suspension-run", runnerAttemptId: "suspension-attempt",
    task: { id: "suspension-task", title: "Runtime suspension", prompt: "Read evidence then report the result." },
    provider: { provider: "suspension-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture-no-network", reasoning: false },
    tools: ["read"], signal: controller.signal, hostCompactionEnabled: true,
    onEvent: event => events.push(event), onTaskContinuationBoundary: async () => undefined,
    onProviderInvocationAdmitted: receipt => admitted.push(receipt),
    onProviderInvocationSettled: receipt => settled.push(receipt), ...changes };
  const preparedInput = await runner.prepareTaskInput(options);
  return { runner, options: { ...options, preparedInput }, controller, events, contexts, admitted, settled, requests: () => requests };
}

function assertNoTerminalEvent(f) {
  assert.equal(f.events.some(event => event.type === "run_error" || event.type === "run_end"), false);
}

test("provider boundary suspends a paired actual SDK read view without another transport", testOptions, async t => {
  let captured;
  const f = await fixture(t, { onTaskContinuationBoundary: async (point, modelView) => {
    if (point === "before_provider_request" && modelView?.at(-1)?.role === "toolResult") {
      captured = structuredClone(modelView);
      return directive();
    }
  } }, true);
  await assert.rejects(f.runner.runTask(f.options), error => {
    assert.equal(error.name, "PiRunnerSuspended", error.stack);
    assert.deepEqual(error.request, directive());
    assert.ok(Number.isFinite(Date.parse(error.sdkStoppedAt)));
    return true;
  });
  assert.equal(captured.at(-2).content[0].id, "read-1");
  assert.equal(captured.at(-1).toolCallId, "read-1");
  assert.match(captured.at(-1).content[0].text, /Actual SDK read evidence/u);
  assert.equal(f.requests(), 1);
  assert.equal(f.events.filter(event => event.type === "tool_start").length, 1);
  assert.equal(f.events.filter(event => event.type === "tool_end").length, 1);
  assert.equal(f.events.some(event => event.type.startsWith("context_compaction_")), false);
  assert.equal(f.events.some(event => event.type === "message_end" && event.stopReason === "aborted"), false,
    "the SDK's private suspension-control failure is not a task message");
  assert.equal(f.events.filter(event => event.type === "turn_end").length, 1,
    "only the completed read turn belongs to canonical task evidence");
  assert.equal(f.controller.signal.aborted, false);
  assertNoTerminalEvent(f);
});

test("settled boundary receives the real complete SDK view before run_end and can suspend", testOptions, async t => {
  let calls = 0;
  const f = await fixture(t, { onTaskSettledBoundary: async modelView => {
    calls += 1;
    assert.equal(modelView.at(-1).role, "assistant");
    assert.equal(modelView.at(-1).stopReason, "stop");
    assert.equal(f.settled.length, 1);
    assert.equal(f.settled[0].outcome, "succeeded");
    assertNoTerminalEvent(f);
    return directive();
  } });
  await assert.rejects(f.runner.runTask(f.options), { name: "PiRunnerSuspended" });
  assert.equal(calls, 1);
  assert.equal(f.requests(), 1);
  assertNoTerminalEvent(f);
});

test("settled boundary preserves the full paired tool transcript without replay or tail removal", testOptions, async t => {
  let captured;
  const f = await fixture(t, { onTaskSettledBoundary: async modelView => {
    captured = structuredClone(modelView);
    return directive();
  } }, true);
  await assert.rejects(f.runner.runTask(f.options), { name: "PiRunnerSuspended" });
  assert.deepEqual(captured.map(message => message.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(captured[1].content[0].id, captured[2].toolCallId);
  assert.equal(captured.at(-1).stopReason, "stop");
  assert.equal(f.requests(), 2);
  assert.equal(f.events.filter(event => event.type === "tool_end").length, 1);
  assertNoTerminalEvent(f);
});

test("a real settled callback exposes only its independent ephemeral inventory window", testOptions, async t => {
  let receipt, inventory;
  const readSettled = value => observation.readPiSettledBoundaryInventory(value, "suspension-run", "suspension-attempt");
  const readProvider = value => observation.readPiProviderBoundaryInventory(value, "suspension-run", "suspension-attempt");
  const f = await fixture(t, {
    onToolBoundaryObservation: value => { receipt = value; },
    onTaskContinuationBoundary: async point => {
      if (point !== "before_provider_request") return;
      assert.equal(readSettled(receipt), undefined);
      assert.ok(readProvider(receipt));
    },
    onTaskSettledBoundary: async () => {
      inventory = readSettled(receipt);
      assert.deepEqual(inventory, { toolCallIds: ["read-1"], settledBuiltinReads: [{ toolCallId: "read-1", toolName: "read" }] });
      assert.ok(Object.isFrozen(inventory));
      assert.equal(readProvider(receipt), undefined);
      assert.equal(readSettled({ ...receipt }), undefined);
      assert.equal(observation.readPiSettledBoundaryInventory(receipt, "other", "suspension-attempt"), undefined);
      return directive();
    },
  }, true);
  await assert.rejects(f.runner.runTask(f.options), { name: "PiRunnerSuspended" });
  assert.ok(inventory);
  assert.equal(readSettled(receipt), undefined);
  assert.equal(readProvider(receipt), undefined);
  assertNoTerminalEvent(f);
});

test("settled snapshot binds the original complete view and cannot be changed by a Host callback", testOptions, async t => {
  let receipt, captured;
  const read = value => observation.readPiSettledBoundarySnapshot(value, "suspension-run", "suspension-attempt");
  const f = await fixture(t, {
    onToolBoundaryObservation: value => { receipt = value; },
    onTaskContinuationBoundary: async () => { assert.equal(read(receipt), undefined); },
    onTaskSettledBoundary: async view => {
      captured = structuredClone(view);
      const snapshot = read(receipt);
      assert.deepEqual(snapshot.modelView, captured);
      assert.deepEqual(snapshot.inventory.toolCallIds, ["read-1"]);
      assert.equal(read({ ...receipt }), undefined);
      view.at(-1).content[0].text = "mutated callback view";
      snapshot.modelView.at(-1).content[0].text = "mutated returned snapshot";
      assert.deepEqual(read(receipt).modelView, captured, "only the original SDK view can become settlement evidence");
      return directive();
    },
  }, true);
  await assert.rejects(f.runner.runTask(f.options), { name: "PiRunnerSuspended" });
  assert.ok(captured);
  assert.equal(read(receipt), undefined, "settlement evidence cannot escape the original callback window");
  assertNoTerminalEvent(f);
});

test("settled inventory rejects forged/getter receipts and cannot outlive its window", () => {
  const original = observation.createPiToolBoundaryObservation("run", "attempt");
  const read = receipt => observation.readPiSettledBoundaryInventory(receipt, "run", "attempt");
  assert.equal(read(original.receipt), undefined);
  original.enter("call", "read");
  original.completeBuiltinRead("call", "read");
  original.completeTool("call", "read");
  original.enterSettledBoundary();
  assert.deepEqual(read(original.receipt), { toolCallIds: ["call"], settledBuiltinReads: [{ toolCallId: "call", toolName: "read" }] });
  assert.equal(read({ ...original.receipt }), undefined);
  let getters = 0;
  assert.equal(read({ get runId() { getters += 1; return "run"; }, attemptId: "attempt" }), undefined);
  assert.equal(getters, 0);
  original.leaveSettledBoundary();
  assert.equal(read(original.receipt), undefined);
  original.finish();
  original.enterSettledBoundary();
  assert.equal(read(original.receipt), undefined);
});

for (const first of ["Provider", "Settled"]) {
  test(`provider and settled windows reject overlapping authority: first=${first}`, () => {
    const original = observation.createPiToolBoundaryObservation("run", "attempt");
    original[`enter${first}Boundary`]();
    original[`enter${first === "Provider" ? "Settled" : "Provider"}Boundary`]();
    assert.equal(observation.readPiProviderBoundaryInventory(original.receipt, "run", "attempt"), undefined);
    assert.equal(observation.readPiSettledBoundaryInventory(original.receipt, "run", "attempt"), undefined);
  });
}

test("settled inventory refuses pending tools and cancellation even before leaving the callback", () => {
  const pending = observation.createPiToolBoundaryObservation("run", "attempt");
  pending.enter("call", "read");
  pending.enterSettledBoundary();
  assert.equal(observation.readPiSettledBoundaryInventory(pending.receipt, "run", "attempt"), undefined);
  const original = observation.createPiToolBoundaryObservation("run", "attempt");
  const controller = new AbortController();
  original.enterSettledBoundary(controller.signal);
  assert.ok(observation.readPiSettledBoundaryInventory(original.receipt, "run", "attempt"));
  controller.abort();
  assert.equal(observation.readPiSettledBoundaryInventory(original.receipt, "run", "attempt"), undefined);
});

test("runtime receipt reader copies only the closed data-only Host identity", () => {
  const input = directive();
  const expected = { runId: input.runId, runnerAttemptId: input.attemptId };
  const captured = readRuntimeSuspensionDirective(input, expected);
  assert.deepEqual(captured, input);
  assert.notEqual(captured, input);
  assert.ok(Object.isFrozen(captured));
  input.checkpointId = "caller-mutated";
  assert.equal(captured.checkpointId, "checkpoint-1");
  assert.deepEqual(readRuntimeSuspensionDirective(Object.assign(Object.create(null), directive()), expected), directive());
  assert.ok(Object.isFrozen(new PiRunnerSuspended(captured, new Date().toISOString()).request));
});

const malformed = [
  ["missing schema", value => { delete value.schemaVersion; }],
  ["wrong schema", value => { value.schemaVersion = 2; }],
  ["wrong kind", value => { value.kind = "user_input_required"; }],
  ["missing Run", value => { delete value.runId; }],
  ["wrong Run", value => { value.runId = "other-run"; }],
  ["missing Attempt", value => { delete value.attemptId; }],
  ["wrong Attempt", value => { value.attemptId = "other-attempt"; }],
  ["missing suspension", value => { delete value.suspensionId; }],
  ["missing checkpoint", value => { delete value.checkpointId; }],
  ["empty identity", value => { value.suspensionId = ""; }],
  ["long identity", value => { value.checkpointId = "x".repeat(241); }],
  ["nonstring identity", value => { value.suspensionId = 1; }],
  ["newline identity", value => { value.checkpointId = "checkpoint\n"; }],
  ["missing hash", value => { delete value.checkpointSha256; }],
  ["short hash", value => { value.checkpointSha256 = "a".repeat(63); }],
  ["uppercase hash", value => { value.checkpointSha256 = "A".repeat(64); }],
  ["nonhex hash", value => { value.checkpointSha256 = "g".repeat(64); }],
  ["long hash", value => { value.checkpointSha256 = "a".repeat(65); }],
  ["extra field", value => { value.authority = true; }],
  ["symbol key", value => { value[Symbol("authority")] = true; }],
  ["nonenumerable identity", value => { Object.defineProperty(value, "runId", { enumerable: false }); }],
];
for (const [label, mutate] of malformed) {
  test(`runtime receipt rejects ${label}`, () => {
    const input = directive();
    mutate(input);
    assert.throws(() => readRuntimeSuspensionDirective(input, { runId: "suspension-run", runnerAttemptId: "suspension-attempt" }),
      /Invalid Pi runtime suspension/u);
  });
}

test("runtime receipt rejects missing expected identities and invokes no getter/proxy/serializer", () => {
  const expected = { runId: "suspension-run", runnerAttemptId: "suspension-attempt" };
  for (const changed of [{ runId: undefined }, { runnerAttemptId: undefined }, { runId: "" }, { runnerAttemptId: 1 }]) {
    assert.throws(() => readRuntimeSuspensionDirective(directive(), { ...expected, ...changed }), /Invalid Pi runtime suspension/u);
  }
  let calls = 0;
  const getter = directive();
  Object.defineProperty(getter, "checkpointSha256", { enumerable: true, get() { calls += 1; return "a".repeat(64); } });
  const proxy = new Proxy(directive(), { getOwnPropertyDescriptor() { calls += 1; throw new Error("proxy trap"); },
    ownKeys() { calls += 1; throw new Error("proxy trap"); }, getPrototypeOf() { calls += 1; throw new Error("proxy trap"); } });
  const serializer = { ...directive(), toJSON() { calls += 1; return directive(); } };
  for (const value of [null, false, [], "runtime_suspension", getter, proxy, serializer,
    Object.assign(Object.create({ authority: true }), directive())]) {
    assert.throws(() => readRuntimeSuspensionDirective(value, expected), /Invalid Pi runtime suspension/u);
  }
  assert.equal(calls, 0);
});

test("swallowed suspension remains latched across every Host/tool/provider/compaction admission and duplicates", async () => {
  let hostCalls = 0, effects = 0, transports = 0;
  const request = directive();
  const boundary = createPiTaskBoundary({ runId: request.runId, runnerAttemptId: request.attemptId,
    onTaskContinuationBoundary: async () => { hostCalls += 1; return request; },
    onToolBefore: () => { effects += 1; return { allowed: true }; },
    onApprovalRequired: () => { effects += 1; return {}; },
    onPermissionRequired: () => { effects += 1; return {}; },
    onToolHydrationRequest: () => { effects += 1; return {}; },
    onMcpToolCall: () => { effects += 1; return {}; },
    onHostCapabilityCall: () => { effects += 1; return {}; },
    onMediaGenerationToolCall: () => { effects += 1; return {}; },
    onDelegationToolCall: async () => { effects += 1; return {}; },
    onUserInputRequest: async () => { effects += 1; return {}; },
    onTaskSettledBoundary: async () => { effects += 1; return request; },
  });
  let pending;
  await assert.rejects(boundary.options.onTaskContinuationBoundary("before_provider_request", [{ role: "user" }]), error => {
    pending = error; return true;
  });
  assert.equal(boundary.failure, undefined);
  assert.notEqual(boundary.suspensionRequest, request);
  assert.ok(Object.isFrozen(boundary.suspensionRequest));
  request.checkpointId = "mutated-after-boundary";
  assert.equal(boundary.suspensionRequest.checkpointId, "checkpoint-1");
  const runtime = { streamSimple() { transports += 1; } };
  boundary.bindModelRuntime(runtime);
  assert.throws(() => runtime.streamSimple({}, {}, {}), error => error === pending);
  for (const name of ["onToolBefore", "onApprovalRequired", "onPermissionRequired", "onToolHydrationRequest", "onMcpToolCall",
    "onHostCapabilityCall", "onMediaGenerationToolCall"]) {
    assert.throws(() => boundary.options[name]({}), error => error === pending);
  }
  for (const name of ["onDelegationToolCall", "onUserInputRequest", "onTaskSettledBoundary"]) {
    await assert.rejects(boundary.options[name]({}), error => error === pending);
  }
  await assert.rejects(boundary.options.onTaskContinuationBoundary("before_provider_request", [{}]), error => error === pending);
  assert.throws(() => boundary.options.onTaskContinuationDirectiveFailure(pending), error => error === pending);
  assert.equal(boundary.failure, undefined);
  assert.equal(hostCalls, 1);
  assert.equal(effects, 0);
  assert.equal(transports, 0);
});

for (const point of ["before_agent_start", "tool_call", "before_provider_request"]) {
  test(`runtime suspension refuses an unproven ${point} boundary`, async () => {
    const boundary = createPiTaskBoundary({ runId: "suspension-run", runnerAttemptId: "suspension-attempt",
      onTaskContinuationBoundary: async () => directive() });
    await assert.rejects(boundary.options.onTaskContinuationBoundary(point), /actual provider boundary view/u);
    assert.equal(boundary.suspensionRequest, undefined);
    assert.ok(boundary.failure);
  });
}

test("concurrent callback returns cannot replace the first latched suspension", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const boundary = createPiTaskBoundary({ runId: "suspension-run", runnerAttemptId: "suspension-attempt",
    onTaskContinuationBoundary: async () => {
      const n = ++calls;
      if (n === 1) await gate;
      return directive({ checkpointId: `checkpoint-${n}` });
    } });
  const first = boundary.options.onTaskContinuationBoundary("before_provider_request", [{}]);
  await assert.rejects(boundary.options.onTaskContinuationBoundary("before_provider_request", [{}]));
  release();
  await assert.rejects(first);
  assert.equal(boundary.suspensionRequest.checkpointId, "checkpoint-2");
  assert.equal(boundary.failure, undefined);
});

for (const trigger of ["provider", "settled"]) {
  for (const cleanup of ["idle", "late-cancel", "reject"]) {
    test(`${trigger} suspension awaits actual SDK stop+idle; cleanup=${cleanup}`, testOptions, async t => {
      let receipt;
      const changes = trigger === "provider" ? { onTaskContinuationBoundary: async (point, modelView) =>
        point === "before_provider_request" && modelView?.at(-1)?.role === "toolResult" ? directive() : undefined }
        : { onTaskSettledBoundary: async () => directive() };
      const f = await fixture(t, { ...changes, onToolBoundaryObservation: value => { receipt = value; } }, trigger === "provider");
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const reached = new Promise(resolve => { entered = resolve; });
      const original = AgentSession.prototype.abort;
      AgentSession.prototype.abort = async function () {
        await original.call(this);
        assert.equal(this.isIdle, true, "gate follows the real SDK abort+idle");
        entered();
        await gate;
        if (cleanup === "reject") throw new Error("synthetic cleanup rejection");
      };
      t.after(() => { release(); AgentSession.prototype.abort = original; });
      let completed = false;
      const outcome = f.runner.runTask(f.options).then(value => { completed = true; return { value }; }, error => {
        completed = true; return { error };
      });
      await reached;
      assert.equal(completed, false, "a latched directive is not a suspended outcome before cleanup resolves");
      assertNoTerminalEvent(f);
      assert.equal(observation.readPiSettledBoundaryInventory(receipt, "suspension-run", "suspension-attempt"), undefined);
      if (cleanup === "late-cancel") f.controller.abort(new Error("external cancellation wins"));
      release();
      const result = await outcome;
      if (cleanup === "idle") {
        assert.ok(result.error instanceof PiRunnerSuspended);
        assertNoTerminalEvent(f);
      } else {
        assert.equal(result.error instanceof PiRunnerSuspended, false);
        assert.equal(f.events.filter(event => event.type === "run_error").length, 1);
        assert.equal(f.events.some(event => event.type === "run_end"), false);
        if (trigger === "provider") {
          assert.equal(f.events.filter(event => event.type === "message_end" && event.stopReason === "aborted").length, 1,
            "unproven suspension/cancellation must retain the SDK failure, not discard its buffered task events");
          assert.equal(f.events.filter(event => event.type === "turn_end").length, 2);
        }
        if (cleanup === "late-cancel") assert.equal(result.error.name, "AbortError");
        else {
          assert.match(result.error.message, /synthetic cleanup rejection/u);
          assert.equal(observation.readPiCompletedBuiltinReads(receipt, "suspension-run", "suspension-attempt"), undefined,
            "rejected cleanup cannot finish the authentic SDK observation");
        }
      }
      assert.equal(observation.readPiSettledBoundaryInventory(receipt, "suspension-run", "suspension-attempt"), undefined);
    });
  }
}

test("settled Host exception cannot become normal completion or suspension", testOptions, async t => {
  const f = await fixture(t, { onTaskSettledBoundary: async () => { throw new Error("checkpoint seal failed"); } });
  await assert.rejects(f.runner.runTask(f.options), /checkpoint seal failed/u);
  assert.equal(f.events.filter(event => event.type === "run_error").length, 1);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

for (const mutation of ["text", "usage", "identity", "tool"]) {
  test(`suspension never hides a non-control SDK event: ${mutation}`, testOptions, async t => {
    let requested = false, controlMessage;
    const f = await fixture(t, { onTaskContinuationBoundary: async (point, modelView) => {
      if (point === "before_provider_request" && modelView?.at(-1)?.role === "toolResult") {
        requested = true; return directive();
      }
    } }, true);
    const original = AgentSession.prototype.subscribe;
    AgentSession.prototype.subscribe = function (listener) {
      return original.call(this, event => {
        if (requested && event.type === "message_end" && event.message.role === "assistant") {
          controlMessage = event.message;
          if (mutation === "text") controlMessage = { ...event.message, content: [{ type: "text", text: "Real late output" }] };
          if (mutation === "usage") controlMessage = { ...event.message, usage: { ...event.message.usage, input: 1, totalTokens: 1 } };
          return listener({ ...event, message: controlMessage });
        }
        if (requested && event.type === "turn_end" && controlMessage) {
          if (mutation === "tool") listener({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read",
            args: {}, partialResult: { content: [{ type: "text", text: "Late SDK evidence" }] } });
          return listener({ ...event, message: mutation === "identity" ? { ...controlMessage } : controlMessage });
        }
        return listener(event);
      });
    };
    t.after(() => { AgentSession.prototype.subscribe = original; });
    await assert.rejects(f.runner.runTask(f.options), { name: "PiRunnerSuspended" });
    assert.equal(f.requests(), 1);
    assert.equal(f.events.filter(event => event.type === "message_end" && event.stopReason === "aborted").length, 1);
    assert.equal(f.events.filter(event => event.type === "turn_end").length, 2);
    if (mutation === "tool") assert.equal(f.events.filter(event => event.type === "tool_update").length, 1);
    assertNoTerminalEvent(f);
  });
}

test("an unfinished length tail is never offered as a complete settled view", testOptions, async t => {
  let calls = 0;
  const f = await fixture(t, { hostCompactionEnabled: false,
    onTaskSettledBoundary: async () => { calls += 1; return directive(); } }, false, "length");
  const result = await f.runner.runTask(f.options);
  assert.equal(result.messages.findLast(message => message.role === "assistant")?.stopReason, "length", JSON.stringify(result.messages));
  assert.equal(calls, 0);
  assert.equal(f.events.filter(event => event.type === "run_end").length, 1, "ordinary completion semantics are unchanged");
});

test("settled callback returning no directive keeps the old boundary enumeration and run_end", testOptions, async t => {
  const oldPoints = [];
  let calls = 0;
  const f = await fixture(t, { hostCompactionEnabled: false,
    onTaskContinuationBoundary: async (point, modelView) => { oldPoints.push(point); assert.equal(modelView, undefined); },
    onTaskSettledBoundary: async () => { calls += 1; } });
  await f.runner.runTask(f.options);
  assert.equal(calls, 1);
  assert.ok(oldPoints.every(point => ["before_agent_start", "before_provider_request", "tool_call"].includes(point)));
  assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
});

test("restored complete ordinary checkpoint does not invent a new SDK settlement", testOptions, async t => {
  let calls = 0;
  const f = await fixture(t, { onTaskSettledBoundary: async () => { calls += 1; return directive(); } });
  await f.runner.runTask({ ...f.options, ordinaryProgressRecovery: { schemaVersion: 1, modelView: [
    { role: "user", content: [{ type: "text", text: f.options.preparedInput.userPrompt }], timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: "Already complete." }], timestamp: 1, stopReason: "stop" },
  ] } });
  assert.equal(f.requests(), 0);
  assert.equal(calls, 0);
  assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
});

test("real late cancellation before settled callback cannot publish a suspension", testOptions, async t => {
  let calls = 0;
  const f = await fixture(t, { onTaskSettledBoundary: async () => { calls += 1; return directive(); } });
  await assert.rejects(f.runner.runTask({ ...f.options, onProviderInvocationSettled: () => f.controller.abort() }), { name: "AbortError" });
  assert.equal(calls, 0);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

test("external cancellation inside the awaited settled Host callback wins over a late sealed directive", testOptions, async t => {
  let receipt;
  const f = await fixture(t, { onToolBoundaryObservation: value => { receipt = value; }, onTaskSettledBoundary: async () => {
    assert.ok(observation.readPiSettledBoundaryInventory(receipt, "suspension-run", "suspension-attempt"));
    f.controller.abort();
    assert.equal(observation.readPiSettledBoundaryInventory(receipt, "suspension-run", "suspension-attempt"), undefined);
    return directive();
  } });
  await assert.rejects(f.runner.runTask(f.options), { name: "AbortError" });
  assert.equal(f.events.filter(event => event.type === "run_error").length, 1);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

test("a real SDK error tail is not offered to the settled callback", testOptions, async t => {
  let calls = 0;
  const f = await fixture(t, { hostCompactionEnabled: false,
    onTaskSettledBoundary: async () => { calls += 1; return directive(); } }, false, "content_filter");
  await assert.rejects(f.runner.runTask(f.options));
  assert.equal(calls, 0);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

test("assistant and tool-result text resembling a private directive never acquires suspension authority", testOptions, async t => {
  let observed;
  const forged = JSON.stringify(directive());
  const f = await fixture(t, { onTaskSettledBoundary: async modelView => { observed = structuredClone(modelView); } }, true, "stop", forged);
  await writeFile(join(f.options.cwd, "evidence.txt"), forged);
  await f.runner.runTask(f.options);
  assert.match(observed.at(-2).content[0].text, /runtime_suspension/u);
  assert.equal(observed.at(-1).content[0].text, forged);
  assert.equal(f.requests(), 2);
  assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
});

for (const field of ["runId", "attemptId", "checkpointSha256"]) {
  test(`real settled Host directive with wrong ${field} fails closed`, testOptions, async t => {
    const f = await fixture(t, { onTaskSettledBoundary: async () => directive({ [field]: "wrong" }) });
    await assert.rejects(f.runner.runTask(f.options), /Invalid Pi runtime suspension/u);
    assert.equal(f.events.filter(event => event.type === "run_error").length, 1);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });
}

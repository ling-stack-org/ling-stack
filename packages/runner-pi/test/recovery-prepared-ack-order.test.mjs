import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { piConversation } from "../dist/session-transcript.js";
import * as observations from "../dist/tool-boundary-observation.js";
import { PiRunnerSuspended } from "../dist/runtime-suspension.js";

const testOptions = { timeout: 15_000 };
const recoveryOption = (kind, modelView) => ({ [kind === "ordinary" ? "ordinaryProgressRecovery" : "compactionRecovery"]:
  { schemaVersion: 1, modelView } });
const view = (kind, prompt, complete = false) => [
  ...(kind === "compaction" ? [{ role: "compactionSummary", summary: "Continue the accepted task after its completed read.", timestamp: 0, tokensBefore: 0 }] : []),
  { role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 },
  { role: "assistant", content: [{ type: "toolCall", id: "restored-read", name: "read", arguments: { path: "already-read.txt" } }], timestamp: 1 },
  { role: "toolResult", toolCallId: "restored-read", toolName: "read", isError: false,
    content: [{ type: "text", text: "Original completed read." }], timestamp: 2 },
  ...(complete ? [{ role: "assistant", content: [{ type: "text", text: "Already complete." }], timestamp: 3, stopReason: "stop" }] : []),
];

/** Real SDK Session and stream parser; only transport and an observed SDK refresh are controlled. */
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-recovery-ack-order-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const controls = {}, contexts = [], wire = [], events = [], boundaries = [];
  let effects = 0;
  const refresh = AgentSession.prototype.refreshContext;
  t.mock.method(AgentSession.prototype, "refreshContext", function (...args) {
    const result = Reflect.apply(refresh, this, args);
    if (this.messages.some(message => message.role === "toolResult" && message.toolCallId === "restored-read")) {
      controls.session = this;
      if (controls.failInstall) throw controls.failInstall;
    }
    return result;
  });
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) => {
        contexts.push(structuredClone(context));
        return stream(model, context, { ...options, fetch: async (_url, request) => {
          wire.push(JSON.parse(request.body));
          return new Response('data: {"choices":[{"index":0,"delta":{"content":"Continued once."},"finish_reason":null}]}\n\n'
            + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } });
        } });
      } });
    }
  }
  const runner = new FixtureRunner();
  const options = { cwd, agentDir: join(cwd, "agent"), runId: "recovery-ack-run", runnerAttemptId: "recovery-ack-attempt",
    task: { id: "recovery-ack-task", title: "Recover", prompt: "Continue without repeating the completed read." },
    provider: { provider: "recovery-ack-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture-no-network", reasoning: false }, tools: ["read"],
    onEvent: event => events.push(event), onTaskContinuationBoundary: point => { boundaries.push(point); },
    onToolBefore: () => { effects += 1; return { allowed: true }; } };
  const preparedInput = await runner.prepareTaskInput(options);
  return { runner, options: { ...options, preparedInput }, controls, contexts, wire, events, boundaries, effects: () => effects };
}

for (const kind of ["ordinary", "compaction"]) {
  test(`${kind} restored-complete observation is separate, ACK-bound, detached and valid only in its own callback`, testOptions, async t => {
    const f = await fixture(t);
    let receipt, calls = 0, acknowledged = false;
    await f.runner.runTask({ ...f.options, ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt, true)),
      onToolBoundaryObservation: value => { receipt = value; },
      onPreparedInputAccepted: () => { acknowledged = true;
        assert.equal(observations.readPiRestoredCompleteSnapshot?.(receipt, f.options.runId, f.options.runnerAttemptId), undefined);
      },
      onTaskSettledBoundary: () => { throw new Error("A restored complete view is not a new model settlement"); },
      onTaskRestoredCompleteBoundary: async modelView => {
        calls++; assert.equal(acknowledged, true);
        assert.equal(observations.readPiSettledBoundarySnapshot(receipt, f.options.runId, f.options.runnerAttemptId), undefined);
        assert.equal(observations.readPiRestoredCompleteSnapshot({ ...receipt }, f.options.runId, f.options.runnerAttemptId), undefined);
        const snapshot = observations.readPiRestoredCompleteSnapshot(receipt, f.options.runId, f.options.runnerAttemptId);
        assert.ok(snapshot); assert.deepEqual(snapshot.modelView, modelView);
        assert.deepEqual(snapshot.inventory, { toolCallIds: [], settledBuiltinReads: [] });
        const original = structuredClone(snapshot.modelView);
        modelView.at(-1).content[0].text = "changed DTO";
        snapshot.modelView.at(-1).content[0].text = "changed reader clone";
        await Promise.resolve();
        assert.deepEqual(observations.readPiRestoredCompleteSnapshot(receipt, f.options.runId, f.options.runnerAttemptId).modelView, original);
      } });
    assert.equal(calls, 1, "complete recovery must enter its independent Host boundary");
    assert.equal(observations.readPiRestoredCompleteSnapshot(receipt, f.options.runId, f.options.runnerAttemptId), undefined);
    assert.equal(f.wire.length, 0); assert.equal(f.effects(), 0);
  });

  test(`${kind} restored-complete suspension stops the actual SDK without a new provider wire`, testOptions, async t => {
    const f = await fixture(t);
    const directive = { schemaVersion: 1, kind: "runtime_suspension", runId: f.options.runId, attemptId: f.options.runnerAttemptId,
      suspensionId: "restored-suspension", checkpointId: "restored-settlement", checkpointSha256: "a".repeat(64) };
    let acknowledged = false;
    await assert.rejects(f.runner.runTask({ ...f.options,
      ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt, true)),
      onPreparedInputAccepted: () => { acknowledged = true; },
      onTaskRestoredCompleteBoundary: () => { assert.equal(acknowledged, true); return directive; },
    }), error => error instanceof PiRunnerSuspended && assert.deepEqual(error.request, directive) === undefined);
    assert.equal(f.wire.length, 0); assert.equal(f.effects(), 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });

  test(`${kind} restored-complete boundary failure cannot emit success or fall back to a new prompt`, testOptions, async t => {
    const f = await fixture(t), failure = new Error("Original final ledger was revoked");
    await assert.rejects(f.runner.runTask({ ...f.options,
      ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt, true)),
      onPreparedInputAccepted: () => undefined,
      onTaskRestoredCompleteBoundary: () => { throw failure; },
    }), error => error === failure);
    assert.equal(f.wire.length, 0); assert.equal(f.effects(), 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });

  test(`${kind} complete recovery rechecks current Host authority after the actual ACK without emitting success`, testOptions, async t => {
    const f = await fixture(t), rejected = new Error("Host authority changed after terminal-view ACK");
    let acknowledged = false;
    await assert.rejects(f.runner.runTask({ ...f.options,
      ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt, true)),
      onPreparedInputAccepted: () => { acknowledged = true; },
      onTaskContinuationBoundary: async point => {
        assert.equal(acknowledged, true);
        assert.equal(point, "before_agent_start");
        throw rejected;
      },
    }), error => error === rejected);
    assert.equal(acknowledged, true);
    assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.effects(), 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });

  for (const reason of ["aborted", "error", "length", "toolUse", undefined]) {
    test(`${kind} ${String(reason)} final response cannot ACK, execute or emit success`, testOptions, async t => {
      const f = await fixture(t), modelView = view(kind, f.options.preparedInput.userPrompt, true);
      if (reason === undefined) delete modelView.at(-1).stopReason;
      else modelView.at(-1).stopReason = reason;
      let receipts = 0;
      await assert.rejects(f.runner.runTask({ ...f.options, ...recoveryOption(kind, modelView),
        onPreparedInputAccepted: () => { receipts += 1; } }), /Invalid Pi .*recovery model view/u);
      assert.equal(receipts, 0);
      assert.equal(f.controls.session, undefined, "invalid final state is rejected before SDK recovery installation");
      assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.effects(), 0);
      assert.equal(f.events.some(event => event.type === "run_end"), false);
    });
  }

  test(`${kind} recovery rejects a missing accepted anchor before prepared ACK`, testOptions, async t => {
    const f = await fixture(t);
    let receipts = 0;
    await assert.rejects(f.runner.runTask({ ...f.options, ...recoveryOption(kind, view(kind, "Unaccepted task")),
      onPreparedInputAccepted: () => { receipts += 1; } }), /accepted task anchor/u);
    assert.equal(receipts, 0, "invalid recovery must not publish a prepared ACK");
    assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.effects(), 0);
  });

  test(`${kind} real SDK installation failure precedes prepared ACK`, testOptions, async t => {
    const f = await fixture(t), rejected = new Error("Owned SDK recovery installation failure");
    f.controls.failInstall = rejected;
    let receipts = 0;
    await assert.rejects(f.runner.runTask({ ...f.options, ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt)),
      onPreparedInputAccepted: () => { receipts += 1; } }), error => error === rejected);
    assert.ok(f.controls.session instanceof AgentSession, "the real SDK reached recovery installation");
    assert.equal(receipts, 0, "SDK installation failure must not publish a prepared ACK");
    assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.effects(), 0);
  });

  for (const complete of [false, true]) {
    test(`${kind} ${complete ? "complete" : "continuing"} view is actually installed before a blocking ACK and zero wire`, testOptions, async t => {
      const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
      const modelView = view(kind, f.options.preparedInput.userPrompt, complete);
      let receipts = 0;
      const running = f.runner.runTask({ ...f.options, ...recoveryOption(kind, modelView),
        onPreparedInputAccepted: async () => { receipts += 1; entered.resolve(); await release.promise; } });
      try {
        await Promise.race([entered.promise, running.then(() => { throw new Error("Recovery bypassed prepared ACK"); })]);
        assert.ok(f.controls.session instanceof AgentSession, "ACK must observe the actual restored SDK Session");
        const installed = piConversation(f.controls.session.state.messages);
        const normalizeSummary = messages => messages.map(message => message.role === "compactionSummary" ? { ...message, timestamp: 0 } : message);
        assert.deepEqual(normalizeSummary(installed), normalizeSummary(modelView));
        assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0); assert.equal(f.boundaries.length, 0);
      } finally { release.resolve(); await running.catch(() => {}); }
      const result = await running;
      assert.equal(receipts, 1); assert.equal(f.wire.length, complete ? 0 : 1); assert.equal(f.effects(), 0);
      assert.equal(result.messages.at(-1).role, "assistant");
      assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
    });
  }

  test(`${kind} installed recovery cannot continue after Host ACK rejection`, testOptions, async t => {
    const f = await fixture(t), rejected = new Error("Host refused the prepared ACK");
    let receipts = 0;
    await assert.rejects(f.runner.runTask({ ...f.options, ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt)),
      onPreparedInputAccepted: () => { receipts += 1; throw rejected; } }), error => error === rejected);
    assert.ok(f.controls.session instanceof AgentSession);
    assert.equal(receipts, 1); assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0);
    assert.equal(f.boundaries.length, 0); assert.equal(f.events.some(event => event.type === "run_end"), false);
  });

  test(`${kind} ACK cannot mutate the accepted task after installation`, testOptions, async t => {
    const f = await fixture(t);
    await assert.rejects(f.runner.runTask({ ...f.options, ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt)),
      onPreparedInputAccepted: () => { f.options.task.prompt = "Changed during prepared ACK"; } }), /prepared.*input|input.*prepar/iu);
    assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0);
  });

  for (const complete of [false, true]) {
    test(`${kind} ${complete ? "complete" : "continuing"} ACK cannot alter the installed SDK messages`, testOptions, async t => {
      const f = await fixture(t);
      await assert.rejects(f.runner.runTask({ ...f.options, ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt, complete)),
        onPreparedInputAccepted: () => {
          assert.ok(f.controls.session instanceof AgentSession);
          f.controls.session.state.messages.find(message => message.role === "toolResult").content[0].text = "Changed during ACK";
        } }), /restored.*view|recovery.*changed/iu);
      assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0);
      assert.equal(f.events.some(event => event.type === "run_end"), false);
    });
  }

  for (const mutation of ["messages accessor", "nested accessor", "serializer", "proxy"]) {
    test(`${kind} ACK rejects a ${mutation} without invoking it`, testOptions, async t => {
      const f = await fixture(t);
      let invoked = 0, restore;
      try {
        await assert.rejects(f.runner.runTask({ ...f.options, ...recoveryOption(kind, view(kind, f.options.preparedInput.userPrompt, true)),
          onPreparedInputAccepted: () => {
            const state = f.controls.session.state;
            const messages = state.messages;
            if (mutation === "messages accessor") {
              const descriptor = Object.getOwnPropertyDescriptor(state, "messages");
              restore = () => Object.defineProperty(state, "messages", descriptor);
              Object.defineProperty(state, "messages", { configurable: true, enumerable: true,
                get: () => { invoked += 1; return messages; } });
            } else {
              const content = messages.find(message => message.role === "toolResult").content;
              if (mutation === "nested accessor") Object.defineProperty(content[0], "text", {
                enumerable: true, get: () => { invoked += 1; return "Original completed read."; } });
              if (mutation === "serializer") content[0].toJSON = () => { invoked += 1; return { type: "text", text: "Original completed read." }; };
              if (mutation === "proxy") content[0] = new Proxy(content[0], { ownKeys: target => { invoked += 1; return Reflect.ownKeys(target); } });
            }
          } }), /restored.*data-only/u);
      } finally { restore?.(); }
      assert.equal(invoked, 0, "the view guard must not execute caller-supplied data hooks");
      assert.equal(f.contexts.length, 0); assert.equal(f.wire.length, 0);
      assert.equal(f.events.some(event => event.type === "run_end"), false);
    });
  }
}

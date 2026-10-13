import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { PiRunnerAdapter } from "../dist/adapter.js";
import { boundModelToolResults } from "../dist/model-context-budget.js";
import { createInitializedPiSession } from "../dist/session-factory.js";
import { piConversation, piTranscript } from "../dist/session-transcript.js";
import {
  assertOrdinaryProgressRecoveryModelContext, installOrdinaryProgressRecoveryView, readOrdinaryProgressRecoveryView,
} from "../dist/ordinary-progress-recovery.js";

const testOptions = { timeout: 15_000 };
const view = (prompt = "Accepted task") => [
  { role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 },
  { role: "assistant", content: [{ type: "toolCall", id: "source-read", name: "read", arguments: { path: "already-read.txt" } }], timestamp: 1 },
  { role: "toolResult", toolCallId: "source-read", toolName: "read", isError: false,
    content: [{ type: "text", text: "Actual source evidence." }], details: { source: "durable" }, timestamp: 2 },
];
const recovery = (messages = view()) => ({ schemaVersion: 1, modelView: messages });

test("ordinary recovery captures exact plain JSON without mutating the source", () => {
  const input = recovery();
  const captured = readOrdinaryProgressRecoveryView(input);
  assert.deepEqual(captured, input.modelView);
  assert.notEqual(captured, input.modelView);
  input.modelView.at(-1).content[0].text = "Changed after capture";
  assert.equal(captured.at(-1).content[0].text, "Actual source evidence.");
});

test("ordinary recovery rejects malformed private option values rather than falling back to a prompt", () => {
  for (const value of [null, false, 0, "", { schemaVersion: 1, modelView: [] }]) {
    assert.throws(() => readOrdinaryProgressRecoveryView(value), /Invalid Pi ordinary progress/u);
  }
});

const invalidViews = [
  ["summary authority", messages => { messages.unshift({ role: "compactionSummary", summary: "not ordinary", timestamp: 0 }); }],
  ["system authority", messages => { messages.unshift({ role: "system", content: "unsealed", timestamp: 0 }); }],
  ["fresh user ending", messages => { messages.push({ role: "user", content: "fresh prompt", timestamp: 3 }); }],
  ["orphan result", messages => { messages.at(-1).toolCallId = "unknown"; }],
  ["wrong tool name", messages => { messages.at(-1).toolName = "bash"; }],
  ["missing result", messages => { messages.pop(); }],
  ["duplicate result", messages => { messages.push(structuredClone(messages.at(-1))); }],
  ["duplicate call", messages => { messages[1].content.push(structuredClone(messages[1].content[0])); }],
  ["assistant before result", messages => { messages.splice(2, 0, { role: "assistant", content: [{ type: "text", text: "premature" }], timestamp: 2 }); }],
  ["nonprimitive role", messages => { messages[1].role = ["assistant"]; }],
  ["nonboolean result status", messages => { messages.at(-1).isError = "false"; }],
  ["unknown content block", messages => { messages.at(-1).content[0] = { type: "custom", text: "unsupported" }; }],
  ["missing timestamp", messages => { delete messages.at(-1).timestamp; }],
  ["nonfinite timestamp", messages => { messages.at(-1).timestamp = NaN; }],
  ["aborted assistant", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "aborted" }], timestamp: 3, stopReason: "aborted" }); }],
  ["unfinished assistant", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "cut off" }], timestamp: 3, stopReason: "length" }); }],
  ["missing final stop reason", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "not proven settled" }], timestamp: 3 }); }],
  ["array final stop reason", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "malformed" }], timestamp: 3, stopReason: ["stop"] }); }],
  ["null final stop reason", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "malformed" }], timestamp: 3, stopReason: null }); }],
  ["toolUse final stop reason without a tool call", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "not terminal" }], timestamp: 3, stopReason: "toolUse" }); }],
  ["error final stop reason", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "error" }], timestamp: 3, stopReason: "error" }); }],
  ["non-exact final stop reason", messages => { messages.push({ role: "assistant", content: [{ type: "text", text: "malformed" }], timestamp: 3, stopReason: "STOP" }); }],
  ["credential field", messages => { messages[1].content[0].arguments.apiKey = "fixture-secret-value"; }],
  ["explicit bearer credential", messages => { messages.at(-1).content[0].text = "Bearer fixture-secret-credential-value"; }],
  ["explicit key credential", messages => { messages.at(-1).content[0].text = "sk-fixturesecretcredential123456"; }],
  ["over-budget view", messages => { messages.at(-1).content[0].text = "x".repeat(512 * 1024); }],
];
for (const [label, mutate] of invalidViews) {
  test(`ordinary recovery rejects ${label}`, () => {
    const messages = view();
    mutate(messages);
    assert.throws(() => readOrdinaryProgressRecoveryView(recovery(messages)), /Invalid Pi ordinary progress/u);
  });
}

test("ordinary recovery rejects getters, toJSON, inherited authority and cycles without invoking user code", () => {
  let calls = 0;
  const getter = { schemaVersion: 1, get modelView() { calls += 1; return view(); } };
  const serializer = { ...recovery(), toJSON() { calls += 1; return recovery(); } };
  const inherited = Object.assign(Object.create({ authority: true }), recovery());
  const cyclic = recovery();
  cyclic.modelView.at(-1).details = cyclic;
  for (const value of [getter, serializer, inherited, cyclic, { ...recovery(), unexpected: true }]) {
    assert.throws(() => readOrdinaryProgressRecoveryView(value), /Invalid Pi ordinary progress/u);
  }
  assert.equal(calls, 0);
});

test("ordinary recovery does not mistake token budgets, hashes or fences for credentials", () => {
  const messages = view();
  messages[1].content[0].arguments = { path: "file", token: "lexical-token", tokenBudget: 128,
    totalTokens: 10, fencingToken: "fence_fixture_1", hash: "a".repeat(64) };
  assert.deepEqual(readOrdinaryProgressRecoveryView(recovery(messages)), messages);
});

test("ordinary first context must equal the deterministic converted bounded projection", () => {
  const input = recovery();
  input.modelView.at(-1).content[0].text = "large evidence ".repeat(3_000);
  const messages = convertToLlm(boundModelToolResults(input.modelView).messages);
  assert.doesNotThrow(() => assertOrdinaryProgressRecoveryModelContext(input, { messages }));
  assert.deepEqual(input.modelView.at(-1).content[0].text, "large evidence ".repeat(3_000));
  const drifted = structuredClone(messages);
  drifted.at(-1).content[0].text += "changed";
  assert.throws(() => assertOrdinaryProgressRecoveryModelContext(input, { messages: drifted }), /changed before/u);
});

/** Real SDK Session/provider parser; only the network transport is replaced. */
async function fixture(t, changes = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pi-ordinary-recovery-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const contexts = [], boundaries = [], events = [], payloads = [], admitted = [], settled = [];
  let effects = 0;
  class FixtureRunner extends PiRunnerAdapter {
    registerCustomProviderIfNeeded(runtime, provider) {
      super.registerCustomProviderIfNeeded(runtime, provider);
      runtime.registerProvider(provider.provider, { api: "openai-completions", streamSimple: (model, context, options) => {
        contexts.push(structuredClone(context));
        return stream(model, context, { ...options, fetch: async (_url, init) => {
          payloads.push(JSON.parse(init.body));
          const delta = { content: "Finished from the durable tool result." };
          return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
            + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } });
        } });
      } });
    }
  }
  const runner = new FixtureRunner();
  const options = { cwd, agentDir: join(cwd, "agent"), runId: "ordinary-source", runnerAttemptId: "ordinary-target",
    task: { id: "ordinary-task", title: "Recover original task", prompt: "Report the completed read without replaying it." },
    provider: { provider: "ordinary-fixture", model: "fixture", baseUrl: "https://fixture.invalid/v1",
      api: "openai-completions", apiKey: "fixture-no-network", reasoning: false }, tools: ["read"],
    onEvent: event => events.push(event),
    onProviderInvocationAdmitted: receipt => admitted.push(receipt),
    onProviderInvocationSettled: receipt => settled.push(receipt),
    onTaskContinuationBoundary: async (boundary, modelView) => {
      boundaries.push({ boundary, modelView: structuredClone(modelView) });
      await changes.onBoundary?.(boundary, modelView);
    },
    onToolBefore: () => { effects += 1; return { allowed: true }; },
  };
  const preparedInput = await runner.prepareTaskInput(options);
  return { runner, options: { ...options, preparedInput }, contexts, boundaries, events, payloads, admitted, settled, effects: () => effects };
}

test("ordinary tool-result recovery uses the real SDK once with exact first context and no historical effect", testOptions, async t => {
  const f = await fixture(t);
  const input = recovery(view(f.options.preparedInput.userPrompt));
  const result = await f.runner.runTask({ ...f.options, ordinaryProgressRecovery: input });
  assert.equal(f.contexts.length, 1);
  assert.equal(f.payloads.length, 1);
  assert.equal(f.admitted.length, 1);
  assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0].outcome, "succeeded");
  assert.equal(f.effects(), 0);
  assert.deepEqual(piConversation(piTranscript(f.contexts[0]).messages), convertToLlm(boundModelToolResults(input.modelView).messages));
  assert.deepEqual(f.boundaries.find(item => item.boundary === "before_provider_request").modelView, input.modelView);
  assert.ok(f.boundaries.some(item => item.boundary === "before_agent_start"));
  assert.equal(f.payloads[0].messages.filter(message => message.role === "tool" && message.tool_call_id === "source-read").length, 1);
  assert.equal(f.events.filter(event => event.type === "tool_start" || event.type === "tool_end").length, 0);
  assert.equal(f.events.some(event => event.type.startsWith("context_compaction_")), false);
  assert.equal(result.messages.at(-1).role, "assistant");
});

test("ordinary completed assistant recovery rechecks Host but never starts a provider", testOptions, async t => {
  const f = await fixture(t);
  const messages = [...view(f.options.preparedInput.userPrompt),
    { role: "assistant", content: [{ type: "text", text: "Already finished." }], timestamp: 3, stopReason: "stop" }];
  const result = await f.runner.runTask({ ...f.options, ordinaryProgressRecovery: recovery(messages) });
  assert.equal(f.contexts.length, 0);
  assert.equal(f.effects(), 0);
  assert.equal(f.boundaries.filter(item => item.boundary === "before_agent_start").length, 1);
  assert.equal(f.events.filter(event => event.type === "run_end").length, 1);
  assert.deepEqual(piConversation(result.messages), messages);
});

test("ordinary completed assistant cannot publish run_end after the final-branch Host rejects", testOptions, async t => {
  const f = await fixture(t, { onBoundary: async point => {
    if (point === "before_agent_start") throw new Error("Final Host checkpoint authority changed");
  } });
  const messages = [...view(f.options.preparedInput.userPrompt),
    { role: "assistant", content: [{ type: "text", text: "Already finished." }], timestamp: 3, stopReason: "stop" }];
  await assert.rejects(f.runner.runTask({ ...f.options, ordinaryProgressRecovery: recovery(messages) }),
    /Final Host checkpoint authority changed/u);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.payloads.length, 0);
  assert.equal(f.effects(), 0);
  assert.equal(f.events.some(event => event.type === "run_end"), false);
});

for (const boundary of ["before_agent_start", "before_provider_request"]) {
  test(`ordinary recovery cannot bypass original Host ${boundary} rejection after setup`, testOptions, async t => {
    const f = await fixture(t, { onBoundary: async point => { if (point === boundary) throw new Error("Host checkpoint authority changed"); } });
    await assert.rejects(f.runner.runTask({ ...f.options, ordinaryProgressRecovery: recovery(view(f.options.preparedInput.userPrompt)) }),
      /Host checkpoint authority changed/u);
    assert.equal(f.payloads.length, 0, "Host rejection must prevent every transport fetch");
    assert.equal(f.admitted.length, 0, "Host rejection must prevent logical provider admission");
    assert.equal(f.settled.length, 0, "an unadmitted stream must not publish provider settlement");
    // Pi assembles the stream before its awaited before_provider_request payload hook.
    // Initialization is not transport: the Host latch must block the fetch above.
    assert.equal(f.contexts.length, boundary === "before_provider_request" ? 1 : 0);
    assert.equal(f.boundaries.filter(item => item.boundary === boundary).length, 1);
    assert.equal(f.effects(), 0);
    assert.equal(f.events.some(event => event.type === "run_end"), false);
  });
}

test("ordinary recovery requires original prepared authority and mutually exclusive recovery modes", testOptions, async t => {
  const f = await fixture(t);
  const input = recovery(view(f.options.preparedInput.userPrompt));
  for (const changed of [ { preparedInput: undefined }, { runId: undefined }, { runnerAttemptId: undefined },
    { onEvent: undefined }, { onTaskContinuationBoundary: undefined },
    { ordinaryProgressRecovery: null }, { ordinaryProgressRecovery: false },
    { compactionRecovery: { schemaVersion: 1, modelView: [] } }, { approvedToolContinuation: {} } ]) {
    await assert.rejects(f.runner.runTask({ ...f.options, ordinaryProgressRecovery: input, ...changed }), /ordinary progress recovery/u);
  }
  assert.equal(f.contexts.length, 0);
});

test("ordinary recovery captures its view before awaited Host callbacks can mutate caller evidence", testOptions, async t => {
  let input;
  const f = await fixture(t, { onBoundary: async point => {
    if (point === "before_agent_start") input.modelView.at(-1).content[0].text = "Caller mutation after setup";
  } });
  input = recovery(view(f.options.preparedInput.userPrompt));
  const sealed = structuredClone(input);
  await f.runner.runTask({ ...f.options, ordinaryProgressRecovery: input });
  assert.notDeepEqual(input, sealed);
  assert.equal(f.contexts.length, 1);
  assert.deepEqual(piConversation(piTranscript(f.contexts[0]).messages), convertToLlm(boundModelToolResults(sealed.modelView).messages));
});

test("ordinary installation rejects a busy session before any SDK state write", () => {
  const session = { isIdle: false, messages: [], sessionManager: { appendMessage() { assert.fail("unexpected SDK mutation"); } } };
  assert.throws(() => installOrdinaryProgressRecoveryView(session, recovery(), "Accepted task"), /idle empty session/u);
});

test("ordinary installation rejects a missing task anchor before touching the real Session", testOptions, async t => {
  const f = await fixture(t);
  const session = await createInitializedPiSession(f.options, runtime => f.runner.registerCustomProviderIfNeeded(runtime, f.options.provider));
  t.after(() => session.dispose());
  assert.throws(() => installOrdinaryProgressRecoveryView(session, recovery(), f.options.preparedInput.userPrompt), /accepted task anchor/u);
  assert.equal(session.messages.length, 0);
  const input = recovery(view(f.options.preparedInput.userPrompt));
  assert.equal(installOrdinaryProgressRecoveryView(session, input, f.options.preparedInput.userPrompt), "continue");
  assert.deepEqual(piConversation(session.state.messages), input.modelView);
  assert.equal(session.sessionManager.buildSessionProjection().entries.some(entry => entry.sourceEntry.type === "compaction"), false);
  assert.throws(() => installOrdinaryProgressRecoveryView(session, input, f.options.preparedInput.userPrompt), /idle empty session/u);
  assert.equal(f.contexts.length, 0);
});

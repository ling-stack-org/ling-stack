import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { compactionFixture, response } from "./support/pi-compaction-fixture.mjs";
import { createPiTaskBoundary, createPiSessionStopper } from "../dist/task-boundary.js";

const testOptions = { timeout: 15_000 };
const prompt = "Finish the fixture and preserve all recorded effects. " + "goal ".repeat(100);
const compactions = f => f.sessionManager.getEntries().filter(entry => entry.type === "compaction");
const ends = f => f.events.filter(event => event.type === "compaction_end");
const providerError = (message, status = 400) => new Response(JSON.stringify({ error: { message,
  type: status === 503 ? "server_error" : "invalid_request_error" } }),
  { status, headers: { "content-type": "application/json" } });

test("SDK threshold compaction is post-agent-run, not between high-usage tool turns", testOptions, async t => {
  const f = await compactionFixture(t, { task: ({ index }) => response({
    ...(index < 3 ? { toolCallId: "effect-" + index } : {}), inputTokens: index < 4 ? 1_850 : 100,
  }) });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["effect-0", "effect-1", "effect-2"]);
  assert.equal(ends(f).length, 1);
  assert.equal(ends(f)[0].reason, "threshold");
  assert.equal(ends(f)[0].willRetry, false);
  assert.ok(ends(f)[0].result);
  const lastToolEnd = f.events.findLastIndex(event => event.type === "tool_execution_end");
  const start = f.events.findIndex(event => event.type === "compaction_start");
  assert.ok(start > lastToolEnd);
  assert.equal(f.events.slice(0, start).filter(event => event.type === "turn_end").length, 4);
  assert.equal(f.requests.filter(request => request.phase === "task").length, 4);
  assert.equal(compactions(f).length, 1);
  await f.session.prompt("Continue without repeating effects.");
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["effect-0", "effect-1", "effect-2"]);
  const followup = f.requests.filter(request => request.phase === "task").at(-1);
  const callIds = new Set(followup.messages.flatMap(message => message.role === "assistant"
    ? message.content.filter(block => block.type === "toolCall").map(block => block.id) : []));
  for (const result of followup.messages.filter(message => message.role === "toolResult")) {
    assert.ok(callIds.has(result.toolCallId), "kept tool results must retain their calls");
  }
  assert.equal(compactions(f).length, 1, "stale usage must not trigger compaction again on followup");
});

test("SDK auto-compaction failure is an event, not a rejected prompt or an installed summary", testOptions, async t => {
  const f = await compactionFixture(t, {
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: () => new Response(JSON.stringify({ error: { message: "SYNTHETIC_PRIVATE_PROVIDER_DETAIL", type: "invalid_request_error" } }),
      { status: 400, headers: { "content-type": "application/json" } }),
  });
  await assert.doesNotReject(f.session.prompt(prompt));
  await f.session.waitForIdle();
  assert.equal(ends(f).length, 1);
  assert.equal(ends(f)[0].result, undefined);
  assert.match(ends(f)[0].errorMessage, /SYNTHETIC_PRIVATE_PROVIDER_DETAIL/);
  assert.equal(ends(f)[0].willRetry, false);
  assert.equal(compactions(f).length, 0);
  assert.equal(f.session.isIdle, true);
});

test("a compaction model cannot execute a tool from its summary response", testOptions, async t => {
  const f = await compactionFixture(t, {
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: () => response({ toolCallId: "must-not-execute" }),
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), []);
  assert.equal(compactions(f).length, 0);
  assert.ok(ends(f)[0].errorMessage);
});

test("SDK abort alone does not cancel an active automatic summary request", testOptions, async t => {
  let entered, release, summarySignal;
  const f = await compactionFixture(t, {
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: async ({ signal }) => { summarySignal = signal; entered.resolve(); await release.promise; return response({ text: "Late summary" }); },
  });
  entered = f.hold(); release = f.hold();
  const running = f.session.prompt(prompt);
  await entered.promise;
  let stopped = false;
  const stopping = f.session.abort().then(() => { stopped = true; });
  await nextTick();
  assert.equal(summarySignal.aborted, false);
  assert.equal(stopped, false);
  f.session.abortCompaction();
  assert.equal(summarySignal.aborted, true);
  release.resolve();
  await Promise.all([running, stopping]);
  assert.equal(compactions(f).length, 0);
  assert.equal(f.session.isIdle, true);
  assert.equal(ends(f)[0].result, undefined);
});

test("manual compact aborts an active tool and never automatically resumes the interrupted turn", testOptions, async t => {
  let entered, release, toolSignal;
  const f = await compactionFixture(t, {
    compaction: { enabled: false },
    task: ({ index }) => response(index === 1 ? { toolCallId: "manual-effect" } : { text: "Warmup. " + "text ".repeat(400) }),
    tool: async ({ signal }) => { toolSignal = signal; entered.resolve(); await release.promise;
      return { content: [{ type: "text", text: "Cleaned up after recorded effect." }], details: {} }; },
  });
  entered = f.hold(); release = f.hold();
  await f.session.prompt(prompt);
  const running = f.session.prompt("Perform one effect, then continue.");
  await entered.promise;
  const compacting = f.session.compact();
  await nextTick();
  assert.equal(toolSignal.aborted, true);
  assert.equal(f.events.filter(event => event.type === "compaction_start").length, 0, "must wait for tool cleanup");
  release.resolve();
  await running;
  await compacting;
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["manual-effect"]);
  assert.equal(f.requests.filter(request => request.phase === "task").length, 2);
  assert.equal(ends(f)[0].reason, "manual");
  assert.equal(ends(f)[0].willRetry, false);
  assert.equal(compactions(f).length, 1);
});

test("overflow compact-and-retry keeps completed effects and removes the failed response only from retry context", testOptions, async t => {
  const f = await compactionFixture(t, { task: ({ index }) => index === 0
    ? response({ toolCallId: "effect-before-overflow", inputTokens: 1_200 })
    : index === 1 ? providerError("maximum context length exceeded") : response() });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["effect-before-overflow"]);
  assert.equal(f.requests.filter(request => request.phase === "task").length, 3);
  assert.equal(ends(f).length, 1);
  assert.equal(ends(f)[0].reason, "overflow");
  assert.equal(ends(f)[0].willRetry, true);
  assert.equal(compactions(f).length, 1);
  const retry = f.requests.filter(request => request.phase === "task").at(-1);
  assert.equal(retry.messages.some(message => message.role === "assistant" && message.stopReason === "error"), false);
  assert.ok(f.sessionManager.getEntries().some(entry => entry.type === "message"
    && entry.message.role === "assistant" && entry.message.stopReason === "error"), "SDK history retains the failed response");
  assert.equal(f.session.state.messages.at(-1).stopReason, "stop");
});

test("a second overflow ends recovery instead of re-compacting or re-executing effects forever", testOptions, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-08T00:00:00.000Z") });
  const f = await compactionFixture(t, { task: ({ index }) => index === 0
    ? response({ toolCallId: "bounded-effect", inputTokens: 1_200 }) : providerError("maximum context length exceeded"),
    event: event => { if (event.type === "compaction_end" && event.result) t.mock.timers.tick(1); },
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["bounded-effect"]);
  assert.equal(f.requests.filter(request => request.phase === "task").length, 3);
  assert.equal(compactions(f).length, 1);
  assert.equal(f.events.filter(event => event.type === "compaction_start").length, 1);
  assert.equal(ends(f).length, 2, "recovery exhaustion emits an end failure without a second start");
  assert.match(ends(f)[1].errorMessage, /after one compact-and-retry attempt/);
  assert.equal(ends(f)[1].willRetry, false);
  assert.equal(f.session.state.messages.at(-1).stopReason, "error");
});

test("same-millisecond overflow still requires reading assistant failure even without a second compaction_end", testOptions, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-08T00:00:00.000Z") });
  const f = await compactionFixture(t, { task: ({ index }) => index === 0
    ? response({ toolCallId: "same-time-effect", inputTokens: 1_200 }) : providerError("maximum context length exceeded") });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["same-time-effect"]);
  assert.equal(f.requests.filter(request => request.phase === "task").length, 3);
  assert.equal(compactions(f).length, 1);
  assert.equal(ends(f).length, 1, "SDK timestamp guard treats a same-millisecond new error as pre-compaction");
  const lastAssistant = f.events.findLast(event => event.type === "message_end" && event.message.role === "assistant");
  assert.equal(lastAssistant.message.stopReason, "error");
  assert.equal(lastAssistant.message.timestamp, new Date(compactions(f)[0].timestamp).getTime());
});

test("transient summary retry is bounded and does not rerun the completed task", testOptions, async t => {
  const f = await compactionFixture(t, {
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: ({ index }) => index === 0 ? providerError("overloaded", 503) : response({ text: "Recovered summary." }),
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.equal(f.requests.filter(request => request.phase === "task").length, 1);
  const summaries = f.requests.filter(request => request.phase === "summary");
  assert.equal(summaries.length, 2);
  assert.deepEqual(summaries[0].messages, summaries[1].messages);
  assert.equal(f.events.filter(event => event.type === "summarization_retry_scheduled").length, 1);
  assert.equal(f.events.filter(event => event.type === "summarization_retry_attempt_start").length, 1);
  assert.deepEqual(f.events.find(event => event.type === "summarization_retry_finished"), { type: "summarization_retry_finished" });
  assert.ok(ends(f)[0].result, "success comes from compaction completion, not the retry_finished event name");
  assert.equal(compactions(f).length, 1);
});

test("cancelling summary backoff prevents the retry request and installs no late SDK summary entry", testOptions, async t => {
  const f = await compactionFixture(t, {
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 10_000, provider: { maxRetries: 0 } },
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: () => providerError("overloaded", 503),
    event: event => { if (event.type === "summarization_retry_scheduled") f.session.abortCompaction(); },
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.equal(f.requests.filter(request => request.phase === "summary").length, 1);
  assert.equal(f.events.filter(event => event.type === "summarization_retry_attempt_start").length, 0);
  assert.deepEqual(f.events.find(event => event.type === "summarization_retry_finished"), { type: "summarization_retry_finished" });
  assert.equal(f.requests.find(request => request.phase === "summary").signal.aborted, true);
  assert.equal(ends(f)[0].result, undefined);
  assert.equal(compactions(f).length, 0);
});

test("cancelling one session's summary leaves an independent concurrent SDK session intact", testOptions, async t => {
  let entered, release, summarySignal;
  const first = await compactionFixture(t, {
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: async ({ signal }) => { summarySignal = signal; entered.resolve(); await release.promise; return response(); },
  });
  entered = first.hold(); release = first.hold();
  const running = first.session.prompt(prompt);
  await entered.promise;
  const second = await compactionFixture(t, { task: ({ index }) => index === 0
    ? response({ toolCallId: "independent-effect" }) : response() });
  first.session.abortCompaction();
  release.resolve();
  await Promise.all([running, second.session.prompt(prompt)]);
  assert.equal(summarySignal.aborted, true);
  assert.equal(compactions(first).length, 0);
  assert.deepEqual(await second.effects(), ["independent-effect"]);
  assert.equal(second.session.state.messages.at(-1).stopReason, "stop");
  assert.equal(second.requests.filter(request => request.phase === "task").length, 2);
});

test("Ling stop plus its runtime guard prevents a late summary from being installed after cancellation", testOptions, async t => {
  let entered, release, summarySignal;
  const caller = new AbortController();
  const boundary = createPiTaskBoundary({ signal: caller.signal });
  const f = await compactionFixture(t, {
    bindRuntime: runtime => boundary.bindModelRuntime(runtime),
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: async ({ signal }) => { summarySignal = signal; entered.resolve(); await release.promise; return response(); },
  });
  entered = f.hold(); release = f.hold();
  const running = f.session.prompt(prompt);
  await entered.promise;
  caller.abort();
  assert.equal(summarySignal.aborted, true);
  assert.throws(() => boundary.assertOpen(), { name: "AbortError" });
  const stopping = createPiSessionStopper(f.session)();
  await nextTick();
  release.resolve();
  await Promise.all([running, stopping]);
  await f.session.waitForIdle();
  assert.equal(compactions(f).length, 0);
});

test("Ling's stream guard does not cancel SDK-owned summary backoff; stop must also abort compaction", testOptions, async t => {
  let entered;
  const caller = new AbortController();
  const boundary = createPiTaskBoundary({ signal: caller.signal });
  const f = await compactionFixture(t, {
    bindRuntime: runtime => boundary.bindModelRuntime(runtime),
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 10_000, provider: { maxRetries: 0 } },
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: () => providerError("overloaded", 503),
    event: event => { if (event.type === "summarization_retry_scheduled") entered.resolve(); },
  });
  entered = f.hold();
  let settled = false;
  const running = f.session.prompt(prompt).then(() => { settled = true; });
  await entered.promise;
  caller.abort();
  await nextTick();
  assert.equal(settled, false, "SDK retry timer has its own controller, despite closed model admission");
  await Promise.all([running, createPiSessionStopper(f.session)()]);
  await f.session.waitForIdle();
  assert.equal(f.requests.filter(request => request.phase === "summary").length, 1);
  assert.equal(compactions(f).length, 0);
  assert.equal(f.events.filter(event => event.type === "summarization_retry_attempt_start").length, 0);
});

test("session stopping registers ownership before reentrant cleanup and preserves cleanup rejection", async () => {
  let stops = 0, compactionStops = 0, reentrant;
  const failure = new Error("synthetic stop failure");
  const stop = createPiSessionStopper({
    abortCompaction() { compactionStops++; reentrant = stop(); },
    async abort() { stops++; throw failure; },
  });
  const first = stop();
  const rejection = assert.rejects(first, error => error === failure);
  assert.equal(first, stop());
  assert.equal(compactionStops, 1, "cancellation is sent before returning, not delayed to a later microtask");
  assert.equal(stops, 1);
  await rejection;
  assert.equal(first, reentrant);
  assert.equal(compactionStops, 1);
  assert.equal(stops, 1);
});

test("a failed compaction cancellation still attempts to stop the agent and remains a failure", async () => {
  const failure = new Error("synthetic compaction cancellation failure");
  let agentStopped = false;
  const stop = createPiSessionStopper({
    abortCompaction() { throw failure; },
    async abort() { agentStopped = true; },
  });
  await assert.rejects(stop(), error => error === failure);
  assert.equal(agentStopped, true);
});

test("session stop waits for an uncooperative summary transport to actually settle", testOptions, async t => {
  let entered, release;
  const f = await compactionFixture(t, {
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: async () => { entered.resolve(); await release.promise; return response({ text: "Late summary" }); },
  });
  entered = f.hold(); release = f.hold();
  const running = f.session.prompt(prompt);
  await entered.promise;
  let stopped = false;
  const stopping = createPiSessionStopper(f.session)().then(() => { stopped = true; });
  await nextTick();
  assert.equal(stopped, false);
  release.resolve();
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
  assert.equal(f.session.isIdle, true);
  assert.equal(compactions(f).length, 0);
});

import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import test from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { compactionFixture, response } from "./support/pi-compaction-fixture.mjs";
import { createPiTaskBoundary, createPiSessionStopper } from "../dist/task-boundary.js";
import { translatePiEvent } from "../dist/events.js";

const testOptions = { timeout: 15_000 };
const prompt = "Finish the fixture and preserve all recorded effects. " + "goal ".repeat(100);
const compactions = f => f.sessionManager.getEntries().filter(entry => entry.type === "compaction");
const ends = f => f.events.filter(event => event.type === "compaction_end");
const providerError = (message, status = 400) => new Response(JSON.stringify({ error: { message,
  type: status === 503 ? "server_error" : "invalid_request_error" } }),
  { status, headers: { "content-type": "application/json" } });

function assertToolPairs(messages) {
  const callIds = new Set(messages.flatMap(message => message.role === "assistant"
    ? message.content.filter(block => block.type === "toolCall").map(block => block.id) : []));
  const results = messages.filter(message => message.role === "toolResult");
  const resultIds = new Set(results.map(result => result.toolCallId));
  for (const result of results) {
    assert.ok(callIds.has(result.toolCallId), "kept tool results must retain their calls");
  }
  for (const id of callIds) assert.ok(resultIds.has(id), "settled tool calls must retain their results");
}

test("SDK 1.1 keeps the preceding tool pair when a trailing result exceeds the recent-token budget", testOptions, async t => {
  const f = await compactionFixture(t, { task: ({ index }) => response({
    ...(index < 3 ? { toolCallId: "effect-" + index } : {}), inputTokens: index < 3 ? 1_850 : 100,
  }) });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["effect-0", "effect-1", "effect-2"]);
  assert.equal(ends(f).length, 3);
  const starts = f.events.flatMap((event, index) => event.type === "compaction_start" ? [index] : []);
  assert.equal(starts.length, 3);
  for (const [index, start] of starts.entries()) {
    const end = ends(f)[index];
    assert.equal(end.reason, "threshold");
    assert.equal(end.willRetry, false);
    assert.ok(end.result);
    const kept = f.sessionManager.getEntry(end.result.firstKeptEntryId);
    assert.equal(kept.type, "message");
    assert.equal(kept.message.role, "assistant", "never cut at the oversized tool result itself");
    assert.deepEqual(kept.message.content, [{ type: "toolCall", id: `effect-${index}`,
      name: "fixture_effect", arguments: {} }]);
    const before = f.events.slice(0, start);
    assert.equal(before.filter(event => event.type === "tool_execution_end").length, index + 1);
    assert.equal(before.filter(event => event.type === "turn_end").length, index + 1,
      "each compaction starts only after its current tool turn has settled");
  }
  const lastToolEnd = f.events.findLastIndex(event => event.type === "tool_execution_end");
  assert.ok(starts[0] < lastToolEnd, "a safe preceding tool call enables compaction during the loop");
  const taskRequests = f.requests.filter(request => request.phase === "task");
  assert.equal(taskRequests.length, 4);
  assert.equal(compactions(f).length, 3);
  for (const [index, request] of taskRequests.entries()) {
    assertToolPairs(request.messages);
    assertToolPairs(request.canonicalMessages);
    if (index > 0) {
      assert.ok(request.eventIndex > starts[index - 1]);
      assert.deepEqual(request.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId),
        [`effect-${index - 1}`], "the next request retains the complete newest pair, not older effects");
    }
  }
  await f.session.prompt("Continue without repeating effects.");
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["effect-0", "effect-1", "effect-2"]);
  const followup = f.requests.filter(request => request.phase === "task").at(-1);
  assertToolPairs(followup.messages);
  assert.equal(compactions(f).length, 3, "stale usage must not trigger compaction again on followup");
});

test("SDK can compact between tool turns when a safe cut point exists", testOptions, async t => {
  const installedViews = [];
  const f = await compactionFixture(t, {
    compaction: { keepRecentTokens: 200 },
    task: ({ index }) => response(index < 4
      ? { toolCallId: `effect-${index}`, inputTokens: 1_850 }
      : { text: "All effects complete.", inputTokens: 1_850 }),
    event: event => {
      if (event.type === "compaction_end" && event.result) {
        installedViews.push({ summary: event.result.summary,
          checkpoint: structuredClone(compactions(f).at(-1)),
          projection: structuredClone(f.sessionManager.buildSessionProjection().messages),
          messages: structuredClone(f.session.state.messages) });
      }
    },
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["effect-0", "effect-1", "effect-2", "effect-3"]);
  const firstCompaction = f.events.findIndex(event => event.type === "compaction_start");
  const lastToolEnd = f.events.findLastIndex(event => event.type === "tool_execution_end");
  assert.ok(firstCompaction > 0 && firstCompaction < lastToolEnd,
    "the first SDK compaction must occur while the tool loop is still active");
  assert.ok(f.requests.some((request, index) => request.phase === "summary"
    && f.requests.slice(index + 1).some(next => next.phase === "task")),
  "a task model request must follow a mid-run summary request");
  assert.ok(installedViews.length > 0);
  for (const installed of installedViews) {
    assert.deepEqual(installed.messages, installed.projection,
      "compaction_end observes the already-installed canonical journal projection");
    assert.equal(installed.messages[0].role, "system");
    assert.deepEqual(installed.messages[0], installed.checkpoint.systemMessage,
      "Pi 1.1 persists the leading system authority inside the compaction checkpoint");
    assert.equal(installed.messages[1].role, "compactionSummary");
    assert.equal(installed.messages[1].summary, installed.summary,
      "compaction_end observes the exact model view already installed by the SDK");
    assert.equal(installed.messages.filter(message => message.role === "compactionSummary").length, 1);
    assert.equal(getCurrentSystemPrompt(installed.messages), f.requests[0].systemPrompt);
    assert.deepEqual(getCurrentTools(installed.messages), f.requests[0].tools);
  }
  for (const request of f.requests.filter(item => item.phase === "task")) {
    assertToolPairs(request.messages);
    assertToolPairs(request.canonicalMessages);
    assert.equal(request.systemPrompt, f.requests[0].systemPrompt);
    assert.deepEqual(request.tools, f.requests[0].tools);
  }
});

test("Ling's disabled auto-compaction setting prevents SDK mid-run and post-run compaction", testOptions, async t => {
  const f = await compactionFixture(t, {
    compaction: { enabled: false, keepRecentTokens: 200 },
    task: ({ index }) => response(index < 4
      ? { toolCallId: `effect-${index}`, inputTokens: 1_850 }
      : { text: "All effects complete.", inputTokens: 1_850 }),
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.deepEqual(await f.effects(), ["effect-0", "effect-1", "effect-2", "effect-3"]);
  assert.equal(ends(f).length, 0);
  assert.equal(compactions(f).length, 0);
  assert.equal(f.requests.filter(request => request.phase === "summary").length, 0);
});

test("SDK may send another task request after a failed mid-run summary", testOptions, async t => {
  const f = await compactionFixture(t, {
    compaction: { keepRecentTokens: 200 },
    task: ({ index }) => response(index < 3
      ? { toolCallId: `effect-${index}`, inputTokens: 1_850 }
      : { text: "All effects complete.", inputTokens: 1_850 }),
    summary: () => providerError("PRIVATE_MID_RUN_SUMMARY_FAILURE"),
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  const failedSummary = f.requests.findIndex(request => request.phase === "summary");
  assert.ok(failedSummary >= 0);
  assert.equal(ends(f)[0].result, undefined);
  assert.ok(f.requests.slice(failedSummary + 1).some(request => request.phase === "task"),
    "Host must independently close provider admission when a required checkpoint fails");
  assert.deepEqual(await f.effects(), ["effect-0", "effect-1", "effect-2"]);
  assert.equal(compactions(f).length, 0);
});

test("a completed compacted SDK view cannot be blindly continued after restart", testOptions, async t => {
  const source = await compactionFixture(t, {
    task: ({ index }) => response(index === 0
      ? { toolCallId: "effect-before-checkpoint", inputTokens: 1_200 }
      : { text: "Completed before compaction. " + "history ".repeat(400), inputTokens: 1_850 }),
  });
  await source.session.prompt(prompt);
  await source.session.waitForIdle();
  assert.equal(compactions(source).length, 1);
  const compactedView = structuredClone(source.session.state.messages);
  assert.deepEqual(compactedView, source.sessionManager.buildSessionProjection().messages);
  assert.equal(compactedView[0].role, "system");
  assert.equal(compactedView[1].role, "compactionSummary");
  assert.equal(compactedView[1].summary, compactions(source)[0].summary);
  const restored = await compactionFixture(t, { compaction: { enabled: false },
    task: () => response({ text: "Continued from committed summary." }) });
  restored.session.state.messages = compactedView;
  assert.equal(compactedView.at(-1).role, "assistant");
  await assert.rejects(restored.session.agent.continue(), /Cannot continue from message role: assistant/u);
  assert.equal(restored.requests.filter(request => request.phase === "task").length, 0);
  assert.deepEqual(await restored.effects(), [], "recovery must not re-execute the prior tool call");
});

test("SDK lifecycle becomes bounded Runner evidence without publishing summary or provider error", testOptions, async t => {
  const successful = await compactionFixture(t, {
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: () => response({ text: "PRIVATE_SUMMARY_CONTENT" }),
  });
  await successful.session.prompt(prompt);
  await successful.session.waitForIdle();
  const translated = successful.events.map(translatePiEvent).filter(Boolean);
  const start = translated.find(event => event.type === "context_compaction_start");
  const end = translated.find(event => event.type === "context_compaction_end");
  assert.deepEqual(start, { type: "context_compaction_start", reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1" });
  assert.equal(end.outcome, "sdk_installed");
  assert.equal(end.reason, "threshold");
  assert.equal(end.willRetry, false);
  assert.ok(end.tokensBefore > 0);
  assert.ok(translated.some(event => event.type === "message_end" && event.usage?.input === 1_850));
  assert.equal(JSON.stringify([start, end]).includes("PRIVATE_SUMMARY_CONTENT"), false);

  const failed = await compactionFixture(t, {
    task: () => response({ inputTokens: 1_850, text: "Completed task. " + "text ".repeat(400) }),
    summary: () => providerError("PRIVATE_PROVIDER_DETAIL"),
  });
  await failed.session.prompt(prompt);
  await failed.session.waitForIdle();
  const failedEnd = failed.events.map(translatePiEvent).find(event => event?.type === "context_compaction_end");
  assert.equal(failedEnd.outcome, "failed");
  assert.equal(JSON.stringify(failedEnd).includes("PRIVATE_PROVIDER_DETAIL"), false);
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

test("SDK 1.1 abort cancels an automatic summary and waits for its uncooperative transport", testOptions, async t => {
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
  assert.equal(summarySignal.aborted, true);
  assert.equal(stopped, false, "session.abort must wait until the ignored cancellation actually settles");
  assert.equal(f.events.filter(event => event.type === "agent_settled").length, 0);
  release.resolve();
  await Promise.all([running, stopping]);
  assert.equal(compactions(f).length, 0);
  assert.equal(stopped, true);
  assert.equal(f.requests.filter(request => request.phase === "task").length, 1,
    "cancellation must not admit another task model request");
  assert.equal(f.requests.filter(request => request.phase === "summary").length, 1);
  assert.equal(f.session.isIdle, true);
  assert.equal(ends(f)[0].result, undefined);
  assert.equal(ends(f)[0].aborted, true);
  assert.equal(ends(f)[0].willRetry, false);
  assert.deepEqual(f.events.filter(event => event.type === "agent_settled"), [{ type: "agent_settled", aborted: true }]);
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

test("SDK 1.1 retry durably omits a failed response from canonical context without deleting journal evidence", testOptions, async t => {
  let originalFailure;
  const f = await compactionFixture(t, {
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } },
    task: ({ index }) => index === 0 ? response({ toolCallId: "effect-before-transient-failure" })
      : index === 1 ? providerError("PRIVATE_CANONICAL_FAILURE", 503) : response(),
    event: event => {
      if (event.type === "auto_retry_start") {
        originalFailure = structuredClone(f.sessionManager.getEntries().findLast(entry => entry.type === "message"
          && entry.message.role === "assistant" && entry.message.stopReason === "error"));
      }
    },
  });
  await f.session.prompt(prompt);
  await f.session.waitForIdle();
  assert.ok(originalFailure, "the failed assistant response is already durable before retry starts");
  assert.match(originalFailure.message.errorMessage, /PRIVATE_CANONICAL_FAILURE/);
  assert.deepEqual(f.sessionManager.getEntry(originalFailure.id), originalFailure,
    "retry must not mutate or delete the original failed journal entry");
  const omissions = f.sessionManager.getEntries().filter(entry => entry.type === "context_edit"
    && entry.targetId === originalFailure.id);
  assert.equal(omissions.length, 1);
  assert.equal(omissions[0].replacement, null, "the journal carries a durable omission, not an ephemeral state filter");
  const projectedFailure = f.sessionManager.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === originalFailure.id);
  assert.deepEqual(projectedFailure.sourceEntry, originalFailure);
  assert.deepEqual(projectedFailure.messages, [], "provenance remains visible but contributes no model context");
  const requests = f.requests.filter(request => request.phase === "task");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].canonicalMessages, requests[1].canonicalMessages,
    "retry preserves the pre-failure canonical user, tool call and completed result");
  assert.deepEqual(requests[2].messages, requests[1].messages);
  assertToolPairs(requests[2].canonicalMessages);
  assert.equal(JSON.stringify(requests[2].messages).includes("PRIVATE_CANONICAL_FAILURE"), false);
  assert.deepEqual(await f.effects(), ["effect-before-transient-failure"]);
  assert.equal(f.events.filter(event => event.type === "auto_retry_start").length, 1);
  assert.equal(f.events.find(event => event.type === "auto_retry_end").success, true);
  assert.equal(compactions(f).length, 0);
  f.session.refreshContext();
  assert.equal(f.session.state.messages.some(message => message.role === "assistant" && message.stopReason === "error"), false);
  await f.session.prompt("Follow up without repeating effects or restoring the failed response.");
  await f.session.waitForIdle();
  const followup = f.requests.filter(request => request.phase === "task").at(-1);
  assert.equal(JSON.stringify(followup.canonicalMessages).includes("PRIVATE_CANONICAL_FAILURE"), false,
    "a later canonical refresh must not resurrect the omitted failed attempt");
  assert.deepEqual(f.sessionManager.getEntry(originalFailure.id), originalFailure);
  assert.deepEqual(await f.effects(), ["effect-before-transient-failure"]);
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
  const failure = f.sessionManager.getEntries().find(entry => entry.type === "message"
    && entry.message.role === "assistant" && entry.message.stopReason === "error");
  assert.ok(failure, "SDK history retains the failed response");
  assert.ok(f.sessionManager.getEntries().some(entry => entry.type === "context_edit"
    && entry.targetId === failure.id && entry.replacement === null),
  "overflow recovery persists canonical omission before compaction and retry");
  assert.equal(retry.canonicalMessages.some(message => message.role === "assistant" && message.stopReason === "error"), false);
  const evidence = structuredClone(failure);
  f.session.refreshContext();
  assert.deepEqual(f.sessionManager.getEntry(failure.id), evidence);
  assert.equal(f.session.state.messages.some(message => message.role === "assistant" && message.stopReason === "error"), false);
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

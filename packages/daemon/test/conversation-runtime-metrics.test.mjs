import assert from "node:assert/strict";
import test from "node:test";
import { userInputTranscriptFixture as fixture, now } from "../../core/test/support/user-input-transcript-fixture.mjs";
import { DEFAULT_WORKSPACE_ID } from "@ling-stack/core";
import { buildConversationDetail } from "../dist/features/conversations/routes.js";
import { buildTeammateDirectTranscript } from "../dist/features/teammates/direct-transcript.js";
import { listChannelConversationItems } from "../dist/features/channels/channel-conversation-api.js";

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
});
function detail(f, surface, options = {}) {
  if (surface === "normal") return buildConversationDetail(f.store, f.cwd, f.thread, options);
  if (surface === "private") return buildTeammateDirectTranscript(f.store, f.participantId, options);
  return listChannelConversationItems({ store: f.store, cwd: f.cwd, channel: f.channel, thread: f.thread, ...options });
}
function append(f, events) {
  for (const [type, data] of events) f.store.appendEvent(f.run.id, type, data);
}
function addRun(f, { thread, id, measured, native = false, teammateId = f.participantId, channelId = f.channel?.id }) {
  const turn = f.store.appendConversationUserTurn({
    threadId: thread.id, ...(channelId ? { channelId } : {}), teammateId,
    title: id, userInstruction: id, idempotencyKey: id,
    payload: { body: id, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }, now);
  const unit = f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: id, idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now });
  const run = f.store.createRun({ id, cwd: f.cwd, taskId: `${id}-task`, threadId: thread.id, turnId: turn.turnId,
    ...(channelId ? { channelId } : {}), teammateId, workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  if (!native) f.store.appendEvent(run.id, "turn_start", {});
  f.store.appendEvent(run.id, "message_end", { role: "assistant", usage: measured });
  return { turn, run };
}

for (const surface of ["normal", "private", "channel"]) {
  test(`${surface} public detail reports measured tokens, tool steps and cache classes`, async t => {
    const f = await fixture(t, { surface });
    append(f, [
      ["turn_start", {}], ["tool_start", { toolName: "fixture" }],
      ["message_end", { role: "assistant", usage: usage(10, 20, 30, 40) }], ["turn_end", {}],
    ]);
    const metrics = detail(f, surface).runtimeMetrics;
    assert.equal(metrics.aiRounds, 1);
    assert.equal(metrics.toolSteps, 1);
    assert.deepEqual([metrics.inputTokens, metrics.outputTokens, metrics.cacheReadTokens,
      metrics.cacheWriteTokens, metrics.totalTokens], [10, 20, 30, 40, 100]);
    assert.equal(metrics.context.measuredInputTokens, 80);
    assert.equal(metrics.context.capacityTokens, null);
    assert.equal(metrics.context.basis, "measured");
    assert.equal(metrics.coverage, "partial", "running Run has an incomplete evidence window");
  });
  test(`${surface} public detail keeps unsupported runner measurements unknown`, async t => {
    const f = await fixture(t, { surface });
    append(f, [["assistant_text_delta", { text: "native output" }]]);
    const metrics = detail(f, surface).runtimeMetrics;
    assert.equal(metrics.aiRounds, null);
    assert.equal(metrics.toolSteps, null);
    assert.equal(metrics.totalTokens, null);
    assert.equal(metrics.recentReplyTokensPerSecond, null);
    assert.equal(metrics.context.measuredInputTokens, null);
    assert.equal(metrics.coverage, "partial");
  });
}

test("normal detail aggregates more than one event page without counting another owner", async t => {
  const f = await fixture(t);
  append(f, [["turn_start", {}]]);
  for (let i = 0; i < 1_002; i++) f.store.appendEvent(f.run.id, "assistant_text_delta", { text: "x" });
  append(f, [["tool_start", { toolName: "last-page" }], ["message_end", { role: "assistant", usage: usage(5, 7, 9, 11) }]]);
  const metrics = detail(f, "normal").runtimeMetrics;
  assert.equal(metrics.aiRounds, 1);
  assert.equal(metrics.toolSteps, 1);
  assert.equal(metrics.totalTokens, 32);
  const other = addRun(f, { thread: f.store.createLingThread({ kind: "conversation", teammateId: f.participantId,
    title: "Unrelated conversation", objective: "Separate owner" }, now), id: "other-normal", measured: usage(999, 999) });
  assert.equal(other.run.id, "other-normal");
  assert.equal(detail(f, "normal").runtimeMetrics.totalTokens, 32, "another Thread in the same store is excluded");
});

test("channel metrics span root and another discussion thread, regardless of selected item page", async t => {
  const f = await fixture(t, { surface: "channel" });
  append(f, [["turn_start", {}], ["message_end", { role: "assistant", usage: usage(5, 7) }]]);
  const secondThread = f.store.createLingThread({ kind: "channel_discussion", channelId: f.channel.id,
    teammateId: f.participantId, title: "Another discussion", objective: "Same channel" }, now);
  addRun(f, { thread: secondThread, id: "second-thread-run", measured: usage(11, 13) });
  const root = detail(f, "channel", { limit: 1 });
  const other = listChannelConversationItems({ store: f.store, cwd: f.cwd, channel: f.channel,
    thread: secondThread, limit: 1 });
  assert.equal(root.runtimeMetrics.totalTokens, 36);
  assert.equal(other.runtimeMetrics.totalTokens, 36);
  assert.equal(root.runtimeMetrics.aiRounds, 2);
  assert.equal(root.items.length, 1);
  assert.equal(other.items.length, 1);
  const unrelated = f.store.createChannel({ name: "Unrelated channel", boundPath: f.cwd }, now);
  const unrelatedThread = f.store.createLingThread({ kind: "channel_discussion", channelId: unrelated.id,
    teammateId: f.participantId, title: "Other channel", objective: "Other channel" }, now);
  addRun(f, { thread: unrelatedThread, id: "unrelated-channel-run", channelId: unrelated.id, measured: usage(999, 999) });
  assert.equal(detail(f, "channel", { limit: 1 }).runtimeMetrics.totalTokens, 36);
});

test("channel detail excludes superseded source turns from metrics", async t => {
  const f = await fixture(t, { surface: "channel" });
  append(f, [["turn_start", {}], ["message_end", { role: "assistant", usage: usage(100, 100) }]]);
  f.store.commitConversationMessageEdit({
    surface: "channel_root", ownerId: f.channel.id, laneId: f.thread.id, messageId: f.turn.item.id,
    expectedRevision: 1, current: f.turn.item.payload, replacement: { ...f.turn.item.payload, body: "changed" },
    sourceTurnId: f.turn.turnId, supersededTurnId: f.turn.turnId, supersededRunIds: [f.run.id],
    supersededResponseMessageIds: [], idempotencyKey: "metrics-channel-superseded",
  }, now);
  assert.equal(detail(f, "channel").runtimeMetrics.totalTokens, null);
});

test("private detail excludes superseded source turns from metrics", async t => {
  const f = await fixture(t, { surface: "private" });
  append(f, [["turn_start", {}], ["message_end", { role: "assistant", usage: usage(100, 100) }]]);
  f.store.commitConversationMessageEdit({
    surface: "teammate_direct", ownerId: f.participantId, laneId: f.directThread.id, messageId: f.turn.item.id,
    expectedRevision: 1, current: f.turn.item.payload, replacement: { ...f.turn.item.payload, body: "changed" },
    sourceTurnId: f.turn.turnId, supersededTurnId: f.turn.turnId, supersededRunIds: [f.run.id],
    supersededResponseMessageIds: [], idempotencyKey: "metrics-private-superseded",
  }, now);
  assert.equal(detail(f, "private").runtimeMetrics.totalTokens, null);
});

test("mixed native lifecycle gaps do not claim exact AI/tool totals", async t => {
  const f = await fixture(t);
  append(f, [["turn_start", {}], ["tool_start", { toolName: "fixture" }],
    ["message_end", { role: "assistant", usage: usage(1, 2) }]]);
  addRun(f, { thread: f.thread, id: "native-gap-run", native: true, measured: usage(3, 4) });
  f.store.appendEvent("native-gap-run", "assistant_text_delta", { text: "native-only continuation" });
  const metrics = detail(f, "normal").runtimeMetrics;
  assert.equal(metrics.aiRounds, null);
  assert.equal(metrics.toolSteps, null);
  assert.equal(metrics.totalTokens, 10);
  assert.equal(metrics.coverage, "partial");
});

test("normal detail includes compaction invocation usage but labels post-compaction context estimated", async t => {
  const f = await fixture(t);
  append(f, [
    ["turn_start", {}], ["message_end", { role: "assistant", usage: usage(8, 12, 20, 4) }],
    ["context_compaction_start", { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1" }],
    ["context_compaction_end", { reason: "threshold", policyVersion: "pi_sdk_lifecycle_v1", outcome: "sdk_installed",
      willRetry: false, estimatedTokensAfter: 22, usage: usage(3, 5, 7, 2) }],
  ]);
  const metrics = detail(f, "normal").runtimeMetrics;
  assert.deepEqual([metrics.inputTokens, metrics.outputTokens, metrics.cacheReadTokens,
    metrics.cacheWriteTokens, metrics.totalTokens], [11, 17, 27, 6, 61]);
  assert.equal(metrics.context.basis, "estimated");
  assert.equal(metrics.context.estimatedTokens, 22);
  assert.equal(metrics.context.measuredInputTokens, null);
});

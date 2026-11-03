import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { startRealPiChannelFixture, systemText } from "./support/channel-operation-real-pi-fixture.mjs";

// Regression: C01-R7 — invalid selector output must not become a tool-free reply.
// Found by /qa on 2026-10-25
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/r7-routing-investigation.md
const code = "channel_intent_selection_failed";
const malformed = '{"action":"execute","reason":"Engineer writes, QA verifies","execution":{"schemaVersion":2,"operations":[{]}}';

async function fixture(t, outputs, body = "Engineer 新增 check.test.js 并测试，QA 独立验证后新增 audit.md；两名都是 required。") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-intent-output-failure-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const provider = store.createProviderPreset({ kind: "glm", displayName: "Static intent failure fixture",
    providerId: "static", model: "static", api: "google-generative-ai", capabilities: ["chat"],
    input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "Synthetic only; no model request" });
  const channel = store.createChannel({ name: "Intent failure", boundPath: cwd,
    defaultProviderPresetId: provider.id, allowedTools: ["read", "write", "bash"] }, now);
  for (const id of ["teammate_builtin_engineer", "teammate_builtin_qa"]) {
    store.replaceTeammateChannelMemberships(id, [{ channelId: channel.id }], now);
  }
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user",
    body }, now);
  const prompts = [];
  return {
    get store() { return store; }, channel, source, prompts,
    reopen() { store.close(); store = createSqliteRunStore(cwd); },
    select() {
      return selectChannelWorkflowIntent({ store, channel, sourceMessage: source,
        secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
        runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async request => {
          assert.deepEqual(request.tools, []);
          prompts.push(request.task.prompt);
          const output = outputs[Math.min(prompts.length - 1, outputs.length - 1)];
          if (output instanceof Error) throw output;
          request.onEvent({ type: "assistant_text_delta", text: typeof output === "string" ? output : JSON.stringify(output) });
          return { messages: [] };
        } } } }) } });
    },
  };
}
function assertNoExecution(f) {
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
  assert.deepEqual(f.store.getChannel(f.channel.id).allowedTools, ["read", "write", "bash"]);
}

test("invalid JSON gets one format repair, without a tool call or an ordinary-reply fallback", async t => {
  const f = await fixture(t, [malformed, { action: "reply", reason: "The corrected intent is discussion only" }]);
  const result = await f.select();
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1], /strict JSON/u);
  assert.equal(result.action, "continue");
  const decision = f.store.listChannelIntentDecisions({ sourceItemId: f.source.id })[0];
  assert.equal(decision.createdBy, "model_policy");
  assert.equal(decision.reason, "The corrected intent is discussion only");
  assertNoExecution(f);
});

test("format repair cannot add a third binding repair or admit an invalid graph", async t => {
  const f = await fixture(t, [malformed, { action: "execute", reason: "Still invalid graph",
    execution: { schemaVersion: 2, operations: [] } }]);
  const result = await f.select();
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, "channel_operation_plan_invalid");
  assert.equal(f.prompts.length, 2);
  assertNoExecution(f);
});

for (const [label, output, action] of [
  ["bad JSON", malformed, "blocked"],
  ["invalid binding", { action: "execute", reason: "Still invalid graph",
    execution: { schemaVersion: 2, operations: [] } }, "blocked"],
  ["valid reply", { action: "reply", reason: "Discussion only" }, "continue"],
]) test(`context compaction retry shares the two-call limit with ${label}`, async t => {
  const f = await fixture(t, [new Error("maximum context length exceeded"), output]);
  const result = await f.select();
  assert.equal(f.prompts.length, 2, "compaction, format and binding repairs must share the same retry allowance");
  assert.equal(result.action, action);
  assertNoExecution(f);
});

for (const proposal of [false, true]) test(`Host ${proposal ? "proposal" : "reply"} decision write failure is not a model selection failure`, async t => {
  const body = "Engineer 创建 result.txt，内容是“状态回归”。";
  const output = proposal ? { action: "execute", reason: "Create the source-bound file", execution: {
    schemaVersion: 2, operations: [{ id: "create_result", kind: "file_create", targetKind: "file", required: true,
      dependsOn: [], sourceQuote: body, owner: { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" },
      target: { path: "result.txt", sourceQuote: "result.txt" },
      contentSource: { kind: "literal", text: "状态回归", sourceQuote: "“状态回归”" } }],
  } } : { action: "reply", reason: "Discussion only" };
  const f = await fixture(t, [output], body);
  const original = f.store.createChannelIntentDecision.bind(f.store);
  const failure = new Error("injected accepted-decision write failure");
  f.store.createChannelIntentDecision = (input, ...rest) => {
    if (input.status === "accepted") throw failure;
    return original(input, ...rest);
  };
  await assert.rejects(f.select(), error => error === failure);
  f.store.createChannelIntentDecision = original;
  const source = f.store.getConversationItem(f.source.id);
  assert.equal(f.store.getConversationItemByIdempotencyKey(source.threadId, `channel-intent-selection-blocker:${source.id}`), undefined);
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: source.id }).length, 0);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, proposal ? 1 : 0);
  if (proposal) {
    f.reopen();
    const result = await f.select();
    assert.equal(result.action, "blocked");
    assert.equal(result.errorCode, "existing_proposal_participant_lineage_invalid");
    assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 1);
    assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  }
});

test("partial diagnostic publication recovers from its committed item without reclassification", async t => {
  const f = await fixture(t, [malformed]);
  const original = f.store.createChannelIntentDecision.bind(f.store);
  f.store.createChannelIntentDecision = () => { throw new Error("injected decision write failure"); };
  await assert.rejects(f.select(), /Could not persist/);
  f.store.createChannelIntentDecision = original;
  const source = f.store.getConversationItem(f.source.id);
  const item = f.store.getConversationItemByIdempotencyKey(source.threadId, `channel-intent-selection-blocker:${source.id}`);
  assert.equal(item.payload.deliveryStatus, "blocked");
  f.reopen();
  const result = await f.select();
  assert.equal(result.action, "blocked");
  assert.equal(result.aiReply.id, item.id);
  assert.equal(f.prompts.length, 2);
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.source.id }).length, 1);
  assertNoExecution(f);
});

test("concurrent failed selectors publish one source-owned diagnostic", async t => {
  const f = await fixture(t, [malformed]);
  const [first, second] = await Promise.all([f.select(), f.select()]);
  assert.equal(first.action, "blocked");
  assert.deepEqual(second, first);
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.source.id }).length, 1);
  assertNoExecution(f);
});

test("real Pi HTTP/SSE returns blocked after format exhaustion, never a tool-free reply", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-intent-output-transport-"));
  const daemon = await startRealPiChannelFixture(cwd, request => {
    assert.match(systemText(request), /channel intent selector/i, "an ordinary-reply model must never run after format exhaustion");
    return { text: malformed };
  });
  t.after(async () => { await daemon.close(); await rm(cwd, { recursive: true, force: true }); });
  const scope = `cwd=${encodeURIComponent(cwd)}`;
  const post = async (path, payload) => {
    const response = await fetch(`${daemon.url}${path}?${scope}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  };
  const provider = (await post("/providers", { kind: "glm", displayName: "Loopback intent failure",
    ...daemon.providerOverrides, input: ["text"], authHeader: false, enabled: true })).provider;
  daemon.store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: new Date().toISOString(), message: "Local SSE fixture" });
  const channel = (await post("/channels", { name: "Failed intent transports", boundPath: cwd, status: "active",
    defaultProviderPresetId: provider.id, autoReplyMode: "mentions_only", allowedTools: ["read", "write", "bash"] })).channel;
  const request = { body: "Engineer 新增测试，QA 独立验证。", requestAiReply: true,
    teammateId: "ling_agent", idempotencyKey: "intent-failure-http" };
  const first = await post(`/channels/${channel.id}/turns`, request);
  assert.equal(first.assistantItems.length, 1);
  assert.equal(first.turn.status, "blocked");
  assert.equal(first.assistantItems[0].payload.deliveryStatus, "blocked");
  assert.equal(first.assistantItems[0].payload.errorMessage, code);
  assert.equal(first.autoStartedWorkflow, undefined);
  const replay = await post(`/channels/${channel.id}/turns`, request);
  assert.equal(replay.assistantItems[0].id, first.assistantItems[0].id);
  assert.equal(daemon.selectorRequests.length, 2);
  const stream = await fetch(`${daemon.url}/channels/${channel.id}/turns/stream?${scope}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, idempotencyKey: "intent-failure-sse" }) });
  assert.equal(stream.ok, true);
  const raw = await stream.text();
  const events = raw.split(/\r?\n\r?\n/).filter(block => block.startsWith("event:")).map(block => {
    const lines = block.split(/\r?\n/);
    return { event: lines[0].slice(6).trim(), data: JSON.parse(lines.find(line => line.startsWith("data:")).slice(5)) };
  });
  assert.equal(events.at(-1).event, "blocked", raw);
  assert.equal(events.at(-1).data.assistantItems[0].payload.errorMessage, code);
  assert.equal(daemon.selectorRequests.length, 4);
  assertNoExecution({ store: daemon.store, channel });
});

for (const [label, outputs, expectedCalls] of [
  ["repeated invalid JSON", [malformed], 2],
  ["repeated invalid schema", [{ action: "execute", reason: "", execution: {} }], 2],
  ["transport failure", [new Error("fixture disconnected")], 1],
  ["failed repair transport", [malformed, new Error("fixture disconnected")], 2],
]) test(`${label} yields a durable failed diagnostic, not an accepted ordinary reply`, async t => {
  const f = await fixture(t, outputs);
  const first = await f.select();
  assert.equal(first.action, "blocked");
  assert.equal(first.errorCode, code);
  assert.equal(first.aiReply.status, "blocked");
  assert.equal(first.aiReply.errorMessage, code);
  assert.match(first.aiReply.body, /未.*执行|未.*启动/u);
  assert.doesNotMatch(first.aiReply.body, /fixture disconnected|Expected.*JSON|没有.*工具/u);
  const decision = f.store.getChannelIntentDecision(first.intentDecisionId);
  assert.equal(decision.status, "failed");
  assert.equal(decision.execution, undefined);
  assert.deepEqual(decision.resultItemIds, [first.aiReply.id]);
  f.reopen();
  assert.deepEqual(await f.select(), first);
  assert.equal(f.prompts.length, expectedCalls, "restart/replay cannot trigger model retry or a fresh reply");
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.source.id }).length, 1);
  assertNoExecution(f);
});

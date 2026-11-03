import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { startRealPiChannelFixture, systemText } from "./support/channel-operation-real-pi-fixture.mjs";

const code = "operation_binding_host_capability_unavailable";
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-open-blocker-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const provider = store.createProviderPreset({ kind: "glm", displayName: "Local static selector", providerId: "static", model: "static",
    api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "No model or Host opener is invoked" });
  const channel = store.createChannel({ name: "Unavailable Host capability", boundPath: cwd, defaultProviderPresetId: provider.id,
    defaultTeammateId: "teammate_builtin_engineer", allowedTools: ["read", "write", "bash"] }, now);
  store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "请展示 index.html。" }, now);
  const execution = { schemaVersion: 2, operations: [{ id: "open_target", kind: "open_local_target", targetKind: "file",
    required: true, dependsOn: [], owner: { kind: "host_default" }, sourceQuote: source.body,
    target: { path: "index.html", sourceQuote: "index.html" } }] };
  let modelCalls = 0;
  return {
    get store() { return store; }, channel, source, execution,
    get modelCalls() { return modelCalls; },
    reopen() { store.close(); store = createSqliteRunStore(cwd); },
    select() {
      return selectChannelWorkflowIntent({ store, channel, sourceMessage: source,
        secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
        runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async (options) => {
          modelCalls += 1; assert.deepEqual(options.tools, []);
          options.onEvent({ type: "assistant_text_delta", text: JSON.stringify({ action: "execute", reason: "Show the requested file", execution }) });
          return { messages: [] };
        } } } }) } });
    },
  };
}
function assertNoExecution(f) {
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
}
test("real Pi and HTTP/SSE expose one blocked source turn, with no tool execution or ready success", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-host-open-transport-"));
  const body = "请展示 index.html。";
  const daemon = await startRealPiChannelFixture(cwd, (request) => {
    assert.match(systemText(request), /channel intent selector/i, "no execution or ordinary-reply model call may follow a Host blocker");
    return { text: JSON.stringify({ action: "execute", reason: "Show the requested file", execution: { schemaVersion: 2,
      operations: [{ id: "open_target", kind: "open_local_target", targetKind: "file", required: true, dependsOn: [],
        owner: { kind: "host_default" }, sourceQuote: body, target: { path: "index.html", sourceQuote: "index.html" } }] } }) };
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
  const provider = (await post("/providers", { kind: "glm", displayName: "Local transport fixture", ...daemon.providerOverrides,
    input: ["text"], authHeader: false, enabled: true })).provider;
  daemon.store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: new Date().toISOString(), message: "Local SSE fixture" });
  const channel = (await post("/channels", { name: "Host blocker transports", boundPath: cwd, status: "active",
    defaultProviderPresetId: provider.id, autoReplyMode: "mentions_only", allowedTools: ["read", "bash"] })).channel;
  const request = { body, requestAiReply: true, teammateId: "ling_agent", idempotencyKey: "host-open-http" };
  const first = await post(`/channels/${channel.id}/turns`, request);
  assert.equal(first.assistantItems?.length, 1, JSON.stringify(first));
  assert.equal(first.assistantItems[0].payload.deliveryStatus, "blocked");
  assert.equal(first.assistantItems[0].payload.errorMessage, code);
  assert.equal(first.turn.status, "blocked");
  assert.equal(first.autoStartedWorkflow, undefined);
  const replay = await post(`/channels/${channel.id}/turns`, request);
  assert.equal(replay.assistantItems[0].id, first.assistantItems[0].id);
  assert.equal(daemon.selectorRequests.length, 1);
  const response = await fetch(`${daemon.url}/channels/${channel.id}/turns/stream?${scope}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, idempotencyKey: "host-open-sse" }) });
  assert.equal(response.ok, true);
  const raw = await response.text();
  const events = raw.split(/\r?\n\r?\n/).filter((block) => block.startsWith("event:")).map((block) => {
    const lines = block.split(/\r?\n/);
    return { event: lines[0].slice(6).trim(), data: JSON.parse(lines.find((line) => line.startsWith("data:")).slice(5)) };
  });
  assert.equal(events.at(-1).event, "blocked", raw);
  assert.equal(events.at(-1).data.assistantItems[0].payload.errorMessage, code);
  assert.equal(daemon.selectorRequests.length, 2);
  for (const created of [first, events.at(-1).data]) {
    const source = daemon.store.getConversationItem(created.userItem.id);
    assert.equal(daemon.store.getLingTurn(source.turnId).status, "blocked");
  }
  assertNoExecution({ store: daemon.store, channel });
});
test("unavailable Host open is a durable blocked result, never a ready clarification or a bash plan", async (t) => {
  const f = await fixture(t);
  const result = await f.select();
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, code);
  assert.equal(result.aiReply.status, "blocked");
  assert.equal(result.aiReply.errorMessage, code);
  assert.doesNotMatch(result.aiReply.body, /请确认每项操作|内容要求|请补充.*文件/);
  const decision = f.store.getChannelIntentDecision(result.intentDecisionId);
  assert.equal(decision.action, "reply", "failed diagnostic cannot contain a fabricated executable plan");
  assert.equal(decision.status, "failed");
  assert.equal(decision.errorCode, code);
  assert.equal(decision.clarification, undefined);
  assert.equal(decision.execution, undefined);
  assert.deepEqual(decision.resultItemIds, [result.aiReply.id]);
  const item = f.store.getConversationItem(result.aiReply.id);
  assert.equal(item.turnId, f.store.getConversationItem(f.source.id).turnId);
  assertNoExecution(f);
});
for (const reopen of [false, true]) test(`Host capability blocker replays without another model or effect after ${reopen ? "restart" : "duplicate dispatch"}`, async (t) => {
  const f = await fixture(t);
  const first = await f.select();
  assert.equal(first.action, "blocked");
  if (reopen) f.reopen();
  const second = await f.select();
  assert.deepEqual(second, first);
  assert.equal(f.modelCalls, 1);
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.source.id }).length, 1);
  assertNoExecution(f);
});
test("a failed decision write cannot fail open, and restart repairs the committed blocker without reclassifying", async (t) => {
  const f = await fixture(t);
  const create = f.store.createChannelIntentDecision.bind(f.store);
  f.store.createChannelIntentDecision = () => { throw new Error("injected decision write failure"); };
  await assert.rejects(f.select(), /Could not persist the Host capability blocker/);
  f.store.createChannelIntentDecision = create;
  const source = f.store.getConversationItem(f.source.id);
  const before = f.store.getConversationItemByIdempotencyKey(source.threadId, `channel-operation-capability-blocker:${source.id}`);
  assert.equal(before.payload.deliveryStatus, "blocked");
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: source.id }).length, 0);
  f.reopen();
  const recovered = await f.select();
  assert.equal(recovered.action, "blocked");
  assert.equal(recovered.aiReply.id, before.id);
  assert.equal(f.modelCalls, 1);
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: source.id }).length, 1);
  assertNoExecution(f);
});
test("concurrent duplicate selector responses publish one blocker and one failed decision", async (t) => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.select(), f.select()]);
  assert.equal(first.action, "blocked");
  assert.deepEqual(first, second);
  assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.source.id }).length, 1);
  assertNoExecution(f);
});
test("a blocker is scoped to its source turn, not every later request in the channel", async (t) => {
  const f = await fixture(t);
  await f.select();
  const next = appendChannelItemFixture(f.store, { channelId: f.channel.id, threadId: f.source.threadId,
    authorType: "local-user", body: "先只解释 HTML，不操作文件。" }, new Date().toISOString());
  let calls = 0;
  const result = await selectChannelWorkflowIntent({ store: f.store, channel: f.channel, sourceMessage: next,
    secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
    runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async (options) => {
      calls += 1; options.onEvent({ type: "assistant_text_delta", text: JSON.stringify({ action: "reply", reason: "Discuss only" }) });
      return { messages: [] };
    } } } }) } });
  assert.equal(result.action, "continue");
  assert.equal(calls, 1);
  assertNoExecution(f);
});
for (const [name, mutate] of [
  ["unquoted target", (op) => { op.target.path = "other.html"; }],
  ["unbound source", (op) => { op.sourceQuote = "invented instruction"; }],
  ["invalid dependency", (op) => { op.dependsOn = ["missing"]; }],
]) test(`invalid ${name} is still rejected as binding failure before capability classification`, async (t) => {
  const f = await fixture(t); mutate(f.execution.operations[0]);
  const result = await f.select();
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, "channel_operation_plan_invalid");
  const decision = f.store.getChannelIntentDecision(result.intentDecisionId);
  assert.equal(decision.status, "failed");
  assert.equal(decision.errorCode, "channel_operation_plan_invalid");
  assert.notEqual(decision.errorCode, code);
  assert.equal(decision.execution, undefined);
  assertNoExecution(f);
});

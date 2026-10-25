import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { createDaemonServer } from "../dist/index.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

async function fixture(t, clarification, body = "请组织 Engineer 与 QA 协作验收项目，缺少实际输入时先询问，不要执行。") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-intent-clarification-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-23T00:00:00.000Z";
  const provider = store.createProviderPreset({ kind: "glm", displayName: "Clarification fixture", providerId: "static", model: "static",
    api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "Synthetic only; no network" });
  const channel = store.createChannel({ name: "Clarification", boundPath: cwd, defaultProviderPresetId: provider.id,
    allowedTools: ["read", "write", "bash"] }, now);
  for (const id of ["teammate_builtin_engineer", "teammate_builtin_qa"]) {
    store.replaceTeammateChannelMemberships(id, [{ channelId: channel.id }], now);
  }
  const sourceMessage = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body }, now);
  let calls = 0;
  const input = { store, channel, sourceMessage, secretResolver: createCompositeSecretResolver({ env: {} }),
    config: { channels: { intentSelector: true } },
    runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async (request) => {
      calls += 1;
      assert.deepEqual(request.tools, []);
      request.onEvent({ type: "assistant_text_delta", text: JSON.stringify({ action: "clarify", reason: "Missing product decision", clarification }) });
      return { messages: [] };
    } } } }) } };
  return { store, channel, input, calls: () => calls };
}

for (const [label, clarification] of [
  ["Chinese input paths with a camelCase audit key", { missingFields: ["originalInputPaths"], question: "请提供原始输入文件的工作区路径。" }],
  ["Chinese CLI question with a camelCase audit key", { missingFields: ["qaCliCommand"], question: "QA 应运行哪条验收命令？" }],
  ["localized known product field", { missingFields: ["acceptance_criteria"], question: "Quels sont les critères de réussite ?" }],
  ["audit data that is not a regular expression", { missingFields: ["input["], question: "Which input should the review use?" }],
]) {
  test(`model clarification preserves ${label} without an ordinary reply or execution`, async t => {
    const f = await fixture(t, clarification);
    const first = await selectChannelWorkflowIntent(f.input);
    assert.equal(first.action, "clarify");
    assert.equal(first.aiReply.body, clarification.question);
    const decision = f.store.listChannelIntentDecisions({ sourceItemId: f.input.sourceMessage.id, limit: 10 })[0];
    assert.equal(decision.action, "clarify");
    assert.equal(decision.createdBy, "model_policy");
    assert.deepEqual(decision.clarification, clarification);
    const replay = await selectChannelWorkflowIntent(f.input);
    assert.equal(replay.action, "clarify");
    assert.equal(replay.aiReply.id, first.aiReply.id);
    assert.equal(replay.intentDecisionId, first.intentDecisionId);
    assert.equal(f.calls(), 1, "replay must not reclassify or duplicate the question");
    assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.input.sourceMessage.id, limit: 10 }).length, 1);
    assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id, limit: 10 }), []);
    assert.equal(f.store.listRuns({ channelId: f.channel.id, limit: 10 }).length, 0);
    assert.equal(f.store.listTasks({ channelId: f.channel.id, limit: 10 }).length, 0);
    assert.deepEqual(f.store.getChannel(f.channel.id).allowedTools, ["read", "write", "bash"]);
  });
}

for (const clarification of [
  { missingFields: [], question: "Which input?" },
  { missingFields: ["input"], question: "  " },
  { missingFields: ["input", " input "], question: "Which input?" },
  { missingFields: ["input"], question: "Which input?", execution: {} },
]) {
  test(`malformed clarification remains non-executable: ${JSON.stringify(clarification)}`, async t => {
    const f = await fixture(t, clarification);
    assert.equal((await selectChannelWorkflowIntent(f.input)).action, "blocked");
    const decision = f.store.listChannelIntentDecisions({ sourceItemId: f.input.sourceMessage.id, limit: 10 })[0];
    assert.equal(decision.action, "reply");
    assert.equal(decision.status, "failed");
    assert.equal(decision.errorCode, "channel_intent_selection_failed");
    assert.equal(f.calls(), 2, "malformed clarification receives only one format repair");
    assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id, limit: 10 }), []);
  });
}

test("content-only turn still cannot be redirected to a local target clarification", async t => {
  const f = await fixture(t, { missingFields: ["target"], question: "要保存到哪个文件？" }, "请解释一下什么是递归，不需要任何本地操作。");
  assert.equal((await selectChannelWorkflowIntent(f.input)).action, "continue");
  const decision = f.store.listChannelIntentDecisions({ sourceItemId: f.input.sourceMessage.id, limit: 10 })[0];
  assert.equal(decision.action, "reply");
  assert.match(decision.reason, /independently answerable content turn/);
  assert.equal(f.store.listRuns({ channelId: f.channel.id, limit: 10 }).length, 0);
});

test("HTTP channel turn delivers localized clarification without starting a reply Run or workflow", async t => {
  const question = "QA 应运行哪条验收命令？";
  const f = await fixture(t, { missingFields: ["qaCliCommand"], question });
  let intentCalls = 0;
  class ClarificationOnlyRunner extends ToolFreePiRunner {
    async runTask(options) {
      return super.runTask(options, () => {
        if (/context segmentation policy proposer/i.test(options.systemPrompt ?? "")) {
          return JSON.stringify({ action: "uncertain", candidateSegmentIds: [] });
        }
        assert.match(options.systemPrompt, /channel intent selector/);
        intentCalls += 1;
        return JSON.stringify({ action: "clarify", reason: "QA needs a user decision",
          clarification: { missingFields: ["qaCliCommand"], question } });
      });
    }
  }
  const cwd = f.store.paths.cwd;
  const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, host: "127.0.0.1", port: 0,
    channels: { intentSelector: true } }, { storeFactory: () => f.store, runner: new ClarificationOnlyRunner() });
  try {
    await daemon.start();
    const address = daemon.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/channels/${f.channel.id}/turns?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "请组织 Engineer 和 QA 协作验收，缺少原始输入或验收命令请先询问。",
        requestAiReply: true }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.assistantItems.length, 1, JSON.stringify(body));
    assert.equal(body.assistantItems[0].payload.body, question);
    assert.equal(body.assistantItems[0].status, "committed");
    assert.equal(body.assistantItems[0].turnId, body.turn.id);
    assert.equal(intentCalls, 1);
    assert.equal(f.store.listRuns({ channelId: f.channel.id, limit: 10 }).length, 0);
    assert.equal(f.store.listTasks({ channelId: f.channel.id, limit: 10 }).length, 0);
    assert.equal(f.store.listChannelWorkflows({ channelId: f.channel.id, limit: 10 }).length, 0);
    assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id, limit: 10 }).length, 0);
  } finally {
    await daemon.stop();
  }
});

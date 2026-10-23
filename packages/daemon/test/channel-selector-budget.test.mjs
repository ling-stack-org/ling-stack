import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { routeChannelMessageReply } from "../dist/features/channels/channel-message-router.js";
import { compactChannelDiscussionForNoToolsRetry } from "../dist/features/channels/context-compaction.js";
import { buildChannelIntentSelectorContextPack, estimateTextTokens, renderContextPack } from "../dist/features/channels/context-packs.js";

const now = "2026-10-23T00:00:00.000Z";
function setBudget(f, fields) {
  f.store.updateProviderPreset(f.provider.id, fields, now);
  f.store.recordProviderCheckResult(f.provider.id, { ok: true, checkedAt: now, message: "No network fixture" });
}
async function fixture(t, handler, tokenFields = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-selector-budget-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const provider = store.createProviderPreset({ kind: "glm", providerId: "static", model: "static",
    displayName: "Synthetic budget test", api: "google-generative-ai", capabilities: ["chat"],
    input: ["text"], authHeader: false, enabled: true, ...tokenFields }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "No network fixture" });
  const channel = store.createChannel({ name: "Budget", boundPath: cwd, defaultProviderPresetId: provider.id,
    autoReplyMode: "auto_route", allowedTools: ["read", "write", "bash"] }, now);
  store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
  const sourceMessage = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user",
    body: "请解释递归，不需要执行命令或写文件。" }, now);
  const requests = [];
  const input = { store, channel, sourceMessage, secretResolver: createCompositeSecretResolver({ env: {} }),
    config: { channels: { intentSelector: true, autoRoute: true } },
    runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async request => {
      requests.push(request);
      const output = await handler(request, requests.length);
      request.onEvent({ type: "assistant_text_delta", text: JSON.stringify(output) });
      return { messages: [] };
    } } } }) } };
  return { store, provider, channel, input, requests };
}

for (const [label, run] of [["intent", selectChannelWorkflowIntent], ["auto-route", routeChannelMessageReply]]) {
  test(`${label} does not invoke an adapter with an exhausted output reservation`, async t => {
    const f = await fixture(t, () => ({ action: "reply", reason: "synthetic", confidence: 1 }),
      { contextWindow: 8192, maxTokens: 8192 });
    await run(f.input);
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.listRuns({ channelId: f.channel.id, limit: 10 }).length, 0);
  });

  test(`${label} checks a rebuilt retry budget after provider capacity changes`, async t => {
    let f;
    f = await fixture(t, () => {
      setBudget(f, { contextWindow: 1024, maxTokens: 512 });
      throw new Error("context_length exceeded by synthetic adapter");
    }, { contextWindow: 32768, maxTokens: 1024 });
    await run(f.input);
    assert.equal(f.requests.length, 1, "retry must be blocked before a second model invocation");
  });
}

test("intent admission counts rendered system text and headings beyond pack section estimates", async t => {
  const f = await fixture(t, () => ({ action: "reply", reason: "synthetic" }),
    { contextWindow: 32768, maxTokens: 1024 });
  const packInput = { ...f.input, providerPresetId: f.provider.id };
  const pack = buildChannelIntentSelectorContextPack(packInput);
  setBudget(f, { contextWindow: pack.estimatedInputTokens + 1024 + 512 });
  const tightPack = buildChannelIntentSelectorContextPack(packInput);
  assert.equal(tightPack.overBudget, false, "section-only estimate fits this fixture");
  assert.ok(estimateTextTokens(renderContextPack(tightPack))
    + estimateTextTokens("You are Ling's channel intent selector. Return strict JSON only.") > tightPack.budget.inputBudgetTokens);
  await selectChannelWorkflowIntent(f.input);
  assert.equal(f.requests.length, 0, "actual rendered request must also fit");
});

test("intent graph-repair prompt must pass admission independently of the first prompt", async t => {
  const f = await fixture(t, () => ({ action: "execute", reason: "synthetic invalid graph",
    execution: { schemaVersion: 2, operations: [] } }), { contextWindow: 32768, maxTokens: 1024 });
  const pack = buildChannelIntentSelectorContextPack({ ...f.input, providerPresetId: f.provider.id });
  const renderedTokens = estimateTextTokens(renderContextPack(pack))
    + estimateTextTokens("You are Ling's channel intent selector. Return strict JSON only.");
  setBudget(f, { contextWindow: renderedTokens + 10 + 1024 + 512 });
  await selectChannelWorkflowIntent(f.input);
  assert.equal(f.requests.length, 1, "the larger repair prompt must not be sent");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id, limit: 10 }).length, 0);
});

test("small no-tool retry budgets skip summary maintenance without inventing capacity", async t => {
  const f = await fixture(t, () => { throw new Error("must not invoke"); });
  const result = await compactChannelDiscussionForNoToolsRetry({ store: f.store, channel: f.channel,
    sourceMessage: f.input.sourceMessage, inputBudgetTokens: 512, now });
  assert.equal(result.summary, undefined);
  assert.ok(result.compactedSummary.text);
  assert.equal(f.requests.length, 0);
});

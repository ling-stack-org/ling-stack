import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { channelOperationVisibleSources } from "../dist/features/channels/channel-operation-sources.js";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-source-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-09-06T00:00:00.000Z";
  const provider = store.createProviderPreset({ kind: "glm", displayName: "Static source selector", providerId: "static", model: "static",
    api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "Static fixture; no provider call" });
  const channel = store.createChannel({ name: "Bound history", boundPath: cwd, defaultProviderPresetId: provider.id,
    defaultTeammateId: "teammate_builtin_engineer", allowedTools: ["read", "write"] }, now);
  store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
  const previous = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "先给我页面内容，不要创建文件。" }, now);
  const content = "<!doctype html><html><body>Source-bound page</body></html>";
  const draft = appendChannelItemFixture(store, { channelId: channel.id, threadId: previous.threadId, authorType: "ai-teammate", authorId: "ling_agent",
    body: `建议文件 index.html，内容：\n${content}`, status: "ready" }, "2026-09-06T00:00:01.000Z");
  const source = appendChannelItemFixture(store, { channelId: channel.id, threadId: previous.threadId, authorType: "local-user",
    body: "请把刚才的页面写入本地。" }, "2026-09-06T00:00:02.000Z");
  const candidate = { schemaVersion: 2, operations: [{ id: "save_page", kind: "file_create", targetKind: "file", required: true, dependsOn: [],
    sourceQuote: source.body, owner: { kind: "host_default" }, target: { path: "index.html", sourceQuote: "index.html", sourceItemId: draft.id },
    contentSource: { kind: "literal", text: content, sourceQuote: content, sourceItemId: draft.id } }] };
  const select = async (execution = candidate) => {
    let calls = 0;
    const result = await selectChannelWorkflowIntent({ store, channel, sourceMessage: source,
      secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
      runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async (input) => {
        calls += 1; assert.deepEqual(input.tools, []);
        input.onEvent({ type: "assistant_text_delta", text: JSON.stringify({ action: "execute", reason: "Current user authorizes saving the prior source-bound page", execution }) });
        return { messages: [] };
      } } } }) } });
    assert.equal(calls, 1);
    return { result, decision: store.listChannelIntentDecisions({ sourceItemId: source.id, limit: 10 })[0] };
  };
  return { store, channel, source, previous, draft, content, candidate, select, now };
}

test("current execution intent and prior assistant content use separate immutable canonical source refs", async (t) => {
  const f = await fixture(t);
  const sources = channelOperationVisibleSources({ store: f.store, sourceItemId: f.source.id });
  assert.ok(sources.some((source) => source.itemId === f.draft.id && source.actorType === "ling_agent"));
  const { result, decision } = await f.select();
  assert.equal(result.action, "workflow_proposal", JSON.stringify(decision));
  assert.equal(result.proposal.status, "draft");
  const binding = decision.execution.operations[0].binding;
  assert.equal(binding.ownerParticipantId, "teammate_builtin_engineer");
  assert.equal(binding.ownerSelection, "host_default");
  assert.deepEqual(binding.sourceRefs, [{ itemId: f.source.id, quote: f.source.body, revision: f.store.getConversationItem(f.source.id).revision, actorType: "local_user" }]);
  assert.equal(binding.outputRefs[0].sourceRefs[0].itemId, f.draft.id);
  assert.equal(binding.contentSource.sourceRefs[0].itemId, f.draft.id);
  assert.equal(binding.contentSource.sourceRefs[0].revision, f.store.getConversationItem(f.draft.id).revision);
  assert.equal(binding.contentSource.sourceRefs[0].actorType, "ling_agent");
  assert.equal(binding.contentSource.text, f.content);
  assert.equal(f.store.listRuns({ channelId: f.channel.id, limit: 20 }).length, 0);
});

test("host_default cannot smuggle a model-chosen participant ID", async (t) => {
  const f = await fixture(t);
  f.candidate.operations[0].owner.participantId = "teammate_builtin_qa";
  const { result, decision } = await f.select();
  assert.equal(result.action, "clarify");
  assert.equal(decision.execution, undefined);
});

test("a foreign canonical item cannot enter the source registry merely because its ID exists", async (t) => {
  const f = await fixture(t);
  const other = f.store.createChannel({ name: "Unrelated source", boundPath: f.channel.boundPath }, f.now);
  const foreign = appendChannelItemFixture(f.store, { channelId: other.id, authorType: "local-user", body: `index.html ${f.content}` }, f.now);
  f.candidate.operations[0].contentSource.sourceItemId = foreign.id;
  const { result, decision } = await f.select();
  assert.equal(result.action, "clarify");
  assert.equal(decision.execution, undefined);
  assert.match(decision.reason, /projected canonical item/u);
});

test("previous assistant text cannot be substituted for the current operation authorization quote", async (t) => {
  const f = await fixture(t);
  f.candidate.operations[0].sourceQuote = f.draft.body;
  const { result, decision } = await f.select();
  assert.equal(result.action, "clarify");
  assert.equal(decision.execution, undefined);
});

test("host_default requires an actual Host routing decision instead of selecting the first candidate", async (t) => {
  const f = await fixture(t);
  const result = bindChannelOperationPlan({ candidate: f.candidate, sourceItemId: f.source.id, sourceText: f.source.body,
    workspaceCwd: f.channel.boundPath, visibleSources: channelOperationVisibleSources({ store: f.store, sourceItemId: f.source.id }),
    participants: [f.store.getAiTeammate("teammate_builtin_engineer"), f.store.getAiTeammate("teammate_builtin_qa")] });
  assert.equal(result.status, "clarify");
  assert.deepEqual(result.missingFields, ["owner.participantId"]);
});

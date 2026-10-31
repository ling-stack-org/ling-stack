import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import * as sources from "../dist/features/channels/channel-operation-sources.js";
import { appendChannelAssistantMessage } from "../dist/features/channels/conversation-item-messages.js";
import { buildConversationContextProjection } from "../dist/features/channels/context-processing/conversation-context-projector.js";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";

const owner = "teammate_builtin_engineer";
const instruction = "@Engineer 只读 input.txt，再原样执行 node --version，不写文件、不联网。";
const confirmation = "确认，沿用刚才的精确命令与输入范围，只读不写。";
const question = "本轮仅执行原请求中的读取和命令，不写文件，是否确认？";

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-continuation-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-25T12:00:00.000Z";
  const channel = store.createChannel({ name: "Continuation regression", boundPath: cwd,
    allowedTools: ["read", "write", "bash"] }, now);
  for (const id of options.participantIds ?? [owner]) store.replaceTeammateChannelMemberships(id, [{ channelId: channel.id }], now);
  const original = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: options.instruction ?? instruction,
    mentions: (options.participantIds ?? [owner]).map(id => ({ id, kind: "ai-teammate", label: id === owner ? "Engineer" : "QA" })) }, now);
  const reply = appendChannelAssistantMessage({ store, sourceItemId: original.id, actorId: owner, body: question,
    idempotencyKey: "continuation-question", now });
  const decision = store.createChannelIntentDecision({ channelId: channel.id, sourceItemId: original.id,
    contextProjection: buildConversationContextProjection({ store, sourceItemId: original.id, view: "selector" }).metadata,
    action: "clarify", status: "accepted", createdBy: "model_policy", reason: "Synthetic clarification only",
    clarification: { missingFields: ["confirmation"], question }, resultItemIds: [reply.id] }, now);
  if (options.intervening) appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: "先解释递归，不要执行操作。" }, now);
  const current = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: options.currentText ?? confirmation,
    ...(options.replyToItemId ? { replyToItemId: options.replyToItemId } : {}) }, now);
  const projection = buildConversationContextProjection({ store, sourceItemId: current.id, view: "selector" });
  const resolve = (overrides = {}) => sources.channelOperationContinuationContext({ store, sourceItemId: current.id, projection, ...overrides });
  const candidate = (context) => ({ schemaVersion: 2,
    continuation: { ...context.anchor, confirmationQuote: current.body }, operations: [
      { id: "read", kind: "file_read", targetKind: "file", required: true, dependsOn: [],
        owner: { participantId: owner, sourceQuote: "Engineer" }, sourceQuote: instruction,
        target: { path: "input.txt", sourceQuote: "input.txt" } },
      { id: "version", kind: "run_command", targetKind: "command", required: true, dependsOn: ["read"],
        owner: { participantId: owner, sourceQuote: "Engineer" }, sourceQuote: instruction,
        command: { text: "node --version", sourceQuote: "node --version" } },
    ] });
  const bind = (plan, continuationContext = resolve()) => bindChannelOperationPlan({ candidate: plan,
    sourceItemId: current.id, sourceText: current.body, workspaceCwd: cwd, continuationContext,
    visibleSources: sources.channelOperationVisibleSources({ store, sourceItemId: current.id, projection }),
    participants: (options.participantIds ?? [owner]).map(id => store.getAiTeammate(id)) });
  return { cwd, get store() { return store; }, channel, original, reply, decision, current, projection, resolve, candidate, bind, now,
    reopen: () => { store.close(); store = createSqliteRunStore(cwd); return store; } };
}

function selectorFixture(f, execution, options = {}) {
  const provider = f.store.createProviderPreset({ kind: "glm", displayName: "Continuation fixture", providerId: "static", model: "static",
    api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, f.now);
  f.store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: f.now, message: "Synthetic; no provider call" });
  const prompts = [];
  const input = { store: f.store, channel: f.store.updateChannel(f.channel.id, { defaultProviderPresetId: provider.id }, f.now),
    sourceMessage: f.current, secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
    runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async request => {
      prompts.push(request.task.prompt);
      assert.deepEqual(request.tools, []);
      assert.match(request.task.prompt, /pending clarification continuation/iu);
      if (options.contextLengthError && prompts.length === 1) throw new Error("context length exceeded");
      if (options.contextLengthError) assert.doesNotMatch(request.task.prompt, /Pending clarification continuation JSON: null/u);
      request.onEvent({ type: "assistant_text_delta", text: JSON.stringify({ action: "execute", reason: "Confirmed original scope", execution }) });
      return { messages: [] };
    } } } }) } };
  return { input, prompts };
}

test("Host exposes only the immediately pending canonical user clarification as a continuation candidate", async t => {
  const f = await fixture(t), context = f.resolve();
  assert.equal(context.source.itemId, f.original.id);
  assert.equal(context.source.actorType, "local_user");
  assert.equal(context.anchor.clarificationDecisionId, f.decision.id);
  assert.equal(context.clarification.itemId, f.reply.id);
  assert.equal(context.confirmation.itemId, f.current.id);
  assert.equal(context.anchor.contextSegmentId, f.projection.metadata.segmentId);
  assert.match(context.anchor.projectionFingerprint, /^[a-f0-9]{64}$/u);
  assert.deepEqual(f.resolve({ projection: { ...f.projection,
    metadata: { ...f.projection.metadata, sourceStateFingerprint: "unrelated-tail-compacted" } } }), context);
});

test("an intervening user request cannot borrow an older pending clarification", async t => {
  const f = await fixture(t, { intervening: true });
  assert.equal(f.resolve(), undefined);
});

test("invisible, foreign-segment and incomplete projected sources cannot supply continuation authority", async t => {
  const f = await fixture(t);
  for (const id of [f.original.id, f.reply.id, f.current.id]) {
    assert.equal(f.resolve({ projection: { ...f.projection, items: f.projection.items.filter(item => item.id !== id) } }), undefined);
  }
  assert.equal(f.resolve({ projection: { ...f.projection,
    metadata: { ...f.projection.metadata, segmentId: "foreign" } } }), undefined);
});

test("a bound continuation freezes both user quotes and its exact clarification without dispatch", async t => {
  const f = await fixture(t), context = f.resolve(), bound = f.bind(f.candidate(context));
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  for (const operation of bound.execution.operations) {
    assert.equal(operation.binding.ownerParticipantId, owner);
    assert.ok(operation.binding.sourceRefs.some(ref => ref.itemId === f.original.id && ref.quote === instruction));
    assert.ok(operation.binding.sourceRefs.some(ref => ref.itemId === f.current.id && ref.quote === confirmation));
    assert.ok(operation.binding.sourceRefs.some(ref => ref.itemId === f.reply.id && ref.quote === question));
    assert.deepEqual(operation.binding.effectScope.writePaths, []);
    assert.match(operation.targetRef.id, new RegExp(`^${f.current.id}:`));
  }
  assert.deepEqual(bound.execution.operations[1].binding.effectScope.exactCommands, ["node --version"]);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
});

test("historical command cwd and input coordinates stay explicit instead of being inferred from confirmation text", async t => {
  const body = "@Engineer 在工作目录 project 原样执行 node cli.js，输入 project/cli.js，只读不写。";
  const f = await fixture(t, { instruction: body });
  const candidate = f.candidate(f.resolve());
  candidate.operations = [{ id: "command", kind: "run_command", targetKind: "command", required: true, dependsOn: [],
    owner: { participantId: owner, sourceQuote: "Engineer" }, sourceQuote: body,
    workingDirectory: { path: "project", sourceQuote: "工作目录 project" },
    command: { text: "node cli.js", sourceQuote: "node cli.js" },
    inputs: [{ path: "project/cli.js", sourceQuote: "project/cli.js" }] }];
  const bound = f.bind(candidate);
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  const binding = bound.execution.operations[0].binding;
  assert.equal(binding.workingDirectory.path, "project");
  assert.deepEqual(binding.effectScope.readPaths, ["project/cli.js"]);
  assert.deepEqual(binding.effectScope.exactCommands, ["node cli.js"]);
  assert.equal(binding.workingDirectory.sourceRefs[0].itemId, f.original.id);
  candidate.operations[0].workingDirectory = { path: "elsewhere", sourceQuote: "elsewhere" };
  assert.equal(f.bind(candidate).status, "clarify");
});

test("a replaced question or newer non-clarify decision retires the pending continuation", async t => {
  for (const mode of ["question-replaced", "decision-settled"]) {
    const f = await fixture(t), original = f.store.getConversationItem(f.original.id);
    if (mode === "question-replaced") {
      f.store.appendConversationItem({ channelId: f.channel.id, threadId: original.threadId, turnId: original.turnId,
        kind: "assistant_message", status: "committed", visibility: "channel", actorType: "teammate", actorId: owner,
        payload: { ...f.store.getConversationItem(f.reply.id).payload, body: "问题已撤回，不要开始。" }, supersedesItemId: f.reply.id,
        domainRefs: [{ type: "conversation_item", id: f.original.id }] }, "2026-10-25T12:01:00.000Z");
    } else {
      f.store.createChannelIntentDecision({ channelId: f.channel.id, sourceItemId: f.original.id,
        contextProjection: buildConversationContextProjection({ store: f.store, sourceItemId: f.original.id, view: "selector" }).metadata,
        action: "reply", status: "accepted", createdBy: "model_policy", reason: "Question resolved" }, "2026-10-25T12:01:00.000Z");
    }
    assert.equal(f.resolve(), undefined, mode);
  }
});

test("the model cannot omit the continuation anchor or forge its revision, decision or current quote", async t => {
  const f = await fixture(t), context = f.resolve();
  for (const mutate of [
    p => { delete p.continuation; },
    p => { p.continuation.sourceRevision += 1; },
    p => { p.continuation.clarificationDecisionId = "foreign-decision"; },
    p => { p.continuation.projectionFingerprint = "stale"; },
    p => { p.continuation.confirmationQuote = "确认"; },
    p => { p.operations[1].command = { text: "node --help", sourceQuote: "node --help" }; },
    p => { p.operations[1].sourceQuote = question; },
  ]) {
    const candidate = f.candidate(context); mutate(candidate);
    assert.equal(f.bind(candidate).status, "clarify", JSON.stringify(candidate));
  }
  assert.equal(f.bind(f.candidate(context), null).status, "clarify");
});

test("selector preserves original explicit owner and current source, and recovery does not replan", async t => {
  const f = await fixture(t), context = f.resolve();
  const { input, prompts } = selectorFixture(f, f.candidate(context));
  const result = await selectChannelWorkflowIntent(input);
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  assert.equal(result.proposal.sourceMessageId, f.current.id);
  const decision = f.store.getChannelIntentDecision(result.intentDecisionId);
  assert.deepEqual(decision.selectedTeammateIds, [owner]);
  assert.equal(decision.sourceItemId, f.current.id);
  assert.equal(decision.execution.operations.length, 2);
  assert.deepEqual(f.resolve(), context, "publishing a new Turn proposal does not alter its frozen input anchor");
  const reopened = f.reopen();
  assert.equal((await selectChannelWorkflowIntent({ ...input, store: reopened })).intentDecisionId, result.intentDecisionId);
  assert.equal(reopened.getChannelIntentDecision(result.intentDecisionId).execution.fingerprint, decision.execution.fingerprint);
  assert.equal(prompts.length, 1);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
});

test("an explicit current participant exclusion narrows the old required manifest, not only its operations", async t => {
  const f = await fixture(t, { participantIds: [owner, "teammate_builtin_qa"],
    instruction: "@Engineer 读取 input.txt；@QA 检查 input.txt。",
    currentText: "确认，这次只让 Engineer 读取，不需要 QA。" });
  const plan = f.candidate(f.resolve());
  plan.operations = [plan.operations[0]];
  plan.operations[0].sourceQuote = f.original.body;
  plan.continuation.excludedParticipants = [{ participantId: "teammate_builtin_qa", sourceQuote: "不需要 QA" }];
  const { input } = selectorFixture(f, plan);
  const result = await selectChannelWorkflowIntent(input);
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  assert.deepEqual(result.proposal.collaborationSteps.map(step => step.teammateId), [owner]);
  assert.deepEqual(f.store.getChannelIntentDecision(result.intentDecisionId).participantManifest.participants.map(p => p.participantId), [owner]);
});

test("real context-length compaction preserves exactly the required continuation sources and one retry", async t => {
  const f = await fixture(t, { instruction: instruction + "背景说明。".repeat(800) });
  const context = f.resolve(), plan = f.candidate(context);
  plan.operations.forEach(operation => { operation.sourceQuote = f.original.body; });
  const { input, prompts } = selectorFixture(f, plan, { contextLengthError: true });
  const result = await selectChannelWorkflowIntent(input);
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes(f.original.id));
  assert.ok(prompts[1].includes(f.reply.id));
  assert.ok(prompts[1].includes(f.current.body));
  assert.equal(f.store.getChannelIntentDecision(result.intentDecisionId).execution.operations[1].binding.effectScope.exactCommands[0], "node --version");
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
});

test("omitting an original participant's operations is not an implicit exclusion", async t => {
  const f = await fixture(t, { participantIds: [owner, "teammate_builtin_qa"],
    instruction: "@Engineer 读取 input.txt；@QA 检查 input.txt。", currentText: "确认，继续原请求。" });
  const plan = f.candidate(f.resolve());
  plan.operations = [plan.operations[0]];
  plan.operations[0].sourceQuote = f.original.body;
  const { input } = selectorFixture(f, plan);
  const result = await selectChannelWorkflowIntent(input);
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  assert.deepEqual(result.proposal.collaborationSteps.map(step => step.teammateId), [owner, "teammate_builtin_qa"]);
  const manifest = f.store.getChannelIntentDecision(result.intentDecisionId).participantManifest;
  assert.ok(manifest.participants.every(participant => participant.requirement === "required"));
});

test("exclusions require current quoted identity and cannot duplicate, name an unavailable owner or keep excluded operations", async t => {
  const qa = "teammate_builtin_qa";
  const f = await fixture(t, { participantIds: [owner, qa], currentText: "确认，只保留 Engineer，不需要 QA。" });
  const base = f.candidate(f.resolve());
  base.continuation.excludedParticipants = [{ participantId: qa, sourceQuote: "不需要 QA" }];
  const bound = f.bind(base);
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.deepEqual(bound.excludedParticipantIds, [qa]);
  for (const mutate of [
    p => { p.continuation.excludedParticipants[0].sourceQuote = "原请求中有 QA"; },
    p => { p.continuation.excludedParticipants[0].sourceQuote = "不需要"; },
    p => { p.continuation.excludedParticipants[0].participantId = "unavailable"; },
    p => { p.continuation.excludedParticipants.push({ ...p.continuation.excludedParticipants[0] }); },
    p => { p.continuation.excludedParticipants = [{ participantId: owner, sourceQuote: "只保留 Engineer" }]; },
    p => { p.continuation.excludedParticipants[0].verified = true; },
    p => { p.continuation.excludedParticipants = []; },
    p => { delete p.continuation; p.excludedParticipants = base.continuation.excludedParticipants; },
    p => { p.continuation.projectionFingerprint = "foreign"; },
  ]) {
    const candidate = structuredClone(base); mutate(candidate);
    assert.equal(f.bind(candidate).status, "clarify", JSON.stringify(candidate));
  }
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
});

test("retaining pending sources bypasses only text trimming, never visibility or missing-source boundaries", async t => {
  const f = await fixture(t, { instruction: instruction + "背景说明。".repeat(800) });
  const sourceIds = [f.original.id, f.reply.id, f.current.id];
  const minimal = buildConversationContextProjection({ store: f.store, sourceItemId: f.current.id, view: "selector", maxTailTextChars: 2048 });
  assert.equal(sources.channelOperationContinuationContext({ store: f.store, sourceItemId: f.current.id, projection: minimal }), undefined);
  const current = f.store.getConversationItem(f.current.id);
  const privateItem = f.store.appendConversationItem({ channelId: f.channel.id, threadId: current.threadId, turnId: current.turnId,
    kind: "assistant_message", status: "committed", visibility: "agent_private", visibilityOwnerId: owner,
    actorType: "teammate", actorId: owner, payload: { ...f.store.getConversationItem(f.reply.id).payload,
      body: "PRIVATE RETENTION MUST NOT EXPOSE THIS" }, domainRefs: [] }, f.now);
  const projection = buildConversationContextProjection({ store: f.store, sourceItemId: f.current.id, view: "selector",
    maxTailTextChars: 2048, retainItemIds: [...sourceIds, privateItem.id, "missing-item"] });
  assert.deepEqual(projection.items.map(item => item.id), sourceIds);
  assert.deepEqual(sources.channelOperationContinuationContext({ store: f.store, sourceItemId: f.current.id, projection }), f.resolve());
  for (const id of sourceIds) assert.ok(projection.metadata.sourceRefs.some(ref => ref.id === id));
});

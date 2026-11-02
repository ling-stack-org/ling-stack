import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { applyChannelPendingAnswerPatch } from "../dist/features/channels/channel-pending-operation.js";

const owner = "teammate_builtin_qa";
const body = "@QA 仅执行 node project/validate.mjs，输入 project/validate.mjs；请先询问依赖目录再开始；不写文件、不联网。";
const question = "请明确 Node 项目依赖目录；当前尚未执行。";
const candidate = () => ({ schemaVersion: 2, operations: [{ id: "validate", kind: "run_command", targetKind: "command",
  required: true, dependsOn: [], owner: { participantId: owner, sourceQuote: "QA" }, sourceQuote: body,
  command: { text: "node project/validate.mjs", sourceQuote: "node project/validate.mjs" },
  inputs: [{ path: "project/validate.mjs", sourceQuote: "project/validate.mjs" }] }] });

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-pending-daemon-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-27T09:00:00.000Z";
  const provider = store.createProviderPreset({ kind: "glm", displayName: "Offline pending regression", providerId: "static",
    model: "static", api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "Static test runner only" });
  const channel = store.createChannel({ name: "Pending fields", boundPath: cwd, defaultProviderPresetId: provider.id,
    allowedTools: ["read", "bash"] }, now);
  store.replaceTeammateChannelMemberships(owner, [{ channelId: channel.id }], now);
  if (options.engineer) store.replaceTeammateChannelMemberships("teammate_builtin_engineer", [{ channelId: channel.id }], now);
  const council = options.council ? store.createAiCouncil({ displayName: "Pending authority council",
    members: [{ teammateId: owner }] }, now) : undefined;
  if (council) store.upsertChannelCouncilPolicy(channel.id, { attachedCouncilIds: [council.id] }, now);
  const original = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: options.body ?? body,
    mentions: [{ kind: "ai-teammate", id: owner, label: "QA" },
      ...(options.engineer ? [{ kind: "ai-teammate", id: "teammate_builtin_engineer", label: "Engineer" }] : [])] }, now);
  const prompts = [];
  async function select(source, output, beforeReturn) {
    return selectChannelWorkflowIntent({ store, channel: store.getChannel(channel.id), sourceMessage: source,
      secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
      runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async request => {
        assert.deepEqual(request.tools, []); prompts.push(request.task.prompt);
        beforeReturn?.();
        request.onEvent({ type: "assistant_text_delta", text: JSON.stringify(output) }); return { messages: [] };
      } } } }) } });
  }
  const initial = await select(original, { action: "clarify", reason: "Explicit dependency scope is missing",
    clarification: { missingFields: ["projectInputRoot"], question },
    pendingDraft: { execution: options.execution ?? candidate(), slots: [{ operationId: "validate", field: "project_input_root" }] } });
  assert.equal(initial.action, "clarify");
  const decision = store.getChannelIntentDecision(initial.intentDecisionId);
  assert.ok(decision.clarification.pendingOperation);
  const answer = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user",
    body: "确认，仅允许 project 作为 Node 依赖目录；不改命令、参与者和其他权限。", replyToItemId: initial.aiReply.id }, now);
  const patch = () => ({ action: "resolve_pending", reason: "Fill only the pending dependency scope",
    pendingAnswer: { pendingDecisionId: decision.id, draftFingerprint: decision.clarification.pendingOperation.fingerprint,
      answerItemId: answer.id, answerRevision: store.getConversationItem(answer.id).revision,
      patches: [{ operationId: "validate", field: "project_input_root", path: "project", sourceQuote: answer.body }] } });
  return { cwd, channel, council, original, initial, decision, answer, prompts, patch, select, now,
    get store() { return store; }, reopen() { store.close(); store = createSqliteRunStore(cwd); } };
}

test("a clarification freezes a non-executable plan and its answer fills only the named field", async t => {
  const f = await fixture(t), draft = f.decision.clarification.pendingOperation;
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
  applyChannelPendingAnswerPatch({ store: f.store, sourceItemId: f.answer.id, patch: f.patch().pendingAnswer });
  const result = await f.select(f.answer, f.patch());
  assert.equal(result.action, "workflow_proposal");
  const decision = f.store.getChannelIntentDecision(result.intentDecisionId), operation = decision.execution.operations[0];
  const { commandInputScope, sourceRefs, ...binding } = operation.binding;
  assert.deepEqual({ ...operation, binding: { ...binding, sourceRefs: sourceRefs.slice(0, -1) } }, draft.execution.operations[0]);
  assert.equal(sourceRefs.at(-1).quote, f.answer.body);
  assert.equal(commandInputScope.projectRoot, "project");
  assert.deepEqual(commandInputScope.sourceRefs, [{ itemId: f.answer.id, revision: f.patch().pendingAnswer.answerRevision,
    actorType: "local_user", quote: "project" }]);
  assert.ok(f.store.getChannelPendingOperationResolution(f.decision.id));
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1], /resolve_pending/u);
  assert.match(f.prompts[1], /Do not regenerate/u);
  f.reopen();
  const replay = await f.select(f.answer, new Error("must not call model"));
  assert.equal(replay.proposal.id, result.proposal.id);
  assert.equal(f.prompts.length, 2);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 1);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
});

for (const [name, mutate] of [
  ["changed command", p => { p.pendingAnswer.patches[0].command = "rm -rf project"; }],
  ["changed owner", p => { p.pendingAnswer.patches[0].ownerParticipantId = "ling_agent"; }],
  ["foreign decision", p => { p.pendingAnswer.pendingDecisionId = "foreign"; }],
  ["stale draft", p => { p.pendingAnswer.draftFingerprint = "b".repeat(64); }],
  ["stale answer", p => { p.pendingAnswer.answerRevision += 1; }],
  ["missing slot", p => { p.pendingAnswer.patches = []; }],
  ["duplicate slot", p => { p.pendingAnswer.patches.push({ ...p.pendingAnswer.patches[0] }); }],
  ["invented path", p => { p.pendingAnswer.patches[0].path = "other"; }],
  ["truncated answer", p => { p.pendingAnswer.patches[0].sourceQuote = "project"; }],
  ["hidden directory", p => { p.pendingAnswer.patches[0].path = ".git"; }],
]) test(`pending answer refuses ${name}`, async t => {
  const f = await fixture(t), patch = f.patch(); mutate(patch);
  const result = await f.select(f.answer, patch);
  assert.equal(result.action, "blocked");
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
});

test("a pending answer cannot replace the frozen plan with a freshly generated execution", async t => {
  const f = await fixture(t);
  const result = await f.select(f.answer, { action: "execute", reason: "Not a field patch", execution: candidate() });
  assert.equal(result.action, "blocked");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
  assert.equal(f.prompts.length, 2, "Do not repair a newly generated graph when a frozen draft exists");
});

test("policy drift while the model is answering blocks publication", async t => {
  const f = await fixture(t);
  const result = await f.select(f.answer, f.patch(), () => f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, f.now));
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, "channel_pending_operation_authority_changed");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});

test("policy is checked again inside the atomic publication, not only before it", async t => {
  const f = await fixture(t), resolve = f.store.resolveChannelPendingOperation.bind(f.store);
  f.store.resolveChannelPendingOperation = (...args) => {
    f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, f.now);
    return resolve(...args);
  };
  const result = await f.select(f.answer, f.patch());
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, "channel_pending_operation_authority_changed");
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});

// Regression: CP-REVOKE-20261028-02 — an authority rejection was mislabeled
// as invalid model JSON, telling the user to retry an expired operation.
// Found by /qa on 2026-10-28; see the engine-lifecycle native acceptance report.
for (const regenerated of [false, true]) test(`revoked pending authority keeps its own blocker even with regenerated=${regenerated}`, async t => {
  const f = await fixture(t);
  f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, "2026-10-27T09:00:01.000Z");
  const output = regenerated ? { action: "execute", reason: "Unexpected whole plan", execution: candidate() } : f.patch();
  const result = await f.select(f.answer, output);
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, "channel_pending_operation_authority_changed");
  assert.match(result.aiReply.body, /权限|authorization/u);
  assert.doesNotMatch(result.aiReply.body, /可重试本次请求|retry the request/u);
  const decision = f.store.getChannelIntentDecision(result.intentDecisionId);
  assert.equal(decision.errorCode, result.errorCode);
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
  f.store.updateChannel(f.channel.id, { allowedTools: ["read", "bash"] }, "2026-10-27T09:00:02.000Z");
  f.reopen();
  const calls = f.prompts.length;
  const replay = await f.select(f.answer, new Error("recovery must not call the model"));
  assert.equal(replay.errorCode, result.errorCode);
  assert.equal(replay.aiReply.id, result.aiReply.id);
  assert.equal(replay.intentDecisionId, result.intentDecisionId);
  assert.equal(f.prompts.length, calls);
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
});

test("restoring the same policy before an answer cannot revive an older authority revision", async t => {
  const f = await fixture(t);
  f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, "2026-10-27T09:00:01.000Z");
  f.store.updateChannel(f.channel.id, { allowedTools: ["read", "bash"] }, "2026-10-27T09:00:02.000Z");
  const result = await f.select(f.answer, f.patch());
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, "channel_pending_operation_authority_changed");
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
});

// Independent review found that equal values/timestamps do not prove that
// authority stayed unchanged. These public Store writes use the same timestamp.
for (const scope of ["workspace", "channel", "approval", "participant", "membership", "council_policy", "council_member", "council"]) {
  test(`same-time ${scope} authority ABA stays expired across Store reopen`, async t => {
    const f = await fixture(t, { council: scope.startsWith("council") });
    if (scope === "workspace") {
      const old = f.store.getWorkspaceSettings();
      f.store.updateWorkspaceSettings({ defaultAuthorizationMode: "ask", defaultWorkspaceAccessMode: "read_only" }, f.now);
      f.store.updateWorkspaceSettings({ defaultAuthorizationMode: old.defaultAuthorizationMode,
        defaultWorkspaceAccessMode: old.defaultWorkspaceAccessMode,
        defaultPermissionMode: old.defaultPermissionMode, defaultPermissionPreset: old.defaultPermissionPreset }, f.now);
    } else if (scope === "channel") {
      f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, f.now);
      f.store.updateChannel(f.channel.id, { allowedTools: ["read", "bash"] }, f.now);
    } else if (scope === "approval") {
      const old = f.store.getApprovalPolicy();
      f.store.updateApprovalPolicy({ toolDecisions: { bash: "deny" } }, old.updatedAt);
      f.store.updateApprovalPolicy({ toolDecisions: old.toolDecisions }, old.updatedAt);
    } else if (scope === "participant") {
      const old = f.store.getAiTeammate(owner);
      f.store.updateAiTeammate(owner, { allowedTools: ["read"] }, old.updatedAt);
      f.store.updateAiTeammate(owner, { allowedTools: old.allowedTools }, old.updatedAt);
    } else if (scope === "membership") {
      f.store.replaceTeammateChannelMemberships(owner, [], f.now);
      f.store.replaceTeammateChannelMemberships(owner, [{ channelId: f.channel.id }], f.now);
    } else if (scope === "council_policy") {
      f.store.upsertChannelCouncilPolicy(f.channel.id, { attachedCouncilIds: [] }, f.now);
      f.store.upsertChannelCouncilPolicy(f.channel.id, { attachedCouncilIds: [f.council.id] }, f.now);
    } else if (scope === "council_member") {
      f.store.replaceAiCouncilMembers(f.council.id, [{ teammateId: owner, enabled: false }], f.now);
      f.store.replaceAiCouncilMembers(f.council.id, [{ teammateId: owner, enabled: true }], f.now);
    } else {
      f.store.updateAiCouncil(f.council.id, { status: "paused" }, f.now);
      f.store.updateAiCouncil(f.council.id, { status: "active" }, f.now);
    }
    f.reopen();
    const result = await f.select(f.answer, f.patch());
    assert.equal(result.action, "blocked");
    assert.equal(result.errorCode, "channel_pending_operation_authority_changed");
    assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
    assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
    assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
  });
}

test("theme changes and no-op permission writes do not expire a pending operation", async t => {
  const f = await fixture(t), old = f.store.getWorkspaceSettings();
  f.store.updateWorkspaceSettings({ theme: "dark" }, "2026-10-27T09:00:01.000Z");
  f.store.updateWorkspaceSettings({ defaultAuthorizationMode: old.defaultAuthorizationMode,
    defaultWorkspaceAccessMode: old.defaultWorkspaceAccessMode }, "2026-10-27T09:00:02.000Z");
  f.reopen();
  const result = await f.select(f.answer, f.patch());
  assert.equal(result.action, "workflow_proposal");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 1);
});

for (const scope of ["channel", "approval", "participant"]) test(`timestamp-only ${scope} writes preserve pending authority`, async t => {
  const f = await fixture(t), later = "2026-10-27T09:00:02.000Z";
  if (scope === "channel") f.store.updateChannel(f.channel.id, { allowedTools: f.channel.allowedTools }, later);
  else if (scope === "approval") f.store.updateApprovalPolicy({ toolDecisions: f.store.getApprovalPolicy().toolDecisions }, later);
  else f.store.updateAiTeammate(owner, { allowedTools: f.store.getAiTeammate(owner).allowedTools }, later);
  f.reopen();
  const result = await f.select(f.answer, f.patch());
  assert.equal(result.action, "workflow_proposal");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 1);
});

// Healthy contract: authority-storage integrity failures belong to the Host,
// not the model's patch validator, and cannot leave a publication behind.
for (const damage of ["missing trigger", "missing version"]) test(`pending resolution propagates ${damage} without a model-plan diagnostic`, async t => {
  const f = await fixture(t);
  if (damage === "missing trigger") f.store.database.exec("DROP TRIGGER pending_authority_channel_update");
  else f.store.database.prepare("DELETE FROM channel_pending_authority_versions WHERE scope='channel' AND owner_id=?").run(f.channel.id);
  await assert.rejects(f.select(f.answer, f.patch()), /channel_pending_authority\.(?:schema_conflict|unavailable)/u);
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listChannelIntentDecisions({ sourceItemId: f.answer.id }), []);
  assert.equal(f.store.getChannelPendingOperationResolution(f.decision.id), undefined);
});

for (const action of ["reply", "no_reply"]) test(`authority drift does not turn unrelated ${action} into an execution blocker`, async t => {
  const f = await fixture(t);
  f.store.updateChannel(f.channel.id, { allowedTools: ["read"] }, "2026-10-27T09:00:01.000Z");
  const result = await f.select(f.answer, { action, reason: "Unrelated or declining text does not resume the pending operation" });
  assert.ok(["continue", "no_reply"].includes(result.action));
  assert.deepEqual(f.store.listChannelExecutionProposals({ channelId: f.channel.id }), []);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
});

test("a question replaced during the model request cannot revive its old draft", async t => {
  const f = await fixture(t);
  const result = await f.select(f.answer, f.patch(), () => {
    const item = f.store.getConversationItem(f.initial.aiReply.id);
    f.store.appendConversationItem({ channelId: item.channelId, threadId: item.threadId, turnId: item.turnId,
      kind: item.kind, status: "committed", actorType: item.actorType, actorId: item.actorId, visibility: item.visibility,
      payload: item.payload, domainRefs: item.domainRefs, supersedesItemId: item.id }, f.now);
  });
  assert.equal(result.action, "blocked");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});

test("a multi-participant pending plan retains every required owner and dependency", async t => {
  const engineer = "@Engineer 创建 project/validate.mjs，内容为输出 ok 的 Node 程序。";
  const qa = "@QA 仅执行 node project/validate.mjs，输入 project/validate.mjs；请先询问依赖目录再开始；不写文件、不联网。";
  const execution = { schemaVersion: 2, operations: [
    { id: "create", kind: "file_create", targetKind: "file", required: true, dependsOn: [], sourceQuote: engineer,
      owner: { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" },
      target: { path: "project/validate.mjs", sourceQuote: "project/validate.mjs" },
      contentSource: { kind: "generated_objective", text: "输出 ok 的 Node 程序", sourceQuote: "输出 ok 的 Node 程序", inputOperationIds: [] } },
    { ...candidate().operations[0], sourceQuote: qa, dependsOn: ["create"],
      inputs: [{ path: "project/validate.mjs", sourceQuote: "project/validate.mjs", fromOperationId: "create" }] },
  ] };
  const f = await fixture(t, { body: `${engineer}\n${qa}`, execution, engineer: true });
  const result = await f.select(f.answer, f.patch());
  assert.equal(result.action, "workflow_proposal");
  const decision = f.store.getChannelIntentDecision(result.intentDecisionId);
  assert.deepEqual(decision.execution.operations[0], f.decision.clarification.pendingOperation.execution.operations[0]);
  assert.deepEqual(decision.execution.operations[1].dependsOn, ["create"]);
  assert.deepEqual(new Set(decision.participantManifest.participants.map(p => p.participantId)),
    new Set([owner, "teammate_builtin_engineer"]));
  assert.ok(decision.participantManifest.participants.every(p => p.requirement === "required"));
  assert.deepEqual(decision.participantManifest, f.decision.clarification.pendingOperation.participantManifest);
});

test("a project symlink outside the workspace is not dependency-scope authority", async t => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "ling-pending-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.cwd, "project"));
  const result = await f.select(f.answer, f.patch());
  assert.equal(result.action, "blocked");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});

for (const action of ["reply", "no_reply"]) test(`an unrelated or declining ${action} does not execute the pending plan`, async t => {
  const f = await fixture(t);
  const result = await f.select(f.answer, { action, reason: "User did not supply authorization for the old task" });
  assert.ok(["continue", "no_reply"].includes(result.action));
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});

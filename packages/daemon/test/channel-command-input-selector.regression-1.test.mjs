import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";

// Regression: Host should not publish a redundant dependency-directory question.
// Found by /qa on 2026-10-27
// Report: output/e6-20260928/channel-policy-command-inputs-implementation-20261027.md
// Static runner tests real selector/store publication, not model quality or tool execution.
async function fixture(t, { askFirst = false, directOnly = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-policy-selector-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-10-27T14:00:00.000Z", owner = "teammate_builtin_qa";
  const provider = store.createProviderPreset({ kind: "glm", displayName: "Offline policy scope", providerId: "static",
    model: "static", api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "Static runner only" });
  const channel = store.createChannel({ name: "Input policy", boundPath: cwd, defaultProviderPresetId: provider.id,
    allowedTools: ["read", "bash"] }, now);
  store.replaceTeammateChannelMemberships(owner, [{ channelId: channel.id }], now);
  const restriction = [askFirst ? "请先询问依赖目录再开始。" : "", directOnly ? "只读 project/validate.cjs，不读取其他文件。" : ""].join("");
  const body = `@QA 执行 node project/validate.cjs，入口 project/validate.cjs；不写文件、不联网。${restriction}`;
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body,
    mentions: [{ kind: "ai-teammate", id: owner, label: "QA" }] }, now);
  const execution = { schemaVersion: 2, operations: [{ id: "validate", kind: "run_command", targetKind: "command",
    required: true, dependsOn: [], owner: { participantId: owner, sourceQuote: "QA" }, sourceQuote: body,
    command: { text: "node project/validate.cjs", sourceQuote: "node project/validate.cjs" },
    inputs: [{ path: "project/validate.cjs", sourceQuote: "project/validate.cjs" }],
    ...(restriction ? { commandInputConstraint: { mode: askFirst ? "ask_first" : "direct_inputs_only", sourceQuote: restriction } } : {}),
  }] };
  let calls = 0;
  const prompts = [];
  const select = output => selectChannelWorkflowIntent({ store, channel: store.getChannel(channel.id), sourceMessage: source,
    secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
    runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async request => {
      calls++; prompts.push(request.task.prompt); assert.deepEqual(request.tools, []);
      request.onEvent({ type: "assistant_text_delta", text: JSON.stringify(output) }); return { messages: [] };
    } } } }) } });
  return { channel, source, execution, select, prompts, get store() { return store; }, get calls() { return calls; },
    reopen() { store.close(); store = createSqliteRunStore(cwd); } };
}
for (const draft of [false, true]) test(`ordinary command uses inherited policy without redundant question (draft=${draft})`, async t => {
  const f = await fixture(t);
  const output = draft ? { action: "clarify", reason: "Only root missing", clarification: {
    missingFields: ["projectInputRoot"], question: "依赖目录是什么？" }, pendingDraft: { execution: f.execution,
      slots: [{ operationId: "validate", field: "project_input_root" }] } } : { action: "execute", reason: "User asked", execution: f.execution };
  const result = await f.select(output);
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  const decision = f.store.getChannelIntentDecision(result.intentDecisionId);
  const authority = decision.execution.operations[0].binding.commandInputScope.policyAuthority;
  assert.equal(authority.sourceItemId, f.source.id); assert.equal(authority.channelId, f.channel.id);
  assert.equal(decision.clarification, undefined);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
  assert.equal(f.calls, 1);
  assert.match(f.prompts[0], /A separately quoted project directory is NOT required/u);
  f.reopen();
  const replay = await f.select(new Error("Do not call runner again"));
  assert.equal(replay.proposal.id, result.proposal.id);
  assert.equal(f.calls, 1); assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 1);
});
test("explicit ask-first retains a frozen scope question, not inherited policy", async t => {
  const f = await fixture(t, { askFirst: true });
  const result = await f.select({ action: "clarify", reason: "User requested ask-first", clarification: {
    missingFields: ["projectInputRoot"], question: "请提供依赖目录。" },
    pendingDraft: { execution: f.execution, slots: [{ operationId: "validate", field: "project_input_root" }] } });
  assert.equal(result.action, "clarify", JSON.stringify(result));
  const pending = f.store.getChannelIntentDecision(result.intentDecisionId).clarification.pendingOperation;
  assert.equal(pending.execution.operations[0].binding.commandInputScope, undefined);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});
test("single-file restriction admits only explicit inputs and no policy closure", async t => {
  const f = await fixture(t, { directOnly: true });
  const result = await f.select({ action: "execute", reason: "User limited reads", execution: f.execution });
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  const binding = f.store.getChannelIntentDecision(result.intentDecisionId).execution.operations[0].binding;
  assert.equal(binding.commandInputScope, undefined); assert.deepEqual(binding.effectScope.readPaths, ["project/validate.cjs"]);
});
test("Host preserves ask-first even if the model incorrectly selects execute", async t => {
  const f = await fixture(t, { askFirst: true });
  const result = await f.select({ action: "execute", reason: "Incorrectly skipped the user question", execution: f.execution });
  assert.equal(result.action, "clarify", JSON.stringify(result));
  const draft = f.store.getChannelIntentDecision(result.intentDecisionId).clarification.pendingOperation;
  assert.deepEqual(draft.slots, [{ operationId: "validate", field: "project_input_root" }]);
  assert.equal(draft.execution.operations[0].binding.commandInputScope, undefined);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});
test("a model's direct-only interpretation cannot suppress the explicit ask-first question", async t => {
  const f = await fixture(t, { askFirst: true, directOnly: true });
  f.execution.operations[0].commandInputConstraint = { mode: "direct_inputs_only", sourceQuote: "只读 project/validate.cjs，不读取其他文件。" };
  const result = await f.select({ action: "execute", reason: "Only direct inputs", execution: f.execution });
  assert.equal(result.action, "clarify", JSON.stringify(result));
  const draft = f.store.getChannelIntentDecision(result.intentDecisionId).clarification.pendingOperation;
  assert.deepEqual(draft.slots, [{ operationId: "validate", field: "project_input_root" }]);
  assert.equal(draft.execution.operations[0].binding.commandInputScope, undefined);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});
test("unavailable inherited read authority is a permission blocker, not another directory question", async t => {
  const f = await fixture(t);
  f.store.updateApprovalPolicy({ toolDecisions: { read: "deny" } }, "2026-10-27T14:00:00.000Z");
  const result = await f.select({ action: "execute", reason: "User asked", execution: f.execution });
  assert.equal(result.action, "blocked", JSON.stringify(result));
  assert.equal(result.errorCode, "operation_binding_input_read_unavailable");
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
  assert.deepEqual(f.store.listRuns({ channelId: f.channel.id }), []);
});

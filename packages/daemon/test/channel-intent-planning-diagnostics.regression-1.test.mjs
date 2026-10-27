import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_WORKSPACE_ID, createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { bindChannelOperationPlan, isChannelOperationCandidatePlanV2 } from "../dist/features/channels/channel-operation-bindings.js";

const body = "@Engineer 只执行一次 node --version，在工作区根目录；不读写文件、不联网、不安排其他 Agent。";
const owner = "teammate_builtin_engineer";
const plan = () => ({ schemaVersion: 2, operations: [{ id: "version", kind: "run_command", targetKind: "command",
  required: true, dependsOn: [], owner: { participantId: owner, sourceQuote: "Engineer" }, sourceQuote: body,
  command: { text: "node --version", sourceQuote: "node --version" } }] });
const execute = execution => ({ action: "execute", reason: "Private model reason /private/reason", execution });

async function fixture(t, outputs, sourceBody = body) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-planning-diagnostics-"));
  let store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  const provider = store.createProviderPreset({ kind: "glm", displayName: "Offline planning diagnostics",
    providerId: "static", model: "static", api: "google-generative-ai", capabilities: ["chat"],
    input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "No model request" });
  const channel = store.createChannel({ name: "Planning diagnostics", boundPath: cwd,
    defaultProviderPresetId: provider.id, allowedTools: ["bash"] }, now);
  store.replaceTeammateChannelMemberships(owner, [{ channelId: channel.id }], now);
  const source = appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user", body: sourceBody,
    mentions: [{ kind: "ai-teammate", id: owner, label: "Engineer" }] }, now);
  const prompts = [];
  return { cwd, source, channel, prompts, get store() { return store; },
    reopen() { store.close(); store = createSqliteRunStore(cwd); },
    diagnostics() { return store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID,
      entityType: "channel_intent_selection", entityId: source.id, limit: 100 }); },
    select() { return selectChannelWorkflowIntent({ store, channel, sourceMessage: source,
      secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
      runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async request => {
        assert.deepEqual(request.tools, []);
        prompts.push(request.task.prompt);
        const output = outputs[Math.min(prompts.length - 1, outputs.length - 1)];
        if (output instanceof Error) throw output;
        request.onEvent({ type: "assistant_text_delta", text: typeof output === "string" ? output : JSON.stringify(output) });
        return { messages: [] };
      } } } }) } }); },
  };
}

test("scalar shape diagnostics distinguish missing, wrong type and invalid value", async t => {
  const f = await fixture(t, []);
  for (const [mutate, path, code] of [
    [p => { delete p.schemaVersion; }, "execution.schemaVersion", "missing"],
    [p => { p.schemaVersion = "2"; }, "execution.schemaVersion", "invalid_type"],
    [p => { delete p.operations[0].required; }, "execution.operations[].required", "missing"],
    [p => { p.operations[0].required = "true"; }, "execution.operations[].required", "invalid_type"],
    [p => { delete p.operations[0].kind; }, "execution.operations[].kind", "missing"],
    [p => { p.operations[0].kind = ["run_command"]; }, "execution.operations[].kind", "invalid_type"],
    [p => { p.operations[0].kind = "invented"; }, "execution.operations[].kind", "invalid_value"],
    [p => { p.operations[0].targetKind = null; }, "execution.operations[].targetKind", "invalid_type"],
    [p => { p.operations[0].targetKind = "file"; }, "execution.operations[].targetKind", "invalid_value"],
  ]) {
    const candidate = plan(); mutate(candidate);
    const result = bindChannelOperationPlan({ candidate, sourceItemId: f.source.id, sourceText: body,
      workspaceCwd: f.cwd, participants: [f.store.getAiTeammate(owner)] });
    assert.equal(isChannelOperationCandidatePlanV2(candidate), false);
    assert.deepEqual(result.shapeIssue, { path, code });
  }
});

test("planner declares generated content dependencies as required and literal content dependencies as forbidden", async t => {
  const f = await fixture(t, [{ action: "reply", reason: "No effects in the prompt contract probe" }]);
  await f.select();
  assert.match(f.prompts[0], /For generated_objective, inputOperationIds is REQUIRED, including an explicit empty array when no read or command evidence is consumed/u);
  assert.match(f.prompts[0], /For literal, omit inputOperationIds entirely/u);
  assert.doesNotMatch(f.prompts[0], /inputOperationIds\?:/u);
  const candidate = { schemaVersion: 2, operations: [{ id: "create", kind: "file_create", targetKind: "file",
    required: true, dependsOn: [], owner: { participantId: owner, sourceQuote: "Engineer" },
    sourceQuote: "@Engineer 创建 stats.mjs，导出有限数值求和函数。",
    target: { path: "stats.mjs", sourceQuote: "stats.mjs" },
    contentSource: { kind: "generated_objective", text: "导出有限数值求和函数", sourceQuote: "导出有限数值求和函数" } }] };
  const bind = () => bindChannelOperationPlan({ candidate, sourceItemId: f.source.id,
    sourceText: candidate.operations[0].sourceQuote, workspaceCwd: f.cwd,
    participants: [f.store.getAiTeammate(owner)] });
  assert.deepEqual(bind().shapeIssue, { path: "execution.operations[].contentSource.inputOperationIds", code: "missing" });
  candidate.operations[0].contentSource.inputOperationIds = [];
  const bound = bind();
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.deepEqual(bound.execution.operations[0].binding.contentSource.inputOperationIds, []);
  assert.deepEqual(bound.execution.operations[0].binding.effectScope.readPaths, []);
});

test("provenance diagnostics identify the fixed field path without persisting rejected quote text", async t => {
  for (const [mutate, field] of [
    [p => { p.operations[0].sourceQuote = "PRIVATE_REJECTED_OPERATION"; }, "execution.operations[].sourceQuote"],
    [p => { p.operations[0].owner.sourceQuote = "PRIVATE_REJECTED_OWNER"; }, "execution.operations[].owner.sourceQuote"],
    [p => { p.operations[0].command.sourceQuote = "PRIVATE_REJECTED_COMMAND"; }, "execution.operations[].command.sourceQuote"],
  ]) {
    const candidate = plan(); mutate(candidate);
    const f = await fixture(t, [execute(candidate)]);
    const result = await f.select();
    assert.equal(result.action, "blocked");
    assert.equal(result.errorCode, "channel_operation_plan_invalid");
    const diagnostics = f.diagnostics();
    const rejected = diagnostics.filter(event => event.data.outcome === "binding_rejected");
    assert.equal(rejected.length, 2);
    assert.deepEqual(rejected.map(event => event.data.fields), [[field], [field]]);
    assert.doesNotMatch(JSON.stringify(diagnostics.map(event => event.data)), /PRIVATE_REJECTED|Private model reason|node --version/u);
    assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
    assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
    assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
  }
});

for (const [name, mutate, path, code] of [
  ["missing execution", () => undefined, "execution", "missing"],
  ["empty operations", p => ({ ...p, operations: [] }), "execution.operations", "empty_array"],
  ["wrong version", p => ({ ...p, schemaVersion: 1 }), "execution.schemaVersion", "invalid_value"],
  ["empty inputs", p => { p.operations[0].inputs = []; return p; }, "execution.operations[].inputs", "empty_array"],
  ["unknown private key", p => { p.operations[0]["/private/SECRET_UNKNOWN_KEY"] = "PRIVATE_VALUE"; return p; },
    "execution.operations[]", "unexpected_fields"],
]) test(`schema diagnostic distinguishes ${name} without disclosing candidate data`, async t => {
  const candidate = mutate(plan());
  const f = await fixture(t, [execute(candidate)]);
  const binding = bindChannelOperationPlan({ candidate, sourceItemId: f.source.id, sourceText: body,
    workspaceCwd: f.cwd, participants: [f.store.getAiTeammate(owner)] });
  assert.equal(isChannelOperationCandidatePlanV2(candidate), false);
  assert.deepEqual(binding.shapeIssue, { path, code });
  const result = await f.select();
  assert.equal(result.action, "blocked");
  assert.equal(result.errorCode, "channel_operation_plan_invalid");
  assert.equal(f.prompts.length, 2);
  assert.doesNotMatch(result.aiReply.body, /请分别列出|输入和输出文件/u);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listTasks({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
  const events = f.diagnostics();
  assert.equal(events.filter(e => e.action === "channel_intent.request_started").length, 2);
  const rejected = events.filter(e => e.data.outcome === "shape_rejected");
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected[0].data.issue, { path, code });
  assert.deepEqual(events.filter(e => e.action === "channel_intent.request_started").map(e =>
    [e.data.requestOrdinal, e.data.purpose]), [[1, "initial"], [2, "binding_repair"]]);
  assert.doesNotMatch(JSON.stringify(events.map(e => e.data)), /PRIVATE_VALUE|SECRET_UNKNOWN_KEY|\/private|node --version|不联网/u);
  f.reopen();
  assert.deepEqual(f.diagnostics(), events);
  const replay = await f.select();
  assert.equal(replay.aiReply.id, result.aiReply.id);
  assert.equal(f.prompts.length, 2, "recovery does not classify or execute again");
});

test("one repaired no-file command preserves exact owner, source and zero file privileges", async t => {
  const invalid = plan(); invalid.operations[0].inputs = [];
  const f = await fixture(t, [execute(invalid), execute(plan())]);
  const result = await f.select();
  assert.equal(result.action, "workflow_proposal");
  const decision = f.store.listChannelIntentDecisions({ sourceItemId: f.source.id })[0];
  assert.equal(decision.execution.operations.length, 1);
  const op = decision.execution.operations[0];
  assert.equal(op.required, true);
  assert.equal(op.binding.ownerParticipantId, owner);
  assert.deepEqual(op.binding.effectScope, { readPaths: [], writePaths: [], exactCommands: ["node --version"],
    allowEnvironmentAccess: false, allowNetworkAccess: false });
  assert.equal(op.binding.workingDirectory, undefined);
  assert.deepEqual(decision.selectedTeammateIds, [owner]);
  assert.equal(f.diagnostics().filter(e => e.data.outcome === "bound").length, 1);
  assert.match(f.prompts[0], /No-file command example/u);
});

for (const [label, repair] of [
  ["reply escape", { action: "reply", reason: "Pretend success" }],
  ["transport error", new Error("PRIVATE_ERROR /private/provider")],
]) test(`failed binding repair (${label}) retains a blocker and safe outcome`, async t => {
  const f = await fixture(t, [execute(undefined), repair]);
  const result = await f.select();
  assert.equal(result.action, "blocked");
  assert.equal(f.prompts.length, 2);
  assert.ok(f.diagnostics().some(e => e.data.outcome === (label === "reply escape" ? "repair_action_rejected" : "transport_error")));
  assert.doesNotMatch(JSON.stringify(f.diagnostics().map(e => e.data)), /PRIVATE_ERROR|\/private/u);
});

test("compaction exhausts the same two requests and records the final shape rejection", async t => {
  const f = await fixture(t, [new Error("maximum context length exceeded"), execute(undefined)]);
  const result = await f.select();
  assert.equal(result.action, "blocked");
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.diagnostics().filter(e => e.action === "channel_intent.request_started").map(e => e.data.purpose),
    ["initial", "compaction_retry"]);
  assert.ok(f.diagnostics().some(e => e.data.outcome === "shape_rejected"));
});

test("genuine clarification and ordinary content still do not dispatch work", async t => {
  const f = await fixture(t, [{ action: "clarify", reason: "A real product choice is missing",
    clarification: { missingFields: ["acceptance"], question: "需要保留哪种输出格式？" } }]);
  const result = await f.select();
  assert.equal(result.action, "clarify");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
});

test("ordinary in-conversation content remains a one-request reply", async t => {
  const f = await fixture(t, [{ action: "reply", reason: "Answer the conceptual question" }], "解释一下版本号的含义，不执行任何命令。");
  const result = await f.select();
  assert.equal(result.action, "continue");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
  assert.equal(f.store.listChannelExecutionProposals({ channelId: f.channel.id }).length, 0);
});

for (const ordinal of [1, 2]) for (const phase of ["request_started", "request_finished", "validation"]) {
  test(`diagnostic Host write failure at request ${ordinal} ${phase} is not swallowed as a model failure`, async t => {
    const f = await fixture(t, [execute(undefined)]);
    const append = f.store.appendControlPlaneEvent.bind(f.store);
    const failure = new Error("injected diagnostic persistence failure");
    f.store.appendControlPlaneEvent = (input, now) => {
      if (input.action === `channel_intent.${phase}` && input.data.requestOrdinal === ordinal) throw failure;
      return append(input, now);
    };
    await assert.rejects(f.select(), error => error.cause === failure);
    assert.equal(f.store.listChannelIntentDecisions({ sourceItemId: f.source.id }).length, 0);
    assert.equal(f.store.listRuns({ channelId: f.channel.id }).length, 0);
    assert.equal(f.prompts.length, phase === "request_started" ? ordinal - 1 : ordinal);
  });
}

test("a partially published invalid-plan blocker recovers without another model request", async t => {
  const f = await fixture(t, [execute(undefined)]);
  const createDecision = f.store.createChannelIntentDecision.bind(f.store);
  f.store.createChannelIntentDecision = () => { throw new Error("injected blocker decision failure"); };
  await assert.rejects(f.select(), /Could not persist/u);
  f.store.createChannelIntentDecision = createDecision;
  const source = f.store.getConversationItem(f.source.id);
  const item = f.store.getConversationItemByIdempotencyKey(source.threadId, `channel-operation-plan-blocker:${source.id}`);
  assert.equal(item.payload.deliveryStatus, "blocked");
  const observed = f.diagnostics();
  f.reopen();
  const recovered = await f.select();
  assert.equal(recovered.errorCode, "channel_operation_plan_invalid");
  assert.equal(recovered.aiReply.id, item.id);
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.diagnostics(), observed);
});

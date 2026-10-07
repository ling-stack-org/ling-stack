import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { bindChannelOperationPlan, isChannelOperationCandidatePlanV2 } from "../dist/features/channels/channel-operation-bindings.js";
import { assignExecutionOperationOwners, requiredToolsForExecutionOperations } from "../dist/features/channels/workflow-operation-ownership.js";
import { confirmChannelExecutionProposalWorkflow } from "../dist/features/channels/proposal-workflows.js";
import { isChannelIntentExecutionPlanV1, channelOperationPlanFingerprintV1 } from "@ling-stack/contracts";

// C01 request reconstructed from the packaged capture and explicit file-ref labels.
// No model, command execution, permission expansion or project file write is used.
const c01 = "【C01 双 Agent 真实协作】请组织 Engineer 与 QA 两位队友协作验收当前工作区的 morning-todo 小项目，两位都是必需参与者。Engineer 先简短叙述，再真实读取 todo.mjs 和 app.js，检查实现并写入 morning-todo/engineer-review.md；QA 先简短叙述，再真实读取 todo.test.mjs 和 index.html，检查测试覆盖与键盘可访问性并写入 morning-todo/qa-review.md。两人只读现有代码，各自只写自己的 review 文件，不修改其他文件、不运行命令、不访问环境或密钥。必须等两位真实文件证据到齐才汇总；若不能委派或工具不可用，明确说明阻塞，不要用“我会做”宣称完成。汇总用两个自然段和三项列表，附两个报告文件链接。";
const workflowChoice = { action: "workflow_proposal", reason: "Engineer 与 QA 分别读取源码、写自己的 review；只读现有代码，不运行命令，两份文件证据齐备后汇总。" };

async function select(t, body = c01, modelOutput = workflowChoice, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-c01-operation-contract-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const now = "2026-09-06T00:00:00.000Z";
  const provider = store.createProviderPreset({ kind: "glm", displayName: "C01 static selector", providerId: "static", model: "static",
    api: "google-generative-ai", capabilities: ["chat"], input: ["text"], authHeader: false, enabled: true }, now);
  store.recordProviderCheckResult(provider.id, { ok: true, checkedAt: now, message: "Test fixture only; no provider request" });
  const channel = store.createChannel({ name: "C01 read-only", boundPath: cwd, defaultProviderPresetId: provider.id,
    allowedTools: options.allowedTools ?? ["read", "grep", "find", "ls"] }, now);
  const participantIds = options.participantIds ?? ["teammate_builtin_engineer", "teammate_builtin_qa"];
  for (const teammateId of participantIds) {
    store.replaceTeammateChannelMemberships(teammateId, [{ channelId: channel.id }], now);
  }
  const sourceMessage = appendChannelItemFixture(store, {
    channelId: channel.id,
    authorType: "local-user",
    body,
    mentions: options.mentions ?? [],
  }, now);
  let classifications = 0;
  const prompts = [];
  const result = await selectChannelWorkflowIntent({ store, channel, sourceMessage,
    secretResolver: createCompositeSecretResolver({ env: {} }), config: { channels: { intentSelector: true } },
    runnerRegistry: { resolve: () => ({ runner: { adapter: { runTask: async (input) => {
      classifications += 1;
      prompts.push(input.task.prompt);
      assert.deepEqual(input.tools, []);
      if (classifications === 2 && options.repairError) throw options.repairError;
      const output = options.repairOutput && classifications === 2 ? options.repairOutput : modelOutput;
      input.onEvent({ type: "assistant_text_delta", text: JSON.stringify(output) });
      return { messages: [] };
    } } } }) },
  });
  const expectedClassifications = options.expectedClassifications ?? (
    (modelOutput.action === "execute" || modelOutput.action === "workflow_proposal")
      && !isChannelOperationCandidatePlanV2(modelOutput.execution) ? 2 : 1);
  assert.equal(classifications, expectedClassifications,
    "must exercise the real model-policy application path with the expected bounded request count");
  assert.deepEqual(store.getChannel(channel.id).allowedTools, options.allowedTools ?? ["read", "grep", "find", "ls"]);
  assert.equal(store.listRuns({ channelId: channel.id, limit: 20 }).length, 0);
  assert.equal(store.listTasks({ channelId: channel.id, limit: 20 }).length, 0);
  const decision = store.listChannelIntentDecisions({ sourceItemId: sourceMessage.id, limit: 10 })[0];
  assert.notEqual(decision?.action, "reply", decision?.reason);
  const operations = decision?.execution?.operations ?? [];
  return { result, decision, operations, store, channel, prompts };
}

test("incomplete operation graph gets one bounded repair before Host binding", async (t) => {
  const valid = c01BoundCandidate();
  const malformed = structuredClone(valid);
  delete malformed.operations[0].owner;
  const { result, decision, prompts } = await select(t, c01,
    { action: "execute", reason: "Source-bound work", execution: malformed },
    { repairOutput: { action: "execute", reason: "Repaired graph", execution: valid }, expectedClassifications: 2 });
  assert.equal(result.action, "workflow_proposal");
  assert.equal(decision.action, "execute");
  assert.match(prompts[1], /one corrected strict JSON object/u);
});

test("valid-shaped owner-span mistakes receive one repair without weakening Host binding", async (t) => {
  const valid = c01BoundCandidate();
  const invalid = structuredClone(valid);
  invalid.operations[0].sourceQuote = "真实读取 todo.mjs 和 app.js";
  assert.equal(isChannelOperationCandidatePlanV2(invalid), true);
  const { result, decision, operations, prompts } = await select(t, c01,
    { action: "execute", reason: "Two source-bound participants", execution: invalid },
    { repairOutput: { action: "execute", reason: "Corrected verbatim owner span", execution: valid }, expectedClassifications: 2 });
  assert.equal(result.action, "workflow_proposal");
  assert.equal(decision.action, "execute");
  assert.equal(operations.length, 6);
  assert.deepEqual(operations.map((operation) => operation.binding.ownerParticipantId),
    valid.operations.map((operation) => operation.owner.participantId));
  assert.match(prompts[1], /owner.sourceQuote/u);
  assert.match(prompts[1], /instruction span/u);
  assert.deepEqual(operations.filter((operation) => operation.kind === "file_create").map((operation) => operation.targetRef.label),
    ["morning-todo/engineer-review.md", "morning-todo/qa-review.md"]);
});

test("repeated semantic binding failure stays closed after exactly one repair", async (t) => {
  const invalid = c01BoundCandidate();
  invalid.operations[0].owner = invalid.operations[3].owner;
  const { result, decision, operations, prompts } = await select(t, c01,
    { action: "execute", reason: "Invalid cross-owner span", execution: invalid }, { expectedClassifications: 2 });
  assert.equal(prompts.length, 2);
  assert.equal(result.action, "clarify");
  assert.deepEqual(decision.clarification.missingFields, ["owner.sourceQuote"]);
  assert.deepEqual(operations, []);
  assert.doesNotMatch(result.aiReply.body, /owner\.sourceQuote/u, "internal validator fields are audit facts, not user prose");
});

test("semantic repair cannot evade the binding gate by changing to a text reply", async (t) => {
  const invalid = c01BoundCandidate();
  invalid.operations[0].sourceQuote = "真实读取 todo.mjs 和 app.js";
  const { result, decision, operations } = await select(t, c01,
    { action: "execute", reason: "Invalid owner span", execution: invalid },
    { repairOutput: { action: "reply", reason: "Pretend that work was completed" }, expectedClassifications: 2 });
  assert.equal(result.action, "clarify");
  assert.equal(decision.action, "clarify");
  assert.deepEqual(operations, []);
});

test("failed semantic repair transport retains the original fail-closed decision", async (t) => {
  const invalid = c01BoundCandidate();
  invalid.operations[0].sourceQuote = "真实读取 todo.mjs 和 app.js";
  const { result, decision, operations, prompts } = await select(t, c01,
    { action: "execute", reason: "Invalid owner span", execution: invalid },
    { repairError: new Error("Fixture transport disconnected"), expectedClassifications: 2 });
  assert.equal(prompts.length, 2);
  assert.equal(result.action, "clarify");
  assert.match(decision.reason, /instruction span/u);
  assert.deepEqual(operations, []);
});

test("repair cannot evade Host source binding by inventing a quote", async (t) => {
  const malformed = structuredClone(c01BoundCandidate());
  delete malformed.operations[0].owner;
  const invented = structuredClone(c01BoundCandidate());
  invented.operations[0].sourceQuote = "a source quote not present in the user turn";
  const { result, decision } = await select(t, c01,
    { action: "execute", reason: "Incomplete work", execution: malformed },
    { repairOutput: { action: "execute", reason: "Invented provenance", execution: invented }, expectedClassifications: 2 });
  assert.equal(result.action, "clarify");
  assert.equal(decision.action, "clarify");
});

test("repeated malformed operation graph stops after one repair request", async (t) => {
  const malformed = structuredClone(c01BoundCandidate());
  delete malformed.operations[0].owner;
  const { result, decision, prompts } = await select(t, c01,
    { action: "execute", reason: "Incomplete work", execution: malformed },
    { expectedClassifications: 2 });
  assert.equal(prompts.length, 2);
  assert.equal(result.action, "clarify");
  assert.equal(decision.action, "clarify");
});

test("explicit review-only participant stays required when another participant owns the Host operation", async (t) => {
  const command = `node -e "process.stdout.write('N05-FIX-20260918')"`;
  const body = `@Designer 检查本频道消息渲染并返回一条 evidence。@Engineer 执行命令 ${command}，并返回 stdout 与 exit code。只有两个 participant evidence 都到齐后才汇总。`;
  const modelOutput = {
    action: "execute",
    reason: "Designer supplies review evidence while Engineer owns the exact command.",
    execution: {
      schemaVersion: 2,
      operations: [{
        id: "run_n05_command",
        kind: "run_command",
        targetKind: "command",
        required: true,
        dependsOn: [],
        owner: {
          participantId: "teammate_builtin_engineer",
          sourceQuote: "Engineer",
        },
        sourceQuote: `@Engineer 执行命令 ${command}`,
        command: { text: command, sourceQuote: command },
      }],
    },
  };
  const { result, decision } = await select(t, body, modelOutput, {
    participantIds: ["teammate_builtin_designer", "teammate_builtin_engineer"],
    mentions: [
      { id: "teammate_builtin_designer", label: "Designer", kind: "ai-teammate" },
      { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
    ],
    allowedTools: ["read", "bash"],
  });

  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  assert.equal(decision.action, "execute");
  assert.deepEqual(decision.participantManifest.participants.map((participant) => ({
    participantId: participant.participantId,
    expectedOutcome: participant.expectedOutcome,
    requiredOperationIds: participant.requiredOperationIds,
  })), [
    {
      participantId: "teammate_builtin_designer",
      expectedOutcome: "synthesis",
      requiredOperationIds: [],
    },
    {
      participantId: "teammate_builtin_engineer",
      expectedOutcome: "execution",
      requiredOperationIds: ["run_n05_command"],
    },
  ]);
});

test("C01 negated edits must not become file_edit of the first read input", async (t) => {
  const { operations } = await select(t);
  assert.deepEqual(operations.filter((operation) => operation.kind === "file_edit"), [],
    "Do not translate 不修改其他文件 into permission to edit todo.mjs");
});

test("C01 no-command constraint must forbid synthesized exact verification commands", async (t) => {
  const { operations } = await select(t);
  assert.deepEqual(operations.filter((operation) => operation.kind === "run_command"), [],
    "Reading and review evidence is not permission to construct a node -e command");
});

test("C01 must preserve distinct review outputs or fail closed before accepting a guessed execution", async (t) => {
  const { result, operations } = await select(t);
  if (["clarify", "blocked"].includes(result.action)) return;
  assert.deepEqual(operations.filter((operation) => ["file_create", "file_edit"].includes(operation.kind))
    .map((operation) => operation.targetRef.label).sort(),
  ["morning-todo/engineer-review.md", "morning-todo/qa-review.md"],
  "No accepted executable plan may replace two declared output paths with a read input");
});

test("model typed operation graph cannot be silently replaced by one host-guessed target", async (t) => {
  const modelOutput = { action: "execute", reason: "Two independent review outputs, not an implementation edit", execution: { operations: [
    { id: "engineer_review", kind: "file_create", targetKind: "file", required: true, dependsOn: [] },
    { id: "qa_review", kind: "file_create", targetKind: "file", required: true, dependsOn: [] },
  ] } };
  const { result, operations } = await select(t, c01, modelOutput);
  if (["clarify", "blocked"].includes(result.action)) return;
  assert.deepEqual(operations.filter((operation) => operation.kind === "file_create").map((operation) => operation.id).sort(),
    ["engineer_review", "qa_review"], "Bind each candidate operation or report ambiguity; do not collapse the typed graph to a kind set");
});

function c01BoundCandidate() {
  const engineer = "Engineer 先简短叙述，再真实读取 todo.mjs 和 app.js，检查实现并写入 morning-todo/engineer-review.md";
  const qa = "QA 先简短叙述，再真实读取 todo.test.mjs 和 index.html，检查测试覆盖与键盘可访问性并写入 morning-todo/qa-review.md";
  const group = (ownerId, prefix, sourceQuote, inputs, output, objective) => {
    const owner = { participantId: ownerId, sourceQuote };
    const reads = inputs.map((path, index) => ({ id: `${prefix}_read_${index + 1}`, kind: "file_read", targetKind: "file",
      required: true, dependsOn: [], owner, sourceQuote,
      target: { path, sourceQuote: path, relativeTo: { path: "morning-todo", sourceQuote: "当前工作区的 morning-todo 小项目" } } }));
    return [...reads, { id: `${prefix}_review`, kind: "file_create", targetKind: "file", required: true,
      dependsOn: reads.map((read) => read.id), owner, sourceQuote, target: { path: output, sourceQuote: output },
      contentSource: { kind: "generated_objective", text: objective, sourceQuote: objective,
        inputOperationIds: reads.map((read) => read.id) } }];
  };
  return { schemaVersion: 2, operations: [
    ...group("teammate_builtin_engineer", "engineer", engineer, ["todo.mjs", "app.js"], "morning-todo/engineer-review.md", "检查实现"),
    ...group("teammate_builtin_qa", "qa", qa, ["todo.test.mjs", "index.html"], "morning-todo/qa-review.md", "检查测试覆盖与键盘可访问性"),
  ] };
}

test("C01 full bindings compile six operations with distinct stable owners, inputs and generated outputs", async (t) => {
  const candidate = c01BoundCandidate();
  const { result, decision, operations, store, channel } = await select(t, c01,
    { action: "workflow_proposal", reason: "Two source-bound review outputs", execution: candidate });
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  assert.equal(decision.action, "execute");
  assert.equal(decision.execution.bindingVersion, 1);
  assert.equal(isChannelIntentExecutionPlanV1(decision.execution), true);
  assert.deepEqual(operations.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })),
    candidate.operations.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })));
  assert.deepEqual(operations.filter((op) => op.kind === "file_read").map((op) => op.binding.inputRefs[0].path),
    ["morning-todo/todo.mjs", "morning-todo/app.js", "morning-todo/todo.test.mjs", "morning-todo/index.html"]);
  const writes = operations.filter((op) => op.kind === "file_create");
  assert.deepEqual(writes.map((op) => [op.binding.ownerParticipantId, op.binding.outputRefs[0].path]), [
    ["teammate_builtin_engineer", "morning-todo/engineer-review.md"],
    ["teammate_builtin_qa", "morning-todo/qa-review.md"],
  ]);
  assert.ok(writes.every((op) => op.binding.contentSource.kind === "generated_objective"));
  assert.ok(operations.every((op) => op.binding.effectScope.exactCommands.length === 0));
  assert.deepEqual(requiredToolsForExecutionOperations(operations), ["read", "write"]);
  assert.deepEqual(result.proposal.requiredTools, ["read", "write"]);
  assert.equal(result.proposal.status, "blocked", "binding cannot expand either QA capability or channel tools");
  assert.match(result.proposal.errorMessage, /teammate_builtin_qa.*missing required tool write/u);
  assert.match(result.proposal.errorMessage, /not allowed in this channel: write/u);
  assert.deepEqual(decision.participantManifest.participants.map((participant) => participant.requiredOperationIds),
    [["engineer_read_1", "engineer_read_2", "engineer_review"], ["qa_read_1", "qa_read_2", "qa_review"]]);
  assert.deepEqual(store.getChannel(channel.id).allowedTools, ["read", "grep", "find", "ls"]);
  assert.throws(() => confirmChannelExecutionProposalWorkflow({ store, cwd: channel.boundPath,
    proposalId: result.proposal.id, validateRunRequest: () => undefined }), { code: "proposal_required_tools_not_available" });
  assert.equal(store.listRuns({ channelId: channel.id, limit: 20 }).length, 0);
  assert.equal(store.listTasks({ channelId: channel.id, limit: 20 }).length, 0);
});

test("bound owners do not change when participant enumeration order changes", async (t) => {
  const { operations, store } = await select(t, c01,
    { action: "execute", reason: "Bound independent outputs", execution: c01BoundCandidate() });
  assert.equal(operations.length, 6);
  const participants = ["teammate_builtin_qa", "teammate_builtin_engineer"].map((id) => ({ teammate: store.getAiTeammate(id) }));
  const owners = assignExecutionOperationOwners(operations, participants);
  for (const operation of operations) assert.equal(participants[owners.get(operation.id)].teammate.id, operation.binding.ownerParticipantId);
  assert.throws(() => assignExecutionOperationOwners(operations, participants.slice(0, 1)), /operation_owner_not_available/u);
});

for (const [name, mutate] of [
  ["unbound owner", (plan) => { plan.operations[0].owner.participantId = "missing"; }],
  ["invented target", (plan) => { plan.operations[0].target.path = "other.mjs"; }],
  ["owner from another instruction span", (plan) => { plan.operations[0].owner = plan.operations[3].owner; }],
  ["missing owner field", (plan) => { delete plan.operations[0].owner; }],
  ["duplicate operation ID", (plan) => { plan.operations[1].id = plan.operations[0].id; }],
  ["cycle", (plan) => { plan.operations[0].dependsOn = ["engineer_review"]; }],
  ["missing dependency", (plan) => { plan.operations[2].dependsOn = []; }],
  ["another owner's generated input", (plan) => { plan.operations[2].dependsOn = ["qa_read_1"]; plan.operations[2].contentSource.inputOperationIds = ["qa_read_1"]; }],
  ["path/instruction suffix as literal", (plan) => { plan.operations[2].contentSource = { kind: "literal", text: "not quoted content", sourceQuote: "morning-todo/engineer-review.md" }; }],
]) {
  test(`typed binding fails closed for ${name} without accepting a guessed plan`, async (t) => {
    const candidate = c01BoundCandidate(); mutate(candidate);
    const { result, decision, operations } = await select(t, c01,
      { action: "execute", reason: "Invalid candidate must not trigger materialization fallback", execution: candidate },
      { expectedClassifications: 2 });
    assert.equal(result.action, "clarify");
    assert.equal(decision.action, "clarify");
    assert.deepEqual(operations, []);
  });
}

test("binding contract fingerprint covers owner, scope and content and rejects mixed legacy/bound graphs", async (t) => {
  const { decision } = await select(t, c01,
    { action: "execute", reason: "Bound independent outputs", execution: c01BoundCandidate() });
  const original = decision.execution;
  assert.equal(isChannelIntentExecutionPlanV1(original), true);
  for (const mutate of [
    (plan) => { plan.operations[0].binding.ownerParticipantId = "other"; },
    (plan) => { plan.operations[0].binding.effectScope.readPaths = ["other.mjs"]; },
    (plan) => { plan.operations[2].binding.contentSource.text = "different objective"; },
    (plan) => { delete plan.operations[0].binding; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    assert.notEqual(channelOperationPlanFingerprintV1(changed.operations), original.fingerprint);
    assert.equal(isChannelIntentExecutionPlanV1(changed), false);
  }
  const legacy = { operations: [{ id: "old", kind: "file_create", targetKind: "file", targetRef: { type: "operation", id: "old", label: "legacy.md" }, required: true, dependsOn: [] }] };
  assert.equal(isChannelIntentExecutionPlanV1(legacy), true, "historical V1 records remain readable without rewriting them");
});

test("literal content and generated objective remain distinct source-bound payloads", async (t) => {
  const { store, channel } = await select(t);
  const body = "Engineer 创建 result.txt，内容是“状态回归”。";
  const bound = bindChannelOperationPlan({ sourceItemId: "fixture_source", sourceText: body, workspaceCwd: channel.boundPath,
    participants: [store.getAiTeammate("teammate_builtin_engineer")], candidate: { schemaVersion: 2, operations: [{
      id: "literal_output", kind: "file_create", targetKind: "file", required: true, dependsOn: [], sourceQuote: body,
      owner: { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" }, target: { path: "result.txt", sourceQuote: "result.txt" },
      contentSource: { kind: "literal", text: "状态回归", sourceQuote: "“状态回归”" },
    }] } });
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.equal(bound.execution.operations[0].binding.contentSource.kind, "literal");
  assert.equal(bound.execution.operations[0].binding.contentSource.text, "状态回归");
});

test("an exact command stages only source-bound inputs tied to explicit file dependencies", async (t) => {
  const { store, channel } = await select(t);
  const command = `node -e "require('fs').readFileSync('proof.txt','utf8')"`;
  const body = `Engineer 创建 proof.txt，内容为 ok；QA 执行精确命令 ${command} 验证 proof.txt。`;
  const candidate = { schemaVersion: 2, operations: [
    {
      id: "create_file", kind: "file_create", targetKind: "file", required: true, dependsOn: [], sourceQuote: body,
      owner: { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" },
      target: { path: "proof.txt", sourceQuote: "proof.txt" },
      contentSource: { kind: "literal", text: "ok", sourceQuote: "内容为 ok" },
    },
    {
      id: "verify_target", kind: "run_command", targetKind: "command", required: true, dependsOn: ["create_file"], sourceQuote: body,
      owner: { participantId: "teammate_builtin_qa", sourceQuote: "QA" },
      inputs: [{ path: "proof.txt", sourceQuote: "proof.txt", fromOperationId: "create_file" }],
      command: { text: command, sourceQuote: command },
    },
  ] };
  const bind = (plan) => bindChannelOperationPlan({ sourceItemId: "fixture_source", sourceText: body,
    workspaceCwd: channel.boundPath, participants: [
      store.getAiTeammate("teammate_builtin_engineer"),
      store.getAiTeammate("teammate_builtin_qa"),
    ], candidate: plan });
  const bound = bind(candidate);
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  const commandOperation = bound.execution.operations[1];
  assert.deepEqual(commandOperation.binding.inputRefs.map((ref) => ref.path), ["proof.txt"]);
  assert.deepEqual(commandOperation.binding.effectScope.readPaths, ["proof.txt"]);
  assert.equal(isChannelIntentExecutionPlanV1(bound.execution), true);

  for (const mutate of [
    (plan) => { plan.operations[1].dependsOn = []; },
    (plan) => { plan.operations[1].inputs[0].fromOperationId = "missing"; },
    (plan) => { plan.operations[1].inputs[0].path = "other.txt"; plan.operations[1].inputs[0].sourceQuote = "other.txt"; plan.operations[1].sourceQuote += " other.txt"; },
  ]) {
    const changed = structuredClone(candidate); mutate(changed);
    assert.equal(bind(changed).status, "clarify");
  }
});

test("typed file targets reject traversal and symlink escapes without reading file contents", async (t) => {
  const { store, channel } = await select(t);
  const outside = await mkdtemp(join(tmpdir(), "ling-c01-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(channel.boundPath, "escape"));
  await symlink(join(outside, "does-not-exist"), join(channel.boundPath, "dangling"));
  for (const path of ["../outside.txt", "escape/outside.txt", "dangling/outside.txt"]) {
    const body = `Engineer 读取 ${path}`;
    const result = bindChannelOperationPlan({ sourceItemId: "fixture_source", sourceText: body, workspaceCwd: channel.boundPath,
      participants: [store.getAiTeammate("teammate_builtin_engineer")], candidate: { schemaVersion: 2, operations: [{
        id: "read", kind: "file_read", targetKind: "file", required: true, dependsOn: [], sourceQuote: body,
        owner: { participantId: "teammate_builtin_engineer", sourceQuote: "Engineer" }, target: { path, sourceQuote: path },
      }] } });
    assert.equal(result.status, "clarify", `${path}: ${JSON.stringify(result)}`);
  }
});

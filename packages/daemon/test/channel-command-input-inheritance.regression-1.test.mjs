import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";

// Regression: channel policy inheritance must not require a fabricated user directory quote.
// Found by /qa on 2026-10-27
// Report: output/e6-20260928/channel-policy-command-inputs-implementation-20261027.md
const authority = {
  kind: "channel_effective_policy_v1", channelId: "channel", workspaceId: "workspace",
  participantId: "qa", operationId: "validate", sourceItemId: "user", sourceRevision: 0,
  workspaceCwd: "/workspace", executionCwd: "/workspace",
  workspaceRootIdentity: { device: "1", inode: "2" }, executionRootIdentity: { device: "1", inode: "2" },
  channelUpdatedAt: "2026-10-27T14:00:00.000Z", workspacePolicyUpdatedAt: "2026-10-27T14:00:00.000Z",
  policyFingerprint: "a".repeat(64),
};
async function fixture(t, suffix = "") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-input-inherit-"));
  await mkdir(join(cwd, "project"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const body = `@QA 运行 node project/validate.cjs，入口 project/validate.cjs。${suffix}`;
  const operation = { id: "validate", kind: "run_command", targetKind: "command", required: true, dependsOn: [],
    owner: { participantId: "qa", sourceQuote: "QA" }, sourceQuote: body,
    command: { text: "node project/validate.cjs", sourceQuote: "node project/validate.cjs" },
    inputs: [{ path: "project/validate.cjs", sourceQuote: "project/validate.cjs" }] };
  let calls = 0;
  return { operation, body, bind(overrides = {}) { return bindChannelOperationPlan({
    candidate: { schemaVersion: 2, operations: [operation] }, sourceItemId: "user", sourceText: body,
    workspaceCwd: cwd, participants: [{ id: "qa", displayName: "QA", roleKey: "qa", allowedTools: ["bash", "read"] }],
    visibleSources: [{ itemId: "user", revision: 0, actorType: "local_user", body }],
    compileCommandInputScope: input => {
      calls++; assert.equal(input.operationId, "validate"); assert.equal(input.participantId, "qa");
      assert.equal(input.sourceItemId, "user");
      return { kind: "node_module_closure_v1", projectRoot: ".", sourceRefs: [], policyAuthority: authority };
    }, ...overrides }); }, get calls() { return calls; } };
}
test("new ordinary command inherits Host policy scope without a directory quote", async t => {
  const f = await fixture(t), result = f.bind();
  assert.equal(result.status, "bound", JSON.stringify(result));
  assert.deepEqual(result.execution.operations[0].binding.commandInputScope?.policyAuthority, authority);
  assert.deepEqual(result.execution.operations[0].binding.effectScope.readPaths, ["project/validate.cjs"]);
  assert.equal(f.calls, 1);
});
for (const restriction of ["请先询问依赖目录再开始。", "只读 project/validate.cjs，不能读取其他文件。",
  "Ask me for the dependency scope before execution.", "Only read this file; do not read other files."]) {
  test(`explicit task restriction forbids automatic inheritance: ${restriction}`, async t => {
    const f = await fixture(t, restriction), result = f.bind();
    assert.equal(result.status, "bound", JSON.stringify(result));
    assert.equal(result.execution.operations[0].binding.commandInputScope, undefined);
    assert.equal(f.calls, 0);
  });
}
test("model may narrow inheritance with a quoted constraint but cannot supply authority", async t => {
  const f = await fixture(t, "先征求目录意见。先征求目录意见"), quote = "先征求目录意见";
  f.operation.commandInputConstraint = { mode: "ask_first", sourceQuote: quote };
  const result = f.bind();
  assert.equal(result.status, "bound", JSON.stringify(result));
  assert.equal(result.execution.operations[0].binding.commandInputScope, undefined);
  assert.equal(f.calls, 0);
  f.operation.commandInputConstraint.sourceQuote = "invented";
  assert.equal(f.bind().status, "clarify");
  delete f.operation.commandInputConstraint;
  f.operation.policyAuthority = authority;
  assert.equal(f.bind().status, "clarify");
});
test("legacy caller and denied Host compiler do not gain a scope", async t => {
  const f = await fixture(t);
  assert.equal(f.bind({ compileCommandInputScope: undefined }).execution.operations[0].binding.commandInputScope, undefined);
  assert.equal(f.bind({ compileCommandInputScope: () => undefined }).status, "blocked");
});

test("a model's direct-input restriction cannot override the user's ask-first requirement", async t => {
  const f = await fixture(t, "请先询问依赖目录再开始。只读取 project/validate.cjs。");
  f.operation.commandInputConstraint = { mode: "direct_inputs_only", sourceQuote: "只读取 project/validate.cjs" };
  const result = f.bind();
  assert.equal(result.status, "bound", JSON.stringify(result));
  assert.deepEqual(result.pendingInputScopeOperationIds, ["validate"]);
  assert.equal(result.execution.operations[0].binding.commandInputScope, undefined);
  assert.equal(f.calls, 0);
});

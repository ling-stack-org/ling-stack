import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";
import { channelOperationPlanFingerprintV1, isChannelIntentExecutionPlanV1 } from "@ling-stack/contracts";

async function fixture(t, body = "Engineer 在项目目录 project 内使用依赖，运行 node project/cli.js data.csv") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-project-binding-"));
  await mkdir(join(cwd, "project"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const operation = { id: "cli", kind: "run_command", targetKind: "command", required: true, dependsOn: [],
    owner: { participantId: "engineer", sourceQuote: "Engineer" }, sourceQuote: body,
    command: { text: "node project/cli.js data.csv", sourceQuote: "node project/cli.js data.csv" },
    inputs: [{ path: "project/cli.js", sourceQuote: "project/cli.js" }, { path: "data.csv", sourceQuote: "data.csv" }],
    projectInputRoot: { path: "project", sourceQuote: "项目目录 project 内使用依赖" } };
  const bind = () => bindChannelOperationPlan({ candidate: { schemaVersion: 2, operations: [operation] },
    workspaceCwd: cwd, sourceItemId: "user-item", sourceText: body,
    participants: [{ id: "engineer", displayName: "Engineer", roleKey: "engineer", allowedTools: ["bash"] }] });
  return { operation, bind };
}

test("Host freezes a source-bound project input scope without widening direct tool read paths", async t => {
  const f = await fixture(t), bound = f.bind();
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  const binding = bound.execution.operations[0].binding;
  assert.equal(binding.commandInputScope.kind, "node_module_closure_v1");
  assert.equal(binding.commandInputScope.projectRoot, "project");
  assert.ok(binding.commandInputScope.sourceRefs.every(ref => ref.itemId === "user-item" && ref.actorType === "local_user"));
  assert.deepEqual(binding.effectScope.readPaths, ["project/cli.js", "data.csv"]);
  assert.equal(isChannelIntentExecutionPlanV1(bound.execution), true);
  const tampered = structuredClone(bound.execution);
  tampered.operations[0].binding.commandInputScope.projectRoot = "another-project";
  assert.equal(isChannelIntentExecutionPlanV1(tampered), false, "scope is covered by plan fingerprint");
  tampered.fingerprint = channelOperationPlanFingerprintV1(tampered.operations);
  assert.equal(isChannelIntentExecutionPlanV1(tampered), false, "scope still needs matching source provenance");
});

test("a command path prefix is not permission to read its parent project", async t => {
  const f = await fixture(t, "Engineer 运行 node project/cli.js data.csv");
  f.operation.projectInputRoot.sourceQuote = "node project/cli.js data.csv";
  assert.equal(f.bind().status, "clarify");
});

test("invented, historical and model-asserted scopes are rejected", async t => {
  const f = await fixture(t);
  f.operation.projectInputRoot.sourceQuote = "allow the entire workspace";
  assert.equal(f.bind().status, "clarify");
  f.operation.projectInputRoot = { path: "project", sourceQuote: "项目目录 project 内使用依赖", sourceItemId: "old-item" };
  assert.equal(f.bind().status, "clarify");
  f.operation.projectInputRoot = undefined;
  f.operation.commandInputScope = { kind: "node_module_closure_v1", projectRoot: "project", verified: true };
  assert.equal(f.bind().status, "clarify");
});

test("legacy operations preserve explicit files only", async t => {
  const f = await fixture(t);
  delete f.operation.projectInputRoot;
  const bound = f.bind();
  assert.equal(bound.status, "bound", JSON.stringify(bound));
  assert.equal(bound.execution.operations[0].binding.commandInputScope, undefined);
});

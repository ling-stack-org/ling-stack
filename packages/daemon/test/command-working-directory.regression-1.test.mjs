import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isChannelIntentExecutionPlanV1 } from "@ling-stack/contracts";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";

// Regression: C01-R8 — command cwd must not silently redefine input coordinates.
// Found by /qa on 2026-10-25
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/r8-input-coordinate-repair.md
async function fixture(t, inputs, extra = "") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-command-input-coordinates-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "case/project"), { recursive: true });
  const command = "node cli.js ../records.csv --json";
  const body = `Engineer：运行 ${command}；命令目录 case/project；独立目录 case；输入原文：${inputs.map(ref => ref.sourceQuote).join("；")}。${extra}`;
  const operation = { id: "run", kind: "run_command", targetKind: "command", required: true, dependsOn: [],
    owner: { participantId: "engineer", sourceQuote: "Engineer" }, sourceQuote: body,
    command: { text: command, sourceQuote: command },
    workingDirectory: { path: "case/project", sourceQuote: "命令目录 case/project" }, inputs };
  const request = { sourceItemId: "current", sourceText: body, workspaceCwd: cwd,
    participants: [{ id: "engineer", displayName: "Engineer", roleKey: "engineer", allowedTools: ["read", "write", "bash"] }] };
  const bind = (operations = [operation]) => bindChannelOperationPlan({ ...request, candidate: { schemaVersion: 2, operations } });
  return { cwd, body, operation, request, bind };
}
const anchor = () => ({ path: "case/project", sourceQuote: "命令目录 case/project" });
const paths = result => {
  assert.equal(result.status, "bound", JSON.stringify(result));
  assert.equal(isChannelIntentExecutionPlanV1(result.execution), true);
  return result.execution.operations.at(-1).binding.inputRefs.map(ref => ref.path);
};

test("canonical command inputs are not prefixed by workingDirectory", async t => {
  const f = await fixture(t, [
    { path: "case/project/cli.js", sourceQuote: "case/project/cli.js" },
    { path: "case/records.csv", sourceQuote: "case/records.csv" },
  ]);
  const result = f.bind();
  assert.deepEqual(paths(result), ["case/project/cli.js", "case/records.csv"]);
  assert.equal(result.execution.operations[0].commandMatchPolicy.command, f.operation.command.text);
  assert.equal(result.execution.operations[0].binding.workingDirectory.path, "case/project");
});

test("a bare basename stays workspace-relative; only relativeTo selects another file", async t => {
  const f = await fixture(t, [{ path: "cli.js", sourceQuote: "cli.js" }]);
  assert.deepEqual(paths(f.bind()), ["cli.js"]);
  f.operation.inputs[0].relativeTo = anchor();
  assert.deepEqual(paths(f.bind()), ["case/project/cli.js"]);
});

test("explicit anchors normalize command operands independently of process cwd", async t => {
  const f = await fixture(t, [
    { path: "cli.js", sourceQuote: "cli.js", relativeTo: anchor() },
    { path: "../records.csv", sourceQuote: "../records.csv", relativeTo: anchor() },
  ]);
  assert.deepEqual(paths(f.bind()), ["case/project/cli.js", "case/records.csv"]);
  delete f.operation.workingDirectory;
  assert.deepEqual(paths(f.bind()), ["case/project/cli.js", "case/records.csv"]);
});

test("normalization never erases symlink or non-directory anchors", async t => {
  const f = await fixture(t, [{ path: "../records.csv", sourceQuote: "../records.csv", relativeTo: anchor() }]);
  await rm(join(f.cwd, "case/project"), { recursive: true });
  await symlink(tmpdir(), join(f.cwd, "case/project"));
  delete f.operation.workingDirectory;
  assert.equal(f.bind().status, "clarify", "an erased outside symlink is not an input anchor");
  await rm(join(f.cwd, "case/project"));
  await writeFile(join(f.cwd, "case/project"), "not a directory");
  assert.equal(f.bind().status, "clarify", "an erased file is not an input anchor");
});

test("normalization never erases an internal symlink in the operand", async t => {
  const f = await fixture(t, [{ path: "alias/../cli.js", sourceQuote: "alias/../cli.js", relativeTo: anchor() }]);
  await symlink(tmpdir(), join(f.cwd, "case/project/alias"));
  assert.equal(f.bind().status, "clarify");
});

test("a missing prefix cannot suppress later symlink or non-directory checks", async t => {
  for (const kind of ["symlink", "file"]) {
    const path = "missing/../alias/../records.csv";
    const f = await fixture(t, [{ path, sourceQuote: path, relativeTo: anchor() }]);
    if (kind === "symlink") await symlink(tmpdir(), join(f.cwd, "case/project/alias"));
    else await writeFile(join(f.cwd, "case/project/alias"), "not a directory");
    assert.equal(f.bind().status, "clarify", kind);
  }
});

test("explicit future input directories remain valid without expanding file permissions", async t => {
  const path = "future/nested/records.csv";
  const f = await fixture(t, [{ path, sourceQuote: path, relativeTo: anchor() }]);
  const result = f.bind();
  assert.deepEqual(paths(result), ["case/project/future/nested/records.csv"]);
  assert.deepEqual(result.execution.operations[0].binding.effectScope.readPaths, ["case/project/future/nested/records.csv"]);
  assert.equal(result.execution.operations[0].binding.commandInputScope, undefined);
});

test("each invalid operand stays rejected with an otherwise valid anchor", async t => {
  for (const path of ["../../../escape.csv", "/tmp/escape.csv", "bad//file.csv", "bad\\file.csv", "bad\u0000file.csv", "*.csv"]) {
    const f = await fixture(t, [{ path, sourceQuote: path, relativeTo: anchor() }]);
    assert.equal(f.bind().status, "clarify", JSON.stringify(path));
  }
});

test("an anchor needs its own literal directory quote and current operation span", async t => {
  for (const relativeTo of [
    { path: "case", sourceQuote: "命令目录 case/project" },
    { path: "case/project", sourceQuote: "invented directory" },
    { path: "case/project/..", sourceQuote: "case/project/.." },
    { path: "case/project", sourceQuote: "QA 的目录 case/project" },
  ]) {
    const f = await fixture(t, [{ path: "cli.js", sourceQuote: "cli.js", relativeTo }]);
    f.request.sourceText += ` QA 的目录 case/project；case/project/..。`;
    assert.equal(f.bind().status, "clarify", JSON.stringify(relativeTo));
  }
});

test("a canonical quote cannot masquerade as a different literal operand", async t => {
  const f = await fixture(t, [{ path: "../records.csv", sourceQuote: "case/records.csv", relativeTo: anchor() }]);
  assert.equal(f.bind().status, "clarify");
});

test("historical anchors retain exact canonical registry provenance, never arbitrary item IDs", async t => {
  const f = await fixture(t, [{ path: "../records.csv", sourceQuote: "../records.csv",
    relativeTo: { path: "case/project", sourceQuote: "目录 case/project", sourceItemId: "prior" } }]);
  f.request.visibleSources = [{ itemId: "prior", body: "目录 case/project", revision: 3, actorType: "local_user" }];
  const result = f.bind();
  assert.deepEqual(paths(result), ["case/records.csv"]);
  assert.ok(result.execution.operations[0].binding.inputRefs[0].sourceRefs.some(ref =>
    ref.itemId === "prior" && ref.revision === 3 && ref.quote === "目录 case/project"));
  f.operation.inputs[0].relativeTo.sourceItemId = "unlisted";
  assert.equal(f.bind().status, "clarify");
});

test("producer matching uses canonical paths plus explicit dependency, not a shared basename", async t => {
  const f = await fixture(t, [{ path: "../records.csv", sourceQuote: "../records.csv", relativeTo: anchor(), fromOperationId: "create" }],
    "Engineer 创建 case/records.csv，内容为 sample；也提到 other/records.csv。");
  const producer = { id: "create", kind: "file_create", targetKind: "file", required: true, dependsOn: [],
    owner: { participantId: "engineer", sourceQuote: "Engineer" }, sourceQuote: f.body,
    target: { path: "case/records.csv", sourceQuote: "case/records.csv" },
    contentSource: { kind: "literal", text: "sample", sourceQuote: "sample" } };
  f.operation.dependsOn = ["create"];
  assert.deepEqual(paths(f.bind([producer, f.operation])), ["case/records.csv"]);
  producer.target = { path: "other/records.csv", sourceQuote: "other/records.csv" };
  assert.equal(f.bind([producer, f.operation]).status, "clarify");
  producer.target = { path: "case/records.csv", sourceQuote: "case/records.csv" };
  f.operation.dependsOn = [];
  assert.equal(f.bind([producer, f.operation]).status, "clarify");
});

test("canonical and explicitly anchored function modules generate the same cwd-relative import", async t => {
  for (const module of [
    { path: "case/proof.mjs", sourceQuote: "case/proof.mjs" },
    { path: "../proof.mjs", sourceQuote: "../proof.mjs", relativeTo: anchor() },
  ]) {
    const f = await fixture(t, [], `Engineer 用 Node 从 ${module.sourceQuote} 调用 proof("7319")。`);
    delete f.operation.command;
    delete f.operation.inputs;
    f.operation.commandGoal = { kind: "node_function", module, invocation: 'proof("7319")', sourceQuote: 'proof("7319")' };
    const result = f.bind();
    assert.deepEqual(paths(result), ["case/proof.mjs"]);
    assert.ok(result.execution.operations[0].commandMatchPolicy.command.includes('import("../proof.mjs")'));
  }
});

test("file targets still reject parent operands even with an explicit anchor", async t => {
  const f = await fixture(t, [{ path: "../records.csv", sourceQuote: "../records.csv", relativeTo: anchor() }]);
  f.operation.kind = "file_read";
  f.operation.targetKind = "file";
  f.operation.target = f.operation.inputs[0];
  delete f.operation.command;
  delete f.operation.inputs;
  delete f.operation.workingDirectory;
  assert.equal(f.bind().status, "clarify");
});

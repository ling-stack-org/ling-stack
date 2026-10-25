import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { channelOperationPlanFingerprintV1, isChannelIntentExecutionPlanV1 } from "@ling-stack/contracts";
import { bindChannelOperationPlan } from "../dist/features/channels/channel-operation-bindings.js";

async function fixture(t, command = "node cli.js ../records.csv") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-command-cwd-binding-"));
  await mkdir(join(cwd, "project"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const body = `Engineer 在目录 project 中运行 ${command}`;
  const operation = { id: "command", kind: "run_command", targetKind: "command", required: true, dependsOn: [],
    owner: { participantId: "engineer", sourceQuote: "Engineer" }, sourceQuote: body,
    command: { text: command, sourceQuote: command },
    workingDirectory: { path: "project", sourceQuote: "目录 project 中" },
    inputs: [{ path: "cli.js", sourceQuote: "cli.js" }, { path: "../records.csv", sourceQuote: "../records.csv" }] };
  const bind = () => bindChannelOperationPlan({ candidate: { schemaVersion: 2, operations: [operation] },
    sourceItemId: "current-user", sourceText: body, workspaceCwd: cwd,
    participants: [{ id: "engineer", displayName: "Engineer", roleKey: "engineer", allowedTools: ["bash"] }] });
  return { cwd, body, operation, bind };
}

test("an explicitly quoted command directory preserves raw argv and freezes canonical workspace inputs", async t => {
  const f = await fixture(t), result = f.bind();
  assert.equal(result.status, "bound", JSON.stringify(result));
  const operation = result.execution.operations[0];
  assert.equal(operation.commandMatchPolicy.command, "node cli.js ../records.csv");
  assert.equal(operation.binding.workingDirectory.path, "project");
  assert.deepEqual(operation.binding.inputRefs.map(ref => ref.path), ["project/cli.js", "records.csv"]);
  assert.ok(operation.binding.workingDirectory.sourceRefs.every(ref => ref.itemId === "current-user" && ref.actorType === "local_user"));
  assert.equal(isChannelIntentExecutionPlanV1(result.execution), true);
  const changed = structuredClone(result.execution);
  changed.operations[0].binding.workingDirectory.path = "another";
  changed.fingerprint = channelOperationPlanFingerprintV1(changed.operations);
  assert.equal(isChannelIntentExecutionPlanV1(changed), false, "a rehash cannot replace cwd provenance");
});

test("a script prefix or historical/invented directory quote cannot choose command cwd", async t => {
  const f = await fixture(t, "node project/cli.js ../records.csv");
  for (const directory of [
    { path: "project", sourceQuote: "node project/cli.js ../records.csv" },
    { path: "project", sourceQuote: "directory invented" },
    { path: "project", sourceQuote: "目录 project 中", sourceItemId: "historical-user" },
    { path: "../project", sourceQuote: "目录 project 中" },
  ]) {
    f.operation.workingDirectory = directory;
    assert.equal(f.bind().status, "clarify", JSON.stringify(directory));
  }
});

test("cwd cannot authorize workspace escapes or symlink directories", async t => {
  const f = await fixture(t, "node cli.js ../../records.csv");
  f.operation.inputs[1] = { path: "../../records.csv", sourceQuote: "../../records.csv" };
  assert.equal(f.bind().status, "clarify");
  const g = await fixture(t);
  await rm(join(g.cwd, "project"), { recursive: true });
  await symlink(tmpdir(), join(g.cwd, "project"));
  assert.equal(g.bind().status, "clarify");
});

test("a cwd quote does not grant local-module closure and cannot be attached to file operations", async t => {
  const f = await fixture(t), result = f.bind();
  assert.equal(result.status, "bound", JSON.stringify(result));
  assert.equal(result.execution.operations[0].binding.commandInputScope, undefined);
  f.operation.kind = "file_read";
  f.operation.targetKind = "file";
  f.operation.target = { path: "project/cli.js", sourceQuote: "cli.js" };
  delete f.operation.command;
  delete f.operation.inputs;
  assert.equal(f.bind().status, "clarify");
});

test("a request without workingDirectory retains root-relative paths and rejects raw parent inputs", async t => {
  const f = await fixture(t);
  delete f.operation.workingDirectory;
  assert.equal(f.bind().status, "clarify");
  f.operation.inputs = [{ path: "cli.js", sourceQuote: "cli.js" }];
  const result = f.bind();
  assert.equal(result.status, "bound", JSON.stringify(result));
  assert.deepEqual(result.execution.operations[0].binding.inputRefs.map(ref => ref.path), ["cli.js"]);
  assert.equal(result.execution.operations[0].binding.workingDirectory, undefined);
});

test("natural-language function goals keep canonical module paths and generate cwd-relative imports", async t => {
  for (const [path, canonical, importPath] of [["proof.mjs", "project/proof.mjs", "./proof.mjs"],
    ["../proof.mjs", "proof.mjs", "../proof.mjs"]]) {
    const f = await fixture(t, `Node 从 ${path} 调用 proof("7319")`);
    delete f.operation.command;
    delete f.operation.inputs;
    f.operation.commandGoal = { kind: "node_function", module: { path, sourceQuote: path },
      invocation: 'proof("7319")', sourceQuote: 'proof("7319")' };
    const result = f.bind();
    assert.equal(result.status, "bound", JSON.stringify(result));
    assert.equal(isChannelIntentExecutionPlanV1(result.execution), true);
    const operation = result.execution.operations[0];
    assert.equal(operation.binding.commandGoal.modulePath, canonical);
    assert.deepEqual(operation.binding.effectScope.readPaths, [canonical]);
    assert.ok(operation.commandMatchPolicy.command.includes(`import(${JSON.stringify(importPath)})`));
    const changed = structuredClone(result.execution);
    changed.operations[0].binding.workingDirectory.path = "different";
    changed.fingerprint = channelOperationPlanFingerprintV1(changed.operations);
    assert.equal(isChannelIntentExecutionPlanV1(changed), false);
  }
});

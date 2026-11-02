import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindChannelOperationPlan, commandInputInheritanceRestriction } from "../dist/features/channels/channel-operation-bindings.js";
import { captureNodeCommandInputs } from "../dist/runtime/sandbox/node-command-inputs.js";

// Regression: CP-SINGLE-20261028-01 — a negated directory question is not ask-first.
// Found by /qa on 2026-10-28
// Report: output/e6-20260928/channel-policy-single-native-failure-20261028.md
// Value: protects=explicit single-file restrictions do not become scope-expansion questions;
// fails_when=negated ask verbs match the Host ask-first guard; why_new=prior cases have no negation;
// seam=none; no_claim=real model/package behavior (this uses the real binder and captured synthetic bytes).
const entry = "channel-policy-auto-fixture-20261027/validate.cjs";
const command = `node ${entry}`;
const singleFileSource = `@QA CP-SINGLE-20261028-01：这是独立的反向验收任务，不重试或修改任何旧任务。目标命令为 ${command}，工作目录为 .。本次明确只允许读取入口文件 ${entry}，禁止读取其 package.json、lib/values.cjs 或任何其他文件，不得继承或扩大目录范围。禁止写文件、联网、重试或执行其他命令。如果该命令必须读取被禁止的依赖，应在执行前明确阻止并说明具体缺失能力，不要询问扩大授权，不要声称执行成功。`;

for (const [text, expected] of [
  [singleFileSource, "direct_inputs_only"],
  ["只读取 project/validate.cjs。执行前不要询问依赖目录。", "direct_inputs_only"],
  ["只读取 project/validate.cjs。不要先确认依赖范围。", "direct_inputs_only"],
  ["Only read this file. Before execution, do not ask for a broader dependency scope.", "direct_inputs_only"],
  ["Only read this file; never request dependency scope before execution.", "direct_inputs_only"],
  ["只读取 project/validate.cjs。不要自动继承，执行前先询问依赖目录。", "ask_first"],
  ["只读取 project/validate.cjs。先不要执行，先问我确认依赖目录。", "ask_first"],
  ["Only read this file. Do not execute yet; ask for the dependency scope first.", "ask_first"],
]) {
  test(`Host preserves the polarity of the directory request: ${text}`, () => {
    assert.equal(commandInputInheritanceRestriction(text), expected);
  });
}

test("the actual single-file source binds no scope/pending slot and preparation refuses its undeclared dependency", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-single-input-negation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "channel-policy-auto-fixture-20261027"));
  let compilerCalls = 0;
  const result = bindChannelOperationPlan({
    candidate: { schemaVersion: 2, operations: [{ id: "validate", kind: "run_command", targetKind: "command",
      required: true, dependsOn: [], sourceQuote: singleFileSource,
      owner: { participantId: "qa", sourceQuote: "@QA" },
      command: { text: command, sourceQuote: command }, inputs: [{ path: entry, sourceQuote: entry }] }] },
    sourceItemId: "single-source", sourceText: singleFileSource, workspaceCwd: cwd,
    participants: [{ id: "qa", displayName: "QA", roleKey: "qa", allowedTools: ["bash", "read"] }],
    visibleSources: [{ itemId: "single-source", revision: 0, actorType: "local_user", body: singleFileSource }],
    compileCommandInputScope: () => { compilerCalls++; throw new Error("Single-file requests must not inherit a project root"); },
  });
  assert.equal(result.status, "bound", JSON.stringify(result));
  assert.deepEqual(result.pendingInputScopeOperationIds ?? [], []);
  const binding = result.execution.operations[0].binding;
  assert.equal(binding.commandInputScope, undefined);
  assert.deepEqual(binding.effectScope.readPaths, [entry]);
  assert.equal(compilerCalls, 0);
  const captured = [];
  await assert.rejects(captureNodeCommandInputs({ inputRefs: binding.inputRefs, commandInputScope: binding.commandInputScope,
    hasOptionalInput: () => { throw new Error("No metadata probe is authorized"); },
    capture: async path => {
      captured.push(path);
      assert.equal(path, entry, "Prohibited dependency must never reach the byte reader");
      const bytes = Buffer.from('require("./lib/values.cjs");\n');
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  }), error => error.code === "restricted_command_dependency_scope_required"
    && error.path === "channel-policy-auto-fixture-20261027/lib/values.cjs");
  assert.deepEqual(captured, [entry]);
});

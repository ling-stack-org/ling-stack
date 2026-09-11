import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindChannelOperationPlan } from "../../../packages/daemon/dist/features/channels/channel-operation-bindings.js";
import {
  buildPackagedContinuityIntentFixture,
  extractPackagedExactCommand,
  resolvePackagedContinuityWorkspaces,
} from "./support/packaged-continuity-intent-fixture.mjs";

const proofFileName = "r5-packaged-proof.txt";
const proofContent = "continuity-v2-r5-proof";
const exactVerificationCommand = `node -e "const fs=require('fs');const p=Buffer.from('${Buffer.from(proofFileName, "utf8").toString("base64")}','base64').toString('utf8');const e=Buffer.from('${Buffer.from(proofContent, "utf8").toString("base64")}','base64').toString('utf8');if(fs.readFileSync(p,'utf8')!==e)process.exit(1)"`;

const participants = [
  { id: "teammate_builtin_engineer", displayName: "Engineer", roleKey: "engineer", allowedTools: ["read", "write", "bash"] },
  { id: "teammate_builtin_qa", displayName: "QA", roleKey: "qa", allowedTools: ["read", "write", "bash"] },
];

async function assertFixtureBinds({ prompt, sourceText, scenarioParticipants = participants }) {
  const workspaceCwd = await mkdtemp(join(tmpdir(), "ling-packaged-intent-fixture-"));
  try {
    const fixture = buildPackagedContinuityIntentFixture({
      prompt,
      proofFileName,
      proofContent,
      exactVerificationCommand,
    });
    assert.equal(fixture.execution.schemaVersion, 2);
    const result = bindChannelOperationPlan({
      candidate: fixture.execution,
      sourceItemId: "item_packaged_fixture",
      sourceText,
      workspaceCwd,
      participants: scenarioParticipants,
    });
    assert.equal(result.status, "bound", result.reason);
    return result;
  } finally {
    await rm(workspaceCwd, { recursive: true, force: true });
  }
}

test("packaged continuity multi-agent fixture satisfies the current source-bound operation contract", async () => {
  const sourceText = `@Engineer @QA 请协作完成一个最小可验证任务：由 Engineer 创建 ${proofFileName}，内容为 ${proofContent}；QA 执行精确命令：${exactVerificationCommand} 验证文件内容。Engineer 与 QA 都必须完成并提供真实 evidence 后才报告成功。`;
  const result = await assertFixtureBinds({ prompt: sourceText, sourceText });
  assert.deepEqual(result.execution.operations.map((operation) => operation.binding.ownerParticipantId), [
    "teammate_builtin_engineer",
    "teammate_builtin_qa",
  ]);
});

test("packaged naked-ready fixture resolves the dynamic participant and still requires Host evidence", async () => {
  const participant = { id: "teammate_dynamic_naked", displayName: "Naked Ready", roleKey: "engineer", allowedTools: ["write"] };
  const sourceText = "@Naked Ready 请创建 naked-ready.txt 完成 naked-ready delegated task；只有真实 evidence 才能报告成功。";
  const prompt = `${sourceText}\nAvailable teammate roles JSON: ${JSON.stringify([{ id: participant.id, role: participant.roleKey, label: participant.displayName }])}`;
  const result = await assertFixtureBinds({ prompt, sourceText, scenarioParticipants: [participant] });
  assert.equal(result.execution.operations[0].binding.ownerParticipantId, participant.id);
});

test("packaged missing-provider fixture binds before provider readiness blocks workflow confirmation", async () => {
  const sourceText = '@Engineer @QA 请协作完成 missing-provider task：Engineer 创建 missing-provider.txt；QA 执行精确命令 `node -e "process.exit(0)"` 验证。';
  const result = await assertFixtureBinds({ prompt: sourceText, sourceText });
  assert.deepEqual(result.execution.operations.map((operation) => operation.kind), ["file_create", "run_command"]);
});

test("packaged command extraction excludes rendered binding metadata and preserves command semicolons", () => {
  const workflowPrompt = `verify_target: run_command; exact command: ${exactVerificationCommand}; binding: {"schemaVersion":1}`;
  assert.equal(extractPackagedExactCommand(workflowPrompt, "fallback"), exactVerificationCommand);

  const restartCommand = "sleep 30; printf 'must-not-repeat\\n' > packaged-effect-unknown.txt";
  assert.equal(
    extractPackagedExactCommand(`Run the exact command: ${restartCommand}\nNext instruction`, "fallback"),
    restartCommand,
  );
});

test("packaged crash scenarios isolate effect-unknown recovery from persistent stop-unconfirmed write risk", () => {
  const workspaces = resolvePackagedContinuityWorkspaces("/tmp/ling-packaged-continuity-fixture");
  assert.equal(workspaces.continuity, "/tmp/ling-packaged-continuity-fixture/workspace");
  assert.equal(workspaces.effectUnknown, "/tmp/ling-packaged-continuity-fixture/effect-unknown-workspace");
  assert.notEqual(workspaces.effectUnknown, workspaces.continuity);
});

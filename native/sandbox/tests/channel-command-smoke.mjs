import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import test from "node:test";
import { nodeFunctionGoalCommand } from "../../../packages/contracts/dist/index.js";
import { startRealPiChannelFixture, systemText } from "../../../packages/daemon/test/support/channel-operation-real-pi-fixture.mjs";
import { fileOperationCandidate } from "../../../packages/daemon/test/support/channel-operation-candidate-fixture.mjs";
assert.equal(process.platform, "darwin"); assert.ok(process.argv[2] && isAbsolute(process.argv[2]));
const pin = path => ({ path: realpathSync(path), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
const restrictedCommands = { inputHelper: { ...pin(process.argv[2]), version: "0.1.0-dev.0" }, executables: { node: pin(process.execPath) } };
const owner = { kind: "host_default" };

test("real Pi channel creates a module then performs the natural-language Node goal with atomic Host evidence and one report", { timeout: 60000 }, async t => {
  const cwd = await mkdtemp("/private/tmp/ling-native-channel-");
  const source = '创建 continuity-v2-proof.js，内容是导出 formatProof，然后运行 Node 调用 formatProof("7319") 验证。';
  const content = 'exports.formatProof = value => "proof:" + value;';
  const command = nodeFunctionGoalCommand({ modulePath: "continuity-v2-proof.js", invocation: 'formatProof("7319")' });
  let executionTurns = 0;
  const execution = { schemaVersion: 2, operations: [
    fileOperationCandidate({ id: "create_file", path: "continuity-v2-proof.js",
      sourceQuote: "创建 continuity-v2-proof.js，内容是导出 formatProof",
      contentSource: { kind: "generated_objective", text: "导出 formatProof", sourceQuote: "导出 formatProof", inputOperationIds: [] } }),
    { id: "run_command", kind: "run_command", targetKind: "command", required: true, dependsOn: ["create_file"], owner,
      sourceQuote: '然后运行 Node 调用 formatProof("7319") 验证。',
      commandGoal: { kind: "node_function", module: { path: "continuity-v2-proof.js", sourceQuote: "continuity-v2-proof.js" },
        invocation: 'formatProof("7319")', sourceQuote: 'formatProof("7319")' } },
  ] };
  const daemon = await startRealPiChannelFixture(cwd, request => {
    if (/channel intent selector/i.test(systemText(request))) return { text: JSON.stringify({ action: "execute", reason: "Explicit Node goal", execution }) };
    executionTurns++;
    if (executionTurns === 1) return { tool: "write", input: { path: "continuity-v2-proof.js", content } };
    if (executionTurns === 2) return { tool: "bash", input: { command, timeoutMs: 5000 } };
    assert.ok(JSON.stringify(request.messages).includes("proof:7319"), "Pi must receive actual Host command output");
    return { text: "Created continuity-v2-proof.js and invoked formatProof with 7319; output proof:7319." };
  }, { sandbox: { restrictedCommands } });
  t.after(async () => { await daemon.close(); await rm(cwd, { recursive: true, force: true }); });
  const scope = "cwd=" + encodeURIComponent(cwd);
  const provider = (await json(daemon.url + "/providers?" + scope, {
    kind: "glm", displayName: "Native channel loopback fixture", ...daemon.providerOverrides,
    input: ["text"], authHeader: false, enabled: true,
  })).provider;
  await json(daemon.url + "/providers/" + encodeURIComponent(provider.id) + "/check?" + scope, {});
  const channel = (await json(daemon.url + "/channels?" + scope, {
    name: "Native Node goal", status: "active", boundPath: cwd, defaultProviderPresetId: provider.id,
    autoReplyMode: "mentions_only", allowedTools: ["read", "write", "bash"],
  })).channel;
  const created = await json(daemon.url + "/channels/" + channel.id + "/turns?" + scope, { body: source });
  assert.ok(created.autoStartedWorkflow, JSON.stringify(created));
  const participantIds = created.autoStartedWorkflow.workflowSteps.map(step => step.toParticipantId);
  const result = await daemon.assertWorkflowCompleted(created, {
    files: [{ path: "continuity-v2-proof.js", content }], actionTypes: ["write", "bash"], participantIds, approvalCount: 2,
  });
  const action = result.actions.find(action => action.actionType === "bash");
  assert.equal(action.commandEvidence.command, command); assert.equal(action.commandEvidence.exitCode, 0);
  const toolEnd = daemon.store.listEvents(action.runId, { limit: 1000 }).find(event =>
    event.type === "tool_end" && event.data.toolCallId === action.toolCallId);
  assert.equal(toolEnd.data.result.details.unifiedExec.isolation.backend, "macos_seatbelt");
  assert.equal(toolEnd.data.result.details.unifiedExec.stdout.preview, "proof:7319\n");
  assert.equal(result.report.outcomeStatus, "succeeded");
  assert.equal(daemon.store.listHostCommandWriteBlockers(cwd).length, 0);
});

async function json(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json(); assert.equal(response.ok, true, JSON.stringify(payload)); return payload;
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import test from "node:test";
import { nodeFunctionGoalCommand } from "../../../packages/contracts/dist/index.js";
import { messageText, startRealPiChannelFixture, systemText } from "../../../packages/daemon/test/support/channel-operation-real-pi-fixture.mjs";
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
    // Participants receive only their owned operations. Drive each actual Pi
    // session from its advertised tools and Host results, never a shared turn count.
    const available = new Set((request.tools ?? []).map(tool => tool.function.name));
    assert.ok(available.has("write") || available.has("bash"), "The execution participant must receive its bound tools.");
    if (available.has("write")) {
      const result = latestToolResult(request, "write");
      if (!result) return { tool: "write", input: { path: "continuity-v2-proof.js", content } };
      assert.ok(messageText(result).includes("Applied patch to 1 file."), "Pi must receive the actual successful Host write result");
    }
    if (available.has("bash")) {
      const result = latestToolResult(request, "bash");
      if (!result) return { tool: "bash", input: { command, timeoutMs: 5000 } };
      assert.ok(messageText(result).includes("proof:7319"), "Pi must receive actual Host command output");
      return { text: "Invoked formatProof with 7319; output proof:7319." };
    }
    return { text: "Created continuity-v2-proof.js with the requested formatProof export." };
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

function latestToolResult(request, name) {
  const calls = new Map();
  let result;
  for (const message of request.messages) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call.function.name);
    if (message.role === "tool" && calls.get(message.tool_call_id) === name) result = message;
  }
  return result;
}

async function json(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json(); assert.equal(response.ok, true, JSON.stringify(payload)); return payload;
}

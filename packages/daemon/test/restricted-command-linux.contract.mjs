import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { channelOperationPlanFingerprintV1, createRequiredParticipantManifestV1, isChannelIntentDecisionV2, isChannelIntentExecutionPlanV1 } from "../../contracts/dist/index.js";
import { createDaemonServer } from "../dist/index.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";
import { readPackagedRestrictedCommandConfig } from "../dist/runtime/sandbox/packaged-restricted-command-bootstrap.js";
import { gateOwner, typedOperation } from "./support/workflow-operation-gate-fixture.mjs";

// Dedicated mandatory Linux lane, not a skipped Darwin positive or simulated OS.
assert.equal(process.platform, "linux", "This contract requires an actual Linux process.");
const unavailableConfig = {
  inputHelper: { path: "/ling-platform-contract/nonexistent-helper", sha256: "0".repeat(64), version: "platform-contract-v1" },
  executables: { node: { path: "/ling-platform-contract/nonexistent-node", sha256: "0".repeat(64) } },
};

// Value: protects=unsupported Hosts cannot read pins or fall back to raw spawning;
// fails_when=real Linux reaches binary verification or accepts a typed command;
// why_new=Darwin-only positives were scheduled on Ubuntu; seam=none
test("real Linux refuses the native runtime before reading any configured binary", () => {
  const runtime = new NativeRestrictedCommandRuntime(unavailableConfig);
  assert.throws(() => runtime.assertAvailable("node --version"), {
    message: "restricted_command_platform_unavailable",
  });
});

test("real Linux refuses packaged discovery before bundle verification", () => {
  let bundleChecks = 0;
  assert.throws(() => readPackagedRestrictedCommandConfig({
    environment: { LING_STACK_PACKAGED_DESKTOP: "1", ELECTRON_RUN_AS_NODE: "1" },
    executablePath: unavailableConfig.executables.node.path,
    architecture: "arm64",
    verifyBundle() { bundleChecks++; },
  }), { message: "restricted_command_packaged_platform_invalid" });
  assert.equal(bundleChecks, 0);
});

test("HTTP proposal confirmation on Linux rejects before creating Task, Run, or Workflow", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-linux-platform-confirm-"));
  const store = createSqliteRunStore(cwd);
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0,
    sandbox: { restrictedCommands: unavailableConfig } }, { storeFactory: () => store });
  t.after(async () => { await daemon.stop(); await rm(cwd, { recursive: true, force: true }); });
  await daemon.start();
  const now = new Date().toISOString();
  const command = `node -e "require('node:fs').writeFileSync('must-not-run','unsafe')"`;
  const channel = store.createChannel({ name: "Linux platform refusal", status: "active", boundPath: cwd,
    allowedTools: ["bash"] }, now);
  store.replaceTeammateChannelMemberships(gateOwner, [{ channelId: channel.id }], now);
  const thread = store.resolveOrCreateConversationThread({ surfaceKind: "channel_root", channelId: channel.id,
    title: "Linux platform refusal", objective: command }, now).thread;
  const accepted = store.appendConversationUserTurn({ channelId: channel.id, threadId: thread.id,
    title: "Linux platform refusal", userInstruction: command,
    payload: { body: command, format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: "linux-platform-refusal" }, now);
  const operation = typedOperation("run_command", command);
  operation.binding.sourceRefs = [{ itemId: accepted.item.id, quote: command }];
  const execution = { bindingVersion: 1, operations: [operation],
    fingerprint: channelOperationPlanFingerprintV1([operation]) };
  assert.ok(isChannelIntentExecutionPlanV1(execution), "The valid typed plan must reach the real platform gate.");
  const participantManifest = createRequiredParticipantManifestV1([{ participantId: gateOwner, role: "engineer",
    requirement: "required", expectedOutcome: "execution", requiredOperationIds: [operation.id], requestedBy: "structured_mention" }]);
  const proposal = store.createChannelExecutionProposal({ channelId: channel.id, sourceMessageId: accepted.item.id,
    proposedByTeammateId: "ling_agent", title: "Linux platform refusal", prompt: command,
    assigneeTeammateId: gateOwner, requiredTools: ["bash"], status: "draft" }, now);
  const assignment = store.getEffectiveTurnContextAssignment(accepted.turnId);
  const decision = store.createChannelIntentDecision({ channelId: channel.id, sourceItemId: accepted.item.id,
    contextProjection: { projectionVersion: `projection:${accepted.item.id}:${assignment.revision}`,
      sourceStateFingerprint: `source-state:${accepted.item.id}:${assignment.revision}`,
      threadId: accepted.item.threadId, turnId: accepted.item.turnId, segmentId: assignment.segmentId,
      throughItemSequence: accepted.item.sequence, summaryIds: [],
      sourceRefs: [{ type: "conversation_item", id: accepted.item.id }],
      policyVersion: "linux-platform-contract-v1", visibilityFingerprint: "channel_shared" },
    action: "execute", selectedTeammateIds: [gateOwner], participantManifest, execution,
    proposalId: proposal.id, reason: "Explicit typed command", status: "accepted", createdBy: "deterministic" }, now);
  assert.ok(isChannelIntentDecisionV2(decision), "The complete executable decision must pass v2 schema validation before HTTP confirmation.");
  assert.deepEqual(decision.execution, execution, "The persisted decision must retain the exact typed command plan.");
  const before = { tasks: store.listTasks(), runs: store.listRuns({ channelId: channel.id, limit: 100 }),
    workflows: store.listChannelWorkflows({ channelId: channel.id, limit: 100 }) };
  const response = await fetch(`http://127.0.0.1:${daemon.server.address().port}/channel-proposals/${proposal.id}/confirm-workflow?cwd=${encodeURIComponent(cwd)}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.error, "operation_binding_runtime_not_ready");
  assert.match(body.message, /restricted_command_platform_unavailable/u);
  assert.deepEqual(store.listTasks(), before.tasks);
  assert.deepEqual(store.listRuns({ channelId: channel.id, limit: 100 }), before.runs);
  assert.deepEqual(store.listChannelWorkflows({ channelId: channel.id, limit: 100 }), before.workflows);
  assert.equal(store.getChannelExecutionProposal(proposal.id).status, "blocked");
  await assert.rejects(readFile(join(cwd, "must-not-run")), { code: "ENOENT" });
  assert.equal(store.listHostCommandWriteBlockers(cwd).length, 0);
});

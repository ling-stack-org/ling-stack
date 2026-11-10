import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { assignExecutionOperationOwners } from "../dist/features/channels/workflow-operation-ownership.js";
import {
  a10CompressibleOverBudgetFixture,
  a10CurrentLiteralFixtures,
  a10InlineFixture,
  a10OverBudgetFixture,
  a10Participants,
  a10RecentCodeFixtures,
} from "./support/a10-file-content-fixtures.mjs";

const execFileAsync = promisify(execFile);
const now = "2026-10-14T00:00:00.000Z";
const exactQaPattern = /^node -e "const fs=require\('fs'\);const p=Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)\.toString\('utf8'\);const e=Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)\.toString\('utf8'\);if\(fs\.readFileSync\(p,'utf8'\)!==e\)process\.exit\(1\)"$/u;

/** Exercise the real selector and canonical SQLite inputs, without a model call. */
async function selectFixture(t, fixture, { mentions = a10Participants, modelPolicy = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a10-content-preservation-"));
  let store;
  t.after(async () => {
    try { store?.close(); } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  store = createSqliteRunStore(cwd);
  const provider = store.createProviderPreset({
    kind: "glm", displayName: "A10 isolated static selector", providerId: "a10-static", model: "a10-static",
    api: "google-generative-ai", capabilities: ["chat", "tool_call"], input: ["text"], authHeader: false, enabled: true,
  }, now);
  store.recordProviderCheckResult(provider.id, {
    ok: true, checkedAt: now, message: "Fixture only; no external provider request",
  });
  const allowedTools = ["read", "write", "bash"];
  const channel = store.createChannel({
    name: "A10 content preservation", boundPath: cwd, defaultProviderPresetId: provider.id, allowedTools,
  }, now);
  for (const participant of a10Participants) {
    store.replaceTeammateChannelMemberships(participant.id, [{ channelId: channel.id }], now);
  }
  let priorMessage;
  if (fixture.priorBody) {
    // Both items use the canonical same-thread context projection. No direct
    // private-function import or monkeypatched context resolver is permitted.
    appendChannelItemFixture(store, {
      channelId: channel.id, authorType: "local-user", body: `请给出 ${fixture.target} 的代码。`,
    }, now);
    priorMessage = appendChannelItemFixture(store, {
      channelId: channel.id, authorType: "ai-teammate", authorId: a10Participants[0].id,
      body: fixture.priorBody, kind: "ai_reply",
    }, "2026-10-14T00:00:01.000Z");
  }
  const sourceMessage = appendChannelItemFixture(store, {
    channelId: channel.id, authorType: "local-user", body: fixture.body, mentions,
  }, "2026-10-14T00:00:02.000Z");
  assert.equal(sourceMessage.body, fixture.body, "canonical source must retain the actual request bytes");
  assert.equal(store.getConversationItem(sourceMessage.id).payload.body, fixture.body);
  let modelCalls = 0;
  const result = await selectChannelWorkflowIntent({
    store, channel, sourceMessage, secretResolver: createCompositeSecretResolver({ env: {} }),
    config: { channels: { intentSelector: modelPolicy } },
    runnerRegistry: { resolve: () => {
      assert.equal(modelPolicy, true, "explicit deterministic routing must never invoke a model");
      return { runner: { adapter: { runTask: async (input) => {
        modelCalls += 1;
        assert.deepEqual(input.tools, []);
        input.onEvent({ type: "assistant_text_delta", text: JSON.stringify({ action: "reply", reason: "A10 model-policy guard" }) });
        return { messages: [] };
      } } } };
    } },
  });
  const decision = store.listChannelIntentDecisions({ sourceItemId: sourceMessage.id, limit: 10 })[0];
  assert.equal(modelCalls, modelPolicy ? 1 : 0);
  assert.deepEqual(store.getChannel(channel.id).allowedTools, allowedTools, "content preservation cannot grant tools");
  assert.equal(store.listRuns({ channelId: channel.id, limit: 10 }).length, 0);
  assert.equal(store.listTasks({ channelId: channel.id, limit: 10 }).length, 0);
  return { cwd, store, channel, sourceMessage, priorMessage, result, decision };
}

function assertHostPlan(selected, fixture, { verification = true, participants = a10Participants } = {}) {
  const { result, decision, store, sourceMessage } = selected;
  assert.equal(result.action, "workflow_proposal", JSON.stringify(result));
  assert.equal(decision.action, "execute", decision.reason);
  assert.equal(decision.createdBy, "deterministic");
  assert.equal(decision.sourceItemId, sourceMessage.id);
  assert.equal(result.intentDecisionId, decision.id);
  assert.equal(decision.proposalId, result.proposal.id);
  assert.equal(result.proposal.sourceMessageId, sourceMessage.id);
  const operations = decision.execution?.operations;
  assert.ok(Array.isArray(operations), "must inspect a persisted Host operation plan, not a title");
  assert.deepEqual(operations.map(({ id, kind, required, dependsOn }) => ({ id, kind, required, dependsOn })), [
    { id: "create_file", kind: "file_create", required: true, dependsOn: [] },
    ...(verification ? [{ id: "verify_target", kind: "run_command", required: true, dependsOn: ["create_file"] }] : []),
  ]);
  assert.deepEqual(operations[0].targetRef, {
    type: "operation", id: `${sourceMessage.id}:create_file`, label: fixture.target,
  });
  assert.deepEqual(decision.selectedTeammateIds, participants.map(({ id }) => id));
  assert.deepEqual(decision.participantManifest.participants.map(({ participantId, requirement, requestedBy, requiredOperationIds }) => ({
    participantId, requirement, requestedBy, requiredOperationIds,
  })), participants.map(({ id }, index) => ({
    participantId: id, requirement: "required", requestedBy: "structured_mention",
    requiredOperationIds: index === 0 ? ["create_file"] : verification ? ["verify_target"] : [],
  })));
  const owners = assignExecutionOperationOwners(operations, participants.map(({ id }) => ({ teammate: store.getAiTeammate(id) })));
  assert.equal(owners.get("create_file"), 0);
  if (verification) {
    assert.equal(owners.get("verify_target"), 1);
    assert.equal(operations[1].targetRef.id, `${sourceMessage.id}:verify_target`);
  }
  assert.deepEqual(result.proposal.requiredTools, verification ? ["write", "bash"] : ["write"]);
  return operations;
}

function assertDedicatedWriterPayload(selected, fixture) {
  const sourceLabel = fixture.source === "recent_code_block"
    ? `recent same-thread code block (${selected.priorMessage.id})`
    : "current message";
  const marker = `Requested content from ${sourceLabel}:\n`;
  const prompt = selected.result.proposal.prompt;
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0, "writer must receive a dedicated content payload, not just the original request");
  const expected = Buffer.from(fixture.content, "utf8");
  const actual = Buffer.from(prompt.slice(start + marker.length, start + marker.length + fixture.content.length), "utf8");
  assert.deepEqual(actual, expected, "dedicated writer content must retain the authored payload bytes");
  assert.equal(prompt.slice(start + marker.length + fixture.content.length, start + marker.length + fixture.content.length + 2), "\n\n",
    "content must end at the prompt's structural separator, without fence markers or verification instructions");
}

/** Execute only the exact Host-generated Node argv, never a user-provided shell. */
async function executeExactQa(cwd, command) {
  assert.match(command, exactQaPattern, "only the fixed Host verification program is executable by this fixture");
  const script = command.slice('node -e "'.length, -1);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", script], {
      cwd, env: {}, timeout: 5_000, maxBuffer: 8_192,
    });
    return { code: 0, signal: null, stdout, stderr };
  } catch (error) {
    assert.equal(error.killed, false, "a timeout is not a content-verification result");
    assert.equal(error.signal, null);
    assert.equal(error.code, 1, "only the exact check's intentional mismatch exit is expected");
    return { code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr };
  }
}

async function assertExactQaPayload(selected, fixture) {
  const [, verification] = assertHostPlan(selected, fixture);
  assert.equal(verification.commandMatchPolicy?.kind, "exact_command");
  const command = verification.commandMatchPolicy.command;
  assert.ok(command.length <= 512, "the existing exact-command cap is not widened");
  const match = exactQaPattern.exec(command);
  assert.ok(match, "verification must be the real Host-materialized file comparison");
  const target = Buffer.from(match[1], "base64");
  const expected = Buffer.from(fixture.content, "utf8");
  assert.deepEqual(target, Buffer.from(fixture.target, "utf8"));
  assert.deepEqual(Buffer.from(match[2], "base64"), expected,
    "QA must compare the original payload, not the same incorrectly normalized writer content");
  assert.ok(selected.result.proposal.prompt.includes(`exact command: ${command}`),
    "the persisted proposal must carry the same exact command as the Host completion plan");
  // Fixture writes are limited to the owned mkdtemp root. No workflow launch,
  // model invocation, permission bypass, or product-created file is claimed.
  assert.match(fixture.target, /^a10-[a-z-]+\.(?:txt|js)$/u);
  await writeFile(join(selected.cwd, fixture.target), expected);
  assert.deepEqual(await executeExactQa(selected.cwd, command), { code: 0, signal: null, stdout: "", stderr: "" });
  const flattened = Buffer.from(fixture.content.replace(/\s+/gu, " ").trim(), "utf8");
  const wrong = flattened.equals(expected) ? Buffer.concat([expected, Buffer.from("!mismatch", "utf8")]) : flattened;
  assert.notDeepEqual(wrong, expected);
  await writeFile(join(selected.cwd, fixture.target), wrong);
  assert.deepEqual(await executeExactQa(selected.cwd, command), { code: 1, signal: null, stdout: "", stderr: "" },
    "a flattened or changed file must fail even when an incorrectly flattened writer could otherwise appear successful");
}

for (const fixture of [...a10CurrentLiteralFixtures, ...a10RecentCodeFixtures, a10InlineFixture]) {
  test(`A10 writer: ${fixture.name}`, async (t) => {
    const selected = await selectFixture(t, fixture);
    assertHostPlan(selected, fixture);
    assertDedicatedWriterPayload(selected, fixture);
  });
  test(`A10 Host QA: ${fixture.name}`, async (t) => {
    const selected = await selectFixture(t, fixture);
    await assertExactQaPayload(selected, fixture);
  });
}

for (const fixture of [a10OverBudgetFixture, a10CompressibleOverBudgetFixture]) {
  test(`A10 exact-QA budget: ${fixture.name}`, async (t) => {
    const targetBase64 = Buffer.from(fixture.target, "utf8").toString("base64");
    const contentBase64 = Buffer.from(fixture.content, "utf8").toString("base64");
    const originalByteCommand = `node -e "const fs=require('fs');const p=Buffer.from('${targetBase64}','base64').toString('utf8');const e=Buffer.from('${contentBase64}','base64').toString('utf8');if(fs.readFileSync(p,'utf8')!==e)process.exit(1)"`;
    assert.ok(originalByteCommand.length > 512, "budget is measured from the authored payload, not normalized text");
    const selected = await selectFixture(t, fixture);
    const failClosed = selected.result.action === "clarify" || selected.result.action === "blocked"
      || (selected.result.action === "workflow_proposal" && selected.result.proposal.status === "blocked");
    assert.equal(failClosed, true, "unavailable exact verification must not become an executable partial plan");
    assert.equal((selected.decision?.execution?.operations ?? []).some(({ kind }) => kind === "run_command" || kind === "open_local_target"), false,
      "oversized literal cannot acquire a compressed exact command or a weaker existence-only verifier");
    if (selected.result.action === "workflow_proposal") {
      assertDedicatedWriterPayload(selected, fixture);
      assert.ok(selected.result.proposal.errorMessage, "a blocked proposal must carry an explicit reason");
    }
    if (selected.result.action === "clarify") {
      assert.ok(selected.decision?.clarification?.missingFields?.length > 0, "clarification must remain structured");
    }
  });
}

test("A10 enabled model-policy routing is not replaced by deterministic file parsing", async (t) => {
  const selected = await selectFixture(t, a10CurrentLiteralFixtures[0], { modelPolicy: true });
  assert.equal(selected.result.action, "continue");
  assert.equal(selected.decision.action, "reply");
  assert.equal(selected.decision.createdBy, "model_policy");
  assert.equal(selected.decision.execution, undefined);
  assert.deepEqual(selected.store.listChannelExecutionProposals({ channelId: selected.channel.id, limit: 10 }), []);
});

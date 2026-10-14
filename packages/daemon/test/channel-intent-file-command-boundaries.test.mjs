import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";
import { a10Participants } from "./support/a10-file-content-fixtures.mjs";

/** Persist real same-channel inputs; this fixture never executes payload commands. */
async function select(t, { target, content, suffix = "；QA 验证文件内容。" }) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-a10-command-boundary-"));
  let store;
  t.after(async () => {
    try { store?.close(); } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  store = createSqliteRunStore(cwd);
  const now = "2026-10-14T00:00:00.000Z";
  const channel = store.createChannel({ name: "A10 literal command boundary", boundPath: cwd,
    allowedTools: ["read", "write", "bash"] }, now);
  for (const participant of a10Participants) {
    store.replaceTeammateChannelMemberships(participant.id, [{ channelId: channel.id }], now);
  }
  const body = `@Engineer @QA 请创建 ${target}，文件内容必须逐字保留，内容如下：\n${content}${suffix}`;
  const sourceMessage = appendChannelItemFixture(store, { channelId: channel.id,
    authorType: "local-user", body, mentions: a10Participants }, now);
  const result = await selectChannelWorkflowIntent({ store, channel, sourceMessage,
    config: { channels: { intentSelector: false } }, secretResolver: createCompositeSecretResolver({ env: {} }),
    runnerRegistry: { resolve() { throw new Error("A10 literal boundary must not invoke a model"); } },
  });
  const decision = store.listChannelIntentDecisions({ sourceItemId: sourceMessage.id, limit: 10 })[0];
  assert.equal(decision.createdBy, "deterministic");
  assert.equal(store.getConversationItem(sourceMessage.id).payload.body, body);
  assert.equal(store.listRuns({ channelId: channel.id, limit: 10 }).length, 0);
  assert.equal(store.listTasks({ channelId: channel.id, limit: 10 }).length, 0);
  assert.deepEqual(store.getChannel(channel.id).allowedTools, ["read", "write", "bash"]);
  return { result, decision, store, channel };
}

const literalCommand = "示例命令 run `node --version`\n其他字节\n";

test("A10 literal commands: an unfenced example cannot become an executable operation", async (t) => {
  const fixture = { target: "a10-example.txt", content: literalCommand };
  const selected = await select(t, fixture);
  assert.equal(selected.result.action, "workflow_proposal");
  const operations = selected.decision.execution.operations;
  assert.deepEqual(operations.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })), [
    { id: "create_file", kind: "file_create", dependsOn: [] },
    { id: "verify_target", kind: "run_command", dependsOn: ["create_file"] },
  ], "literal examples are data; only the Host exact file verifier is requested");
  const command = operations[1].commandMatchPolicy.command;
  assert.match(command, /^node -e "const fs=require\('fs'\);/u);
  assert.ok(command.length <= 512);
  const encoded = [...command.matchAll(/Buffer\.from\('([^']+)','base64'\)/gu)].map((match) => match[1]);
  assert.equal(Buffer.from(encoded[0], "base64").toString("utf8"), fixture.target);
  assert.equal(Buffer.from(encoded[1], "base64").toString("utf8"), literalCommand);
  assert.ok(selected.result.proposal.prompt.includes(`Requested content from current message:\n${literalCommand}\n\n`));
});

test("A10 literal commands: an embedded example cannot evade the exact-QA budget", async (t) => {
  const selected = await select(t, { target: "a10-example-large.txt", content: `${literalCommand}${"z".repeat(360)}` });
  assert.equal(selected.result.action, "clarify", "an example command is not a bounded external verification request");
  assert.deepEqual(selected.decision.clarification.missingFields, ["acceptance_criteria"]);
  assert.equal(selected.decision.execution, undefined);
  assert.deepEqual(selected.store.listChannelExecutionProposals({ channelId: selected.channel.id, limit: 10 }), []);
});

test("A10 literal commands: an explicit outer verification command retains its exact binding", async (t) => {
  const command = "node --check a10-outer.txt";
  const selected = await select(t, { target: "a10-outer.txt", content: `${literalCommand}${"z".repeat(360)}`,
    suffix: `；QA 执行命令 \`${command}\` 验证文件内容。` });
  assert.equal(selected.result.action, "workflow_proposal");
  const operations = selected.decision.execution.operations;
  assert.deepEqual(operations.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })), [
    { id: "create_file", kind: "file_create", dependsOn: [] },
    { id: "run_command", kind: "run_command", dependsOn: ["create_file"] },
  ]);
  assert.deepEqual(operations[1].commandMatchPolicy, { kind: "exact_command", command },
    "the explicit suffix command, not the example inside the literal, is the authority");
});

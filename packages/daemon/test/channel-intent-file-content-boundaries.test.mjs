import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCompositeSecretResolver, createSqliteRunStore } from "@ling-stack/core";
import { appendChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import { selectChannelWorkflowIntent } from "../dist/features/channels/channel-intent-selector.js";

const cases = [
  ["an unclosed explicit fence", "```text\nnew payload\n"],
  ["substantive text after a closed explicit fence", "```text\nnew payload\n```\nthis trailing content is not a verification instruction"],
  ["an empty inline literal", ""],
  ["a whitespace-only multiline literal", "\n \t \r\n"],
  ["an empty explicit fence", "```text\n```\n"],
  ["a whitespace-only explicit fence", "```text\n \t\n\n```\n"],
];

for (const [name, payload] of cases) {
  test(`A10 boundaries: ${name} clarifies without silently reusing recent content`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "ling-a10-content-boundary-"));
    let store;
    t.after(async () => {
      try { store?.close(); } finally { await rm(cwd, { recursive: true, force: true }); }
    });
    store = createSqliteRunStore(cwd);
    const now = "2026-10-14T00:00:00.000Z";
    const channel = store.createChannel({ name: "A10 ambiguous current payload", boundPath: cwd,
      allowedTools: ["read", "write", "bash"] }, now);
    const participants = [
      { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
      { id: "teammate_builtin_qa", label: "QA", kind: "ai-teammate" },
    ];
    for (const participant of participants) {
      store.replaceTeammateChannelMemberships(participant.id, [{ channelId: channel.id }], now);
    }
    appendChannelItemFixture(store, { channelId: channel.id, authorType: "local-user",
      body: "请给出 a10-boundary.txt 的旧内容。" }, now);
    const prior = appendChannelItemFixture(store, { channelId: channel.id, authorType: "ai-teammate",
      authorId: participants[0].id, kind: "ai_reply", body: "```text\nDO_NOT_REUSE_OLD_CONTENT\n```\n" }, now);
    const body = `@Engineer @QA 请创建 a10-boundary.txt，内容如下：\n${payload}`;
    const sourceMessage = appendChannelItemFixture(store, { channelId: channel.id,
      authorType: "local-user", body, mentions: participants }, "2026-10-14T00:00:01.000Z");
    const result = await selectChannelWorkflowIntent({ store, channel, sourceMessage,
      config: { channels: { intentSelector: false } }, secretResolver: createCompositeSecretResolver({ env: {} }),
      runnerRegistry: { resolve() { throw new Error("A10 deterministic boundary must not invoke a model"); } },
    });
    assert.equal(result.action, "clarify", "ambiguous or explicitly empty current content is not permission to use old bytes");
    const decision = store.listChannelIntentDecisions({ sourceItemId: sourceMessage.id, limit: 10 })[0];
    assert.equal(decision.action, "clarify");
    assert.equal(decision.createdBy, "deterministic");
    assert.deepEqual(decision.clarification.missingFields, ["content"]);
    assert.equal(decision.execution, undefined);
    assert.equal(store.getConversationItem(sourceMessage.id).payload.body, body);
    assert.equal(store.getConversationItem(prior.id).payload.body, "```text\nDO_NOT_REUSE_OLD_CONTENT\n```\n");
    assert.deepEqual(store.listChannelExecutionProposals({ channelId: channel.id, limit: 10 }), []);
    assert.equal(store.listRuns({ channelId: channel.id, limit: 10 }).length, 0);
    assert.equal(store.listTasks({ channelId: channel.id, limit: 10 }).length, 0);
    assert.doesNotMatch(result.aiReply.body, /DO_NOT_REUSE_OLD_CONTENT/u);
    assert.deepEqual(store.getChannel(channel.id).allowedTools, ["read", "write", "bash"]);
  });
}

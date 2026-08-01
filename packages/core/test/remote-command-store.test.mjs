import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  RemoteCommandIdempotencyConflictError,
  RemoteCommandRetryWindowExpiredError,
  createBuiltinAiTeammateId,
  createSqliteRunStore,
} from "../dist/index.js";

const issuedAt = "2026-07-31T01:00:00.000Z";
const retryUntil = "2026-08-01T01:00:00.000Z";

function sendInput(overrides) {
  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    deviceId: "device_iphone",
    commandId: "command_send_1",
    bodyHash: "sha256:command_send_1",
    conversationKind: "channel",
    conversationId: "missing",
    body: "Sent from iPhone.",
    issuedAt,
    retryUntil,
    ...overrides,
  };
}

test("remote sends atomically persist one native message, receipt, dispatch intent, and outbox change", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-send-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Mobile", boundPath: cwd }, issuedAt);
    const teammateId = createBuiltinAiTeammateId("designer");
    const direct = store.getOrCreateTeammateDirectThread(teammateId, issuedAt);
    const conversation = store.createLingThread({
      kind: "conversation",
      teammateId: createBuiltinAiTeammateId("ling"),
      title: "iPhone conversation",
      objective: "Continue from iPhone",
    }, issuedAt);

    const channelSend = store.commitRemoteConversationSend(sendInput({
      conversationId: channel.id,
    }), "2026-07-31T01:00:01.000Z");
    assert.equal(channelSend.idempotentReplay, false);
    assert.equal(store.getChannelMessage(channelSend.messageId)?.body, "Sent from iPhone.");
    assert.equal(channelSend.receipt.status, "completed");
    assert.deepEqual(channelSend.receipt.terminalOutcome?.result, {
      kind: "message_created",
      conversationId: channel.id,
      messageId: channelSend.messageId,
    });
    assert.deepEqual(channelSend.dispatchIntent.authority, {
      sourceSurface: "mobile",
      authorityCeiling: "conversation_comment",
      allowAiReply: true,
      allowToolCalls: false,
      allowWorkflowAutoStart: false,
      allowExecutionProposal: false,
    });

    const replay = store.commitRemoteConversationSend(sendInput({
      conversationId: channel.id,
    }), "2026-07-31T01:05:00.000Z");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.messageId, channelSend.messageId);
    assert.equal(store.listChannelMessages({ channelId: channel.id }).filter((item) => item.id === channelSend.messageId).length, 1);

    assert.throws(
      () => store.commitRemoteConversationSend(sendInput({
        conversationId: channel.id,
        bodyHash: "sha256:different-command-body",
      }), "2026-07-31T01:05:01.000Z"),
      RemoteCommandIdempotencyConflictError,
    );

    const directSend = store.commitRemoteConversationSend(sendInput({
      commandId: "command_send_direct",
      bodyHash: "sha256:command_send_direct",
      conversationKind: "teammate_direct",
      conversationId: direct.id,
      body: "Direct from iPhone.",
    }), "2026-07-31T01:10:00.000Z");
    assert.equal(
      store.listTeammateDirectMessages({ teammateId, threadId: direct.id }).find((item) => item.id === directSend.messageId)?.body,
      "Direct from iPhone.",
    );

    const conversationSend = store.commitRemoteConversationSend(sendInput({
      commandId: "command_send_conversation",
      bodyHash: "sha256:command_send_conversation",
      conversationKind: "conversation",
      conversationId: conversation.id,
      body: "Normal conversation from iPhone.",
    }), "2026-07-31T01:15:00.000Z");
    assert.equal(store.getLingTurn(conversationSend.messageId)?.userInstruction, "Normal conversation from iPhone.");

    const pending = store.listRemoteDispatchIntents({ statuses: ["pending"] });
    assert.deepEqual(new Set(pending.map((intent) => intent.id)), new Set([
      channelSend.dispatchIntent.id,
      directSend.dispatchIntent.id,
      conversationSend.dispatchIntent.id,
    ]));

    const claimed = store.claimRemoteDispatchIntent(channelSend.dispatchIntent.id, {
      workerId: "worker_1",
      claimExpiresAt: "2026-07-31T01:20:00.000Z",
    }, "2026-07-31T01:16:00.000Z");
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.attemptCount, 1);
    const failed = store.failRemoteDispatchIntent(
      channelSend.dispatchIntent.id,
      "temporary secret sk-test-should-redact",
      "2026-07-31T01:17:00.000Z",
      "2026-07-31T01:16:01.000Z",
    );
    assert.equal(failed?.status, "failed");
    assert.doesNotMatch(failed?.lastError ?? "", /sk-test-should-redact/u);
    const reclaimed = store.claimRemoteDispatchIntent(channelSend.dispatchIntent.id, {
      workerId: "worker_2",
      claimExpiresAt: "2026-07-31T01:30:00.000Z",
    }, "2026-07-31T01:17:00.000Z");
    assert.equal(reclaimed?.attemptCount, 2);
    assert.equal(store.completeRemoteDispatchIntent(channelSend.dispatchIntent.id, "2026-07-31T01:17:01.000Z")?.status, "dispatched");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid or expired remote sends leave no partial durable state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-send-rollback-"));
  const store = createSqliteRunStore(cwd);
  try {
    const beforeOutbox = store.listRemoteProjectionOutbox({ limit: 1_000 }).length;
    assert.throws(
      () => store.commitRemoteConversationSend(sendInput({
        commandId: "command_missing_conversation",
        bodyHash: "sha256:missing",
      }), "2026-07-31T01:01:00.000Z"),
      /Remote conversation not found/u,
    );
    assert.equal(store.getRemoteCommandReceipt("command_missing_conversation"), undefined);
    assert.equal(store.listRemoteDispatchIntents().length, 0);
    assert.equal(store.listRemoteProjectionOutbox({ limit: 1_000 }).length, beforeOutbox);

    assert.throws(
      () => store.commitRemoteConversationSend(sendInput({
        commandId: "command_expired",
        bodyHash: "sha256:expired",
      }), "2026-08-01T01:00:00.001Z"),
      RemoteCommandRetryWindowExpiredError,
    );
    assert.equal(store.getRemoteCommandReceipt("command_expired"), undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("expired full receipts compact to terminal tombstones retained for seven days", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-remote-command-retention-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Retention", boundPath: cwd }, issuedAt);
    store.commitRemoteConversationSend(sendInput({ conversationId: channel.id }), "2026-07-31T01:00:01.000Z");

    assert.deepEqual(store.compactRemoteCommandReceipts("2026-08-02T01:00:00.000Z"), { compacted: 1, purged: 0 });
    const tombstone = store.getRemoteCommandReceipt("command_send_1");
    assert.equal(tombstone?.receiptState, "tombstone");
    assert.equal(tombstone?.terminalOutcome?.kind, "completed");

    assert.deepEqual(store.compactRemoteCommandReceipts("2026-08-08T00:59:59.000Z"), { compacted: 0, purged: 0 });
    assert.ok(store.getRemoteCommandReceipt("command_send_1"));
    assert.deepEqual(store.compactRemoteCommandReceipts("2026-08-09T01:00:00.000Z"), { compacted: 0, purged: 1 });
    assert.equal(store.getRemoteCommandReceipt("command_send_1"), undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

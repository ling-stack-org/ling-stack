import { appendChannelItemFixture, getChannelItemViewFixture, listChannelItemViewsFixture, updateChannelItemFixture } from "../../core/test/channel-conversation-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("channel team authority ledger API exposes read-only authority facts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-authority-ledger-api-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Authority Channel", boundPath: cwd }, "2026-06-27T00:00:00.000Z");
  const run = store.createRun({
    id: "run_authority_demo",
    cwd,
    taskId: "task_authority_demo",
    channelId: channel.id,
    teammateId: "teammate_builtin_architect",
    providerPresetId: "provider_authority",
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: "task_authority_demo", title: "Authority test" },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd },
    createdAt: "2026-06-27T00:01:00.000Z",
  });
  const source = appendChannelItemFixture(store,
    {
      id: "source_authority_message",
      channelId: channel.id,
      authorType: "local-user",
      body: "Source authority request.",
    },
    "2026-06-27T00:01:30.000Z",
  );
  const reply = appendChannelItemFixture(store,
    {
      id: "reply_authority_demo",
      channelId: channel.id,
      replyToItemId: source.id,
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: "teammate_builtin_architect",
      body: "Authority facts are folded.",
      status: "ready",
    },
    "2026-06-27T00:02:00.000Z",
  );
  const approval = store.createApprovalRequest(
    {
      runId: run.id,
      taskId: run.taskId,
      channelId: channel.id,
      actionType: "git_push",
      risk: "high",
      title: "Risk review required: Approve protected branch push",
      description: "git push origin main\n\nRisk review: Protected-looking branch push requires risk review.",
      payload: { type: "bash", command: "git push origin main", cwd },
    },
    "2026-06-27T00:03:00.000Z",
  );
  store.denyApprovalRequest(approval.id, { reason: "risk review denied", resolvedBy: "local-user" }, "2026-06-27T00:04:00.000Z");
  const lease = store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "bound_path",
    resourceKey: cwd,
    ownerType: "run",
    ownerId: run.id,
    acquiredAt: "2026-06-27T00:05:00.000Z",
    expiresAt: "2027-06-27T00:35:00.000Z",
  });
  assert.ok(lease);
  const before = {
    approvals: store.listApprovalRequests({ limit: 50 }).length,
    leases: store.listResourceLeases({ limit: 50 }).length,
    runs: store.listRuns({ limit: 50 }).length,
  };
  store.close();

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-authority-ledger?cwd=${encodeURIComponent(cwd)}&limit=50`);

    assert.equal(response.cwd, cwd);
    assert.equal(response.channelId, channel.id);
    assert.equal(response.ledger.channelId, channel.id);
    assert.match(response.ledger.note, /does not grant permissions/);
    assert.deepEqual(
      response.ledger.entries.map((entry) => [entry.id, entry.authority, entry.status]),
      [
        [`lease:${lease.id}`, "read", "granted"],
        [`approval:${approval.id}`, "approval", "denied"],
        [`reply:${reply.id}`, "reply", "granted"],
        ["run:run_authority_demo", "run", "granted"],
      ],
    );
    assert.match(response.ledger.entries.find((entry) => entry.id === `approval:${approval.id}`)?.scope, /Risk review required/);

    const storeAfter = createSqliteRunStore(cwd);
    try {
      assert.equal(storeAfter.listApprovalRequests({ limit: 50 }).length, before.approvals);
      assert.equal(storeAfter.listResourceLeases({ limit: 50 }).length, before.leases);
      assert.equal(storeAfter.listRuns({ limit: 50 }).length, before.runs);
    } finally {
      storeAfter.close();
    }

    const missingChannel = await requestJson(`${baseUrl}/channels/missing_channel/team-authority-ledger?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingChannel.status, 404);
    assert.equal(missingChannel.body.error, "channel_not_found");

    const missingCwd = await requestJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-authority-ledger`);
    assert.equal(missingCwd.status, 400);
    assert.equal(missingCwd.body.error, "bad_request");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function requestJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text),
  };
}

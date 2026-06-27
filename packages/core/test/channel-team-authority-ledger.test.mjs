import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChannelTeamAuthorityLedgerProjection } from "../dist/index.js";

const now = "2026-06-27T00:10:00.000Z";

test("authority ledger projects run reply approval and read lease facts without granting authority", () => {
  const projection = buildChannelTeamAuthorityLedgerProjection({
    channelId: "channel_demo",
    now,
    limit: 20,
    runs: [
      run({
        id: "run_demo",
        channelId: "channel_demo",
        teammateId: "architect",
        status: "running",
        createdAt: "2026-06-27T00:01:00.000Z",
      }),
      run({
        id: "run_other",
        channelId: "channel_other",
        teammateId: "security",
        createdAt: "2026-06-27T00:02:00.000Z",
      }),
    ],
    approvals: [
      approval({
        id: "approval_force_push",
        runId: "run_demo",
        actionType: "git_push",
        risk: "high",
        title: "Risk review required: Approve git push",
        status: "pending",
        createdAt: "2026-06-27T00:03:00.000Z",
      }),
      approval({
        id: "approval_denied",
        channelId: "channel_demo",
        actionType: "bash",
        risk: "critical",
        title: "Risk review required: destructive command",
        status: "denied",
        createdAt: "2026-06-27T00:04:00.000Z",
      }),
      approval({
        id: "approval_other",
        channelId: "channel_other",
        status: "approved",
        createdAt: "2026-06-27T00:05:00.000Z",
      }),
    ],
    messages: [
      channelMessage({
        id: "reply_architect",
        channelId: "channel_demo",
        threadId: "source_message",
        authorId: "architect",
        status: "ready",
        createdAt: "2026-06-27T00:06:00.000Z",
      }),
      channelMessage({
        id: "reply_other",
        channelId: "channel_other",
        authorId: "security",
        createdAt: "2026-06-27T00:07:00.000Z",
      }),
    ],
    resourceLeases: [
      {
        id: "lease_workspace_read",
        workspaceId: "workspace_default",
        resourceType: "bound_path",
        resourceKey: "/tmp/demo",
        ownerType: "run",
        ownerId: "run_demo",
        status: "active",
        acquiredAt: "2026-06-27T00:08:00.000Z",
        expiresAt: "2026-06-27T00:18:00.000Z",
      },
      {
        id: "lease_other",
        workspaceId: "workspace_default",
        resourceType: "bound_path",
        resourceKey: "/tmp/other",
        ownerType: "run",
        ownerId: "run_other",
        status: "active",
        acquiredAt: "2026-06-27T00:09:00.000Z",
        expiresAt: "2026-06-27T00:19:00.000Z",
      },
    ],
  });

  assert.equal(projection.channelId, "channel_demo");
  assert.equal(projection.generatedAt, now);
  assert.match(projection.note, /read-only projection/);
  assert.deepEqual(
    projection.entries.map((entry) => [entry.id, entry.authority, entry.status]),
    [
      ["lease:lease_workspace_read", "read", "granted"],
      ["reply:reply_architect", "reply", "granted"],
      ["approval:approval_denied", "approval", "denied"],
      ["approval:approval_force_push", "approval", "requested"],
      ["run:run_demo", "run", "granted"],
    ],
  );
  assert.equal(projection.entries.find((entry) => entry.id === "approval:approval_force_push")?.scope.includes("Risk review required"), true);
  assert.equal(projection.entries.some((entry) => entry.id.includes("other")), false);
});

test("authority ledger maps terminal authority states conservatively", () => {
  const projection = buildChannelTeamAuthorityLedgerProjection({
    channelId: "channel_demo",
    now,
    runs: [
      run({ id: "run_queued", channelId: "channel_demo", status: "queued", createdAt: "2026-06-27T00:01:00.000Z" }),
      run({ id: "run_cancelled", channelId: "channel_demo", status: "cancelled", createdAt: "2026-06-27T00:02:00.000Z" }),
    ],
    approvals: [
      approval({ id: "approval_approved", channelId: "channel_demo", status: "approved", createdAt: "2026-06-27T00:03:00.000Z" }),
      approval({ id: "approval_expired", channelId: "channel_demo", status: "expired", createdAt: "2026-06-27T00:04:00.000Z" }),
      approval({ id: "approval_cancelled", channelId: "channel_demo", status: "cancelled", createdAt: "2026-06-27T00:05:00.000Z" }),
    ],
    messages: [
      channelMessage({ id: "reply_pending", channelId: "channel_demo", status: "pending", createdAt: "2026-06-27T00:06:00.000Z" }),
      channelMessage({ id: "reply_blocked", channelId: "channel_demo", status: "blocked", createdAt: "2026-06-27T00:07:00.000Z" }),
      channelMessage({ id: "reply_failed", channelId: "channel_demo", status: "failed", createdAt: "2026-06-27T00:08:00.000Z" }),
    ],
    resourceLeases: [
      {
        id: "lease_expired",
        workspaceId: "workspace_default",
        resourceType: "channel",
        resourceKey: "channel_demo",
        ownerType: "system",
        ownerId: "system",
        status: "expired",
        acquiredAt: "2026-06-27T00:09:00.000Z",
        expiresAt: "2026-06-27T00:10:00.000Z",
      },
      {
        id: "lease_released",
        workspaceId: "workspace_default",
        resourceType: "channel",
        resourceKey: "channel_demo",
        ownerType: "system",
        ownerId: "system",
        status: "released",
        acquiredAt: "2026-06-27T00:10:00.000Z",
        expiresAt: "2026-06-27T00:11:00.000Z",
      },
    ],
  });

  const statusById = Object.fromEntries(projection.entries.map((entry) => [entry.id, entry.status]));
  assert.equal(statusById["run:run_queued"], "requested");
  assert.equal(statusById["run:run_cancelled"], "revoked");
  assert.equal(statusById["approval:approval_approved"], "granted");
  assert.equal(statusById["approval:approval_expired"], "expired");
  assert.equal(statusById["approval:approval_cancelled"], "revoked");
  assert.equal(statusById["reply:reply_pending"], "requested");
  assert.equal(statusById["reply:reply_blocked"], "denied");
  assert.equal(statusById["reply:reply_failed"], "revoked");
  assert.equal(statusById["lease:lease_expired"], "expired");
  assert.equal(statusById["lease:lease_released"], "revoked");
});

function run(overrides = {}) {
  return {
    id: "run_demo",
    status: "succeeded",
    cwd: "/tmp/demo",
    taskId: "task_demo",
    channelId: "channel_demo",
    teammateId: "architect",
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: { id: "task_demo", title: "Demo task" },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd: "/tmp/demo" },
    eventLogPath: ".ling-stack/sessions/run_demo.jsonl",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides = {}) {
  return {
    id: "approval_demo",
    runId: undefined,
    taskId: "task_demo",
    channelId: "channel_demo",
    actionType: "bash",
    risk: "medium",
    title: "Approve shell command",
    description: "echo demo",
    payload: { type: "bash", command: "echo demo", cwd: "/tmp/demo" },
    status: "pending",
    createdAt: "2026-06-27T00:00:00.000Z",
    expiresAt: "2026-06-27T00:30:00.000Z",
    ...overrides,
  };
}

function channelMessage(overrides = {}) {
  return {
    id: "reply_demo",
    workspaceId: "workspace_default",
    channelId: "channel_demo",
    threadId: "source_message",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "architect",
    body: "Reply body.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

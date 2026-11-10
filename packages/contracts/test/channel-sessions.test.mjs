import assert from "node:assert/strict";
import test from "node:test";
import { isCreateChannelSessionRequest, isUpdateChannelSessionRequest, isChannelSessionSummary,
  isChannelSessionListResponse, isLingThreadContinuityV2 } from "../dist/index.js";

test("an empty channel session is a root continuity object without fork lineage", () => {
  assert.equal(isLingThreadContinuityV2({ surfaceKind: "channel_session", relationKind: "root" }), true);
  for (const lineage of [{ parentThreadId: "parent" }, { forkContextSnapshotId: "snapshot" }, { parentTurnId: "turn" }]) {
    assert.equal(isLingThreadContinuityV2({ surfaceKind: "channel_session", relationKind: "root", ...lineage }), false);
  }
  assert.equal(isLingThreadContinuityV2({ surfaceKind: "channel_session", relationKind: "branch",
    parentThreadId: "parent", parentTurnId: "turn", forkContextSnapshotId: "snapshot" }), false);
});

test("session writes require a creation key, bounded Unicode titles and explicit patch fields", () => {
  assert.equal(isCreateChannelSessionRequest({ idempotencyKey: "draft-1" }), true);
  assert.equal(isCreateChannelSessionRequest({ title: "🎉".repeat(120), idempotencyKey: "draft-1" }), true);
  for (const input of [{}, { idempotencyKey: " " }, { idempotencyKey: "x".repeat(257) },
    { idempotencyKey: "key", title: "" }, { idempotencyKey: "key", title: "🎉".repeat(121) },
    { idempotencyKey: "key", channelId: "another-channel" }, { idempotencyKey: "key", title: null }]) {
    assert.equal(isCreateChannelSessionRequest(input), false, JSON.stringify(input));
  }
  for (const input of [{ title: "新名字" }, { archived: true }, { archived: false }, { title: "名称", archived: true }]) {
    assert.equal(isUpdateChannelSessionRequest(input), true);
  }
  for (const input of [{}, { archived: "false" }, { title: "  " }, { rootThreadId: "foreign" }, { archived: null }]) {
    assert.equal(isUpdateChannelSessionRequest(input), false);
  }
});

test("session summaries preserve canonical identity, default and pagination boundaries", () => {
  const base = { id: "thread-1", channelId: "channel", title: "会话", isDefault: false,
    legacyBranchId: "branch-1", surfaceKind: "channel_session", createdAt: "2026-10-29T00:00:00.000Z",
    activityAt: "2026-10-29T00:00:00.000Z", latestNotificationRevision: 3, pendingApprovalCount: 0, activeRunIds: [], pendingApprovalIds: [], runtimeState: "idle" };
  assert.equal(isChannelSessionSummary(base), true);
  assert.equal(isChannelSessionSummary({ ...base, activeRunIds: ["run-A"], pendingApprovalIds: ["approval-A"], pendingApprovalCount: 1 }), true);
  assert.equal(isChannelSessionSummary({ ...base, activeRunIds: ["run-A", "run-A"] }), false);
  assert.equal(isChannelSessionSummary({ ...base, pendingApprovalIds: ["approval-A"] }), false);
  assert.equal(isChannelSessionSummary({ ...base, pendingApprovalIds: [null] }), false);
  assert.equal(isChannelSessionSummary({ ...base, isDefault: true }), false);
  assert.equal(isChannelSessionSummary({ ...base, latestNotificationRevision: -1 }), false);
  const root = { ...base, id: "root", legacyBranchId: undefined, surfaceKind: "channel_root", isDefault: true };
  assert.equal(isChannelSessionSummary(root), true);
  const response = { cwd: "/workspace", channelId: "channel", defaultSession: root, sessions: [base], diagnostics: [],
    notificationWatermarks: [{ id: "thread-outside-page", latestNotificationRevision: 10 }],
    aggregate: { pendingApprovalCount: 0, runningCount: 0, waitingCount: 0, failedCount: 0 } };
  assert.equal(isChannelSessionListResponse(response), true);
  assert.equal(isChannelSessionListResponse({ ...response, sessions: [base, base] }), false);
  assert.equal(isChannelSessionListResponse({ ...response, sessions: [{ ...base, channelId: "foreign" }] }), false);
  assert.equal(isChannelSessionListResponse({ ...response, sessions: [root] }), false);
});

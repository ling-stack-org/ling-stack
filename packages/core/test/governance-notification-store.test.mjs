import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-06-21T00:00:00.000Z";

function notificationInput(overrides = {}) {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    surface: overrides.surface ?? { kind: "channel", channelId: "channel_1" },
    kind: overrides.kind ?? "skill_candidate",
    severity: overrides.severity ?? "action_required",
    title: overrides.title ?? "Skill candidate ready",
    summary: overrides.summary ?? "A reusable skill candidate is waiting for review.",
    sourceRefs: overrides.sourceRefs ?? [{ type: "skill_candidate", id: "skill_candidate_1", label: "Skill candidate" }],
    targetRoute: overrides.targetRoute ?? { page: "skill_candidate", candidateId: "skill_candidate_1" },
    status: overrides.status,
    deliveryStatus: overrides.deliveryStatus,
    deliveryBlockedReason: overrides.deliveryBlockedReason,
    deliverAfter: overrides.deliverAfter,
    deliveredAt: overrides.deliveredAt,
    dedupeKey: overrides.dedupeKey ?? "workspace_default:channel:channel_1:skill_candidate:skill_candidate_1:pending",
  };
}

async function withStore(prefix, fn) {
  const cwd = await mkdtemp(resolve(tmpdir(), prefix));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      await fn(store, cwd);
    } finally {
      store.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("sqlite governance notifications upsert by dedupe key and preserve user lifecycle", async () => {
  await withStore("ling-stack-governance-notification-", async (store, cwd) => {
    const created = store.upsertGovernanceNotification(notificationInput(), now);
    assert.equal(created.created, true);
    assert.equal(created.notification.status, "unread");
    assert.equal(created.notification.deliveryStatus, "pending");

    const seen = store.markGovernanceNotificationSeen(created.notification.id, "2026-06-21T00:01:00.000Z");
    assert.equal(seen?.status, "seen");

    const updated = store.upsertGovernanceNotification(notificationInput({
      title: "Skill candidate still ready",
      severity: "critical",
      summary: "The same candidate changed severity.",
    }), "2026-06-21T00:02:00.000Z");
    assert.equal(updated.created, false);
    assert.equal(updated.notification.id, created.notification.id);
    assert.equal(updated.notification.title, "Skill candidate still ready");
    assert.equal(updated.notification.severity, "critical");
    assert.equal(updated.notification.status, "seen");
    assert.deepEqual(store.listGovernanceNotifications({ surface: "channel", channelId: "channel_1" }).map((item) => item.id), [created.notification.id]);

    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getGovernanceNotification(created.notification.id)?.title, "Skill candidate still ready");
      assert.equal(reopened.listGovernanceNotifications({ limit: 10 }).length, 1);
    } finally {
      reopened.close();
    }
  });
});

test("sqlite governance notifications hide dismissed and resolved rows from default list", async () => {
  await withStore("ling-stack-governance-notification-lifecycle-", async (store) => {
    const active = store.upsertGovernanceNotification(notificationInput({
      id: "governance_notification_active",
      dedupeKey: "active-key",
    }), now).notification;
    const dismissed = store.upsertGovernanceNotification(notificationInput({
      id: "governance_notification_dismissed",
      dedupeKey: "dismissed-key",
      sourceRefs: [{ type: "memory", id: "memory_1", label: "Candidate memory" }],
      targetRoute: { page: "memory_promotion_inbox", memoryId: "memory_1", channelId: "channel_1" },
      kind: "memory_candidate",
    }), now).notification;
    const resolved = store.upsertGovernanceNotification(notificationInput({
      id: "governance_notification_resolved",
      dedupeKey: "resolved-key",
      sourceRefs: [{ type: "procedure_cluster", id: "cluster_1" }],
      targetRoute: { page: "procedure_cluster", clusterId: "cluster_1" },
      kind: "procedure_cluster",
    }), now).notification;

    store.dismissGovernanceNotification(dismissed.id, "2026-06-21T00:01:00.000Z");
    store.resolveGovernanceNotificationByDedupeKey("workspace_default", "resolved-key", "2026-06-21T00:02:00.000Z");

    assert.deepEqual(store.listGovernanceNotifications().map((item) => item.id), [active.id]);
    assert.equal(store.listGovernanceNotifications({ includeDismissed: true }).some((item) => item.id === dismissed.id), true);
    assert.equal(store.listGovernanceNotifications({ includeResolved: true }).some((item) => item.id === resolved.id), true);
    assert.equal(store.getGovernanceNotification(resolved.id)?.status, "resolved");
    assert.equal(store.getGovernanceNotification(resolved.id)?.deliveryStatus, "suppressed");

    const summary = store.getGovernanceNotificationSummary("workspace_default", "2026-06-21T00:03:00.000Z");
    assert.equal(summary.total, 3);
    assert.equal(summary.actionable, 1);
    assert.equal(summary.unread, 1);
    assert.equal(summary.bySurface[0].surface.kind, "channel");
  });
});

test("sqlite governance notification source refs round trip without source bodies", async () => {
  await withStore("ling-stack-governance-notification-source-refs-", async (store) => {
    const notification = store.upsertGovernanceNotification(notificationInput({
      kind: "memory_candidate",
      sourceRefs: [{ type: "memory", id: "memory_private", label: "Private candidate title" }],
      targetRoute: { page: "memory_promotion_inbox", memoryId: "memory_private", teammateId: "teammate_1" },
      surface: { kind: "teammate_direct", teammateId: "teammate_1", threadId: "thread_1" },
      deliveryStatus: "pending",
      dedupeKey: "workspace_default:teammate_direct:teammate_1:thread_1:memory_private:candidate",
    }), now).notification;

    assert.deepEqual(notification.sourceRefs, [{ type: "memory", id: "memory_private", label: "Private candidate title" }]);
    assert.equal(JSON.stringify(notification).includes("private memory body should never appear"), false);
    assert.equal(store.getGovernanceNotificationSummary().pendingDelivery, 1);
  });
});

test("sqlite governance notification delivery state can be updated without changing lifecycle", async () => {
  await withStore("ling-stack-governance-notification-delivery-", async (store) => {
    const notification = store.upsertGovernanceNotification(notificationInput({
      surface: { kind: "teammate_direct", teammateId: "teammate_1", threadId: "thread_1" },
      deliveryStatus: "pending",
      deliveryBlockedReason: "recent_user_input",
      deliverAfter: "2026-06-21T00:15:00.000Z",
      dedupeKey: "workspace_default:teammate_direct:teammate_1:thread_1:skill_candidate:skill_candidate_1",
    }), now).notification;

    const deliveredAt = "2026-06-21T00:16:00.000Z";
    const delivered = store.updateGovernanceNotificationDelivery(notification.id, {
      deliveryStatus: "delivered",
      deliveryBlockedReason: null,
      deliverAfter: null,
      deliveredAt,
    }, deliveredAt);

    assert.equal(delivered?.status, "unread");
    assert.equal(delivered?.deliveryStatus, "delivered");
    assert.equal(delivered?.deliveryBlockedReason, undefined);
    assert.equal(delivered?.deliverAfter, undefined);
    assert.equal(delivered?.deliveredAt, deliveredAt);
    assert.equal(store.getGovernanceNotificationSummary().pendingDelivery, 0);
  });
});

test("memory candidate notifications pending-deliver on Ling Agent surface", async () => {
  const { memoryCandidateGovernanceNotificationInput } = await import("../dist/index.js");
  const input = memoryCandidateGovernanceNotificationInput({
    id: "memory_workspace_candidate",
    workspaceId: "workspace_default",
    scopeType: "workspace",
    ownerId: "workspace_default",
    title: "Workspace candidate",
    body: "Workspace source body must not be copied.",
    tags: [],
    sourceRefs: [],
    reviewState: "candidate",
    enabled: true,
    sensitivity: "normal",
    verifyBeforeUse: false,
    createdBy: "local-user",
    createdAt: now,
    updatedAt: now,
  }, { kind: "ling_agent", teammateId: "ling_agent" });

  assert.equal(input?.deliveryStatus, "pending");
  assert.equal(input?.surface.kind, "ling_agent");
  assert.equal(JSON.stringify(input).includes("Workspace source body"), false);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";
import { flushTeammateDirectGovernanceNotifications } from "../dist/features/governance-notifications/private-delivery.js";
import { createSqliteRunStore } from "../../core/dist/index.js";

const teammateId = "teammate_builtin_engineer";
const lingAgentId = "ling_agent";
const quietWindowMs = 15 * 60 * 1000;

test("governance notification API exposes memory candidate projections and lifecycle", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-governance-notifications-api-"));
  const daemon = await startDaemonForTest();
  try {
    const memory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "channel",
      ownerId: "channel_1",
      title: "Review channel preference",
      body: "Private source body must not be copied into notifications.",
      reviewState: "candidate",
      sourceRefs: [{ type: "manual", id: "manual_1", label: "Operator note" }],
    })).memory;

    const listed = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=channel&channelId=channel_1`);
    assert.equal(listed.notifications.length, 1);
    assert.equal(listed.notifications[0].kind, "memory_candidate");
    assert.equal(listed.notifications[0].surface.kind, "channel");
    assert.equal(listed.notifications[0].targetRoute.page, "memory_promotion_inbox");
    assert.equal(listed.notifications[0].targetRoute.memoryId, memory.id);
    assert.equal(JSON.stringify(listed.notifications[0]).includes("Private source body"), false);

    const summary = await getJson(`${daemon.url}/governance-notifications/summary?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(summary.summary.actionable, 1);
    assert.equal(summary.summary.bySurface[0].surface.channelId, "channel_1");

    const seen = await postJson(`${daemon.url}/governance-notifications/${encodeURIComponent(listed.notifications[0].id)}/seen?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(seen.notification.status, "seen");
    const dismissed = await postJson(`${daemon.url}/governance-notifications/${encodeURIComponent(listed.notifications[0].id)}/dismiss?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(dismissed.notification.status, "dismissed");
    const hidden = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=channel&channelId=channel_1`);
    assert.equal(hidden.notifications.length, 0);

    await postJson(`${daemon.url}/memory/${encodeURIComponent(memory.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve",
      reason: "Reviewed.",
    });
    const resolved = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=channel&channelId=channel_1&includeResolved=true&includeDismissed=true`);
    assert.equal(resolved.notifications.length, 1);
    assert.equal(resolved.notifications[0].status, "resolved");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct governance notification delivers one private system message after quiet gate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-governance-notifications-direct-api-"));
  const daemon = await startDaemonForTest();
  try {
    await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-thread?cwd=${encodeURIComponent(cwd)}`);
    const memory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Private review memory",
      body: "Private teammate memory body must not be copied into direct notifications.",
      reviewState: "candidate",
      sourceRefs: [{ type: "manual", id: "manual_private", label: "Private operator note" }],
    })).memory;

    const listed = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=teammate_direct&teammateId=${encodeURIComponent(teammateId)}`);
    assert.equal(listed.notifications.length, 1);
    assert.equal(listed.notifications[0].surface.kind, "teammate_direct");
    assert.equal(listed.notifications[0].targetRoute.memoryId, memory.id);
    assert.equal(listed.notifications[0].deliveryStatus, "delivered");
    assert.equal(typeof listed.notifications[0].deliveredAt, "string");
    assert.equal(JSON.stringify(listed.notifications[0]).includes("Private teammate memory body"), false);

    const directMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const systemMessages = directMessages.messages.filter((message) => message.authorType === "system");
    assert.equal(systemMessages.length, 1);
    assert.equal(systemMessages[0].systemPurpose, "governance_notification");
    assert.match(systemMessages[0].body, /Memory Review/);
    assert.doesNotMatch(systemMessages[0].body, /Private teammate memory body/);

    await getJson(`${daemon.url}/governance-notifications/summary?cwd=${encodeURIComponent(cwd)}`);
    const repeatedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(repeatedMessages.messages.filter((message) => message.authorType === "system").length, 1);

    const channelLeak = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=channel&channelId=channel_1`);
    assert.equal(channelLeak.notifications.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct governance notification defers during the 15 minute quiet window", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-governance-notifications-direct-quiet-api-"));
  const daemon = await startDaemonForTest();
  try {
    await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-thread?cwd=${encodeURIComponent(cwd)}`);
    const directMessage = (await postJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`, {
      body: "Still working in this private chat.",
      requestAiReply: false,
    })).message;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Quiet window memory",
      body: "Quiet window source body must not be copied.",
      reviewState: "candidate",
      sourceRefs: [{ type: "manual", id: "manual_quiet", label: "Quiet operator note" }],
    });

    await getJson(`${daemon.url}/governance-notifications/summary?cwd=${encodeURIComponent(cwd)}`);
    const listed = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=teammate_direct&teammateId=${encodeURIComponent(teammateId)}`);
    assert.equal(listed.notifications.length, 1);
    assert.equal(listed.notifications[0].deliveryStatus, "pending");
    assert.equal(listed.notifications[0].deliveryBlockedReason, "recent_user_input");
    assert.equal(listed.notifications[0].deliverAfter, new Date(Date.parse(directMessage.updatedAt) + quietWindowMs).toISOString());

    const directMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(teammateId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(directMessages.messages.filter((message) => message.authorType === "system").length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("teammate direct governance flush defers while an AI reply message is pending", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-governance-notifications-pending-reply-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-06-21T00:00:00.000Z";
    const thread = store.getOrCreateTeammateDirectThread(teammateId, now);
    store.createTeammateDirectMessage({
      threadId: thread.id,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      status: "pending",
    }, now);
    const notification = store.upsertGovernanceNotification({
      surface: { kind: "teammate_direct", teammateId, threadId: thread.id },
      kind: "skill_candidate",
      severity: "action_required",
      title: "Skill candidate ready",
      summary: "A reusable skill candidate is waiting for review.",
      sourceRefs: [{ type: "skill_candidate", id: "skill_candidate_1", label: "Skill candidate" }],
      targetRoute: { page: "skill_candidate", candidateId: "skill_candidate_1" },
      deliveryStatus: "pending",
      dedupeKey: `workspace_default:teammate_direct:${teammateId}:${thread.id}:skill_candidate:skill_candidate_1`,
    }, now).notification;

    const result = flushTeammateDirectGovernanceNotifications(store, {
      now: "2026-06-21T00:01:00.000Z",
      quietWindowMs,
      teammateId,
      threadId: thread.id,
    });

    assert.deepEqual(result, { checked: 1, delivered: 0, deferred: 1, suppressed: 0 });
    const updated = store.getGovernanceNotification(notification.id);
    assert.equal(updated?.deliveryStatus, "pending");
    assert.equal(updated?.deliveryBlockedReason, "teammate_reply_running");
    assert.equal(store.listTeammateDirectMessages({ teammateId, threadId: thread.id }).filter((message) => message.authorType === "system").length, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace governance notifications deliver one Ling Agent digest", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-governance-notifications-ling-agent-"));
  const daemon = await startDaemonForTest();
  try {
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Workspace review memory",
      body: "Workspace governance body must not be copied into Ling Agent digest.",
      reviewState: "candidate",
      sourceRefs: [{ type: "manual", id: "manual_workspace", label: "Workspace operator note" }],
    });
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Workspace review memory 2",
      body: "Second workspace governance body must not be copied either.",
      reviewState: "candidate",
      sourceRefs: [{ type: "manual", id: "manual_workspace_2", label: "Second operator note" }],
    });

    const listed = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=ling_agent&teammateId=${encodeURIComponent(lingAgentId)}`);
    assert.equal(listed.notifications.length, 2);
    assert.equal(listed.notifications.every((notification) => notification.deliveryStatus === "delivered"), true);
    assert.equal(listed.notifications.every((notification) => notification.surface.kind === "ling_agent"), true);

    const directMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(lingAgentId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    const systemMessages = directMessages.messages.filter((message) => message.authorType === "system");
    assert.equal(systemMessages.length, 1);
    assert.equal(systemMessages[0].systemPurpose, "governance_notification");
    assert.match(systemMessages[0].body, /Workspace review digest: 2 items need attention/);
    assert.match(systemMessages[0].body, /Workspace review memory/);
    assert.doesNotMatch(systemMessages[0].body, /Workspace governance body/);
    assert.doesNotMatch(systemMessages[0].body, /Second workspace governance body/);

    await getJson(`${daemon.url}/governance-notifications/summary?cwd=${encodeURIComponent(cwd)}`);
    const repeatedMessages = await getJson(`${daemon.url}/teammates/${encodeURIComponent(lingAgentId)}/direct-messages?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(repeatedMessages.messages.filter((message) => message.authorType === "system").length, 1);

    const channelLeak = await getJson(`${daemon.url}/governance-notifications?cwd=${encodeURIComponent(cwd)}&surface=channel&channelId=channel_1`);
    assert.equal(channelLeak.notifications.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function startDaemonForTest() {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${text}`);
  }
  return text.trim() ? JSON.parse(text) : {};
}

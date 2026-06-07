import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("sqlite work items persist CRUD, route, claim, heartbeat, release, complete, and fail", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-work-items-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-06-01T00:00:00.000Z";
    const channel = store.createChannel({ name: "Ops", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    const routedChannel = store.createChannel({ name: "Review", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    assert.ok(store.getAiTeammate("teammate_builtin_engineer"));

    const item = store.upsertWorkItem({
      channelId: channel.id,
      sourceType: "manual",
      sourceId: "manual-1",
      title: "Review release notes",
      labels: ["release"],
      retryBudget: 2,
    }, now);
    assert.equal(item.status, "ready");
    assert.equal(item.channelId, channel.id);
    assert.equal(store.listWorkItems({ channelId: channel.id }).length, 1);

    const routed = store.routeWorkItem(item.id, {
      channelId: routedChannel.id,
      priority: "high",
      assigneeTeammateId: "teammate_builtin_engineer",
    }, "2026-06-01T00:01:00.000Z");
    assert.equal(routed.channelId, routedChannel.id);
    assert.equal(routed.priority, "high");
    assert.equal(routed.assigneeTeammateId, "teammate_builtin_engineer");

    const claimed = store.claimWorkItem(item.id, { ownerId: "agent-a", leaseMs: 60_000 }, "2026-06-01T00:02:00.000Z");
    assert.ok(claimed.claimToken);
    assert.equal(claimed.workItem.status, "running");
    assert.equal(claimed.workItem.claim.ownerId, "agent-a");
    assert.equal(claimed.workItem.attemptCount, 1);

    const blocked = store.claimWorkItem(item.id, { ownerId: "agent-b", leaseMs: 60_000 }, "2026-06-01T00:02:30.000Z");
    assert.equal(blocked.blocker.code, "already_claimed");
    assert.equal(blocked.blocker.claimedBy, "agent-a");

    const heartbeated = store.heartbeatWorkItem(item.id, {
      claimToken: claimed.claimToken,
      leaseMs: 120_000,
    }, "2026-06-01T00:03:00.000Z");
    assert.equal(heartbeated.claim.heartbeatAt, "2026-06-01T00:03:00.000Z");
    assert.equal(heartbeated.claim.expiresAt, "2026-06-01T00:05:00.000Z");

    const released = store.releaseWorkItem(item.id, { claimToken: claimed.claimToken }, "2026-06-01T00:04:00.000Z");
    assert.equal(released.status, "ready");
    assert.equal(released.claim, undefined);

    const retryItem = store.upsertWorkItem({
      sourceType: "manual",
      sourceId: "manual-retry",
      title: "Retry once",
      retryBudget: 2,
    }, "2026-06-01T00:04:30.000Z");
    const retryClaim = store.claimWorkItem(retryItem.id, { ownerId: "agent-b", leaseMs: 60_000 }, "2026-06-01T00:05:00.000Z");
    const failed = store.failWorkItem(retryItem.id, {
      claimToken: retryClaim.claimToken,
      reason: "Needs input",
      retry: true,
    }, "2026-06-01T00:06:00.000Z");
    assert.equal(failed.status, "ready");
    assert.equal(failed.failedAt, "2026-06-01T00:06:00.000Z");
    assert.equal(failed.failureReason, "Needs input");

    const thirdClaim = store.claimWorkItem(item.id, { ownerId: "agent-c", leaseMs: 60_000 }, "2026-06-01T00:07:00.000Z");
    const completed = store.completeWorkItem(item.id, {
      claimToken: thirdClaim.claimToken,
      proofArtifactIds: ["artifact_1"],
    }, "2026-06-01T00:08:00.000Z");
    assert.equal(completed.status, "done");
    assert.deepEqual(completed.proofArtifactIds, ["artifact_1"]);
    assert.equal(completed.claim, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work item claim honors expired leases, dependency blockers, retry budget, and terminal status", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-work-items-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-06-01T00:00:00.000Z";
    const dependency = store.upsertWorkItem({
      sourceType: "manual",
      sourceId: "dependency",
      title: "Dependency",
    }, now);
    const dependent = store.upsertWorkItem({
      sourceType: "manual",
      sourceId: "dependent",
      title: "Dependent",
      dependencyIds: [dependency.id],
    }, now);

    const blockedByDependency = store.claimWorkItem(dependent.id, { ownerId: "agent-a" }, "2026-06-01T00:01:00.000Z");
    assert.equal(blockedByDependency.blocker.code, "dependency_blocked");
    assert.deepEqual(blockedByDependency.blocker.dependencyIds, [dependency.id]);

    const depClaim = store.claimWorkItem(dependency.id, { ownerId: "agent-a" }, "2026-06-01T00:02:00.000Z");
    store.completeWorkItem(dependency.id, { claimToken: depClaim.claimToken }, "2026-06-01T00:03:00.000Z");

    const firstClaim = store.claimWorkItem(dependent.id, { ownerId: "agent-a", leaseMs: 1_000 }, "2026-06-01T00:04:00.000Z");
    assert.ok(firstClaim.claimToken);
    const reclaimed = store.claimWorkItem(dependent.id, { ownerId: "agent-b", leaseMs: 60_000 }, "2026-06-01T00:04:31.000Z");
    assert.ok(reclaimed.claimToken);
    assert.equal(reclaimed.workItem.claim.ownerId, "agent-b");

    const terminal = store.completeWorkItem(dependent.id, { claimToken: reclaimed.claimToken }, "2026-06-01T00:05:00.000Z");
    assert.equal(terminal.status, "done");
    const blockedTerminal = store.claimWorkItem(dependent.id, { ownerId: "agent-c" }, "2026-06-01T00:06:00.000Z");
    assert.equal(blockedTerminal.blocker.code, "terminal");

    const retryLimited = store.upsertWorkItem({
      sourceType: "manual",
      sourceId: "retry-limited",
      title: "Retry limited",
      retryBudget: 1,
    }, now);
    const limitedClaim = store.claimWorkItem(retryLimited.id, { ownerId: "agent-a" }, "2026-06-01T00:07:00.000Z");
    store.failWorkItem(retryLimited.id, {
      claimToken: limitedClaim.claimToken,
      reason: "Failed",
      retry: true,
    }, "2026-06-01T00:08:00.000Z");
    const blockedRetry = store.claimWorkItem(retryLimited.id, { ownerId: "agent-b" }, "2026-06-01T00:09:00.000Z");
    assert.equal(blockedRetry.blocker.code, "retry_budget_exhausted");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  defaultChannelRuntimePolicy,
} from "../dist/index.js";

test("sqlite channels persist default and edited runtime policy", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-runtime-"));
  const now = "2026-05-26T00:00:00.000Z";
  const updatedAt = "2026-05-26T00:01:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const created = store.createChannel(
      {
        name: "Engineering",
        boundPath: cwd,
      },
      now,
    );

    assert.equal(created.status, "active");
    assert.deepEqual(created.runtimePolicy, defaultChannelRuntimePolicy);

    const updated = store.updateChannel(
      created.id,
      {
        status: "paused",
        runtimePolicy: {
          executionMode: "parallel",
          maxConcurrentRuns: 3,
          writeLockScope: "workspace",
          allowReadOnlyParallel: false,
          queueOnConflict: false,
        },
      },
      updatedAt,
    );

    assert.ok(updated);
    assert.equal(updated.status, "paused");
    assert.deepEqual(updated.runtimePolicy, {
      executionMode: "parallel",
      maxConcurrentRuns: 3,
      writeLockScope: "workspace",
      allowReadOnlyParallel: false,
      queueOnConflict: false,
    });
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite task CAS claim and idempotency allow only one real transition", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-task-cas-"));
  const now = "2026-05-26T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const task = store.createTask(
      {
        channelId: channel.id,
        title: "Inspect workspace",
        prompt: "Inspect the repo.",
      },
      now,
    );

    const first = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_first",
      idempotencyKey: "client-key-1",
      now: "2026-05-26T00:00:01.000Z",
    });
    assert.deepEqual(first, { ok: true, from: "todo", to: "claimed" });

    const stale = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_second",
      idempotencyKey: "client-key-2",
      now: "2026-05-26T00:00:02.000Z",
    });
    assert.deepEqual(stale, {
      ok: false,
      code: "stale_transition",
      currentStatus: "claimed",
    });

    const duplicate = store.transitionTaskStatus({
      taskId: task.id,
      expectedStatus: "todo",
      event: "claim",
      actor: "system",
      reason: "run:run_first",
      idempotencyKey: "client-key-1",
      now: "2026-05-26T00:00:03.000Z",
    });
    assert.deepEqual(duplicate, {
      ok: true,
      from: "claimed",
      to: "claimed",
      duplicate: true,
    });

    const events = store.listStateTransitionEvents({ entityType: "task", entityId: task.id });
    assert.equal(events.length, 1);
    assert.equal(events[0].fromStatus, "todo");
    assert.equal(events[0].toStatus, "claimed");
    assert.equal(events[0].idempotencyKey, "client-key-1");
    assert.equal(store.findStateTransitionByIdempotency("task", task.id, "client-key-1")?.reason, "run:run_first");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite active resource lease index blocks conflicting writers until release", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-lease-conflict-"));
  const store = createSqliteRunStore(cwd);
  const acquiredAt = "2026-05-26T00:00:00.000Z";
  const expiresAt = "2026-05-26T01:00:00.000Z";
  try {
    const first = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_first",
      acquiredAt,
      expiresAt,
    });
    assert.ok(first);

    const second = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_second",
      acquiredAt,
      expiresAt,
    });
    assert.equal(second, undefined);
    assert.equal(store.getBlockingResourceLease("bound_path", cwd)?.ownerId, "run_first");

    assert.equal(store.releaseResourceLeasesForOwner("run", "run_first", "2026-05-26T00:05:00.000Z"), 1);
    const afterRelease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "bound_path",
      resourceKey: cwd,
      ownerType: "run",
      ownerId: "run_second",
      acquiredAt: "2026-05-26T00:05:01.000Z",
      expiresAt,
    });
    assert.ok(afterRelease);
    assert.equal(store.listResourceLeases({ status: "active", resourceType: "bound_path" }).length, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite lease expiry marks active stale leases as expired", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-lease-expiry-"));
  const store = createSqliteRunStore(cwd);
  try {
    const lease = store.acquireResourceLease({
      workspaceId: DEFAULT_WORKSPACE_ID,
      resourceType: "channel",
      resourceKey: "channel_1",
      ownerType: "run",
      ownerId: "run_stale",
      acquiredAt: "2026-05-26T00:00:00.000Z",
      expiresAt: "2026-05-26T00:01:00.000Z",
    });
    assert.ok(lease);

    assert.equal(store.expireResourceLeases("2026-05-26T00:02:00.000Z"), 1);
    assert.equal(store.listResourceLeases({ status: "active" }).length, 0);
    const expired = store.listResourceLeases({ status: "expired" });
    assert.equal(expired.length, 1);
    assert.equal(expired[0].ownerId, "run_stale");
    assert.equal(expired[0].releasedAt, "2026-05-26T00:02:00.000Z");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
} from "../dist/index.js";

test("sqlite control-plane events append with monotonic seq and list filters", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-events-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-06T00:00:00.000Z";
  try {
    const first = store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "run",
      entityId: "run_1",
      action: "run.created",
      data: {
        status: "queued",
        taskId: "task_1",
        apiKeyRef: "env:LOCAL_RELAY_API_KEY",
        authorization: "Bearer sk-test-secret-value",
      },
    }, now);
    const second = store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "skills",
      entityType: "registry",
      entityId: "default",
      action: "skill.registry_changed",
      data: {
        registryGeneration: 2,
        changeType: "refresh",
      },
    }, "2026-06-06T00:00:01.000Z");
    const third = store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "run",
      entityId: "run_1",
      action: "run.completed",
      data: {
        previousStatus: "running",
        status: "succeeded",
      },
    }, "2026-06-06T00:00:02.000Z");

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(third.seq, 3);
    assert.equal(first.workspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(first.cwd, cwd);
    assert.equal(first.ts, now);
    assert.equal(first.data.apiKeyRef, "[REDACTED]");
    assert.equal(first.data.authorization, "[REDACTED]");

    assert.deepEqual(
      store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID }).map((event) => event.seq),
      [1, 2, 3],
    );
    assert.deepEqual(
      store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID, afterSeq: 1, limit: 1 }).map((event) => event.seq),
      [2],
    );
    assert.deepEqual(
      store.listControlPlaneEvents({ workspaceId: DEFAULT_WORKSPACE_ID, domains: ["runs"] }).map((event) => event.action),
      ["run.created", "run.completed"],
    );
    assert.deepEqual(
      store.listControlPlaneEvents({
        workspaceId: DEFAULT_WORKSPACE_ID,
        domains: ["runs"],
        entityType: "run",
        entityId: "run_1",
        action: "run.completed",
      }).map((event) => event.seq),
      [3],
    );
    assert.equal(store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID), 3);
    assert.deepEqual(store.getControlPlaneReplayState(DEFAULT_WORKSPACE_ID), {
      workspaceId: DEFAULT_WORKSPACE_ID,
      replayFloorSeq: 0,
      latestSeq: 3,
      updatedAt: "2026-06-06T00:00:02.000Z",
    });
    assert.deepEqual(store.readControlPlaneReplayWindow({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterSeq: 0,
      limit: 10,
      domains: ["runs"],
    }).window, {
      disposition: "complete",
      requestedAfterSeq: 0,
      replayFloorSeq: 0,
      upperBoundSeq: 3,
      nextAfterSeq: 3,
    });
    assert.deepEqual(store.readControlPlaneReplayWindow({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterSeq: 3,
      limit: 10,
      domains: ["providers"],
    }), {
      window: {
        disposition: "complete",
        requestedAfterSeq: 3,
        replayFloorSeq: 0,
        upperBoundSeq: 3,
        nextAfterSeq: 3,
      },
      events: [],
    });
    assert.equal(store.readControlPlaneReplayWindow({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterSeq: 0,
      limit: 1,
    }).window.reason, "window_exceeded");
    assert.equal(store.readControlPlaneReplayWindow({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterSeq: 4,
      limit: 10,
    }).window.reason, "cursor_unavailable");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("control-plane replay floor survives an empty event table", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-floor-"));
  const store = createSqliteRunStore(cwd);
  try {
    store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "runs",
      entityType: "run",
      entityId: "run_floor",
      action: "run.completed",
      data: {},
    }, "2026-06-06T01:00:00.000Z");
    const database = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    database.exec("BEGIN IMMEDIATE;");
    database.prepare("UPDATE control_plane_replay_state SET replay_floor_seq = latest_seq WHERE workspace_id = ?")
      .run(DEFAULT_WORKSPACE_ID);
    database.prepare("DELETE FROM control_plane_events WHERE workspace_id = ?").run(DEFAULT_WORKSPACE_ID);
    database.exec("COMMIT;");
    database.close();
    assert.deepEqual(store.getControlPlaneReplayState(DEFAULT_WORKSPACE_ID), {
      workspaceId: DEFAULT_WORKSPACE_ID,
      replayFloorSeq: 1,
      latestSeq: 1,
      updatedAt: "2026-06-06T01:00:00.000Z",
    });
    assert.equal(store.readControlPlaneReplayWindow({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterSeq: 0,
      limit: 10,
    }).window.reason, "retention_gap");
    assert.equal(store.readControlPlaneReplayWindow({
      workspaceId: DEFAULT_WORKSPACE_ID,
      afterSeq: 1,
      limit: 10,
    }).window.disposition, "complete");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("recorded migration 117 repairs missing replay state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-replay-repair-"));
  let store = createSqliteRunStore(cwd);
  store.appendControlPlaneEvent({
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd,
    domain: "providers",
    entityType: "provider",
    entityId: "provider_repair",
    action: "provider.updated",
    data: {},
  }, "2026-06-06T02:00:00.000Z");
  store.close();
  const database = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
  database.exec("DROP TABLE control_plane_replay_state;");
  database.close();
  store = createSqliteRunStore(cwd);
  try {
    assert.equal(store.getControlPlaneReplayState(DEFAULT_WORKSPACE_ID).latestSeq, 1);
    const migration = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    assert.ok(migration.prepare("SELECT 1 FROM schema_migrations WHERE version = 117").get());
    migration.close();
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite control-plane event migration is applied to existing databases", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-control-plane-migration-"));
  let store = createSqliteRunStore(cwd);
  store.close();

  const database = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
  try {
    database.exec("DROP TABLE control_plane_events;");
    database.exec("DELETE FROM schema_migrations WHERE name = 'create_control_plane_events';");
  } finally {
    database.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const event = store.appendControlPlaneEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      cwd,
      domain: "providers",
      entityType: "provider",
      entityId: "provider_1",
      action: "provider.updated",
      data: { providerId: "provider_1", enabled: true, kind: "openai", api: "openai-responses" },
    }, "2026-06-06T00:00:00.000Z");
    assert.equal(event.seq, 1);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

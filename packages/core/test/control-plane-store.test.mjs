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
    assert.equal(store.getLatestControlPlaneEventSeq(DEFAULT_WORKSPACE_ID), 3);
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

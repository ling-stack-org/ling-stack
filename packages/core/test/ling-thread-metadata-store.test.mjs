import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../dist/index.js";

test("sqlite Ling thread metadata migration is idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-thread-metadata-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      const column = database
        .prepare("PRAGMA table_info(ling_threads)")
        .all()
        .find((row) => row.name === "metadata_json");
      assert.ok(column);
      assert.ok(database.prepare("SELECT version FROM schema_migrations WHERE version = 45 AND name = 'add_ling_thread_metadata'").get());
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite Ling thread metadata rebuilds from source records and remains disposable", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-thread-metadata-"));
  let store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, "2026-06-08T00:00:00.000Z");
    const thread = store.createLingThread(
      {
        kind: "task",
        channelId: channel.id,
        taskId: "task_thread_metadata",
        title: "Inspect metadata",
        objective: "Inspect metadata read model",
      },
      "2026-06-08T00:00:00.000Z",
    );
    const turn = store.createLingTurn(
      {
        threadId: thread.id,
        kind: "initial_request",
        title: "Inspect metadata turn",
        userInstruction: "Inspect metadata",
        channelId: channel.id,
        taskId: "task_thread_metadata",
      },
      "2026-06-08T00:01:00.000Z",
    );
    const failedRun = store.createRun(createRunInput({
      id: "run_thread_metadata_failed",
      cwd,
      taskId: "task_thread_metadata",
      channelId: channel.id,
      threadId: thread.id,
      turnId: turn.id,
      createdAt: "2026-06-08T00:02:00.000Z",
    }));
    store.markRunFailed(failedRun.id, "2026-06-08T00:03:00.000Z", "metadata failure");
    store.createArtifact({
      id: "artifact_thread_metadata",
      runId: failedRun.id,
      type: "markdown",
      path: "/tmp/thread-metadata.md",
      title: "Thread metadata evidence",
      createdAt: "2026-06-08T00:03:30.000Z",
    });

    const retryRun = store.createRun(createRunInput({
      id: "run_thread_metadata_waiting",
      cwd,
      taskId: "task_thread_metadata",
      channelId: channel.id,
      threadId: thread.id,
      turnId: turn.id,
      turnRunRole: "retry",
      parentRunId: failedRun.id,
      createdAt: "2026-06-08T00:04:00.000Z",
    }));
    store.markRunWaitingForApproval(retryRun.id, "2026-06-08T00:04:30.000Z");
    const approval = store.createApprovalRequest(
      {
        runId: retryRun.id,
        taskId: "task_thread_metadata",
        actionType: "bash",
        risk: "medium",
        title: "Approve metadata command",
        description: "echo metadata",
        payload: { type: "bash", cwd, command: "echo metadata", riskFlags: [] },
      },
      "2026-06-08T00:04:40.000Z",
    );
    const blockedTurn = store.createLingTurn(
      {
        threadId: thread.id,
        kind: "manual_followup",
        status: "blocked",
        title: "Blocked follow-up",
        userInstruction: "Blocked follow-up",
      },
      "2026-06-08T00:05:00.000Z",
    );

    const rebuilt = store.rebuildLingThreadMetadata(thread.id, "2026-06-08T00:06:00.000Z");
    assert.ok(rebuilt?.metadata);
    assert.equal(rebuilt.metadata.schemaVersion, 1);
    assert.equal(rebuilt.metadata.summary, blockedTurn.title);
    assert.equal(rebuilt.metadata.lastTurnId, blockedTurn.id);
    assert.equal(rebuilt.metadata.lastActivityAt, "2026-06-08T00:05:00.000Z");
    assert.equal(rebuilt.metadata.pendingApprovalCount, 1);
    assert.equal(rebuilt.metadata.blockedCount, 1);
    assert.equal(rebuilt.metadata.failedAttemptCount, 1);
    assert.equal(rebuilt.metadata.artifactCount, 1);
    assert.equal(rebuilt.metadata.latestFailureRunId, failedRun.id);
    assert.equal(rebuilt.metadata.latestEvidenceArtifactId, "artifact_thread_metadata");
    assert.equal(rebuilt.metadata.rebuiltAt, "2026-06-08T00:06:00.000Z");

    const paths = resolveRuntimePaths(cwd);
    store.close();
    const database = new DatabaseSync(paths.databasePath);
    try {
      database.prepare("UPDATE ling_threads SET metadata_json = ? WHERE id = ?").run("{not json", thread.id);
    } finally {
      database.close();
    }

    store = createSqliteRunStore(cwd);
    assert.equal(store.getLingThread(thread.id)?.metadata, undefined);
    const approved = store.approveApprovalRequest(approval.id, { reason: "metadata is not authority" }, "2026-06-08T00:07:00.000Z");
    assert.ok(approved);
    assert.equal(approved.status, "approved");
    assert.equal(store.getLingThread(thread.id)?.metadata?.pendingApprovalCount, 0);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function createRunInput(overrides) {
  return {
    id: overrides.id,
    cwd: overrides.cwd,
    taskId: overrides.taskId,
    channelId: overrides.channelId,
    providerName: "openai",
    providerModel: "gpt-test",
    taskSnapshot: { id: overrides.taskId, title: "Inspect metadata", prompt: "Inspect metadata" },
    providerSnapshot: { provider: "openai", model: "gpt-test", apiKey: "sk-testsecret000000" },
    requestSnapshot: { cwd: overrides.cwd, task: { id: overrides.taskId, title: "Inspect metadata", prompt: "Inspect metadata" } },
    threadId: overrides.threadId,
    turnId: overrides.turnId,
    turnRunRole: overrides.turnRunRole,
    parentRunId: overrides.parentRunId,
    createdAt: overrides.createdAt,
  };
}

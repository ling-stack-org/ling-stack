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

test("sqlite Ling turns persist, link runs, and reconcile status", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-turns-store-"));
  const now = "2026-06-08T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const thread = store.createLingThread(
      {
        kind: "task",
        channelId: channel.id,
        taskId: "task_turns",
        title: "Inspect workspace",
        objective: "Inspect workspace safely",
      },
      now,
    );

    const turn = store.createLingTurn(
      {
        threadId: thread.id,
        kind: "initial_request",
        title: "Inspect workspace sk-testsecret000000",
        userInstruction: "Run checks with token sk-testsecret000000",
        channelId: channel.id,
        taskId: "task_turns",
      },
      now,
    );
    assert.match(turn.id, /^turn_/);
    assert.equal(turn.status, "open");
    assert.equal(turn.threadId, thread.id);
    assert.equal(turn.title, "Inspect workspace [REDACTED]");
    assert.equal(turn.userInstruction, "Run checks with token [REDACTED]");
    assert.deepEqual(store.listLingTurns({ threadId: thread.id }).map((item) => item.id), [turn.id]);

    const legacyRun = store.createRun(createRunInput({
      id: "run_legacy",
      cwd,
      taskId: "task_turns",
      channelId: channel.id,
      threadId: thread.id,
      createdAt: "2026-06-08T00:00:05.000Z",
    }));
    assert.equal(legacyRun.threadId, thread.id);
    assert.equal(store.getLingTurnForRun(legacyRun.id), undefined);

    const run = store.createRun(createRunInput({
      id: "run_turn_attempt_1",
      cwd,
      taskId: "task_turns",
      channelId: channel.id,
      threadId: thread.id,
      turnId: turn.id,
      createdAt: "2026-06-08T00:01:00.000Z",
    }));
    assert.equal(store.getLingTurnForRun(run.id)?.id, turn.id);
    assert.deepEqual(store.listLingTurnRuns(turn.id), [
      {
        turnId: turn.id,
        runId: run.id,
        attemptNumber: 1,
        role: "primary",
        createdAt: "2026-06-08T00:01:00.000Z",
      },
    ]);
    assert.equal(store.getLingTurn(turn.id)?.status, "running");
    assert.equal(store.getLingTurn(turn.id)?.activeRunId, run.id);

    store.markRunWaitingForApproval(run.id, "2026-06-08T00:01:30.000Z");
    assert.equal(store.getLingTurn(turn.id)?.status, "waiting_for_approval");
    store.markRunSucceeded(run.id, "2026-06-08T00:02:00.000Z");
    const succeededTurn = store.getLingTurn(turn.id);
    assert.equal(succeededTurn?.status, "succeeded");
    assert.equal(succeededTurn?.activeRunId, undefined);
    assert.equal(succeededTurn?.lastRunId, run.id);
    assert.equal(succeededTurn?.completedAt, "2026-06-08T00:02:00.000Z");

    const retry = store.createRun(createRunInput({
      id: "run_turn_attempt_2",
      cwd,
      taskId: "task_turns",
      channelId: channel.id,
      threadId: thread.id,
      turnId: turn.id,
      turnRunRole: "retry",
      parentRunId: run.id,
      createdAt: "2026-06-08T00:03:00.000Z",
    }));
    assert.deepEqual(store.listLingTurnRuns(turn.id).map((item) => [item.runId, item.attemptNumber, item.role]), [
      [run.id, 1, "primary"],
      [retry.id, 2, "retry"],
    ]);
    assert.equal(store.getLingTurn(turn.id)?.status, "running");
    assert.equal(store.getLingTurn(turn.id)?.completedAt, undefined);

    const secondTurn = store.createLingTurn(
      {
        threadId: thread.id,
        kind: "manual_followup",
        title: "Second turn",
        userInstruction: "Second turn",
      },
      "2026-06-08T00:04:00.000Z",
    );
    assert.throws(
      () => store.linkRunToLingTurn({ turnId: secondTurn.id, runId: retry.id, role: "primary", now: "2026-06-08T00:04:01.000Z" }),
      /UNIQUE|constraint/i,
    );

    const otherThread = store.createLingThread(
      {
        kind: "task",
        taskId: "task_other",
        title: "Other thread",
        objective: "Other objective",
      },
      "2026-06-08T00:05:00.000Z",
    );
    const otherTurn = store.createLingTurn(
      {
        threadId: otherThread.id,
        kind: "initial_request",
        title: "Other turn",
        userInstruction: "Other turn",
      },
      "2026-06-08T00:05:01.000Z",
    );
    assert.throws(
      () => store.linkRunToLingTurn({ turnId: otherTurn.id, runId: retry.id, role: "primary", now: "2026-06-08T00:05:02.000Z" }),
      /Run does not belong to Ling turn thread/,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite Ling turn migration is idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-turns-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ling_turns'").get());
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ling_turn_runs'").get());
      assert.ok(database.prepare("SELECT version FROM schema_migrations WHERE version = 44 AND name = 'create_ling_turns'").get());
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite Ling turn status transitions are CAS, durable, and idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-turn-transition-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Turn transitions", boundPath: cwd }, "2026-08-12T11:00:00.000Z");
    const thread = store.createLingThread({
      kind: "channel",
      channelId: channel.id,
      title: "Source turn",
      objective: "Close from workflow publication",
    }, "2026-08-12T11:00:00.000Z");
    const turn = store.createLingTurn({
      threadId: thread.id,
      kind: "initial_request",
      title: "Create and verify",
      userInstruction: "Create and verify",
      channelId: channel.id,
    }, "2026-08-12T11:00:01.000Z");

    const started = store.transitionLingTurnStatus({
      turnId: turn.id,
      expectedStatus: "open",
      event: "start",
      actor: "system",
      idempotencyKey: "workflow:test:start",
      now: "2026-08-12T11:00:02.000Z",
    });
    assert.deepEqual(started, { ok: true, from: "open", to: "running" });
    const duplicate = store.transitionLingTurnStatus({
      turnId: turn.id,
      expectedStatus: "open",
      event: "start",
      actor: "system",
      idempotencyKey: "workflow:test:start",
      now: "2026-08-12T11:00:03.000Z",
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    const stale = store.transitionLingTurnStatus({
      turnId: turn.id,
      expectedStatus: "open",
      event: "succeed",
      actor: "system",
      now: "2026-08-12T11:00:04.000Z",
    });
    assert.deepEqual(stale, { ok: false, code: "stale_transition", currentStatus: "running" });
    assert.deepEqual(store.transitionLingTurnStatus({
      turnId: turn.id,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      idempotencyKey: "workflow:test:report:test-report:succeeded",
      now: "2026-08-12T11:00:05.000Z",
    }), { ok: true, from: "running", to: "succeeded" });
    assert.equal(store.getLingTurn(turn.id).completedAt, "2026-08-12T11:00:05.000Z");
    assert.deepEqual(store.listStateTransitionEvents({ entityType: "turn", entityId: turn.id }).map((event) => [event.fromStatus, event.toStatus]), [
      ["running", "succeeded"],
      ["open", "running"],
    ]);
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
    taskSnapshot: { id: overrides.taskId, title: "Inspect workspace", prompt: "Inspect workspace" },
    providerSnapshot: { provider: "openai", model: "gpt-test", apiKey: "sk-testsecret000000" },
    requestSnapshot: { cwd: overrides.cwd, task: { id: overrides.taskId, title: "Inspect workspace", prompt: "Inspect workspace" } },
    threadId: overrides.threadId,
    turnId: overrides.turnId,
    turnRunRole: overrides.turnRunRole,
    parentRunId: overrides.parentRunId,
    createdAt: overrides.createdAt,
  };
}

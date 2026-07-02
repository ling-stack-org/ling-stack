import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { lingThreadKinds as contractLingThreadKinds } from "@ling-stack/contracts";
import { createSqliteRunStore, lingThreadKinds as coreLingThreadKinds } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { maybeQueueGoalContinuation } from "../dist/features/runs/interventions.js";
import { syncLingThreadForTerminalRun } from "../dist/features/runs/threads.js";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

test("Ling thread kind runtime constants stay in sync across packages", () => {
  assert.deepEqual([...contractLingThreadKinds], [...coreLingThreadKinds]);
  assert.equal(coreLingThreadKinds.includes("conversation"), true);
});

test("daemon API exposes durable Ling turns and links runs to turns", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-ling-turns-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const initial = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_auto_turn"));
    assert.equal(initial.events.some((event) => event.event === "ready"), true);
    assert.equal(initial.events.some((event) => event.event === "result"), true);

    const store = stores.get(cwd);
    assert.ok(store);
    const initialRun = store.getRun(initial.runId);
    assert.ok(initialRun);
    assert.ok(initialRun.threadId);
    const autoTurn = store.getLingTurnForRun(initialRun.id);
    assert.ok(autoTurn);
    assert.equal(autoTurn.threadId, initialRun.threadId);
    assert.equal(autoTurn.kind, "initial_request");
    assert.equal(autoTurn.status, "succeeded");

    const listed = await getJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/turns?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.threadId, initialRun.threadId);
    assert.deepEqual(listed.turns.map((turn) => turn.id), [autoTurn.id]);
    assert.deepEqual(listed.runLinks.map((link) => [link.turnId, link.runId, link.attemptNumber, link.role]), [
      [autoTurn.id, initialRun.id, 1, "primary"],
    ]);

    const created = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      kind: "manual_followup",
      status: "succeeded",
      title: "Retry with sk-manualturnsecret123",
      userInstruction: "Do not leak sk-manualturnsecret123 into durable turn fields.",
      activeRunId: initialRun.id,
      createdByActor: "local-user",
    });
    assert.equal(created.turn.kind, "manual_followup");
    assert.equal(created.turn.status, "open");
    assert.equal(created.turn.activeRunId, undefined);
    assert.equal(created.turn.title.includes("sk-manualturnsecret123"), false);
    assert.equal(created.turn.userInstruction.includes("sk-manualturnsecret123"), false);
    assert.deepEqual(created.runLinks, []);

    const explicit = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_manual_turn"),
      threadId: initialRun.threadId,
      turnId: created.turn.id,
    });
    const explicitRun = store.getRun(explicit.runId);
    assert.ok(explicitRun);
    assert.equal(explicitRun.threadId, initialRun.threadId);
    assert.equal(store.getLingTurnForRun(explicitRun.id)?.id, created.turn.id);

    const afterExplicit = await getJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/turns?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.deepEqual(afterExplicit.runLinks.find((link) => link.runId === explicitRun.id), {
      turnId: created.turn.id,
      runId: explicitRun.id,
      attemptNumber: 1,
      role: "primary",
      createdAt: afterExplicit.runLinks.find((link) => link.runId === explicitRun.id)?.createdAt,
    });
    assert.equal(afterExplicit.turns.find((turn) => turn.id === created.turn.id)?.status, "succeeded");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon resume preview and execute can anchor to a durable Ling turn", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-turn-resume-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const initial = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_turn_resume_source"));
    const store = stores.get(cwd);
    assert.ok(store);
    const initialRun = store.getRun(initial.runId);
    assert.ok(initialRun);
    assert.ok(initialRun.threadId);
    const sourceTurn = store.getLingTurnForRun(initialRun.id);
    assert.ok(sourceTurn);

    const siblingTurn = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/turns?cwd=${encodeURIComponent(cwd)}`, {
      kind: "manual_followup",
      title: "Sibling follow-up turn",
      userInstruction: "Create a second turn so source validation can reject mismatches.",
      createdByActor: "local-user",
    });
    const sibling = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_turn_resume_sibling"),
      threadId: initialRun.threadId,
      turnId: siblingTurn.turn.id,
    });
    const siblingRun = store.getRun(sibling.runId);
    assert.ok(siblingRun);
    assert.equal(store.getLingTurnForRun(siblingRun.id)?.id, siblingTurn.turn.id);

    const preview = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/resume-preview?cwd=${encodeURIComponent(cwd)}`, {
      turnId: sourceTurn.id,
      instruction: "Resume from the first durable turn.",
      includeArtifacts: true,
    });
    assert.equal(preview.sourceRun.id, initialRun.id);
    assert.equal(preview.context.sourceRunId, initialRun.id);
    assert.equal(preview.context.sourceTurnId, sourceTurn.id);
    assert.deepEqual(preview.context.priorTurnIds, [sourceTurn.id]);
    assert.equal(preview.context.includedTurnCount, 1);
    assert.deepEqual(preview.context.priorRunIds, [initialRun.id]);
    assert.match(preview.context.contextText, /Source turn:/);

    const mismatch = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/resume-preview?cwd=${encodeURIComponent(cwd)}`, {
      turnId: sourceTurn.id,
      sourceRunId: siblingRun.id,
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, "source_run_not_in_turn");

    const activeTurn = store.createLingTurn(
      {
        threadId: initialRun.threadId,
        kind: "manual_followup",
        status: "running",
        title: "Active selected turn",
        userInstruction: "Keep execute blocked while this turn is active.",
        activeRunId: initialRun.id,
        lastRunId: initialRun.id,
      },
      "2026-06-08T00:10:00.000Z",
    );
    const activePreview = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/resume-preview?cwd=${encodeURIComponent(cwd)}`, {
      turnId: activeTurn.id,
    });
    assert.equal(activePreview.context.sourceTurnId, activeTurn.id);
    assert.equal(activePreview.context.warnings.some((warning) => warning.includes(activeTurn.id)), true);
    const activeExecute = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/resume?cwd=${encodeURIComponent(cwd)}`, {
      turnId: activeTurn.id,
      idempotencyKey: "active-turn-resume-blocked",
    });
    assert.equal(activeExecute.status, 409, JSON.stringify(activeExecute.body));
    assert.equal(activeExecute.body.error, "turn_active");

    const resumed = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/resume?cwd=${encodeURIComponent(cwd)}`, {
      turnId: sourceTurn.id,
      instruction: "Resume from the first durable turn.",
      idempotencyKey: "turn-linked-resume",
    });
    assert.equal(resumed.continuationReason, "manual_resume");
    assert.equal(resumed.sourceRun.id, initialRun.id);
    assert.ok(resumed.runId);

    await waitForCondition(() => {
      const run = store.getRun(resumed.runId);
      return Boolean(run && run.status === "succeeded");
    }, "turn-linked resume should finish");
    const resumedRun = store.getRun(resumed.runId);
    assert.ok(resumedRun);
    assert.equal(resumedRun.parentRunId, initialRun.id);
    assert.equal(resumedRun.continuationReason, "manual_resume");
    const childTurn = store.getLingTurnForRun(resumedRun.id);
    assert.ok(childTurn);
    assert.equal(childTurn.sourceTurnId, sourceTurn.id);
    assert.deepEqual(store.listLingTurnRuns(childTurn.id).map((link) => [link.runId, link.role]), [
      [resumedRun.id, "resume"],
    ]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon fork creates child thread lineage without copying runs", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-thread-fork-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const channelId = channel.id;
    const initial = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_turn_fork_source"),
      task: {
        id: "task_turn_fork_source",
        title: "Forkable source thread",
        prompt: "Create a terminal turn that can be forked.",
        channelId,
      },
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const initialRun = store.getRun(initial.runId);
    assert.ok(initialRun);
    assert.ok(initialRun.threadId);
    assert.equal(initialRun.channelId, channelId);
    const sourceTurn = store.getLingTurnForRun(initialRun.id);
    assert.ok(sourceTurn);

    const forked = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/fork?cwd=${encodeURIComponent(cwd)}`, {
      turnId: sourceTurn.id,
      sourceRunId: initialRun.id,
      title: "Forked source thread",
      objective: "Explore a child branch without mutating the source.",
      idempotencyKey: "fork-source-turn",
    });
    assert.equal(forked.lineage.parentThreadId, initialRun.threadId);
    assert.equal(forked.lineage.parentTurnId, sourceTurn.id);
    assert.equal(forked.lineage.forkedFromRunId, initialRun.id);
    assert.equal(forked.childThread.parentThreadId, initialRun.threadId);
    assert.equal(forked.childThread.parentTurnId, sourceTurn.id);
    assert.equal(forked.childThread.forkedFromRunId, initialRun.id);
    assert.equal(forked.childThread.channelId, channelId);
    assert.equal(forked.childThread.status, "open");
    assert.equal(forked.childThread.activeRunId, undefined);
    assert.equal(forked.childThread.lastRunId, undefined);
    assert.equal(store.listRuns({ threadId: forked.childThread.id, limit: 10 }).length, 0);
    assert.equal(store.getLingThread(initialRun.threadId).status, "succeeded");

    const repeated = await postJson(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/fork?cwd=${encodeURIComponent(cwd)}`, {
      turnId: sourceTurn.id,
      sourceRunId: initialRun.id,
      idempotencyKey: "fork-source-turn",
    });
    assert.equal(repeated.childThread.id, forked.childThread.id);

    const channelThreads = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channelId)}&limit=20`);
    assert.equal(channelThreads.threads.some((thread) => thread.id === initialRun.threadId), true);
    assert.equal(channelThreads.threads.some((thread) => thread.id === forked.childThread.id), true);

    const shellThread = store.createLingThread(
      {
        kind: "task",
        channelId,
        title: "Thread-level fork source",
        objective: "No terminal turns yet.",
      },
      "2026-06-08T00:20:00.000Z",
    );
    const shellFork = await postJson(`${daemon.url}/threads/${encodeURIComponent(shellThread.id)}/fork?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "fork-no-turn-thread",
    });
    assert.equal(shellFork.childThread.parentThreadId, shellThread.id);
    assert.equal(shellFork.childThread.parentTurnId, undefined);
    assert.equal(shellFork.childThread.forkedFromRunId, undefined);
    assert.equal(shellFork.childThread.channelId, channelId);

    const activeTurn = store.createLingTurn(
      {
        threadId: initialRun.threadId,
        kind: "manual_followup",
        status: "running",
        title: "Active fork source",
        userInstruction: "Fork should be blocked until this turn is terminal.",
        activeRunId: initialRun.id,
        lastRunId: initialRun.id,
      },
      "2026-06-08T00:21:00.000Z",
    );
    const activeFork = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(initialRun.threadId)}/fork?cwd=${encodeURIComponent(cwd)}`, {
      turnId: activeTurn.id,
    });
    assert.equal(activeFork.status, 409);
    assert.equal(activeFork.body.error, "turn_active");

    const archivedThread = store.createLingThread(
      {
        kind: "task",
        channelId,
        title: "Archived fork source",
        objective: "Archived sources are blocked in V2D-B.",
      },
      "2026-06-08T00:22:00.000Z",
    );
    store.updateLingThread(archivedThread.id, { status: "archived", archivedAt: "2026-06-08T00:22:30.000Z" }, "2026-06-08T00:22:30.000Z");
    const archivedFork = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(archivedThread.id)}/fork?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "fork-archived-source",
    });
    assert.equal(archivedFork.status, 409);
    assert.equal(archivedFork.body.error, "source_thread_archived");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon fork-run creates child thread turn and run idempotently", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-thread-fork-run-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const channelId = channel.id;
    const initial = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_turn_fork_run_source"),
      task: {
        id: "task_turn_fork_run_source",
        title: "Fork-run source thread",
        prompt: "Create a terminal turn that can start a child branch.",
        channelId,
      },
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const sourceRun = store.getRun(initial.runId);
    assert.ok(sourceRun);
    assert.ok(sourceRun.threadId);
    const sourceThread = store.getLingThread(sourceRun.threadId);
    assert.ok(sourceThread);
    const sourceTurn = store.getLingTurnForRun(sourceRun.id);
    assert.ok(sourceTurn);

    const forkRun = await postJson(`${daemon.url}/threads/${encodeURIComponent(sourceRun.threadId)}/fork-run?cwd=${encodeURIComponent(cwd)}`, {
      turnId: sourceTurn.id,
      sourceRunId: sourceRun.id,
      instruction: "Implement the first child branch task.",
      idempotencyKey: "fork-run-source-turn",
    });
    assert.equal(forkRun.status, "run_started");
    assert.equal(forkRun.sourceThread.id, sourceRun.threadId);
    assert.equal(forkRun.sourceTurn.id, sourceTurn.id);
    assert.equal(forkRun.sourceRun.id, sourceRun.id);
    assert.equal(forkRun.childThread.parentThreadId, sourceRun.threadId);
    assert.equal(forkRun.childThread.parentTurnId, sourceTurn.id);
    assert.equal(forkRun.childThread.forkedFromRunId, sourceRun.id);
    assert.equal(forkRun.childThread.channelId, channelId);
    assert.equal(forkRun.childTurn.threadId, forkRun.childThread.id);
    assert.equal(forkRun.childTurn.sourceTurnId, undefined);
    assert.equal(forkRun.childTurn.userInstruction, "Implement the first child branch task.");
    assert.ok(forkRun.runId);

    await waitForCondition(() => {
      const run = store.getRun(forkRun.runId);
      return Boolean(run && run.status === "succeeded");
    }, "fork-run child run should finish");
    const childRun = store.getRun(forkRun.runId);
    assert.ok(childRun);
    assert.equal(childRun.threadId, forkRun.childThread.id);
    assert.equal(store.getLingTurnForRun(childRun.id)?.id, forkRun.childTurn.id);
    assert.equal(childRun.parentRunId, undefined);
    assert.equal(childRun.continuationReason, undefined);
    assert.equal(store.getLingThread(sourceRun.threadId).status, "succeeded");
    assert.deepEqual(store.listLingTurnRuns(forkRun.childTurn.id).map((link) => [link.runId, link.role]), [
      [childRun.id, "primary"],
    ]);

    const repeated = await postJson(`${daemon.url}/threads/${encodeURIComponent(sourceRun.threadId)}/fork-run?cwd=${encodeURIComponent(cwd)}`, {
      turnId: sourceTurn.id,
      sourceRunId: sourceRun.id,
      instruction: "Implement the first child branch task.",
      idempotencyKey: "fork-run-source-turn",
    });
    assert.equal(repeated.childThread.id, forkRun.childThread.id);
    assert.equal(repeated.childTurn.id, forkRun.childTurn.id);
    assert.equal(repeated.runId, childRun.id);
    assert.equal(store.listRuns({ threadId: forkRun.childThread.id, limit: 10 }).length, 1);
    assert.equal(store.listLingTurns({ threadId: forkRun.childThread.id, limit: 10 }).length, 1);

    const archivedThread = store.createLingThread(
      {
        kind: "task",
        channelId,
        title: "Archived fork-run source",
        objective: "Archived sources cannot start fork-run.",
      },
      "2026-06-08T00:30:00.000Z",
    );
    store.updateLingThread(archivedThread.id, { archivedAt: "2026-06-08T00:30:30.000Z" }, "2026-06-08T00:30:30.000Z");
    const archivedForkRun = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(archivedThread.id)}/fork-run?cwd=${encodeURIComponent(cwd)}`, {
      instruction: "This should not create a child branch.",
      providerPresetId: "provider_test",
      idempotencyKey: "fork-run-archived-source",
    });
    assert.equal(archivedForkRun.status, 409);
    assert.equal(archivedForkRun.body.error, "source_thread_archived");
    assert.equal(store.listLingThreads({ limit: 100 }).some((thread) => thread.parentThreadId === archivedThread.id), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon archive pin and archived filters", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-thread-visibility-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const channelId = channel.id;
    const store = stores.get(cwd);
    assert.ok(store);
    const first = store.createLingThread(
      {
        kind: "task",
        channelId,
        title: "First visible branch",
        objective: "Visible branch that can be archived.",
        status: "succeeded",
      },
      "2026-06-08T00:30:00.000Z",
    );
    const second = store.createLingThread(
      {
        kind: "task",
        channelId,
        title: "Second visible branch",
        objective: "Visible branch used to verify pin ordering.",
        status: "succeeded",
      },
      "2026-06-08T00:31:00.000Z",
    );

    const pinned = await postJson(`${daemon.url}/threads/${encodeURIComponent(first.id)}/pin?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "pin-first-visible-branch",
    });
    assert.equal(pinned.thread.id, first.id);
    assert.ok(pinned.thread.pinnedAt);
    const activeAfterPin = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channelId)}&archived=exclude&limit=10`);
    assert.deepEqual(activeAfterPin.threads.map((thread) => thread.id).slice(0, 2), [first.id, second.id]);

    const archived = await postJson(`${daemon.url}/threads/${encodeURIComponent(first.id)}/archive?cwd=${encodeURIComponent(cwd)}`, {
      reason: "hide this finished branch",
      idempotencyKey: "archive-first-visible-branch",
    });
    assert.equal(archived.thread.id, first.id);
    assert.ok(archived.thread.archivedAt);
    assert.equal(archived.thread.status, "succeeded");
    assert.equal(archived.thread.archivedReason, "hide this finished branch");

    const defaultList = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channelId)}&limit=10`);
    assert.equal(defaultList.threads.some((thread) => thread.id === first.id), false);
    assert.equal(defaultList.threads.some((thread) => thread.id === second.id), true);

    const includeList = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channelId)}&archived=include&limit=10`);
    assert.equal(includeList.threads.some((thread) => thread.id === first.id), true);
    assert.equal(includeList.threads.some((thread) => thread.id === second.id), true);

    const archivedOnly = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channelId)}&archived=only&limit=10`);
    assert.deepEqual(archivedOnly.threads.map((thread) => thread.id), [first.id]);

    const archivedFork = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(first.id)}/fork?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "fork-archived-visibility-source",
    });
    assert.equal(archivedFork.status, 409);
    assert.equal(archivedFork.body.error, "source_thread_archived");

    const unarchived = await postJson(`${daemon.url}/threads/${encodeURIComponent(first.id)}/unarchive?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "unarchive-first-visible-branch",
    });
    assert.equal(unarchived.thread.id, first.id);
    assert.equal(unarchived.thread.archivedAt, undefined);
    assert.equal(unarchived.thread.archivedReason, undefined);
    const restoredList = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channelId)}&archived=exclude&limit=10`);
    assert.equal(restoredList.threads.some((thread) => thread.id === first.id), true);

    const unpinned = await postJson(`${daemon.url}/threads/${encodeURIComponent(first.id)}/unpin?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "unpin-first-visible-branch",
    });
    assert.equal(unpinned.thread.pinnedAt, undefined);

    const idleOpenThread = store.createLingThread(
      {
        kind: "task",
        channelId,
        title: "Idle open branch",
        objective: "Archive should not be blocked by an open turn with no run.",
      },
      "2026-06-08T00:31:00.000Z",
    );
    store.createLingTurn(
      {
        threadId: idleOpenThread.id,
        kind: "manual_followup",
        status: "open",
        title: "Unscheduled turn",
        userInstruction: "This turn never started a run.",
        createdByActor: "local-user",
      },
      "2026-06-08T00:31:30.000Z",
    );
    const idleOpenArchive = await postJson(`${daemon.url}/threads/${encodeURIComponent(idleOpenThread.id)}/archive?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "archive-idle-open-thread",
    });
    assert.equal(idleOpenArchive.thread.id, idleOpenThread.id);
    assert.ok(idleOpenArchive.thread.archivedAt);

    const activeThread = store.createLingThread(
      {
        kind: "task",
        taskId: "task-active-archive-block",
        channelId,
        title: "Active branch",
        objective: "Archive should be blocked while a turn is active.",
      },
      "2026-06-08T00:32:00.000Z",
    );
    const activeTurn = store.createLingTurn(
      {
        threadId: activeThread.id,
        kind: "manual_followup",
        status: "open",
        title: "Open turn",
        userInstruction: "Keep this turn active.",
        createdByActor: "local-user",
      },
      "2026-06-08T00:32:30.000Z",
    );
    store.createRun({
      id: "run_active_archive_block",
      cwd,
      taskId: "task-active-archive-block",
      channelId,
      providerName: "Test provider",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      threadId: activeThread.id,
      turnId: activeTurn.id,
      createdAt: "2026-06-08T00:32:45.000Z",
    });
    const activeArchive = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(activeThread.id)}/archive?cwd=${encodeURIComponent(cwd)}`, {
      idempotencyKey: "archive-active-thread",
    });
    assert.equal(activeArchive.status, 409);
    assert.equal(activeArchive.body.error, "active_thread_archive_blocked");

    const badFilter = await getJsonAllowError(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&archived=invalid`);
    assert.equal(badFilter.status, 400);
    assert.equal(badFilter.body.error, "bad_archived_filter");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon thread collection accepts conversation kind query", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-conversation-thread-kind-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&limit=1`);
    const store = stores.get(cwd);
    assert.ok(store);
    const conversationThread = store.createLingThread(
      {
        kind: "conversation",
        teammateId: "ling_agent",
        title: "Conversation smoke",
        objective: "Verify conversation thread listing.",
        status: "open",
      },
      "2026-06-08T00:40:00.000Z",
    );

    const listed = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&kind=conversation&archived=exclude&limit=20`);
    assert.deepEqual(listed.threads.map((thread) => thread.id), [conversationThread.id]);
    assert.deepEqual(listed.threads.map((thread) => thread.kind), ["conversation"]);

    const invalid = await getJsonAllowError(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&kind=invalid`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "bad_request");
    assert.match(invalid.body.message, /conversation/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon structured thread search uses durable fields and archived filters", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-thread-search-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = (await createChannel(daemon.url, cwd)).channel;
    const channelId = channel.id;
    const initial = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_search_prompt"),
      task: {
        id: "task_search_prompt",
        title: "Search prompt run",
        prompt: "Calibrate crawler prompt from the run task snapshot.",
        channelId,
      },
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.getRun(initial.runId);
    assert.ok(run?.threadId);
    const thread = store.getLingThread(run.threadId);
    assert.ok(thread);
    store.updateLingThread(thread.id, {
      title: "Structured alpha branch",
      objective: "Keep sk-searchsecret123456789 for secret audit matching.",
    }, "2026-06-08T01:00:00.000Z");
    const turn = store.createLingTurn(
      {
        threadId: thread.id,
        kind: "manual_followup",
        status: "succeeded",
        title: "Nebula investigation turn",
        userInstruction: "Investigate nebula branch routing from durable turn text.",
        taskId: "task_search_prompt",
        lastRunId: run.id,
        createdByActor: "local-user",
      },
      "2026-06-08T01:01:00.000Z",
    );
    const archivedThread = store.createLingThread(
      {
        kind: "task",
        channelId,
        title: "Archived search branch",
        objective: "Archived branch should only show when filters include it.",
        status: "succeeded",
        archivedAt: "2026-06-08T01:02:00.000Z",
      },
      "2026-06-08T01:02:00.000Z",
    );

    const titleSearch = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent("alpha")}&limit=10`);
    assert.equal(titleSearch.threads.some((item) => item.id === thread.id), true);
    assert.equal(titleSearch.matches.some((match) => match.threadId === thread.id && match.field === "thread_title"), true);

    const turnSearch = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent("nebula")}&limit=10`);
    assert.equal(turnSearch.threads.some((item) => item.id === thread.id), true);
    assert.equal(turnSearch.matches.some((match) => match.threadId === thread.id && match.turnId === turn.id && match.field === "turn_instruction"), true);

    const promptSearch = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent("crawler prompt")}&limit=10`);
    assert.equal(promptSearch.threads.some((item) => item.id === thread.id), true);
    assert.equal(promptSearch.matches.some((match) => match.threadId === thread.id && match.runId === run.id && match.field === "task_prompt"), true);

    const defaultArchivedSearch = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent("archived search")}&limit=10`);
    assert.equal(defaultArchivedSearch.threads.some((item) => item.id === archivedThread.id), false);
    const archivedOnlySearch = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent("archived search")}&archived=only&limit=10`);
    assert.deepEqual(archivedOnlySearch.threads.map((item) => item.id), [archivedThread.id]);

    const secretSearch = await getJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent("secret audit")}&limit=10`);
    const secretMatch = secretSearch.matches.find((match) => match.threadId === thread.id && match.field === "thread_objective");
    assert.ok(secretMatch);
    assert.equal(secretMatch.snippet.includes("sk-searchsecret123456789"), false);
    assert.equal(secretMatch.snippet.includes("[REDACTED]"), true);

    const tooShort = await getJsonAllowError(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}&q=a`);
    assert.equal(tooShort.status, 400);
    assert.equal(tooShort.body.error, "search_query_too_short");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon API exposes thread conversation mode and goal lifecycle", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-thread-mode-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    const threadId = created.thread.id;

    const initialMode = await getJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/mode?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(initialMode.mode, { mode: "default" });

    const enabled = await patchJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/mode?cwd=${encodeURIComponent(cwd)}`, {
      mode: "plan",
    });
    assert.equal(enabled.mode.mode, "plan");
    assert.equal(typeof enabled.mode.updatedAt, "string");

    const badMode = await patchJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(threadId)}/mode?cwd=${encodeURIComponent(cwd)}`, {
      mode: "execute",
    });
    assert.equal(badMode.status, 400);
    assert.equal(badMode.body.error, "bad_conversation_mode");

    const initialGoal = await getJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(initialGoal.threadId, threadId);
    assert.equal(initialGoal.goal, null);

    const createdGoal = await putJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Finish goal lifecycle.",
      tokenBudget: 50000,
    });
    assert.equal(createdGoal.goal.objective, "Finish goal lifecycle.");
    assert.equal(createdGoal.goal.status, "active");
    assert.equal(createdGoal.goal.tokenBudget, 50000);

    const duplicateGoal = await putJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Replace without confirmation.",
    });
    assert.equal(duplicateGoal.status, 409);
    assert.equal(duplicateGoal.body.error, "goal_replace_required");

    const pausedGoal = await patchJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      status: "paused",
      blockedReason: "waiting for user",
    });
    assert.equal(pausedGoal.goal.status, "paused");
    assert.equal(pausedGoal.goal.blockedReason, "waiting for user");

    const replacedGoal = await putJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Replacement goal.",
      replaceExisting: true,
    });
    assert.equal(replacedGoal.goal.objective, "Replacement goal.");
    assert.equal(replacedGoal.goal.status, "active");
    assert.notEqual(replacedGoal.goal.id, createdGoal.goal.id);

    const directComplete = await patchJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      status: "complete",
    });
    assert.equal(directComplete.status, 400);
    assert.equal(directComplete.body.error, "goal_complete_action_required");

    const lingAgentCompleteWithoutEvidence = await postJsonAllowError(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal/complete?cwd=${encodeURIComponent(cwd)}`, {
      actor: "ling-agent",
      completionVerificationSummary: "All requirements are done.",
    });
    assert.equal(lingAgentCompleteWithoutEvidence.status, 400);
    assert.equal(lingAgentCompleteWithoutEvidence.body.error, "goal_completion_evidence_required");

    const completedGoal = await postJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal/complete?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Verified by user.",
      evidenceRefs: [{ kind: "turn", id: "turn_goal_complete" }],
    });
    assert.equal(completedGoal.goal.status, "complete");
    assert.equal(completedGoal.goal.completedBy, "local-user");
    assert.equal(completedGoal.goal.completedReason, "Verified by user.");
    assert.equal(completedGoal.goal.completionEvidenceRefs.some((ref) => ref.kind === "turn" && ref.id === "turn_goal_complete"), true);

    await putJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Clearable replacement goal.",
      replaceExisting: true,
    });

    const clearedGoal = await deleteJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(clearedGoal.goal.status, "cleared");
    assert.equal(typeof clearedGoal.goal.clearedAt, "string");

    const afterClear = await getJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(afterClear.goal, null);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon API persists proposed plans and links accepted tasks and workflow drafts", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-proposed-plan-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    const threadId = created.thread.id;
    const planId = "proposed_plan_api_lifecycle";
    const planUrl = `${daemon.url}/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}?cwd=${encodeURIComponent(cwd)}`;

    const createdPlan = await putJson(planUrl, {
      title: "Durable plan lifecycle",
      bodyMarkdown: "1. Add storage\n2. Add actions",
      sourceMessageId: "msg_plan_source",
      sourceRunId: "run_plan_source",
    });
    assert.equal(createdPlan.plan.id, planId);
    assert.equal(createdPlan.plan.threadId, threadId);
    assert.equal(createdPlan.plan.sourceMessageId, "msg_plan_source");
    assert.equal(createdPlan.plan.status, "draft");

    const listed = await getJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/proposed-plans?cwd=${encodeURIComponent(cwd)}`);
    assert.deepEqual(listed.plans.map((plan) => plan.id), [planId]);
    assert.equal(listed.plans[0].channelId, channel.channel.id);

    const store = stores.get(cwd);
    assert.ok(store);
    const siblingThread = store.createLingThread(
      {
        kind: "channel_discussion",
        channelId: channel.channel.id,
        parentThreadId: threadId,
        title: "Sibling plan thread",
        objective: "Verify channel aggregate plan history.",
        status: "open",
      },
      "2026-07-01T00:00:00.000Z",
    );
    const siblingPlanId = "proposed_plan_sibling";
    await putJson(`${daemon.url}/threads/${encodeURIComponent(siblingThread.id)}/proposed-plans/${encodeURIComponent(siblingPlanId)}?cwd=${encodeURIComponent(cwd)}`, {
      title: "Sibling plan",
      bodyMarkdown: "1. Aggregate across channel threads",
    });
    const channelPlans = await getJson(`${daemon.url}/channels/${encodeURIComponent(channel.channel.id)}/proposed-plans?cwd=${encodeURIComponent(cwd)}&limit=10`);
    assert.deepEqual(new Set(channelPlans.plans.map((plan) => plan.id)), new Set([planId, siblingPlanId]));

    const saved = await postJson(`${planUrl.replace(/\?.*$/u, "")}/save?cwd=${encodeURIComponent(cwd)}`, {
      plan: {
        title: "Durable plan lifecycle",
        bodyMarkdown: "1. Add storage\n2. Add actions",
        sourceMessageId: "msg_plan_source",
        sourceRunId: "run_plan_source",
      },
    });
    assert.equal(saved.plan.id, planId);
    assert.equal(typeof saved.plan.savedAt, "string");

    const refined = await postJson(`${planUrl.replace(/\?.*$/u, "")}/refine?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(refined.plan.status, "draft");

    const accepted = await postJson(`${planUrl.replace(/\?.*$/u, "")}/accept?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(accepted.plan.status, "accepted");
    assert.equal(accepted.plan.acceptedTaskId, accepted.taskId);
    assert.equal(typeof accepted.plan.acceptedAt, "string");
    const task = store.getTask(accepted.taskId);
    assert.ok(task);
    assert.equal(task.channelId, channel.channel.id);
    assert.equal(task.requestedSkillId, "plan-acceptance");
    assert.match(task.prompt, /Source proposed plan: proposed_plan_api_lifecycle/);

    const repeatedAccept = await postJson(`${planUrl.replace(/\?.*$/u, "")}/accept?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(repeatedAccept.taskId, accepted.taskId);

    const overwriteAccepted = await putJsonAllowError(planUrl, {
      title: "Overwrite accepted plan",
      bodyMarkdown: "This should not replace accepted content.",
    });
    assert.equal(overwriteAccepted.status, 409);
    assert.equal(overwriteAccepted.body.error, "accepted_plan_immutable");

    const converted = await postJson(`${planUrl.replace(/\?.*$/u, "")}/convert-workflow?cwd=${encodeURIComponent(cwd)}`, {
      createdBy: "local-user",
      workflowTitle: "Edited workflow draft",
      workflowSteps: ["Confirm contracts", "Wire Plan Mode controls"],
      workflowStepPreviews: [
        { title: "Confirm contracts", ownerId: "teammate_plan", ownerLabel: "Planner" },
        { title: "Wire Plan Mode controls", ownerId: "teammate_web", ownerLabel: "Web" },
      ],
    });
    assert.equal(converted.plan.acceptedWorkflowId, converted.workflowId);
    assert.equal(converted.plan.acceptedWorkflowStepId, converted.workflowStepId);
    assert.equal(typeof converted.plan.convertedAt, "string");
    const workflow = store.getChannelWorkflow(converted.workflowId);
    assert.ok(workflow);
    assert.equal(workflow.status, "draft");
    assert.equal(workflow.channelId, channel.channel.id);
    assert.equal(workflow.title, "Edited workflow draft");
    assert.equal(workflow.objective, "Confirm contracts\nWire Plan Mode controls");
    const workflowSteps = store.listChannelWorkflowSteps({ workflowId: workflow.id, limit: 10 });
    assert.equal(workflowSteps.length, 2);
    const step = store.getChannelWorkflowStep(converted.workflowStepId);
    assert.ok(step);
    assert.equal(step.workflowId, workflow.id);
    assert.equal(step.status, "queued");
    assert.equal(step.toParticipantId, "teammate_plan");
    assert.equal(step.title, "Confirm contracts");
    assert.match(step.prompt, /Source proposed plan: proposed_plan_api_lifecycle/);
    const secondStep = workflowSteps.find((item) => item.title === "Wire Plan Mode controls");
    assert.ok(secondStep);
    assert.equal(secondStep.toParticipantId, "teammate_web");
    assert.equal(secondStep.toParticipantLabel, "Web");
    assert.match(secondStep.prompt, /Wire Plan Mode controls/);

    const archived = await postJson(`${planUrl.replace(/\?.*$/u, "")}/archive?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(archived.plan.status, "archived");
    assert.equal(typeof archived.plan.archivedAt, "string");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon updates active goal accounting when a linked run reaches terminal state", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-goal-accounting-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new UsageRunner({ inputTokens: 4, outputTokens: 6 }), stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    const threadId = created.thread.id;
    await putJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Exercise goal accounting.",
      tokenBudget: 10,
    });

    const result = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_goal_accounting"),
      threadId,
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const accountedGoal = store.getLingThreadGoal(threadId);
    assert.ok(accountedGoal);
    assert.equal(accountedGoal.lastRunId, result.runId);
    assert.equal(accountedGoal.tokensUsed, 10);
    assert.equal(accountedGoal.status, "budget_limited");
    assert.equal(accountedGoal.blockedReason, "Token budget reached.");
    assert.equal(Number.isInteger(accountedGoal.timeUsedSeconds), true);
    assert.equal(accountedGoal.timeUsedSeconds >= 0, true);
    assert.equal(accountedGoal.completionEvidenceRefs.some((ref) => ref.kind === "run" && ref.id === result.runId), true);
    assert.equal(accountedGoal.completionEvidenceRefs.some((ref) => ref.kind === "turn"), true);

    syncLingThreadForTerminalRun(store, result.runId, new Date().toISOString());
    const afterDuplicateSync = store.getLingThreadGoal(threadId);
    assert.ok(afterDuplicateSync);
    assert.equal(afterDuplicateSync.tokensUsed, accountedGoal.tokensUsed);
    assert.equal(afterDuplicateSync.timeUsedSeconds, accountedGoal.timeUsedSeconds);
    assert.deepEqual(afterDuplicateSync.completionEvidenceRefs, accountedGoal.completionEvidenceRefs);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon uses estimated goal token accounting when provider usage is missing", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-goal-estimated-usage-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    const threadId = created.thread.id;
    await putJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Exercise estimated goal accounting.",
      tokenBudget: 1,
    });

    const result = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_goal_estimated_accounting"),
      threadId,
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const goal = store.getLingThreadGoal(threadId);
    assert.ok(goal);
    assert.equal(goal.lastRunId, result.runId);
    assert.equal(goal.usageSource, "estimated");
    assert.equal(goal.tokensUsed >= 1, true);
    assert.equal(goal.status, "budget_limited");
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon marks active goal usage_limited when provider quota stops a run", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-goal-usage-limited-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new QuotaFailureRunner(), stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    const threadId = created.thread.id;
    await putJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Stop visibly when provider quota is exhausted.",
      tokenBudget: 100,
    });

    const result = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_goal_usage_limited"),
      threadId,
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const run = store.getRun(result.runId);
    assert.ok(run);
    assert.equal(run.status, "failed");
    assert.match(run.errorMessage, /status 429/);

    const goal = store.getLingThreadGoal(threadId);
    assert.ok(goal);
    assert.equal(goal.status, "usage_limited");
    assert.equal(goal.blockedReason, "Provider quota or rate limit reached.");
    assert.equal(goal.lastRunId, result.runId);
    assert.equal(goal.lastContinuationStopReason, "usage_limited");
    assert.equal(goal.lastContinuationEvidenceDelta.statusChanged, true);
    assert.deepEqual(store.listRunInterventions({ sourceRunId: result.runId }), []);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon marks goal blocked only after three matching blockers", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-goal-same-blocker-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-01T00:00:00.000Z";
    const thread = store.createLingThread(
      {
        kind: "channel_discussion",
        channelId: "channel_goal_same_blocker",
        title: "Same blocker goal",
        objective: "Verify blocker threshold.",
        status: "open",
      },
      now,
    );
    store.createLingThreadGoal(
      {
        threadId: thread.id,
        objective: "Block only after repeated same blocker.",
        tokenBudget: 1000,
      },
      now,
    );
    for (const index of [1, 2, 3]) {
      const run = store.createRun({
        id: `run_goal_same_blocker_${index}`,
        cwd,
        taskId: `task_goal_same_blocker_${index}`,
        channelId: thread.channelId,
        threadId: thread.id,
        providerName: "test-provider",
        providerModel: "test-model",
        taskSnapshot: {
          id: `task_goal_same_blocker_${index}`,
          title: "Same blocker run",
          prompt: "Fail with same blocker.",
          channelId: thread.channelId,
        },
        providerSnapshot: { provider: "test-provider", model: "test-model" },
        requestSnapshot: { cwd, tools: ["read"] },
        createdAt: `2026-07-01T00:0${index}:00.000Z`,
      });
      store.markRunStarted(run.id, `2026-07-01T00:0${index}:10.000Z`);
      store.markRunFailed(run.id, `2026-07-01T00:0${index}:20.000Z`, "Missing required approval from reviewer");
      syncLingThreadForTerminalRun(store, run.id, `2026-07-01T00:0${index}:20.000Z`);
      const goal = store.getLingThreadGoal(thread.id);
      assert.ok(goal);
      assert.equal(goal.sameBlockerCount, index);
      assert.equal(goal.status, index < 3 ? "active" : "blocked");
      if (index === 3) {
        assert.equal(goal.lastContinuationStopReason, "same_blocker_threshold");
        assert.equal(goal.lastContinuationEvidenceDelta.statusChanged, true);
      }
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon manual goal runs reset automatic continuation chain metadata", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-goal-manual-reset-"));
  const store = createSqliteRunStore(cwd);
  try {
    const now = "2026-07-01T00:00:00.000Z";
    const thread = store.createLingThread(
      {
        kind: "channel_discussion",
        channelId: "channel_goal_manual_reset",
        title: "Manual reset goal",
        objective: "Verify manual continuation reset.",
        status: "open",
      },
      now,
    );
    const createdGoal = store.createLingThreadGoal(
      {
        threadId: thread.id,
        objective: "Reset automatic continuation state on manual run.",
        tokenBudget: 1000,
      },
      now,
    );
    store.updateLingThreadGoal(createdGoal.id, {
      continuationChainId: "goal_chain_existing",
      continuationDepth: 2,
      noEvidenceContinuationCount: 1,
      lastContinuationStopReason: "no_evidence_threshold",
      lastContinuationStoppedAt: "2026-07-01T00:00:30.000Z",
      lastContinuationEvidenceDelta: {
        newEvidenceRefs: 0,
        changedFiles: 0,
        acceptedPlans: 0,
        artifacts: 0,
        statusChanged: false,
      },
    }, "2026-07-01T00:00:30.000Z");
    const run = store.createRun({
      id: "run_goal_manual_reset",
      cwd,
      taskId: "task_goal_manual_reset",
      channelId: thread.channelId,
      threadId: thread.id,
      providerName: "test-provider",
      providerModel: "test-model",
      taskSnapshot: {
        id: "task_goal_manual_reset",
        title: "Manual reset run",
        prompt: "Manual run should reset automatic chain metadata.",
        channelId: thread.channelId,
      },
      providerSnapshot: { provider: "test-provider", model: "test-model" },
      requestSnapshot: { cwd, tools: ["read"] },
      createdAt: "2026-07-01T00:01:00.000Z",
    });
    store.markRunStarted(run.id, "2026-07-01T00:01:10.000Z");
    store.markRunSucceeded(run.id, "2026-07-01T00:01:20.000Z");
    syncLingThreadForTerminalRun(store, run.id, "2026-07-01T00:01:20.000Z");
    const goal = store.getLingThreadGoal(thread.id);
    assert.ok(goal);
    assert.equal(goal.continuationChainId, undefined);
    assert.equal(goal.continuationDepth, 0);
    assert.equal(goal.noEvidenceContinuationCount, 0);
    assert.equal(goal.lastContinuationStopReason, undefined);
    assert.equal(goal.lastContinuationStoppedAt, undefined);
    assert.equal(goal.lastContinuationEvidenceDelta, undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon queues visible guarded automatic goal continuations", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-goal-continuation-"));
  const stores = new Map();
  const runner = new UsageRunner({ inputTokens: 1, outputTokens: 1 });
  const daemon = await startDaemonForTest(runner, stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    const threadId = created.thread.id;
    await putJson(`${daemon.url}/threads/${encodeURIComponent(threadId)}/goal?cwd=${encodeURIComponent(cwd)}`, {
      objective: "Finish the visible automatic continuation path.",
      tokenBudget: 100,
    });

    const result = await postRunAndCollectEvents(daemon.url, {
      ...runBody(cwd, "task_goal_auto_continue"),
      threadId,
    });
    const store = stores.get(cwd);
    assert.ok(store);
    await waitFor(() => runner.calls.length === 3);

    const interventions = store.listRunInterventions({ sourceRunId: result.runId });
    assert.equal(interventions.length, 1);
    assert.equal(interventions[0].mode, "queue_followup");
    assert.equal(interventions[0].requestedBy, "system");
    assert.equal(interventions[0].status, "started");
    assert.match(interventions[0].instruction, /Continue working toward active goal/);
    assert.ok(interventions[0].continuationRunId);

    const continuationRun = store.getRun(interventions[0].continuationRunId);
    assert.ok(continuationRun);
    assert.equal(continuationRun.parentRunId, result.runId);
    assert.equal(continuationRun.continuationReason, "queue_followup");

    const secondInterventions = store.listRunInterventions({ sourceRunId: continuationRun.id });
    assert.equal(secondInterventions.length, 1);
    assert.equal(secondInterventions[0].status, "started");
    assert.ok(secondInterventions[0].continuationRunId);
    const secondContinuationRun = store.getRun(secondInterventions[0].continuationRunId);
    assert.ok(secondContinuationRun);
    assert.equal(secondContinuationRun.parentRunId, continuationRun.id);
    await waitFor(() => store.getLingThreadGoal(threadId)?.lastRunId === secondContinuationRun.id);
    assert.deepEqual(store.listRunInterventions({ sourceRunId: secondContinuationRun.id }), []);

    const goal = store.getLingThreadGoal(threadId);
    assert.ok(goal);
    assert.equal(goal.status, "active");
    assert.equal(goal.tokensUsed, 6);
    assert.equal(goal.lastRunId, secondContinuationRun.id);
    assert.equal(goal.continuationDepth, 2);
    assert.equal(goal.noEvidenceContinuationCount, 2);
    assert.equal(goal.lastContinuationStopReason, "no_evidence_threshold");
    assert.equal(typeof goal.lastContinuationStoppedAt, "string");
    assert.deepEqual(goal.lastContinuationEvidenceDelta, {
      newEvidenceRefs: 0,
      changedFiles: 0,
      acceptedPlans: 0,
      artifacts: 0,
      statusChanged: false,
    });
    assert.equal(goal.completionEvidenceRefs.filter((ref) => ref.kind === "run").length, 3);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon goal continuation gates block hidden follow-ups", async () => {
  const planMode = await createGoalContinuationGateFixture("plan-mode");
  try {
    planMode.store.updateLingThreadConversationMode(planMode.thread.id, { mode: "plan" }, "2026-07-01T00:04:00.000Z");
    assert.equal(maybeQueueGoalContinuation({
      terminalRun: planMode.run,
      store: planMode.store,
      activeRuns: inactiveRunRegistry,
    }), undefined);
    assert.deepEqual(planMode.store.listRunInterventions({ sourceRunId: planMode.run.id }), []);
    assert.equal(planMode.store.getLingThreadGoal(planMode.thread.id)?.lastContinuationStopReason, "plan_mode_active");
  } finally {
    planMode.store.close();
    await rm(planMode.cwd, { recursive: true, force: true });
  }

  const pendingApproval = await createGoalContinuationGateFixture("pending-approval");
  try {
    pendingApproval.store.createApprovalRequest({
      runId: pendingApproval.run.id,
      taskId: pendingApproval.run.taskId,
      actionType: "bash",
      risk: "medium",
      title: "Approve follow-up command",
      description: "Pending approval should stop automatic continuation.",
      payload: { type: "bash", cwd: pendingApproval.cwd, command: "echo blocked", riskFlags: [] },
      expiresAt: "2999-01-01T00:00:00.000Z",
    }, "2026-07-01T00:04:00.000Z");
    assert.equal(maybeQueueGoalContinuation({
      terminalRun: pendingApproval.run,
      store: pendingApproval.store,
      activeRuns: inactiveRunRegistry,
    }), undefined);
    assert.deepEqual(pendingApproval.store.listRunInterventions({ sourceRunId: pendingApproval.run.id }), []);
    assert.equal(pendingApproval.store.getLingThreadGoal(pendingApproval.thread.id)?.lastContinuationStopReason, "pending_approval");
  } finally {
    pendingApproval.store.close();
    await rm(pendingApproval.cwd, { recursive: true, force: true });
  }

  const maxDepth = await createGoalContinuationGateFixture("max-depth");
  try {
    const goal = maxDepth.store.getLingThreadGoal(maxDepth.thread.id);
    assert.ok(goal);
    maxDepth.store.updateLingThreadGoal(goal.id, {
      continuationDepth: 3,
      continuationChainId: "goal_chain_max_depth",
    }, "2026-07-01T00:04:00.000Z");
    assert.equal(maybeQueueGoalContinuation({
      terminalRun: maxDepth.run,
      store: maxDepth.store,
      activeRuns: inactiveRunRegistry,
    }), undefined);
    assert.deepEqual(maxDepth.store.listRunInterventions({ sourceRunId: maxDepth.run.id }), []);
    assert.equal(maxDepth.store.getLingThreadGoal(maxDepth.thread.id)?.lastContinuationStopReason, "max_depth");
  } finally {
    maxDepth.store.close();
    await rm(maxDepth.cwd, { recursive: true, force: true });
  }

  const budgetLimited = await createGoalContinuationGateFixture("budget-limited", { tokenBudget: 1, usage: { inputTokens: 1, outputTokens: 0 } });
  try {
    const goal = budgetLimited.store.getLingThreadGoal(budgetLimited.thread.id);
    assert.ok(goal);
    assert.equal(goal.status, "budget_limited");
    assert.equal(maybeQueueGoalContinuation({
      terminalRun: budgetLimited.run,
      store: budgetLimited.store,
      activeRuns: inactiveRunRegistry,
    }), undefined);
    assert.deepEqual(budgetLimited.store.listRunInterventions({ sourceRunId: budgetLimited.run.id }), []);
    assert.equal(budgetLimited.store.getLingThreadGoal(budgetLimited.thread.id)?.lastContinuationStopReason, "budget_limited");
  } finally {
    budgetLimited.store.close();
    await rm(budgetLimited.cwd, { recursive: true, force: true });
  }
});

test("daemon blocks workflow execution while the channel root thread is in Plan Mode", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-plan-mode-workflow-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(new SuccessfulRunner(), stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    await patchJson(`${daemon.url}/threads/${encodeURIComponent(created.thread.id)}/mode?cwd=${encodeURIComponent(cwd)}`, {
      mode: "plan",
    });
    const store = stores.get(cwd);
    assert.ok(store);
    const workflow = store.createChannelWorkflow({
      channelId: channel.channel.id,
      title: "Implementation workflow",
      objective: "This should not start while Plan Mode is active.",
      status: "ready",
      createdBy: "local-user",
    }, "2026-07-01T00:10:00.000Z");
    const workflowStep = store.createChannelWorkflowStep({
      workflowId: workflow.id,
      title: "Mutating implementation step",
      prompt: "Implement the proposed change.",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "queued",
    }, "2026-07-01T00:11:00.000Z");

    const orchestrate = await postJsonAllowError(`${daemon.url}/workflows/${encodeURIComponent(workflow.id)}/orchestrate?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(orchestrate.status, 409);
    assert.equal(orchestrate.body.error, "plan_mode_workflow_blocked");
    assert.match(orchestrate.body.message, /Plan Mode is active/);
    assert.equal(store.getChannelWorkflowStep(workflowStep.id)?.status, "queued");

    const startStep = await postJsonAllowError(`${daemon.url}/workflow-steps/${encodeURIComponent(workflowStep.id)}/start?cwd=${encodeURIComponent(cwd)}`, {
      mode: "create_task",
      taskTitle: "Should not be created",
    });
    assert.equal(startStep.status, 409);
    assert.equal(startStep.body.error, "plan_mode_workflow_blocked");
    assert.equal(store.getChannelWorkflowStep(workflowStep.id)?.status, "queued");
    assert.equal(store.listTasks({ channelId: channel.channel.id, limit: 20 }).some((task) => task.title === "Should not be created"), false);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("daemon blocks channel task runs while the channel root thread is in Plan Mode", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-plan-mode-task-run-"));
  const stores = new Map();
  const runner = new UsageRunner({ inputTokens: 1, outputTokens: 1 });
  const daemon = await startDaemonForTest(runner, stores);
  try {
    const channel = await createChannel(daemon.url, cwd);
    const created = await postJson(`${daemon.url}/threads?cwd=${encodeURIComponent(cwd)}`, {
      kind: "channel_discussion",
      channelId: channel.channel.id,
    });
    await patchJson(`${daemon.url}/threads/${encodeURIComponent(created.thread.id)}/mode?cwd=${encodeURIComponent(cwd)}`, {
      mode: "plan",
    });
    const task = await postJson(`${daemon.url}/tasks?cwd=${encodeURIComponent(cwd)}`, {
      channelId: channel.channel.id,
      title: "Implementation task",
      prompt: "This task should not start while Plan Mode is active.",
    });

    const blocked = await postJsonAllowError(`${daemon.url}/tasks/${encodeURIComponent(task.task.id)}/run?cwd=${encodeURIComponent(cwd)}`, {
      providerPresetId: "provider_unused_before_plan_mode_guard",
      skipProviderPreflight: true,
      tools: ["read", "write"],
      idempotencyKey: "plan-mode-task-run",
    });

    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "plan_mode_task_run_blocked");
    assert.match(blocked.body.message, /Plan Mode is active/);
    assert.equal(runner.calls.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

class SuccessfulRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class UsageRunner {
  constructor(usage) {
    this.usage = usage;
    this.calls = [];
  }

  async runTask(options) {
    this.calls.push(options);
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
      usage: this.usage,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

class QuotaFailureRunner {
  async runTask(options) {
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      cwd: options.cwd,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    throw Object.assign(new Error("Provider returned status 429: rate limit exceeded"), { code: "rate_limited" });
  }
}

async function startDaemonForTest(runner, stores) {
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0 },
    {
      runner,
      storeFactory(cwd) {
        const store = createSqliteRunStore(cwd);
        stores.set(cwd, store);
        return store;
      },
    },
  );
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  assert.equal(predicate(), true);
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Exercise Ling turn persistence.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["read"],
    thinkingLevel: "off",
  };
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  const text = await response.text();
  const events = parseSseText(text);
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

async function createChannel(baseUrl, cwd) {
  return await postJson(`${baseUrl}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Fork test",
    status: "active",
    boundPath: cwd,
    allowedTools: ["read"],
  });
}

const inactiveRunRegistry = {
  get() {
    return undefined;
  },
};

async function createGoalContinuationGateFixture(suffix, options = {}) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-stack-goal-continuation-${suffix}-`));
  const store = createSqliteRunStore(cwd);
  const now = "2026-07-01T00:00:00.000Z";
  const thread = store.createLingThread(
    {
      kind: "channel_discussion",
      channelId: `channel_goal_gate_${suffix}`,
      title: "Goal gate thread",
      objective: "Verify goal continuation gates.",
      status: "open",
    },
    now,
  );
  store.createLingThreadGoal(
    {
      threadId: thread.id,
      objective: "Continue only when continuation gates allow it.",
      tokenBudget: options.tokenBudget,
    },
    "2026-07-01T00:01:00.000Z",
  );
  const run = store.createRun({
    id: `run_goal_gate_${suffix}`,
    cwd,
    taskId: `task_goal_gate_${suffix}`,
    channelId: thread.channelId,
    threadId: thread.id,
    providerName: "test-provider",
    providerModel: "test-model",
    taskSnapshot: {
      id: `task_goal_gate_${suffix}`,
      title: "Goal gate run",
      prompt: "Verify goal continuation gates.",
      channelId: thread.channelId,
    },
    providerSnapshot: { provider: "test-provider", model: "test-model" },
    requestSnapshot: { cwd, tools: ["read"] },
    createdAt: "2026-07-01T00:02:00.000Z",
  });
  store.markRunStarted(run.id, "2026-07-01T00:02:10.000Z");
  if (options.usage) {
    store.appendEvent(run.id, "run_end", { usage: options.usage });
  }
  store.markRunSucceeded(run.id, "2026-07-01T00:03:00.000Z");
  syncLingThreadForTerminalRun(store, run.id, "2026-07-01T00:03:00.000Z");
  const terminalRun = store.getRun(run.id);
  assert.ok(terminalRun);
  return { cwd, store, thread: store.getLingThread(thread.id) ?? thread, run: terminalRun };
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function getJsonAllowError(url) {
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function postJson(url, body) {
  await ensureGitRepoForChannelPost(url, body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function postJsonAllowError(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function putJsonAllowError(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function patchJsonAllowError(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function deleteJson(url) {
  const response = await fetch(url, { method: "DELETE" });
  return await readJsonResponse(response);
}

async function readJsonResponse(response) {
  const text = await response.text();
  assert.ok(response.ok, text);
  return text.trim() ? JSON.parse(text) : {};
}

function parseSseText(text) {
  return text
    .split("\n\n")
    .map(parseSseEvent)
    .filter(Boolean);
}

function parseSseEvent(raw) {
  const lines = raw.split("\n").filter(Boolean);
  const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  if (!event) {
    return undefined;
  }
  return { event, data: data ? JSON.parse(data) : undefined };
}

async function waitForCondition(predicate, label, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(label);
}

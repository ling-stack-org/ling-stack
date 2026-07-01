import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { lingThreadKinds as contractLingThreadKinds } from "@ling-stack/contracts";
import { createSqliteRunStore, lingThreadKinds as coreLingThreadKinds } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, invertPatchPlan, planApplyPatch } from "../../core/dist/index.js";
import {
  buildTurnWorkspaceChangesResponse,
  hashRecoveryContent,
  recoverTurnWorkspaceChanges,
} from "../dist/features/runs/workspace-change-recovery.js";
import { recordPatchProvenance } from "../dist/features/runs/patch-actions.js";

test("post-compaction Turn undo resolves durable mutation provenance across reopen", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-post-compaction-undo-"));
  const now = "2026-08-25T02:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Undo", boundPath: cwd }, now);
    const thread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root", channelId: channel.id, title: "Undo", objective: "Undo after compaction",
    }, now).thread;
    const turnResult = store.appendConversationUserTurn({
      turnId: "turn_post_compaction",
      itemId: "item_post_compaction",
      channelId: channel.id,
      threadId: thread.id,
      title: "Change file",
      userInstruction: "Change file",
      payload: { body: "Change file", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: "post-compaction-turn",
    }, now);
    const run = store.createRun({
      id: "run_post_compaction",
      cwd,
      taskId: "task_post_compaction",
      threadId: thread.id,
      turnId: turnResult.turnId,
      providerName: "test",
      providerModel: "test",
      taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {
        cwd,
        effectivePolicySnapshot: {
          mode: "workspace_write", toolDecisions: {}, allowedWritePaths: [cwd],
          workspacePolicyUpdatedAt: now, riskNotes: [],
        },
      },
      createdAt: now,
    });
    const path = resolve(cwd, "file.txt");
    await writeFile(path, "old\n", "utf8");
    const plan = planApplyPatch({
      patchText: `*** Begin Patch
*** Update File: file.txt
@@
-old
+new
*** End Patch`,
      readFile: (relativePath) => relativePath === "file.txt" ? "old\n" : undefined,
    });
    const forward = store.createArtifact({ runId: run.id, type: "json", path: "forward", sealedPayload: plan, createdAt: now });
    const inverse = store.createArtifact({ runId: run.id, type: "json", path: "inverse", sealedPayload: invertPatchPlan(plan), createdAt: now });
    await writeFile(path, "new\n", "utf8");
    store.createWorkspaceMutationRecord({
      cwd, threadId: thread.id, turnId: turnResult.turnId, runId: run.id,
      patchPlanId: `patch_plan_${plan.rawPatchSha256}`, operationIndex: 0,
      path: "file.txt", operation: "update", beforeSha256: "before", afterSha256: "after",
      forwardPatchArtifactId: forward.id, inversePatchArtifactId: inverse.id,
      sourceRefs: [{ type: "turn", id: turnResult.turnId }, { type: "run", id: run.id }], createdAt: now,
    });
    store.markRunSucceeded(run.id, "2026-08-25T02:00:01.000Z");
    store.createCompactionCheckpoint({
      threadId: thread.id, sourceTurnId: turnResult.turnId,
      coveredItemSeqFrom: turnResult.item.sequence, coveredItemSeqTo: turnResult.item.sequence,
      coveredTurnIds: [turnResult.turnId], sourceRefs: [{ type: "turn", id: turnResult.turnId }],
      workspaceProvenanceWatermark: "workspace_default:1", compactionPolicyVersion: "test", createdAt: now,
    });

    const before = await buildTurnWorkspaceChangesResponse(store, store.getLingTurn(turnResult.turnId));
    assert.equal(before.provenanceComplete, true);
    assert.equal(before.canUndo, true);
    // Simulate a daemon crash after the inverse write but before the terminal event.
    store.appendEvent(run.id, "workspace_change_recovery_started", {
      scope: "turn",
      turnId: turnResult.turnId,
      runIds: [run.id],
      action: "undo",
      recoveryId: "recovery-crash-before-terminal",
      idempotencyKey: "undo-post-compaction-crash",
      cwd,
      files: [{
        path: "file.txt",
        beforeSha256: hashRecoveryContent("new\n"),
        afterSha256: hashRecoveryContent("old\n"),
      }],
    });
    await writeFile(path, "old\n", "utf8");
    const recoveredTerminal = await recoverTurnWorkspaceChanges(store, store.getLingTurn(turnResult.turnId), "undo", "undo-post-compaction-crash");
    assert.equal(recoveredTerminal.state, "undone");
    assert.equal(store.listPostCompactionUndoRecords({ targetTurnId: turnResult.turnId, idempotencyKey: "undo-post-compaction-crash" })[0]?.state, "undone");
    const replay = await recoverTurnWorkspaceChanges(store, store.getLingTurn(turnResult.turnId), "undo", "undo-post-compaction-crash");
    assert.equal(replay.state, "undone");
    const reapplied = await recoverTurnWorkspaceChanges(store, store.getLingTurn(turnResult.turnId), "reapply", "reapply-post-compaction-1");
    assert.equal(reapplied.state, "applied");
    assert.equal(store.listPostCompactionUndoRecords({ targetTurnId: turnResult.turnId, idempotencyKey: "reapply-post-compaction-1" })[0]?.state, "applied");
    assert.equal(await readFile(path, "utf8"), "new\n");
    await writeFile(path, "user edit\n", "utf8");
    await assert.rejects(
      () => recoverTurnWorkspaceChanges(store, store.getLingTurn(turnResult.turnId), "undo", "undo-post-compaction-conflict"),
      /changed after preview/,
    );
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Turn recovery requires a matching inverse artifact and never trusts a forward-only record", async () => {
  const fixture = await createTurnFixture("inverse-mismatch");
  try {
    const path = resolve(fixture.cwd, "mismatch.txt");
    await writeFile(path, "old\n", "utf8");
    const plan = planApplyPatch({
      patchText: `*** Begin Patch
*** Update File: mismatch.txt
@@
-old
+new
*** End Patch`,
      readFile: (relativePath) => relativePath === "mismatch.txt" ? "old\n" : undefined,
    });
    const forward = fixture.store.createArtifact({ runId: fixture.run.id, type: "json", path: "forward", sealedPayload: plan, createdAt: fixture.now });
    const wrongInverse = fixture.store.createArtifact({ runId: fixture.run.id, type: "json", path: "wrong-inverse", sealedPayload: plan, createdAt: fixture.now });
    await writeFile(path, "new\n", "utf8");
    fixture.store.createWorkspaceMutationRecord({
      cwd: fixture.cwd,
      workspaceId: fixture.turn.workspaceId,
      threadId: fixture.thread.id,
      turnId: fixture.turn.id,
      runId: fixture.run.id,
      patchPlanId: "patch_plan_inverse_mismatch",
      operationIndex: 0,
      path: "mismatch.txt",
      operation: "update",
      beforeSha256: "before",
      afterSha256: "after",
      forwardPatchArtifactId: forward.id,
      inversePatchArtifactId: wrongInverse.id,
      sourceRefs: [{ type: "turn", id: fixture.turn.id }, { type: "run", id: fixture.run.id }],
      createdAt: fixture.now,
    });
    fixture.store.markRunSucceeded(fixture.run.id, "2026-08-25T03:00:01.000Z");
    const response = await buildTurnWorkspaceChangesResponse(fixture.store, fixture.turn);
    assert.equal(response.provenanceComplete, false);
    assert.equal(response.state, "unavailable");
    await assert.rejects(
      () => recoverTurnWorkspaceChanges(fixture.store, fixture.turn, "undo", "inverse-mismatch-undo"),
      /durable workspace provenance is incomplete/u,
    );
    assert.equal(await readFile(path, "utf8"), "new\n");
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("Turn recovery undoes multiple retry Runs in reverse provenance order", async () => {
  const fixture = await createTurnFixture("multi-run");
  try {
    const path = resolve(fixture.cwd, "retry.txt");
    await writeFile(path, "old\n", "utf8");
    const first = await addTurnPatch(fixture, fixture.run, path, "old", "first", "retry-first");
    const secondRun = fixture.store.createRun({
      id: "run_multi_run_retry",
      cwd: fixture.cwd,
      taskId: "task_multi_run_retry",
      threadId: fixture.thread.id,
      turnId: fixture.turn.id,
      providerName: "test",
      providerModel: "test",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: fixture.requestSnapshot,
      createdAt: "2026-08-25T03:00:02.000Z",
    });
    await addTurnPatch(fixture, secondRun, path, "first", "second", "retry-second");
    assert.equal(await readFile(path, "utf8"), "second\n");
    const response = await recoverTurnWorkspaceChanges(fixture.store, fixture.turn, "undo", "multi-run-undo");
    assert.equal(response.state, "undone");
    assert.equal(await readFile(path, "utf8"), "old\n");
    assert.deepEqual(response.runIds, [fixture.run.id, secondRun.id]);
    assert.ok(first);
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("Turn recovery selectively undoes its own paths and blocks when a later Turn touched them", async () => {
  const fixture = await createTurnFixture("selective");
  try {
    const targetPath = resolve(fixture.cwd, "target.txt");
    const unrelatedPath = resolve(fixture.cwd, "unrelated.txt");
    await writeFile(targetPath, "old\n", "utf8");
    await addTurnPatch(fixture, fixture.run, targetPath, "old", "target", "target");
    const laterTurnResult = fixture.store.appendConversationUserTurn({
      channelId: fixture.channel.id,
      threadId: fixture.thread.id,
      title: "Later edit",
      userInstruction: "Later edit",
      payload: { body: "Later edit", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: "later-turn",
    }, "2026-08-25T03:00:04.000Z");
    const laterRun = fixture.store.createRun({
      id: "run_later_turn",
      cwd: fixture.cwd,
      taskId: "task_later_turn",
      threadId: fixture.thread.id,
      turnId: laterTurnResult.turnId,
      providerName: "test",
      providerModel: "test",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: fixture.requestSnapshot,
      createdAt: "2026-08-25T03:00:05.000Z",
    });
    await writeFile(unrelatedPath, "unrelated-old\n", "utf8");
    await addTurnPatch({ ...fixture, turn: fixture.store.getLingTurn(laterTurnResult.turnId), run: laterRun }, laterRun, unrelatedPath, "unrelated-old", "unrelated-later", "later-unrelated");
    assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated-later\n");
    const undone = await recoverTurnWorkspaceChanges(fixture.store, fixture.turn, "undo", "selective-undo");
    assert.equal(undone.state, "undone");
    assert.equal(await readFile(targetPath, "utf8"), "old\n");
    assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated-later\n");

    const reapplied = await recoverTurnWorkspaceChanges(fixture.store, fixture.turn, "reapply", "selective-reapply");
    assert.equal(reapplied.state, "applied");
    assert.equal(await readFile(targetPath, "utf8"), "target\n");
    const laterTargetTurn = fixture.store.appendConversationUserTurn({
      channelId: fixture.channel.id,
      threadId: fixture.thread.id,
      title: "Later target edit",
      userInstruction: "Later target edit",
      payload: { body: "Later target edit", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: "later-target-turn",
    }, "2026-08-25T03:00:06.000Z");
    const laterTargetRun = fixture.store.createRun({
      id: "run_later_target_turn",
      cwd: fixture.cwd,
      taskId: "task_later_target_turn",
      threadId: fixture.thread.id,
      turnId: laterTargetTurn.turnId,
      providerName: "test",
      providerModel: "test",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: fixture.requestSnapshot,
      createdAt: "2026-08-25T03:00:07.000Z",
    });
    await addTurnPatch({ ...fixture, turn: fixture.store.getLingTurn(laterTargetTurn.turnId), run: laterTargetRun }, laterTargetRun, targetPath, "target", "later-target", "later-target");
    await assert.rejects(
      () => recoverTurnWorkspaceChanges(fixture.store, fixture.turn, "undo", "selective-conflict"),
      /changed after preview/u,
    );
    assert.equal(await readFile(targetPath, "utf8"), "later-target\n");
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

test("no-op provenance capture does not create a mutation record", async () => {
  const fixture = await createTurnFixture("no-op");
  try {
    recordPatchProvenance({
      store: fixture.store,
      run: fixture.run,
      cwd: fixture.cwd,
      plan: { format: "ling-apply-patch-v1", operations: [], touchedPaths: [], summary: { fileCount: 0, addCount: 0, updateCount: 0, deleteCount: 0, moveCount: 0, addedLines: 0, removedLines: 0 }, rawPatchSha256: "noop" },
      before: new Map(),
      after: new Map(),
      forwardPatchArtifactId: "unused-forward",
      inversePatchArtifactId: "unused-inverse",
      now: fixture.now,
    });
    assert.deepEqual(fixture.store.listWorkspaceMutationRecords({ runId: fixture.run.id }), []);
  } finally {
    fixture.store.close();
    await rm(fixture.cwd, { recursive: true, force: true });
  }
});

async function createTurnFixture(suffix) {
  const cwd = await mkdtemp(resolve(tmpdir(), `ling-post-compaction-${suffix}-`));
  const now = "2026-08-25T03:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: `Undo ${suffix}`, boundPath: cwd }, now);
  const thread = store.resolveOrCreateConversationThread({
    surfaceKind: "channel_root", channelId: channel.id, title: `Undo ${suffix}`, objective: "Undo after compaction",
  }, now).thread;
  const turnResult = store.appendConversationUserTurn({
    channelId: channel.id,
    threadId: thread.id,
    title: "Change file",
    userInstruction: "Change file",
    payload: { body: "Change file", format: "plain_text", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
    idempotencyKey: `post-compaction-${suffix}`,
  }, now);
  const requestSnapshot = {
    cwd,
    effectivePolicySnapshot: {
      mode: "workspace_write", toolDecisions: {}, allowedWritePaths: [cwd], workspacePolicyUpdatedAt: now, riskNotes: [],
    },
  };
  const run = store.createRun({
    id: `run_post_compaction_${suffix}`,
    cwd,
    taskId: `task_post_compaction_${suffix}`,
    threadId: thread.id,
    turnId: turnResult.turnId,
    providerName: "test",
    providerModel: "test",
    taskSnapshot: {},
    providerSnapshot: {},
    requestSnapshot,
    createdAt: now,
  });
  return { cwd, now, store, channel, thread, turn: store.getLingTurn(turnResult.turnId), run, requestSnapshot };
}

async function addTurnPatch(fixture, run, absolutePath, before, after, suffix) {
  const relativePath = absolutePath.slice(fixture.cwd.length + 1);
  const plan = planApplyPatch({
    patchText: `*** Begin Patch
*** Update File: ${relativePath}
@@
-${before}
+${after}
*** End Patch`,
    readFile: (path) => path === relativePath ? `${before}\n` : undefined,
  });
  const forward = fixture.store.createArtifact({ runId: run.id, type: "json", path: `${suffix}-forward`, sealedPayload: plan, createdAt: fixture.now });
  const inverse = fixture.store.createArtifact({ runId: run.id, type: "json", path: `${suffix}-inverse`, sealedPayload: invertPatchPlan(plan), createdAt: fixture.now });
  await writeFile(absolutePath, `${after}\n`, "utf8");
  fixture.store.createWorkspaceMutationRecord({
    cwd: fixture.cwd,
    workspaceId: fixture.turn.workspaceId,
    threadId: fixture.turn.threadId,
    turnId: fixture.turn.id,
    runId: run.id,
    patchPlanId: `patch_plan_${suffix}`,
    operationIndex: 0,
    path: relativePath,
    operation: "update",
    beforeSha256: "before",
    afterSha256: "after",
    forwardPatchArtifactId: forward.id,
    inversePatchArtifactId: inverse.id,
    sourceRefs: [{ type: "turn", id: fixture.turn.id }, { type: "run", id: run.id }],
    createdAt: fixture.now,
  });
  fixture.store.markRunSucceeded(run.id, "2026-08-25T03:00:03.000Z");
  return plan;
}

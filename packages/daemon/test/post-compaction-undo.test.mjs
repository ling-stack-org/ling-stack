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

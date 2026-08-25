import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createSqliteRunStore, invertPatchPlan, planApplyPatch } from "../dist/index.js";

test("workspace mutation provenance and compaction checkpoints survive SQLite reopen", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-workspace-provenance-"));
  const now = "2026-08-25T01:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Provenance", boundPath: cwd }, now);
    const thread = store.resolveOrCreateConversationThread({
      surfaceKind: "channel_root",
      channelId: channel.id,
      title: "Provenance",
      objective: "Keep workspace mutations reversible after compaction.",
    }, now).thread;
    const turnResult = store.appendConversationUserTurn({
      turnId: "turn_provenance",
      itemId: "item_provenance",
      channelId: channel.id,
      threadId: thread.id,
      title: "Edit file",
      userInstruction: "Edit file",
      payload: {
        body: "Edit file",
        format: "plain_text",
        mentions: [],
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
      },
      idempotencyKey: "provenance-turn",
    }, now);
    const run = store.createRun({
      id: "run_provenance",
      cwd,
      taskId: "task_provenance",
      threadId: thread.id,
      turnId: turnResult.turnId,
      providerName: "test",
      providerModel: "test",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: now,
    });
    await writeFile(resolve(cwd, "file.txt"), "old\n", "utf8");
    const plan = planApplyPatch({
      patchText: `*** Begin Patch
*** Update File: file.txt
@@
-old
+new
*** End Patch`,
      readFile: (path) => path === "file.txt" ? "old\n" : undefined,
    });
    const forward = store.createArtifact({ runId: run.id, type: "json", path: "forward", sealedPayload: plan, createdAt: now });
    const inverse = store.createArtifact({ runId: run.id, type: "json", path: "inverse", sealedPayload: invertPatchPlan(plan), createdAt: now });
    const records = store.createWorkspaceMutationRecords(plan.operations.map((operation, operationIndex) => ({
      cwd,
      threadId: thread.id,
      turnId: turnResult.turnId,
      runId: run.id,
      patchPlanId: "patch-plan-provenance",
      operationIndex,
      path: operation.path,
      operation: operation.kind,
      beforeSha256: "before",
      afterSha256: "after",
      forwardPatchArtifactId: forward.id,
      inversePatchArtifactId: inverse.id,
      sourceRefs: [{ type: "turn", id: turnResult.turnId }, { type: "run", id: run.id }],
      createdAt: now,
    })));
    assert.equal(records.length, 1);
    assert.equal(records[0].provenanceSeq, 1);
    assert.equal(store.getLatestWorkspaceProvenanceWatermark(), "workspace_default:1");
    const checkpoint = store.createCompactionCheckpoint({
      threadId: thread.id,
      sourceTurnId: turnResult.turnId,
      coveredItemSeqFrom: turnResult.item.sequence,
      coveredItemSeqTo: turnResult.item.sequence,
      coveredTurnIds: [turnResult.turnId],
      summaryIds: [],
      sourceRefs: [{ type: "turn", id: turnResult.turnId }],
      workspaceProvenanceWatermark: "workspace_default:1",
      compactionPolicyVersion: "continuity-v2-summary-v1",
      createdAt: now,
    });
    assert.equal(store.getCompactionCheckpoint(checkpoint.id)?.sourceTurnId, turnResult.turnId);
    assert.throws(() => store.createCompactionCheckpoint({
      threadId: thread.id,
      sourceTurnId: turnResult.turnId,
      coveredItemSeqFrom: turnResult.item.sequence,
      coveredItemSeqTo: turnResult.item.sequence,
      coveredTurnIds: [turnResult.turnId],
      summaryIds: ["missing_summary"],
      sourceRefs: [{ type: "turn", id: turnResult.turnId }],
      workspaceProvenanceWatermark: "workspace_default:1",
      compactionPolicyVersion: "continuity-v2-summary-v1",
      createdAt: now,
    }), /summary does not belong to thread/u);
    const recovery = store.createPostCompactionUndoRecord({
      idempotencyKey: "undo-provenance-record",
      workspaceId: "workspace_default",
      threadId: thread.id,
      targetTurnId: turnResult.turnId,
      targetRunIds: [run.id],
      checkpointId: checkpoint.id,
      expectedWorkspaceFingerprint: "fingerprint-before-undo",
      action: "undo",
      affectedPaths: ["file.txt"],
      createdAt: now,
    });
    assert.equal(recovery.state, "available");
    assert.equal(store.createPostCompactionUndoRecord({
      idempotencyKey: "undo-provenance-record",
      threadId: thread.id,
      targetTurnId: turnResult.turnId,
      targetRunIds: [run.id],
      checkpointId: checkpoint.id,
      expectedWorkspaceFingerprint: "ignored-on-replay",
      action: "undo",
      affectedPaths: ["file.txt"],
      createdAt: now,
    }).id, recovery.id);
    assert.equal(store.updatePostCompactionUndoRecord({
      id: recovery.id,
      expectedState: "available",
      state: "validating",
      lastEventSeq: 8,
      updatedAt: "2026-08-25T01:00:00.500Z",
    })?.state, "validating");
    assert.equal(store.updatePostCompactionUndoRecord({
      id: recovery.id,
      expectedState: "validating",
      state: "undone",
      lastEventSeq: 9,
      updatedAt: "2026-08-25T01:00:01.000Z",
    })?.state, "undone");
    assert.equal(store.updatePostCompactionUndoRecord({
      id: recovery.id,
      expectedState: "validating",
      state: "applied",
      lastEventSeq: 10,
      updatedAt: "2026-08-25T01:00:02.000Z",
    }), undefined);
    assert.throws(() => store.updatePostCompactionUndoRecord({
      id: recovery.id,
      expectedState: "undone",
      state: "validating",
      lastEventSeq: 11,
      updatedAt: "2026-08-25T01:00:03.000Z",
    }), /Illegal post-compaction undo transition/u);
    store.close();
    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.listWorkspaceMutationRecords({ turnId: turnResult.turnId })[0].runId, run.id);
      assert.equal(reopened.listCompactionCheckpoints({ threadId: thread.id })[0].id, checkpoint.id);
      assert.equal(reopened.getLatestWorkspaceProvenanceWatermark(), "workspace_default:1");
      assert.equal(reopened.getPostCompactionUndoRecord(recovery.id)?.state, "undone");
      assert.equal(reopened.listPostCompactionUndoRecords({ idempotencyKey: "undo-provenance-record" }).length, 1);
      const integrity = new DatabaseSync(reopened.paths.databasePath);
      try {
        assert.deepEqual(integrity.prepare("PRAGMA foreign_key_check").all(), []);
      } finally {
        integrity.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch {}
    await rm(cwd, { recursive: true, force: true });
  }
});

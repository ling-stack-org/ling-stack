import assert from "node:assert/strict";
import test from "node:test";
import { executionActionSourceRefs } from "../src/lib/execution-action-lineage.ts";

test("execution action lineage preserves approval source refs", () => {
  const refs = executionActionSourceRefs(executionAction({ approvalId: "approval-1" }), undefined);

  assert.deepEqual(refs.find((ref) => ref.kind === "approval"), {
    kind: "approval",
    id: "approval-1",
  });
});

test("execution action lineage merges conversation anchors with file and diff refs", () => {
  const artifact = {
    id: "artifact-diff-1",
    runId: "run-1",
    type: "diff",
    path: "changes/approved.diff",
    title: "approved.diff",
    contentType: "text/x-diff; charset=utf-8",
    createdAt: "2026-08-26T00:00:01.000Z",
  };
  const refs = executionActionSourceRefs(executionAction({
    sourceRefs: [{ kind: "conversation_item", id: "message-1" }],
    resultArtifactIds: [artifact.id],
  }), undefined, new Map([[artifact.id, artifact]]));

  assert.deepEqual(refs.find((ref) => ref.kind === "conversation_item"), {
    kind: "conversation_item",
    id: "message-1",
  });
  assert.deepEqual(refs.find((ref) => ref.kind === "file"), {
    kind: "file",
    id: "src/approved.ts",
    label: "src/approved.ts",
    path: "src/approved.ts",
    hostTarget: "open_file",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(refs.find((ref) => ref.id === artifact.id), {
    kind: "diff",
    id: artifact.id,
    label: "approved.diff",
    path: "changes/approved.diff",
    hostTarget: "open_diff",
    workspaceId: "workspace-1",
  });
});

function executionAction(overrides = {}) {
  return {
    id: "action-approval",
    workspaceId: "workspace-1",
    runId: "run-1",
    attemptId: "attempt-1",
    approvalId: undefined,
    actionType: "read",
    risk: "low",
    status: "succeeded",
    title: "Read approved file",
    summary: "Read approved file",
    targetRefs: [{ type: "file", id: "src/approved.ts", path: "src/approved.ts" }],
    previewArtifactIds: [],
    resultArtifactIds: [],
    createdAt: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

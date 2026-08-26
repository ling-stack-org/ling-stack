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

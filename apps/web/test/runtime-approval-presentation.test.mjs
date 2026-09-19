import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDialogOwnedApprovalPresentationByRunId,
  dialogOwnedApprovalPresentationForWorkCell,
  composerGateApprovalPresentationForRunId,
} from "../src/lib/runtime-approval-presentation.ts";

const t = (key, values = {}) => key.replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ""));

test("dialog-owned approval projection keeps the queue's first approval per run", () => {
  const presentations = buildDialogOwnedApprovalPresentationByRunId([
    view({
      id: "approval-critical",
      runId: "run-1",
      actionType: "bash",
      payload: { type: "bash", command: "pnpm test" },
    }),
    view({
      id: "approval-later",
      runId: "run-1",
      actionType: "edit",
      payload: { type: "file_edit", path: "README.md" },
    }),
  ], t);

  assert.deepEqual(presentations.get("run-1"), {
    approvalId: "approval-critical",
    runId: "run-1",
    actionSentence: "Run command: pnpm test",
  });
});

test("dialog-owned approval projection resolves payload run ids and strips cwd from paths", () => {
  const presentations = buildDialogOwnedApprovalPresentationByRunId([
    view({
      id: "approval-edit",
      actionType: "edit",
      payload: {
        type: "file_edit",
        runId: "run-payload",
        cwd: "/workspace/ling-stack",
        path: "/workspace/ling-stack/apps/web/src/App.tsx",
      },
    }),
  ], t);
  const presentation = dialogOwnedApprovalPresentationForWorkCell({
    anchorRunId: "run-other",
    runIds: ["run-other", "run-payload"],
  }, presentations);

  assert.deepEqual(presentation, {
    approvalId: "approval-edit",
    runId: "run-payload",
    actionSentence: "Modify file: apps/web/src/App.tsx",
  });
});

test("composer approval ownership resolves directly from the durable run id", () => {
  const presentations = buildDialogOwnedApprovalPresentationByRunId([
    view({ id: "approval-run", runId: "run-direct", actionType: "bash", payload: { type: "bash", command: "pnpm test" } }),
  ], t);
  assert.deepEqual(composerGateApprovalPresentationForRunId("run-direct", presentations), presentations.get("run-direct"));
  assert.equal(composerGateApprovalPresentationForRunId(" ", presentations), undefined);
});

function view(input) {
  return {
    approval: {
      title: "Raw approval title",
      description: "fallback",
      risk: "medium",
      status: "pending",
      createdAt: "2026-08-26T00:00:00.000Z",
      ...input,
    },
    summary: "fallback",
    ownerLabel: "run",
    requiresDetailConfirmation: false,
  };
}

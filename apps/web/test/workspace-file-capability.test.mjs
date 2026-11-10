import assert from "node:assert/strict";
import test from "node:test";
import {
  publishTimelineWorkspaceFileCapability,
  resolveTimelineWorkspaceFileCapability,
  capabilityTargetForRef,
  timelineCapabilityScope,
} from "../src/shared/conversation/timeline/workspace-file-capability-core.ts";

const ref = { kind: "file", id: "file-ref-1", path: "src/parser.ts" };
const operationItem = {
  id: "action:edit-1",
  kind: "fileChange",
  revision: 4,
  threadSequence: 2,
  partIndex: 1,
  runId: "run-1",
  actionId: "tool:run-1:edit-1",
  attemptId: "attempt-1",
  participantId: "engineer",
  workflowStepId: "step-1",
  sourceRefs: [ref],
  title: "Edited parser.ts",
  files: [],
};
const context = {
  cwd: "/workspace",
  workspaceId: "workspace-1",
  threadId: "thread-1",
};

test("timeline capability scope requires workspace, thread and atomic action lineage", () => {
  assert.deepEqual(timelineCapabilityScope(ref, operationItem, context), {
    workspaceId: "workspace-1",
    threadId: "thread-1",
    runId: "run-1",
    actionId: "tool:run-1:edit-1",
    participantId: "engineer",
    workflowStepId: "step-1",
  });

  assert.equal(timelineCapabilityScope(ref, operationItem, { ...context, workspaceId: undefined }), undefined);
  assert.equal(timelineCapabilityScope(ref, operationItem, { ...context, threadId: undefined }), undefined);
  assert.equal(timelineCapabilityScope(ref, { ...operationItem, runId: undefined }, context), undefined);
  assert.equal(timelineCapabilityScope(ref, { ...operationItem, actionId: undefined }, context), undefined);
  assert.equal(timelineCapabilityScope(ref, { ...operationItem, participantId: undefined }, context), undefined);
});

test("timeline file target is published only after the Host issues a capability", async () => {
  let request;
  const target = await resolveTimelineWorkspaceFileCapability(ref, operationItem, context, async (input) => {
    request = input;
    return {
      cwd: "/workspace",
      capability: {
        capabilityId: "wscap-1",
        capabilityTarget: "open_file",
        refId: "file-ref-1",
        displayPath: "src/parser.ts",
        scope: input.scope,
        issuedAt: "2026-09-03T00:00:00.000Z",
        expiresAt: "2026-09-03T00:05:00.000Z",
        daemonEpoch: "epoch-1",
      },
    };
  });

  assert.deepEqual(request, {
    cwd: "/workspace",
    capabilityTarget: "open_file",
    refId: "file-ref-1",
    scope: {
      workspaceId: "workspace-1",
      threadId: "thread-1",
      runId: "run-1",
      actionId: "tool:run-1:edit-1",
      participantId: "engineer",
      workflowStepId: "step-1",
    },
  });
  assert.equal(target.path, "src/parser.ts");
  assert.equal(target.capabilityId, "wscap-1");
  assert.equal(target.capabilityTarget, "open_file");
});

test("timeline capability preserves dedicated diff and artifact viewer targets", async () => {
  assert.equal(capabilityTargetForRef({ kind: "diff" }), "open_diff");
  assert.equal(capabilityTargetForRef({ kind: "artifact" }), "open_artifact");
  assert.equal(capabilityTargetForRef({ kind: "file", hostTarget: "open_diff" }), "open_diff");
  assert.equal(capabilityTargetForRef({ kind: "artifact", hostTarget: "open_diff" }), "open_diff");

  for (const [resourceRef, expectedTarget] of [
    [{ kind: "diff", id: "diff-1", path: "artifacts/change.diff" }, "open_diff"],
    [{ kind: "artifact", id: "artifact-1", path: "artifacts/report.md" }, "open_artifact"],
  ]) {
    const target = await resolveTimelineWorkspaceFileCapability(resourceRef, { ...operationItem, sourceRefs: [resourceRef] }, context, async (input) => ({
      cwd: "/workspace",
      capability: {
        capabilityId: `wscap-${resourceRef.id}`,
        capabilityTarget: input.capabilityTarget,
        refId: resourceRef.id,
        displayPath: resourceRef.path,
        scope: input.scope,
        issuedAt: "2026-09-03T00:00:00.000Z",
        expiresAt: "2026-09-03T00:05:00.000Z",
        daemonEpoch: "epoch-1",
      },
    }));
    assert.equal(target.capabilityTarget, expectedTarget);
  }
});

test("capability API failure never publishes a Dock target", async () => {
  let opened = false;
  await assert.rejects(
    publishTimelineWorkspaceFileCapability(
      ref,
      operationItem,
      context,
      () => { opened = true; },
      async () => { throw new Error("capability unavailable"); },
    ),
    /capability unavailable/u,
  );
  assert.equal(opened, false);
});

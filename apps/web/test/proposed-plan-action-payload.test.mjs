import assert from "node:assert/strict";
import { test } from "node:test";
import { proposedPlanActionPayload } from "../src/features/workspace/proposed-plan-action-payload.ts";

const plan = {
  id: "plan-v2", workspaceId: "workspace", threadId: "thread", channelId: "channel",
  parentPlanId: "plan-v1", planGroupId: "group", version: 2, revision: 7,
  title: "Canonical proposal", bodyMarkdown: "Keep exact\n\n```ts\nconst n = 2;\n```",
  status: "accepted", acceptedTaskId: "task", acceptedAt: "now", savedAt: "later",
  sourceMessageState: "available", createdAt: "created", updatedAt: "updated",
};

test("plan actions carry the displayed revision separately from lineage version", () => {
  const result = proposedPlanActionPayload(plan);
  assert.equal(result.expectedRevision, 7);
  assert.equal(result.version, 2);
  assert.equal(result.parentPlanId, "plan-v1");
  assert.equal(result.bodyMarkdown, plan.bodyMarkdown);
  assert.equal(result.sourceRunId, null);
  for (const field of ["acceptedTaskId", "acceptedAt", "savedAt", "sourceMessageState", "updatedAt"]) {
    assert.equal(Object.hasOwn(result, field), false, field);
  }
  assert.equal(plan.revision, 7);
});

test("an unpersisted source projection cannot fabricate a revision or acceptance fact", () => {
  const { revision, ...sourceProjection } = plan;
  const serialized = JSON.parse(JSON.stringify(proposedPlanActionPayload(sourceProjection)));
  assert.equal(Object.hasOwn(serialized, "expectedRevision"), false);
  assert.equal(Object.hasOwn(serialized, "acceptedTaskId"), false);
});

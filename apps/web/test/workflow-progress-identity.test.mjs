import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(`${specifier.slice(0, -3)}${extension}`, context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildWorkflowProgressModel,
  workflowProgressToConversationWorkCell,
} = await import("../src/lib/workflow-progress.ts");
const { conversationTimelineItemsForModel } = await import("../src/lib/conversation-work-cell.ts");

const t = (key) => key;

function workflow(id) {
  return {
    id,
    workspaceId: "workspace-1",
    channelId: "channel-1",
    title: `${id} workflow`,
    objective: "Complete the task",
    status: "succeeded",
    createdBy: "local-user",
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:01:00.000Z",
  };
}

function step(workflowId, id, position, participantId, label) {
  return {
    id,
    workspaceId: "workspace-1",
    channelId: "channel-1",
    workflowId,
    position,
    title: `${label}: complete task`,
    prompt: `Complete task as ${label}`,
    toParticipantId: participantId,
    toParticipantLabel: label,
    participantAuthority: "workflow_member",
    status: "succeeded",
    resultSummary: `${label} completed`,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:01:00.000Z",
  };
}

function timelineFor(workflowId, stepId) {
  const progress = buildWorkflowProgressModel({
    workflow: workflow(workflowId),
    steps: [step(workflowId, stepId, 0, "teammate_builtin_engineer", "Engineer")],
    runs: [],
    approvals: [],
    artifactsByRun: {},
    t,
  });
  return conversationTimelineItemsForModel(workflowProgressToConversationWorkCell(progress));
}

test("workflow participant timeline identity is scoped per workflow", () => {
  const first = timelineFor("workflow-first", "step-first");
  const second = timelineFor("workflow-second", "step-second");
  const nestedFirst = first.filter((item) => item.kind === "subAgentActivity");
  const nestedSecond = second.filter((item) => item.kind === "subAgentActivity");

  assert.equal(nestedFirst.length, 1);
  assert.equal(nestedSecond.length, 1);
  assert.notEqual(nestedFirst[0].id, nestedSecond[0].id);
  assert.match(nestedFirst[0].id, /workflow-first/);
  assert.match(nestedSecond[0].id, /workflow-second/);
});

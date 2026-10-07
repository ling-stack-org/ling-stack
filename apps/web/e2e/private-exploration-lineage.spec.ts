import { expect, test } from "@playwright/test";
import { timelineBatchGroup } from "./support/timeline-batch-group";
import { installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { mockDaemon, type MockExecutionAction } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";

test("private adjacent reads with committed canonical context use the shared exploration batch", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const { displayName, teammateId } = installTeammateWorkCellFixture(state);
  state.executionActions = state.executionActions.map((action, index) => {
    const path = `src/private-adjacent-${index + 1}.mjs`;
    return {
      ...action, participantId: teammateId, actionType: "read", title: "Read file", summary: path, scopeSummary: "read_only",
      targetRefs: [{ type: "file", id: path, path }], commandEvidence: undefined,
      toolEvidence: { toolName: "read", inputSummary: path, outputText: `export const adjacent = ${index + 1};\n`, outputTruncated: false, latestEventSeq: index + 2 },
    };
  });
  state.terminalReports = [];
  state.conversationItems = state.conversationItems?.filter((item) => item.kind !== "terminal_report");
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: displayName, exact: true }).click();
  const feed = page.getByLabel("Private message feed", { exact: true });
  const batch = feed.locator('[data-conversation-timeline-kind="explorationBatch"]');
  await expect(batch).toHaveCount(1);
  await expect(feed.locator('[data-conversation-timeline-kind="diagnostic"]')).toHaveCount(0);
  const trigger = batch.getByRole("button", { name: "Read 3 items. Expand read records" });
  await trigger.focus();
  await trigger.press("Space");
  await expect((await timelineBatchGroup(batch)).locator('[data-conversation-timeline-kind="exploration"]')).toHaveCount(3);
  for (const action of state.executionActions) {
    await expect((await timelineBatchGroup(batch)).locator(`[data-conversation-action-id="${action.id}"]`)).toBeVisible();
  }
});

test("private successful reads without a canonical anchor remain diagnostic, not a fabricated exploration batch", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const { teammateId, displayName } = installTeammateWorkCellFixture(state);
  const original = state.executionActions[0];
  const assistant = state.teammateDirectMessages[0];
  if (!original?.runId || !original.threadId || !original.attemptId || !isRecord(assistant)) {
    throw new Error("Private lineage fixture requires an existing assistant, run, thread, and attempt");
  }
  const runId = original.runId;
  const threadId = original.threadId;
  const directThreadId = `tdthread_${teammateId}`;
  const sourceMessageId = "dm_msg_p02_user";
  const turnId = "turn_p02_private_read";
  const workUnitId = "work_unit_p02_private_read";
  const instruction = "Read the three project files and report their purpose.";
  state.teammateDirectThreads[teammateId] = {
    id: directThreadId,
    workspaceId: original.workspaceId,
    teammateId,
    title: displayName,
    createdAt: original.createdAt,
    updatedAt: original.updatedAt,
  };
  state.teammateDirectMessages = [{
    ...assistant,
    id: sourceMessageId,
    threadId: directThreadId,
    authorType: "local-user",
    authorId: "local-user",
    body: instruction,
    linkedRunId: undefined,
  }, {
    ...assistant,
    threadId: directThreadId,
    body: "The three reads finished, but their conversation placement must be verified from durable evidence.",
  }];
  state.runs = state.runs.map((run) => run.id === runId ? { ...run, turnId, teammateId } : run);
  state.turns = [{
    id: turnId,
    workspaceId: original.workspaceId,
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title: instruction,
    userInstruction: instruction,
    sourceItemId: sourceMessageId,
    teammateId,
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: original.createdAt,
    updatedAt: original.updatedAt,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: original.createdAt }];
  // Matches packaged P02: the direct-message ID exists, but it is not a
  // ConversationItem. Do not make this fixture green by inventing that anchor.
  state.conversationItems = [];
  state.terminalReports = [];
  state.approvals = [];
  state.executionActions = [41, 77, 84].map((eventSequence, index): MockExecutionAction => {
    const actionId = `execution_action_p02_read_${index + 1}`;
    const toolCallId = `tool_call_p02_read_${index + 1}`;
    const path = `/workspace/p02/project-${index + 1}.mjs`;
    const timestamp = new Date(Date.parse(original.createdAt) + eventSequence * 1_000).toISOString();
    return {
      ...original,
      id: actionId,
      revision: eventSequence + 1,
      sourceEventSequence: eventSequence,
      participantId: teammateId,
      workUnitId,
      toolCallId,
      actionType: "read",
      risk: "low",
      status: "succeeded",
      title: "Read file",
      summary: `Read ${path}`,
      scopeSummary: "read_only",
      targetRefs: [{ type: "file", id: path, path }],
      commandEvidence: undefined,
      previewArtifactIds: [],
      resultArtifactIds: [],
      sourceRefs: [
        { kind: "execution_action", id: actionId },
        { kind: "run", id: runId },
        { kind: "work_unit", id: workUnitId },
        { kind: "attempt", id: original.attemptId! },
        { kind: "participant", id: teammateId },
        { kind: "tool_call", id: toolCallId },
        { kind: "file", id: path, path },
        { kind: "run_event", id: `event_p02_read_${eventSequence}` },
      ],
      toolEvidence: {
        toolName: "read",
        inputSummary: path,
        outputText: `export const project = ${index + 1};\n`,
        outputTruncated: false,
        latestEventSeq: eventSequence + 1,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      executedAt: timestamp,
      completedAt: timestamp,
    };
  });
  expect(state.executionActions.every((action) =>
    action.sourceRefs?.every((ref) => ref.kind !== "conversation_item") &&
    action.runId && action.attemptId && action.participantId && action.sourceEventSequence
  )).toBe(true);
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("button", { name: displayName, exact: true }).click();

  const feed = page.locator('[data-ui2-teammate-private-feed="true"]');
  await expect(feed.getByText(instruction, { exact: true })).toBeVisible();
  await expect(feed.locator('[data-conversation-timeline-kind="diagnostic"]').first()).toBeVisible();
  await expect(feed).toContainText(/lineage|anchor/iu);
  await expect(feed.locator('[data-conversation-timeline-kind="explorationBatch"]')).toHaveCount(0);
  await expect(feed.locator('[data-conversation-timeline-kind="exploration"]')).toHaveCount(0);
  await expect(feed.getByRole("button", { name: /Read 3 items/u })).toHaveCount(0);
  await expect(feed).not.toContainText("export const project");
});

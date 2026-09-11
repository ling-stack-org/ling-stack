import { expect, test } from "@playwright/test";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { mockDaemon } from "./support/mock-daemon";
import { openEngineeringChannel } from "./support/test-helpers";

// API display fixture. Packaged model runs are recorded separately in QA evidence.
test("channel child keeps live narration around its read, including a no-SSE refresh", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const createdAt = "2026-09-06T02:00:00.000Z";
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
  const source = { id: "child_source", workspaceId: "workspace_default", channelId: "channel_engineering",
    kind: "message", authorType: "local-user", authorId: "local-user", intent: "discuss",
    body: "Review the selected file.", status: "ready", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], createdAt, updatedAt: createdAt };
  state.channelMessages = [source];
  state.channelWorkflows = [{ id: "workflow_child", workspaceId: "workspace_default", channelId: "channel_engineering",
    title: "Review the selected file", objective: "Read once", status: "running", createdBy: "system", createdAt, updatedAt: createdAt,
    metadata: { sourceMessageId: source.id } }];
  const step = { id: "step_child", workspaceId: "workspace_default", channelId: "channel_engineering", workflowId: "workflow_child",
    runId: "run_child", position: 0, title: "Inspect file", prompt: "Read once", toParticipantId: "engineer", toParticipantLabel: "Engineer",
    status: "running", createdAt, updatedAt: createdAt,
    runNarration: { runId: "run_child", participantId: "engineer", workflowStepId: "step_child", threadId: "thread_parent", turnId: "turn_parent",
      sourceItemId: source.id, sourceItemSequence: 1, attemptId: "attempt_child",
      segments: [{ content: "Inspect first.", firstEventId: "event_1", lastEventId: "event_2", startEventSequence: 1, endEventSequence: 2, completed: true }] } };
  state.channelWorkflowSteps = [step];
  state.runs = [{ ...state.runs[0]!, id: "run_child", status: "running", channelId: "channel_engineering", teammateId: "engineer",
    workflowStepId: step.id, taskSnapshot: { channelId: "channel_engineering" }, createdAt, updatedAt: createdAt }];
  state.executionActions = [{ id: "child_read", revision: 4, sourceEventSequence: 3, workspaceId: "workspace_default", runId: "run_child",
    attemptId: "attempt_child", participantId: "engineer", workflowStepId: step.id, actionType: "read", risk: "low", status: "succeeded",
    title: "Read file", summary: "Read file", targetRefs: [{ type: "file", path: "sample.ts" }], previewArtifactIds: [], resultArtifactIds: [],
    sourceRefs: [{ kind: "conversation_item", id: source.id }], createdAt,
    toolEvidence: { toolName: "read", inputSummary: "sample.ts", outputText: "const value = 1;", outputTruncated: false, latestEventSeq: 4 } }];
  await mockDaemon(page, state);
  let stepRequests = 0;
  let actionRequests = 0;
  page.on('request', request => {
    if (request.url().includes('/workflows/workflow_child/steps')) stepRequests += 1;
    if (request.url().includes('/execution-actions')) actionRequests += 1;
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  const participant = page.locator('[data-conversation-timeline-kind="subAgentActivity"]');
  await expect(participant).toHaveCount(1);
  const toggle = participant.locator('button[aria-expanded]').first();
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(page.getByText('Inspect first.', { exact: true })).toBeVisible();
  const previousStepRequests = stepRequests;
  const previousActionRequests = actionRequests;
  step.runNarration.segments.push({ content: "## Findings\nThe read is complete.", firstEventId: "event_5", lastEventId: "event_6", startEventSequence: 5, endEventSequence: 6, completed: true });
  state.executionActions.push({ id: "child_loop", revision: 7, sourceEventSequence: 7, workspaceId: "workspace_default", runId: "run_child",
    attemptId: "attempt_child", participantId: "engineer", workflowStepId: step.id, actionType: "runtime_diagnostic", risk: "low", status: "failed",
    title: "execution_loop_detected", summary: "Execution stopped after repeated activity produced no new evidence.", targetRefs: [], previewArtifactIds: [], resultArtifactIds: [],
    sourceRefs: [{ kind: "conversation_item", id: source.id }], createdAt,
    runtimeDiagnostic: { code: "execution_loop_detected", loopKind: "no_progress_budget", repeatedCount: 1,
      noProgressActionCount: 12, fingerprint: "b".repeat(64), retryable: false } });
  await expect.poll(() => actionRequests, { message: 'Action polling remains active', timeout: 10000 }).toBeGreaterThan(previousActionRequests);
  await expect.poll(() => stepRequests, { message: 'Live workflow narration is polled after initial protocol load', timeout: 10000 }).toBeGreaterThan(previousStepRequests);
  await expect(page.getByText('The read is complete.', { exact: true })).toBeVisible({ timeout: 10000 });
  const rows = page.locator('[data-conversation-timeline-depth="1"][data-conversation-timeline-kind]');
  await expect.poll(() => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-conversation-timeline-kind')))).toEqual(['agentMessage', 'exploration', 'agentMessage', 'diagnostic']);
  expect(await rows.first().innerText()).toContain('Inspect first.');
  expect(await rows.nth(2).innerText()).toContain('The read is complete.');
  const diagnostic = rows.last();
  await expect(diagnostic).toHaveAttribute('data-conversation-timeline-renderer-key', 'diagnostic.blocked');
  await expect(diagnostic.locator('.conversation-timeline-activity-main strong')).toHaveText('Repeated execution stopped');
  await expect(diagnostic.locator('.conversation-timeline-activity-main')).toContainText('No new evidence');
  await expect(diagnostic.locator('.conversation-timeline-diagnostic-detail')).toContainText('Action budget exhausted');
});

import { expect, test } from "@playwright/test";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { mockDaemon } from "./support/mock-daemon";
import { openEngineeringChannel } from "./support/test-helpers";

// Synthetic public Host snapshots only; no database receipt or real runner ACK is asserted.
for (const theme of ["light", "dark"] as const) for (const withTools of [false, true]) {
  test(`child Q/A ${withTools ? "interleaved" : "waiting without tools"} · ${theme} · synthetic Host`, async ({ page, context }, testInfo) => {
    await page.addInitScript(selected => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const selection = JSON.stringify({ themeId: "ling-" + selected, mode: "fixed" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    }, theme);
    const state = createBaseState({ approvalStatus: "expired" });
    const createdAt = "2026-09-08T04:00:00.000Z", workspaceId = "workspace_default", channelId = "channel_engineering";
    state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
    state.channelMessages = [{ id: "child_source", workspaceId, channelId, kind: "message", authorType: "local-user", authorId: "local-user",
      intent: "discuss", body: "Synthetic child Q/A history review.", status: "ready", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], createdAt, updatedAt: createdAt }];
    state.channelWorkflows = [{ id: "workflow_child", workspaceId, channelId, title: "Child history review", objective: "Verify display only",
      status: withTools ? "running" : "waiting_for_input", createdBy: "system", createdAt, updatedAt: createdAt, metadata: { sourceMessageId: "child_source" } }];
    const source = { workspaceId, threadId: "child_thread", turnId: "child_turn", runId: "run_child", attemptId: "attempt_child",
      workUnitId: "unit_child", participantId: "engineer", workflowStepId: "step_child", sourceItemId: "child_owned_source" };
    const runEventPosition = { runId: source.runId, attemptId: source.attemptId, afterEventSequence: withTools ? 2 : 0,
      ...(withTools ? { afterEventId: "event_2" } : {}) };
    const request = { kind: "user_input_request", availability: "available", itemId: "child_question", requestId: "request_child", requestVersion: 1,
      source, runEventPosition, status: "answered", statusRevision: 2, waitMode: withTools ? "optional" : "required", createdAt, updatedAt: createdAt,
      questions: [{ questionId: "q", prompt: "Synthetic question: retain the code block?\n\n```ts\nconst retained = true;\n```",
        required: true, allowFreeText: true, options: [{ optionId: "keep", label: "Keep formatting" }] }] };
    const answerText = "Keep the formatting.\n\nPreserve this second paragraph.";
    const answer = { kind: "user_input_answer", availability: "available", itemId: "child_answer", requestId: request.requestId, requestVersion: 1,
      source, runEventPosition, answerId: "accepted_child", acceptedAt: createdAt,
      answers: [{ questionId: "q", prompt: "Synthetic question", kind: "text", text: answerText }],
      delivery: { status: "pending", revision: 1, updatedAt: createdAt } };
    const items = [request, answer].map((record, index) => ({ schemaVersion: 1, id: record.itemId, workspaceId, channelId,
      threadId: source.threadId, turnId: source.turnId, sequence: 100 + index, revision: 1, kind: record.kind, status: "committed",
      actorType: index ? "local_user" : "teammate", actorId: index ? "local-user" : "engineer", visibility: "channel", domainRefs: [],
      payload: { requestId: request.requestId, requestVersion: 1, ...(index ? { answerId: answer.answerId } : {}), runEventPosition }, createdAt, updatedAt: createdAt }));
    const step = { id: "step_child", workspaceId, channelId, workflowId: "workflow_child", runId: source.runId, position: 0,
      title: "Review display", prompt: "Verify display only", toParticipantId: "engineer", toParticipantLabel: "Engineer",
      status: withTools ? "running" : "waiting_for_input", createdAt, updatedAt: createdAt,
      runUserInputHistory: { ...source, parentItemId: "child_source", parentThreadId: "thread_parent", items, userInputs: [request, answer] },
      runNarration: { runId: source.runId, attemptId: source.attemptId, participantId: "engineer", workflowStepId: "step_child",
        threadId: "thread_parent", turnId: "turn_parent", sourceItemId: "child_source", sourceItemSequence: 1,
        segments: withTools ? [1, 5].map(seq => ({ content: seq === 1 ? "Before the question." : "After the selected read.",
          firstEventId: "event_" + seq, lastEventId: "event_" + (seq + 1), startEventSequence: seq, endEventSequence: seq + 1, completed: true })) : [] } };
    state.channelWorkflowSteps = [step];
    state.runs = [{ ...state.runs[0]!, id: source.runId, channelId, teammateId: "engineer", workflowStepId: step.id,
      status: withTools ? "running" : "yielded", taskSnapshot: { channelId }, createdAt, updatedAt: createdAt }];
    state.executionActions = withTools ? [{ id: "child_read", workspaceId, runId: source.runId, attemptId: source.attemptId,
      participantId: "engineer", workflowStepId: step.id, revision: 4, sourceEventSequence: 3, actionType: "read", risk: "low", status: "succeeded",
      title: "Read file", summary: "Read file", targetRefs: [{ type: "file", path: "sample.ts" }], previewArtifactIds: [], resultArtifactIds: [],
      sourceRefs: [{ kind: "conversation_item", id: "child_source" }], createdAt,
      toolEvidence: { toolName: "read", inputSummary: "sample.ts", outputText: "const value = 1;", outputTruncated: false, latestEventSeq: 4 } }] : [];
    await mockDaemon(page, state);
    await page.goto("/");
    await openEngineeringChannel(page);
    const child = page.locator('[data-conversation-timeline-kind="subAgentActivity"]');
    await expect(child).toHaveCount(1);
    const toggle = child.locator("button[aria-expanded]").first();
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    // Disclosure content is a sibling in the shared feed, not a descendant of its header.
    const feed = page.getByLabel("Channel message feed");
    const rows = feed.locator('[data-conversation-timeline-depth="1"][data-conversation-timeline-kind]');
    const kinds = withTools ? ["agentMessage", "userInputRequest", "userInputAnswer", "exploration", "agentMessage"] : ["userInputRequest", "userInputAnswer"];
    await expect.poll(() => rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-conversation-timeline-kind")))).toEqual(kinds);
    const questionRow = feed.locator('[data-conversation-timeline-kind="userInputRequest"]');
    const answerRow = feed.locator('[data-conversation-timeline-kind="userInputAnswer"]');
    await expect(questionRow.locator("pre")).toContainText("const retained = true;");
    await expect(questionRow.locator("img.teammate-avatar-image")).toHaveCount(1);
    expect(await questionRow.locator("img.teammate-avatar-image").getAttribute("src"))
      .toBe(await child.locator("img.teammate-avatar-image").getAttribute("src"));
    const avatarPosition = await answerRow.evaluate(row => ({
      contentRight: row.querySelector(".message-content")!.getBoundingClientRect().right,
      avatarLeft: row.querySelector(".message-content")!.nextElementSibling!.getBoundingClientRect().left,
    }));
    expect(avatarPosition.avatarLeft).toBeGreaterThanOrEqual(avatarPosition.contentRight);
    await expect(answerRow.locator(".conversation-user-input-content p")).toHaveCount(2);
    await expect(page.locator('[data-conversation-timeline-depth="0"][data-conversation-timeline-kind="userInputRequest"]')).toHaveCount(0);
    await page.mouse.move(0, 0);
    await expect(answerRow.locator(".message-action-bar")).toHaveCSS("opacity", "0");
    await answerRow.hover();
    await expect(answerRow.locator(".message-action-bar")).toHaveCSS("opacity", "1");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await answerRow.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(answerText);
    // Same narration revision, no SSE: answer delivery must independently refresh while yielded.
    answer.delivery = { status: "failed", revision: 2, updatedAt: "2026-09-08T04:01:00.000Z" };
    await expect(answerRow).toHaveAttribute("data-user-input-status", "failed", { timeout: 10000 });
    await expect.poll(() => rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-conversation-timeline-kind")))).toEqual(kinds);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 960 });
      await answerRow.scrollIntoViewIfNeeded();
      const bounds = await answerRow.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: testInfo.outputPath(`child-${theme}-${withTools ? "tools" : "waiting"}-${width}-synthetic.png`), fullPage: true });
    }
  });
}

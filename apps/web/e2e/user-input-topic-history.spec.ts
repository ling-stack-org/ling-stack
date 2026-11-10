import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

for (const theme of ["light", "dark"] as const) {
  test("topic Q/A ordering and copy · " + theme + " · synthetic Host fixture", async ({ page, context }, testInfo) => {
    await page.addInitScript(selected => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const selection = JSON.stringify({ themeId: "ling-" + selected, mode: "fixed" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    }, theme);
    const state = createBaseState({ approvalStatus: "expired" });
    const channelId = "channel_engineering", rootId = "topic-input-root", threadId = "thread_topic_input";
    const now = "2026-09-08T00:00:00.000Z";
    state.channelMessages = [{ id: rootId, workspaceId: "workspace_default", channelId, kind: "ai_reply",
      intent: "discuss", authorType: "ai-teammate", authorId: "engineer", body: "Synthetic topic: question history",
      mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: now, updatedAt: now }];
    const source = { workspaceId: "workspace_default", threadId, turnId: "topic-turn", runId: "topic-run",
      attemptId: "topic-attempt", participantId: "engineer", workUnitId: "topic-unit", sourceItemId: "topic-before" };
    const thread = { id: threadId, workspaceId: source.workspaceId, channelId, kind: "channel_discussion",
      title: "Synthetic topic", objective: "Validate history", status: "open", surfaceKind: "topic", relationKind: "reply",
      anchorItemId: rootId, parentThreadId: "thread_channel_channel_engineering", nextItemSequence: 5, createdAt: now, updatedAt: now };
    const request = { kind: "user_input_request", availability: "available", itemId: "topic-question", requestId: "topic-request",
      requestVersion: 1, source, status: "answered", statusRevision: 2, waitMode: "required",
      questions: [{ questionId: "q", prompt: "Synthetic question: keep the code format?\n\n```ts\nconst retained = true;\n```",
        required: true, allowFreeText: true, options: [{ optionId: "keep", label: "Keep formatting" }] }], createdAt: now, updatedAt: now };
    const answerText = "Keep the formatting.\n\nPreserve this second paragraph.";
    const answer = { kind: "user_input_answer", availability: "available", itemId: "topic-answer", requestId: "topic-request",
      requestVersion: 1, source, answerId: "topic-accepted", acceptedAt: now,
      answers: [{ questionId: "q", prompt: "Synthetic question", kind: "text", text: answerText }],
      delivery: { status: "pending", revision: 1, updatedAt: now } };
    const base = { schemaVersion: 1, workspaceId: source.workspaceId, channelId, threadId, turnId: source.turnId,
      status: "committed", actorType: "teammate", actorId: "engineer", visibility: "channel", revision: 1,
      domainRefs: [], createdAt: now, updatedAt: now, committedAt: now };
    const message = (id: string, sequence: number, body: string) => ({ ...base, id, sequence, kind: "assistant_message",
      payload: { body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], deliveryStatus: "ready" } });
    const items = [message("topic-before", 1, "Before the question."),
      { ...base, id: request.itemId, sequence: 2, kind: request.kind, payload: { requestId: request.requestId, requestVersion: 1 } },
      { ...base, id: answer.itemId, sequence: 3, kind: answer.kind, actorType: "local_user", actorId: "local-user",
        payload: { requestId: answer.requestId, requestVersion: 1, answerId: answer.answerId } },
      message("topic-after", 4, "After the accepted answer.")];
    await mockDaemon(page, state);
    await page.route("**/channels/channel_engineering/items**", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("anchorItemId") !== rootId && url.searchParams.get("threadId") !== threadId) return route.fallback();
      await route.fulfill({ json: { cwd, channelId, thread, turns: [], items, userInputs: [request, answer],
        turnContextAssignments: [],
        decorations: [], generatedMedia: [], hasMore: false } });
    });
    await page.goto("/");
    await openEngineeringChannel(page);
    const root = page.getByLabel("Channel message feed").locator("[data-conversation-row-key]")
      .filter({ hasText: "Synthetic topic: question history" });
    await root.hover();
    await root.getByRole("button", { name: "Reply in topic", exact: true }).click();
    const panel = page.getByLabel("Topic replies", { exact: true });
    const questionRow = panel.locator('[data-conversation-timeline-kind="userInputRequest"]');
    const answerRow = panel.locator('[data-conversation-timeline-kind="userInputAnswer"]');
    await expect(questionRow).toHaveCount(1);
    await expect(answerRow).toHaveCount(1);
    await expect(questionRow.locator("pre")).toContainText("const retained = true;");
    await expect(answerRow.locator(".conversation-user-input-content p")).toHaveCount(2);
    await expect(panel).not.toContainText("No replies yet");
    const text = await panel.innerText();
    for (const [before, after] of [["Before the question.", "Synthetic question:"],
      ["Synthetic question:", "Keep the formatting."], ["Keep the formatting.", "After the accepted answer."]]) {
      expect(text.indexOf(before)).toBeLessThan(text.indexOf(after));
    }
    await page.mouse.move(0, 0);
    await expect(answerRow.locator(".message-action-bar")).toHaveCSS("opacity", "0");
    await answerRow.getByRole("button", { name: "Copy message", exact: true }).focus();
    await expect(answerRow.locator(".message-action-bar")).toHaveCSS("opacity", "1");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await answerRow.getByRole("button", { name: "Copy message", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(answerText);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 960 });
      await expect(panel).toBeVisible();
      await answerRow.scrollIntoViewIfNeeded();
      const bounds = await answerRow.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: testInfo.outputPath("topic-" + theme + "-" + width + "-synthetic-input-history.png"), fullPage: true });
    }
    await panel.getByRole("button", { name: "Close topic", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByLabel("Channel message feed")).toBeVisible();
    await expect(page.locator('[data-conversation-timeline-kind="userInputRequest"]')).toHaveCount(0);
  });
}

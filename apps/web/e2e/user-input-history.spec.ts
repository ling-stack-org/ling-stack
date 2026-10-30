import { expect, test } from "@playwright/test";
import type { ConversationItemV1, UserInputTranscriptItemV1 } from "@ling-stack/contracts";
import { installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

// Explicit synthetic DTOs exercising the real AppShell/renderer. No model or SQLite receipt is claimed.
for (const surface of ["normal", "private"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(surface + " Q/A history · " + theme + " · synthetic Host fixture", async ({ page, context }, testInfo) => {
      await page.addInitScript(selectedTheme => {
        localStorage.setItem("ling-stack.locale", "zh-CN");
        const selection = { themeId: "ling-" + selectedTheme, mode: "fixed" };
        localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
        localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
        localStorage.setItem("ling-stack.themePreference", selectedTheme);
        localStorage.setItem("ling-stack.themeBootstrapPreference", selectedTheme);
      }, theme);
      const state = createBaseState({ approvalStatus: "expired" });
      const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
      const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
      const thread = state.threads.find(value => value.kind === (surface === "private" ? "teammate_direct" : "conversation"))!;
      const link = state.turnRunLinks.find(value => state.turns.some(turn => turn.id === value.turnId && turn.threadId === thread.id))!;
      const now = "2026-09-08T00:00:00.000Z";
      const sourceItemId = surface === "private"
        ? state.turns.find(turn => turn.id === link.turnId)?.sourceItemId
        : `conversation-user:${link.turnId}`;
      if (!sourceItemId) throw new Error(`Missing canonical source item for ${surface} Q/A fixture`);
      const attemptId = `attempt_${link.runId}`;
      const participantId = teammate?.teammateId ?? "ling_agent";
      state.executionActions = state.executionActions.map((action, index) => action.runId === link.runId ? {
        ...action,
        revision: action.revision ?? 1,
        attemptId,
        participantId,
        workflowStepId: undefined,
        sourceEventSequence: (index + 1) * 2,
      } : action);
      const runEventPosition = {
        runId: link.runId,
        attemptId,
        afterEventSequence: 2,
        afterEventId: `event_${link.runId}_2`,
      };
      const source = { workspaceId: thread.workspaceId, threadId: thread.id, turnId: link.turnId, runId: link.runId,
        attemptId, participantId, workUnitId: "input-unit", sourceItemId };
      const question: UserInputTranscriptItemV1 = { availability: "available", itemId: "input-question", kind: "user_input_request",
        requestId: "input-request", requestVersion: 1, source, runEventPosition, status: "answered", statusRevision: 2,
        waitMode: "required", questions: [{ questionId: "q", prompt: "测试数据：保留 Markdown 格式吗？\n\n第二段保留换行。",
          required: true, allowFreeText: true, options: [{ optionId: "keep", label: "保留 Markdown 和换行" }] }],
        createdAt: now, updatedAt: now };
      const answerText = "第一段：保留格式。\n\n第二段：独立段落。";
      const answer: UserInputTranscriptItemV1 = { availability: "available", itemId: "input-answer", kind: "user_input_answer",
        requestId: "input-request", requestVersion: 1, source, runEventPosition, answerId: "input-accepted", acceptedAt: now,
        answers: [{ questionId: "q", prompt: "测试数据：保留 Markdown 格式吗？", kind: "text", text: answerText }],
        delivery: { status: "failed", revision: 3, updatedAt: now } };
      state.userInputs = [question, answer];
      state.conversationItems ??= [];
      const sequence = Math.max(100, ...state.conversationItems.map(item => item.sequence));
      state.conversationItems.push(...[question, answer].map((record, index) => ({
        schemaVersion: 1, id: record.itemId, workspaceId: thread.workspaceId, threadId: thread.id, turnId: link.turnId,
        sequence: sequence + index + 1, kind: record.kind, status: "committed",
        actorType: record.kind === "user_input_answer" ? "local_user" : teammate ? "teammate" : "ling_agent",
        actorId: record.kind === "user_input_answer" ? "user" : source.participantId,
        visibility: "thread_participants", revision: 1, domainRefs: [],
        payload: { requestId: record.requestId, requestVersion: 1,
          ...(record.kind === "user_input_answer" ? { answerId: record.answerId } : {}), runEventPosition },
        createdAt: now, updatedAt: now, committedAt: now,
      }) as ConversationItemV1));
      await mockDaemon(page, state);
      await page.goto("/");
      if (title) await page.getByRole("button").filter({ hasText: title }).last().click();
      if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
      const questionRow = page.locator('[data-conversation-timeline-kind="userInputRequest"]');
      const answerRow = page.locator('[data-conversation-timeline-kind="userInputAnswer"]');
      await expect(questionRow).toHaveCount(1);
      await expect(answerRow).toHaveCount(1);
      await answerRow.scrollIntoViewIfNeeded();
      await expect(questionRow).toContainText("测试数据：保留 Markdown 格式吗？");
      await expect(answerRow).toContainText("答案已保存 · 投递失败");
      await expect(answerRow.locator(".conversation-user-input-content p")).toHaveCount(2);
      for (const row of [questionRow, answerRow]) {
        await expect.poll(() => row.locator(".message-body-paragraph").first().evaluate(element => {
          const style = getComputedStyle(element);
          const probe = document.createElement("span");
          probe.style.color = "var(--ling-text-strong)";
          element.append(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          return style.color === expected;
        })).toBe(true);
      }
      await expect(answerRow.locator(".message-bubble-own")).toHaveCount(1);
      await expect(questionRow.locator(".message-bubble-peer")).toHaveCount(1);
      await expect(answerRow).not.toContainText("测试数据：保留 Markdown 格式吗？");
      await expect(answerRow.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      const copy = answerRow.locator(".message-action-bar");
      await page.mouse.move(0, 0);
      await expect(copy).toHaveCSS("opacity", "0");
      await answerRow.getByRole("button", { name: "复制消息", exact: true }).focus();
      await expect(copy).toHaveCSS("opacity", "1");
      await answerRow.hover();
      await expect(copy).toHaveCSS("opacity", "1");
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await answerRow.getByRole("button", { name: "复制消息", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(answerText);
      if (surface === "private") {
        const boxes = await answerRow.locator(".message-bubble-own").evaluate(row => {
          const content = row.querySelector(".message-content")!.getBoundingClientRect();
          const avatar = row.querySelector(".message-content")!.nextElementSibling!.getBoundingClientRect();
          return { contentRight: content.right, avatarLeft: avatar.left };
        });
        expect(boxes.avatarLeft).toBeGreaterThanOrEqual(boxes.contentRight);
      }
      for (const width of [1440, 900]) {
        await page.setViewportSize({ width, height: 960 });
        await answerRow.scrollIntoViewIfNeeded();
        const bounds = await answerRow.boundingBox();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
        await page.screenshot({ path: testInfo.outputPath(surface + "-" + theme + "-" + width + "-synthetic-input-history.png"), fullPage: true });
      }
    });
  }
}

test("pending answer form submits beside existing generated media without hiding the drawing result", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ themeId: "ling-light", mode: "fixed" }));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify({ themeId: "ling-light", mode: "fixed" }));
  });
  const browserErrors: string[] = [];
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
  page.on("pageerror", error => browserErrors.push(error.message));
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  const thread = state.threads.find(value => value.kind === "conversation")!;
  const link = state.turnRunLinks.find(value => state.turns.some(turn => turn.id === value.turnId && turn.threadId === thread.id))!;
  state.runs = state.runs.map(run => run.id === link.runId
    ? { ...run, status: "yielded", endedAt: undefined, updatedAt: "2026-09-08T06:00:00.000Z" }
    : run);
  state.threads = state.threads.map(value => value.id === thread.id
    ? { ...value, status: "waiting_for_input", activeRunId: link.runId, updatedAt: "2026-09-08T06:00:00.000Z" }
    : value);
  state.turns = state.turns.map(turn => turn.id === link.turnId
    ? { ...turn, status: "waiting_for_input", completedAt: undefined, updatedAt: "2026-09-08T06:00:00.000Z" }
    : turn);
  state.terminalReports = [];
  const sourceItemId = `conversation-user:${link.turnId}`;
  const attemptId = `attempt_${link.runId}`;
  state.executionActions = state.executionActions.map((action, index) => action.runId === link.runId ? {
    ...action,
    revision: action.revision ?? 1,
    attemptId,
    participantId: "ling_agent",
    workflowStepId: undefined,
    sourceEventSequence: (index + 1) * 2,
  } : action);
  const now = "2026-09-08T06:00:00.000Z";
  const source = { workspaceId: thread.workspaceId, threadId: thread.id, turnId: link.turnId, runId: link.runId,
    attemptId, participantId: "ling_agent", workUnitId: "input-unit", sourceItemId };
  const request: UserInputTranscriptItemV1 = { availability: "available", itemId: "input-question-pending",
    kind: "user_input_request", requestId: "input-request-pending", requestVersion: 1, source,
    runEventPosition: { runId: link.runId, attemptId, afterEventSequence: 2, afterEventId: `event_${link.runId}_2` },
    status: "pending", statusRevision: 1, waitMode: "required", questions: [{ questionId: "scope",
      prompt: "Should the drawing workflow remain available?", required: true, allowFreeText: true,
      options: [{ optionId: "keep", label: "Keep drawing available" }] }], createdAt: now, updatedAt: now };
  state.userInputs = [request];
  state.conversationItems ??= [];
  state.conversationItems.push({ schemaVersion: 1, id: request.itemId, workspaceId: thread.workspaceId,
    threadId: thread.id, turnId: link.turnId, sequence: 101, kind: request.kind, status: "committed",
    actorType: "ling_agent", actorId: source.participantId, visibility: "thread_participants", revision: 1,
    domainRefs: [], payload: { requestId: request.requestId, requestVersion: 1,
      runEventPosition: request.runEventPosition }, createdAt: now, updatedAt: now, committedAt: now } as ConversationItemV1);
  state.conversationGeneratedMedia = [{ mediaJobId: "media_existing_drawing", runId: link.runId,
    operation: "image_generate", target: { kind: "provider", id: "provider:seedream", displayName: "Seedream Studio" },
    prompt: "A precise product illustration", status: "running", artifacts: [], createdAt: now, updatedAt: now }];

  await mockDaemon(page, state);
  let submitted: unknown;
  await page.route(`http://127.0.0.1:17891/threads/${encodeURIComponent(thread.id)}/user-input-requests/`
    + `${encodeURIComponent(request.requestId)}/answers**`, async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { requestId: request.requestId, requestVersion: 1,
      answerId: "answer-ui", answerItemId: "answer-item-ui", deliveryId: "delivery-ui",
      acceptedAt: now, replayed: false } });
  });
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: title }).last().click();

  const questionRow = page.locator('[data-conversation-timeline-kind="userInputRequest"]');
  const mediaBlock = page.getByLabel("Conversation page").getByLabel("Generated media");
  await expect(questionRow).toHaveCount(1);
  await expect(mediaBlock).toBeVisible();
  await expect(mediaBlock).toContainText("Seedream Studio");
  const keepDrawingRadio = questionRow.getByRole("radio", { name: "Keep drawing available", exact: true });
  await questionRow.getByText("Keep drawing available", { exact: true }).click();
  await expect(keepDrawingRadio).toBeChecked();
  await questionRow.getByRole("button", { name: "Submit answer", exact: true }).click();
  await expect(questionRow).toContainText("Answer saved");
  await expect(questionRow).not.toContainText("Waiting for your answer");
  await expect(mediaBlock).toBeVisible();
  expect(submitted).toMatchObject({ requestId: request.requestId, expectedVersion: 1, expectedStatusRevision: 1,
    answers: [{ questionId: "scope", kind: "option", optionId: "keep" }] });
  await page.screenshot({ path: testInfo.outputPath("answer-form-with-generated-media.png"), fullPage: true });
  expect(browserErrors).toEqual([]);
});

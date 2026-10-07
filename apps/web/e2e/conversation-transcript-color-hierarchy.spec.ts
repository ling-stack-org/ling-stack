import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";

// Display-only fixtures exercise production renderers and the complete CSS
// cascade. These tests are not evidence of a real model run or packaged app.
for (const theme of ["light", "dark"] as const) {
  for (const surface of ["normal", "private", "channel"] as const) {
    test(`${surface} keeps userMessage body primary and evidence secondary in ${theme}`, async ({ page }, testInfo) => {
      await openUserTranscript(page, theme, surface);
      const message = page.locator('[data-conversation-timeline-kind="userMessage"]').filter({ hasText: "用户正文颜色。" });
      const paragraph = message.locator(".message-body-renderer > .message-body-paragraph").first();
      await expect(paragraph).toBeVisible();
      await expectSemanticColor(paragraph, "--conversation-text-strong");
      await expectSemanticColor(message.locator(".message-body-renderer > .message-body-list"), "--conversation-text-strong");
      await expectSemanticColor(message.locator(".message-body-quote .message-body-paragraph").first(), "--conversation-text-soft");
      await expectSemanticColor(message.locator(".message-body-quote .message-body-list"), "--conversation-text-soft");
      // The app's unlayered pre/code rule owns the incumbent code color.
      // Raising narration must not change that separate treatment.
      await expectSemanticColor(message.locator(".message-inline-code"), "--text");
      await expectSemanticColor(message.locator(".message-code-block code"), "--text");
      await expectSemanticColor(message.locator(".message-code-block figcaption > span"), "--conversation-text-muted");
      await page.mouse.move(0, 0);
      await expectSemanticColor(page.locator('[data-conversation-timeline-kind="commandExecution"] .conversation-timeline-activity-main strong').first(), "--conversation-text-muted");
      await paragraph.hover();
      await expectSemanticColor(paragraph, "--conversation-text-strong");
      await page.screenshot({ path: testInfo.outputPath(`fixture-user-message-${surface}-${theme}.png`) });
    });
  }

  for (const surface of ["normal", "private"] as const) {
    test(`${surface} shares narration and interactive fact colors in ${theme}`, async ({ page }) => {
      await selectTheme(page, theme);
      const state = createBaseState({ approvalStatus: "expired" });
      const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
      const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
      // Keep a single fact so this test covers the shared row, not batching.
      const command = state.executionActions[0];
      if (!command?.commandEvidence) throw new Error("Color fixture requires Host command evidence");
      state.executionActions = [command];
      state.terminalReports = [];
      state.conversationItems = state.conversationItems?.filter((item) => item.kind !== "terminal_report");
      await mockDaemon(page, state);
      await page.goto("/");
      if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
      if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
      const narration = page.locator(".conversation-timeline-message.agentMessage .message-body-paragraph").first();
      await expect(narration).toBeVisible();
      await expectSemanticColor(narration, "--conversation-text-strong");
      const fact = page.locator(`[data-conversation-action-id="${command.id}"][data-conversation-timeline-kind="commandExecution"]`);
      const trigger = fact.locator("button.conversation-timeline-activity-main");
      await expect(trigger).toBeVisible();
      await page.mouse.move(0, 0);
      await expectSemanticColor(trigger.locator("strong"), "--conversation-text-muted");
      await trigger.hover();
      await expectSemanticColor(trigger.locator("strong"), "--conversation-text-strong");
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await trigger.focus();
      await expectSemanticColor(trigger.locator("strong"), "--conversation-text-strong");
      await trigger.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(narration).toBeVisible();
      await expectSemanticColor(narration, "--conversation-text-strong");
    });
  }

  test(`transcript keeps completed child narration primary in ${theme}`, async ({ page }, testInfo) => {
    await openTranscript(page, theme);
    const timeline = page.getByLabel("Channel message feed")
      .locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]').first();
    const engineer = timeline.locator('[data-conversation-timeline-sub-agent][data-conversation-participant-id="engineer"]');
    const trigger = engineer.locator(".conversation-timeline-sub-agent-head");
    await trigger.click();
    const groupId = await trigger.getAttribute("aria-controls");
    expect(groupId).toBeTruthy();
    const child = timeline.locator(`[id="${groupId}"]`);
    const narration = child.locator('.conversation-timeline-message.agentMessage .message-body-paragraph').first();
    await expect(narration).toBeVisible();
    await expectSemanticColor(narration, "--conversation-text-strong");
    await narration.hover();
    await expectSemanticColor(narration, "--conversation-text-strong");
    await page.screenshot({ path: testInfo.outputPath(`fixture-child-narration-${theme}.png`) });
  });

  test(`transcript facts are secondary and interactive in ${theme}`, async ({ page }) => {
    await openTranscript(page, theme);
    const timeline = page.getByLabel("Channel message feed")
      .locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]').first();
    const engineer = timeline.locator('[data-conversation-timeline-sub-agent][data-conversation-participant-id="engineer"]');
    const trigger = engineer.locator(".conversation-timeline-sub-agent-head");
    await trigger.click();
    const groupId = await trigger.getAttribute("aria-controls");
    const child = timeline.locator(`[id="${groupId}"]`);
    const fact = child.locator('[data-conversation-timeline-kind="fileChange"]').first();
    const disclosure = fact.locator("button.conversation-timeline-activity-main");
    const title = disclosure.locator("strong");
    const icon = disclosure.locator(":scope > svg");
    await expect(disclosure).toBeVisible();
    await page.mouse.move(0, 0);
    await expectSemanticColor(title, "--conversation-text-muted");
    await expectSemanticColor(icon, "--conversation-text-muted");
    await disclosure.hover();
    await expectSemanticColor(title, "--conversation-text-strong");
    await expectSemanticColor(icon, "--conversation-text-strong");
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await disclosure.focus();
    await expect(disclosure).toBeFocused();
    await expectSemanticColor(title, "--conversation-text-strong");
    await expectSemanticColor(icon, "--conversation-text-strong");
    const wasExpanded = await disclosure.getAttribute("aria-expanded");
    await disclosure.press("Enter");
    await expect(disclosure).toHaveAttribute("aria-expanded", wasExpanded === "true" ? "false" : "true");
  });

  test(`transcript preserves quoted text and code colors in ${theme}`, async ({ page }) => {
    await openTranscript(page, theme, "正文结论。\n\n> 引用原文。\n>\n> - 引用条目。\n\n```text\nconst value = 1;\n```");
    const message = page.locator('.conversation-timeline-message.agentMessage').filter({ hasText: "正文结论。" });
    await expectSemanticColor(message.locator('.message-body-paragraph').filter({ hasText: /^正文结论。$/u }), "--conversation-text-strong");
    await expectSemanticColor(message.locator('.message-body-quote .message-body-paragraph').first(), "--conversation-text-soft");
    await expectSemanticColor(message.locator('.message-body-quote .message-body-list'), "--conversation-text-soft");
    await expect(message.locator(".message-code-block")).toContainText("const value = 1;");
  });
}

async function openUserTranscript(page: Page, theme: "light" | "dark", surface: "normal" | "private" | "channel"): Promise<void> {
  await selectTheme(page, theme);
  const state = createBaseState({ approvalStatus: "expired" });
  const markdown = "用户正文颜色。包含 `user_token`。\n\n- 用户正文条目。\n\n> 用户引用原文。\n>\n> - 用户引用条目。\n\n```text\nconst userValue = 1;\n```";
  const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
  const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
  if (surface === "normal") {
    state.turns = state.turns.map((turn) => ({ ...turn, userInstruction: markdown }));
  } else if (surface === "private") {
    state.teammateDirectMessages = state.teammateDirectMessages.map((message) => isRecord(message) && message.authorType === "local-user"
      ? { ...message, body: markdown }
      : message);
    state.conversationItems = state.conversationItems?.map((item) => item.kind === "user_message"
      ? { ...item, payload: { ...item.payload, body: markdown, format: "markdown" } }
      : item);
  } else {
    const { threadId } = installChannelWorkCellFixture(state, "user-message-colors");
    state.channelMessages = state.channelMessages.map((message) => isRecord(message) && message.threadId === threadId && message.authorType === "local-user"
      ? { ...message, body: markdown }
      : message);
  }
  const command = state.executionActions[0];
  if (!command?.commandEvidence) throw new Error("User color fixture requires Host command evidence");
  state.executionActions = [command];
  state.terminalReports = [];
  state.conversationItems = state.conversationItems?.filter((item) => item.kind !== "terminal_report");
  await mockDaemon(page, state);
  await page.goto("/");
  if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
  if (surface === "channel") await openEngineeringChannel(page);
}

async function openTranscript(page: Page, theme: "light" | "dark", markdown?: string): Promise<void> {
  await selectTheme(page, theme);
  await page.addInitScript(() => localStorage.setItem("ling-stack.workCellDemo", "true"));
  const state = createBaseState({ approvalStatus: "expired" });
  if (markdown) state.channelMessages.push({
    id: "color-quote-reply", workspaceId: "workspace_default", channelId: "channel_engineering",
    kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", authorId: "ling_agent",
    body: markdown, mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready",
    createdAt: "2026-09-06T06:00:00.000Z", updatedAt: "2026-09-06T06:00:00.000Z",
  });
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);
}

async function selectTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.addInitScript((selectedTheme) => {
    const selection = { mode: "fixed", themeId: `ling-${selectedTheme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", selectedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", selectedTheme);
  }, theme);
}

async function expectSemanticColor(locator: Locator, token: string): Promise<void> {
  await expect.poll(() => locator.evaluate((element, name) => {
    if (!element.isConnected) return "detached";
    const style = getComputedStyle(element);
    const tokenValue = style.getPropertyValue(name).trim();
    if (!tokenValue) return `missing token: ${name}`;
    // A live refresh can replace a React-owned paragraph. Resolve its scoped
    // token without inserting a probe into the reconciled message subtree.
    const probe = document.createElement("span");
    probe.style.color = tokenValue;
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    const actual = style.color;
    return actual === expected ? "match" : `${actual} != ${expected}`;
  }, token)).toBe("match");
}

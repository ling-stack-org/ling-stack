import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { attachCommittedChannelReportItem, completedTerminalReport, installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";

// Display fixtures test the real shared renderer, not a model or packaged run.
for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} exposes one final result copy outside evidence disclosure`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("ling-stack.locale", "en-US");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => {
          (globalThis as typeof globalThis & { __resultCopy?: string }).__resultCopy = text;
        } },
      });
    });
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") await page.addInitScript(() => localStorage.setItem("ling-stack.workCellDemo", "true"));
    await mockDaemon(page, state);
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);

    const anchor = page.locator('.conversation-timeline-focus-block[data-feed-item-kind="terminalReport"]').first();
    await expect(anchor).toBeVisible();
    const result = anchor.locator("[data-conversation-terminal-response]");
    const responseId = await anchor.getAttribute("data-conversation-response-id");
    expect(responseId).toBeTruthy();
    const rows = page.locator(`.conversation-timeline-focus-block[data-conversation-response-id=${JSON.stringify(responseId)}]`);
    const footer = rows.locator("[data-conversation-response-footer]");
    await expect(footer).toHaveCount(1);
    await expect(rows.locator(".message-action-bar")).toHaveCount(1);
    await expect(result.locator(".message-action-bar")).toHaveCount(0);
    const narration = rows.locator('[data-conversation-timeline-message][data-conversation-timeline-kind="agentMessage"]');
    const narrationText = (await narration.locator(".message-body-renderer").allTextContents()).join("\n\n").trim();
    const summary = result.locator(".conversation-timeline-result-summary");
    if (narrationText) await expect(summary).toHaveCount(0);
    else await expect(summary).toBeVisible();
    const toggle = result.locator("button.conversation-timeline-activity-main");
    const hasEvidenceDisclosure = await toggle.count() > 0;
    if (hasEvidenceDisclosure) await expect(toggle).toHaveAttribute("aria-expanded", "false");
    else if (await result.count()) await expect(result.locator(".conversation-timeline-activity-main.static")).toHaveCount(1);
    const copy = footer.getByRole("button", { name: "Copy message", exact: true });
    const actions = footer.locator(".message-action-bar");
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await anchor.screenshot({ path: testInfo.outputPath(`fixture-${surface}-copy-hidden.png`) });
    // Hover the response body, not the footer: they share one display owner.
    await (narrationText ? narration.first() : result).hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await anchor.screenshot({ path: testInfo.outputPath(`fixture-${surface}-copy-hover.png`) });
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await copy.focus();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(copy).toBeVisible();
    await expect(copy).toHaveCount(1);
    await copy.click();
    const collapsedCopy = await page.evaluate(() => (globalThis as typeof globalThis & { __resultCopy?: string }).__resultCopy);
    expect(collapsedCopy).toContain(narrationText || (await summary.innerText()).trim());
    if (hasEvidenceDisclosure) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    await expect(rows.locator("[data-conversation-response-footer]")).toHaveCount(1);
    await expect(rows.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
    await copy.click();
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __resultCopy?: string }).__resultCopy)).toBe(collapsedCopy);
    await page.screenshot({ path: testInfo.outputPath(`fixture-${surface}-final-result-copy.png`) });
  });
}

test.describe('touch result actions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('keeps copy discoverable without hover', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('ling-stack.locale', 'en-US');
      localStorage.setItem('ling-stack.workCellDemo', 'true');
    });
    await mockDaemon(page, createBaseState({ approvalStatus: 'expired' }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Channels', exact: true }).click();
    await openEngineeringChannel(page);
    const actions = page.locator('[data-conversation-response-footer] .message-action-bar').first();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(actions.getByRole('button', { name: 'Copy message', exact: true })).toBeVisible();
  });
});

const fileSummaryCases = (["normal", "private", "channel"] as const).flatMap((surface) =>
  (["en-US", "zh-CN"] as const).map((locale) => ({ surface, locale })));

for (const { surface, locale } of fileSummaryCases) {
  test(`${surface} ${locale} settled response shows a bounded file summary outside report disclosure`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem("ling-stack.locale", value), locale);
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") {
      const { threadId, runId } = installChannelWorkCellFixture(state, "final-file-summary");
      const turnId = state.turnRunLinks.find((link) => link.runId === runId)?.turnId;
      if (!turnId) throw new Error("File summary fixture requires its owning TurnRun link");
      const report = { ...completedTerminalReport({ id: "report_channel_final_files", threadId, turnId, runId, title: "Files updated" }), channelId: "channel_engineering" };
      state.terminalReports = [report];
      attachCommittedChannelReportItem(state, report);
    }
    state.terminalReports = state.terminalReports.map((report) => ({ ...report, changes: Array.from({ length: 5 }, (_, index) => ({
      id: `change-${index}`, kind: "code" as const, title: `Updated file ${index}`, summary: "Applied change.",
      paths: [`src/file-${index}.ts`], sourceRefs: [],
    })) }));
    await mockDaemon(page, state);
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+|打开最近对话 \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);
    const files = page.locator("[data-conversation-response-files]");
    await expect(files).toHaveCount(1);
    await expect(files).toContainText(locale === "zh-CN" ? "已编辑 5 个文件" : "Edited 5 files");
    await expect(files.locator(".conversation-response-file")).toHaveCount(3);
    await expect(files.locator(".conversation-response-file-stats")).toHaveCount(0);
    await expect(page.locator("[data-conversation-terminal-response] [data-conversation-response-files]")).toHaveCount(0);
    const more = files.getByRole("button", { name: locale === "zh-CN" ? "文件 +2" : "Files +2", exact: true });
    await more.click();
    await expect(files.locator(".conversation-response-file")).toHaveCount(5);
    await expect(files.locator(".conversation-timeline-file-ref").first()).toHaveAttribute("title", "src/file-0.ts");
    await files.getByRole("button", { name: locale === "zh-CN" ? "收起" : "Collapse", exact: true }).click();
    await expect(files.locator(".conversation-response-file")).toHaveCount(3);
    await files.screenshot({ path: testInfo.outputPath(`fixture-${surface}-${locale}-edited-files.png`) });
  });
}

test("channel child responses finish after their operations without copying another run or parent", async ({ page }, testInfo) => {
  const appErrors: string[] = [];
  page.on("pageerror", (error) => appErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") appErrors.push(`${message.location().url}: ${message.text()}`); });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.workCellDemo", "true");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { Reflect.set(globalThis, "__nestedResponseCopy", text); } },
    });
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "ling_agent", templateId: "ling_agent", kind: "system_teammate", systemRole: "ling_agent", roleKey: "custom", displayName: "Ling Agent" }),
    ...(["architect", "designer", "engineer", "qa"] as const).map((roleKey) => createMockTeammate({
      id: `teammate_builtin_${roleKey}`, templateId: roleKey, roleKey, displayName: `Ling ${roleKey}`,
    })),
  ];
  await mockDaemon(page, state);
  // Display-only demo mutations have no persisted recovery provenance. Model
  // that read-only endpoint explicitly; never grant an executable Undo here.
  await page.route(/\/(?:runs\/demo_work_cell_channel_engineering_run_engineer(?:_followup)?|turns\/conversation-turn%3Ademo_work_cell_channel_engineering_message_request|workflows\/demo_work_cell_channel_engineering_workflow)\/workspace-changes(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") { await route.fallback(); return; }
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split("/")[2]!);
    await route.fulfill({ status: 200, json: {
      cwd: url.searchParams.get("cwd"), state: "unavailable", canUndo: false, canReapply: false,
      files: [], summary: { fileCount: 0, addCount: 0, updateCount: 0, deleteCount: 0, moveCount: 0, addedLines: 0, removedLines: 0 },
      unavailableReason: "Display fixture has no persisted mutation provenance", updatedAt: "2026-07-10T09:15:00.000Z",
      ...(url.pathname.startsWith("/workflows/") ? { workflowId: id, runIds: [] } : url.pathname.startsWith("/runs/") ? { runId: id } : {
        turnId: id, threadId: "conversation-thread:channel:channel_engineering", runIds: [], provenanceComplete: false,
      }),
    } });
  });
  await page.goto("/");
  await openEngineeringChannel(page);
  const timeline = page.locator('[data-conversation-timeline-scope="channel_root"]');
  await expect(timeline).toHaveCount(1);
  const child = timeline.locator('[data-conversation-timeline-kind="subAgentActivity"][data-conversation-participant-id="engineer"]');
  await expect(child).toHaveCount(1);
  const toggle = child.locator(".conversation-timeline-sub-agent-head");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const groupId = await toggle.getAttribute("aria-controls");
  expect(groupId).toBeTruthy();
  const detail = timeline.locator(`[id=${JSON.stringify(groupId)}]`);
  await expect(detail).toHaveAttribute("data-conversation-timeline-scope", "child");
  await expect(detail.locator("[data-conversation-timeline]")).toHaveCount(0);
  // Engineer has two independent Runs in this fixture. The child header owns
  // its identity; generated action narration has no ChannelMessage avatar.
  const firstNarration = detail.locator('[data-conversation-timeline-kind="agentMessage"]').filter({ hasText: "先把 agent 内部工作流拆成可扫描的步骤" });
  await expect(firstNarration).toBeVisible();
  await expect(detail.locator('[data-conversation-timeline-kind="agentMessage"] img.teammate-avatar-image')).toHaveCount(0);
  const firstResponseId = await firstNarration.locator("..").getAttribute("data-conversation-response-id");
  expect(firstResponseId).toBeTruthy();
  const firstRows = detail.locator(`.conversation-timeline-focus-block[data-conversation-response-id=${JSON.stringify(firstResponseId)}]`);
  const childFooter = firstRows.locator("[data-conversation-response-footer]");
  await expect(childFooter).toHaveCount(1);
  await expect(firstRows.last().locator("[data-conversation-response-footer]")).toHaveCount(1);
  await expect(firstRows.last().locator("[data-conversation-response-files]")).toContainText("Edited 2 files");
  await expect(firstRows.locator('[data-conversation-workspace-recovery="run"] button')).toBeDisabled();
  await expect(detail.locator("[data-conversation-response-footer]")).toHaveCount(2);
  await expect(detail.locator("[data-conversation-response-files]")).toHaveCount(2);
  await page.mouse.move(0, 0);
  await expect(childFooter.locator(".message-action-bar")).toHaveCSS("opacity", "0");
  await firstNarration.hover();
  await expect(childFooter.locator(".message-action-bar")).toHaveCSS("opacity", "1");
  await childFooter.getByRole("button", { name: "Copy message", exact: true }).click();
  const childCopy = await page.evaluate(() => Reflect.get(globalThis, "__nestedResponseCopy") as string);
  expect(childCopy).toContain("先把 agent 内部工作流拆成可扫描的步骤");
  expect(childCopy).toContain("然后收紧视觉噪音");
  expect(childCopy).not.toContain("多 Agent 操作记录已接入频道会话");
  expect(childCopy).not.toContain("主要任务：把多 agent 操作记录接入频道会话");
  expect(childCopy).not.toContain("最后把第二轮收口保留在新的时间位置");

  const followupNarration = detail.locator('[data-conversation-timeline-kind="agentMessage"]').filter({ hasText: "最后把第二轮收口保留在新的时间位置" });
  const followupResponseId = await followupNarration.locator("..").getAttribute("data-conversation-response-id");
  expect(followupResponseId).toBeTruthy();
  expect(followupResponseId).not.toBe(firstResponseId);
  const followupRows = detail.locator(`.conversation-timeline-focus-block[data-conversation-response-id=${JSON.stringify(followupResponseId)}]`);
  await expect(followupRows.last().locator("[data-conversation-response-footer]")).toHaveCount(1);
  await expect(followupRows.locator("[data-conversation-response-files]")).toContainText("Edited 1 file");
  const batchToggle = followupRows.locator("button.conversation-command-batch-header");
  await expect(batchToggle).toHaveAccessibleName("Ran 3 commands. Expand command batch");
  await batchToggle.click();
  await expect(batchToggle).toHaveAttribute("aria-expanded", "true");
  await expect(followupRows.locator("[data-conversation-response-footer]")).toHaveCount(1);
  await expect(followupRows.last().locator("[data-conversation-response-footer]")).toHaveCount(1);
  const followupFooter = followupRows.locator("[data-conversation-response-footer]");
  await followupFooter.getByRole("button", { name: "Copy message", exact: true }).focus();
  await followupFooter.getByRole("button", { name: "Copy message", exact: true }).click();
  const followupCopy = await page.evaluate(() => Reflect.get(globalThis, "__nestedResponseCopy") as string);
  expect(followupCopy).toContain("最后把第二轮收口保留在新的时间位置");
  expect(followupCopy).not.toContain("先把 agent 内部工作流拆成可扫描的步骤");
  expect(followupCopy).not.toContain("多 Agent 操作记录已接入频道会话");
  expect(followupCopy).not.toContain("主要任务：把多 agent 操作记录接入频道会话");
  await batchToggle.click();
  await expect(batchToggle).toHaveAttribute("aria-expanded", "false");
  await expect(followupRows.last().locator("[data-conversation-response-footer]")).toHaveCount(1);

  const rootNarration = timeline.locator('[data-conversation-timeline-kind="agentMessage"]').filter({ hasText: "主要任务：把多 agent 操作记录接入频道会话" });
  await expect(rootNarration).toHaveCount(1);
  const rootResponseId = await rootNarration.locator("..").getAttribute("data-conversation-response-id");
  expect(rootResponseId).toBeTruthy();
  const rootRows = timeline.locator(`.conversation-timeline-focus-block[data-conversation-timeline-depth="0"][data-conversation-response-id=${JSON.stringify(rootResponseId)}]`);
  const rootFooter = rootRows.locator("[data-conversation-response-footer]");
  await expect(rootFooter).toHaveCount(1);
  const rootCopyButton = rootFooter.getByRole("button", { name: "Copy message", exact: true });
  await rootCopyButton.focus();
  await rootCopyButton.click();
  const rootCopy = await page.evaluate(() => Reflect.get(globalThis, "__nestedResponseCopy") as string);
  expect(rootCopy).toContain("主要任务：把多 agent 操作记录接入频道会话");
  expect(rootCopy).not.toContain("先把 agent 内部工作流拆成可扫描的步骤");
  expect(rootCopy).not.toContain("最后把第二轮收口保留在新的时间位置");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(appErrors).toEqual([]);
  await detail.screenshot({ path: testInfo.outputPath("simulation-child-response-footer-files.png") });
});

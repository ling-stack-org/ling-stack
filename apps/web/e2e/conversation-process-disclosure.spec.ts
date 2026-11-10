import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { attachCommittedChannelReportItem, completedTerminalReport, installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

// Mock Host facts exercise production adapters/renderers, not packaged model QA.
for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} process disclosure preserves final answer, files and one complete copy`, async ({ page }, info) => {
    await page.addInitScript(() => {
      localStorage.setItem("ling-stack.locale", "en-US");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
        (globalThis as typeof globalThis & { __copiedProcess?: string }).__copiedProcess = text;
      } } });
    });
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") {
      const { runId, threadId } = installChannelWorkCellFixture(state, "process-disclosure");
      const turnId = state.turnRunLinks.find(link => link.runId === runId)!.turnId;
      state.terminalReports = [{ ...completedTerminalReport({ id: "report-process", runId, threadId, turnId, title: "Completed" }), channelId: "channel_engineering" }];
      attachCommittedChannelReportItem(state, state.terminalReports[0]!);
    }
    state.terminalReports = state.terminalReports.map(report => ({ ...report,
      verification: [{ id: "declaration", title: "Tests not requested", status: "not_run", expectation: "informational", sourceRefs: [] }],
      changes: [{ id: "file", kind: "code", title: "Edited file", summary: "Updated", paths: ["src/example.ts"], sourceRefs: [] }],
    }));
    await mockDaemon(page, state);
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);
    const header = page.locator('[data-conversation-process-header]').first();
    await expect(header).toBeVisible();
    await expect(header).toHaveAttribute("data-conversation-process-status", "completed");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-conversation-timeline-kind="commandBatch"]')).toHaveCount(0);
    await expect(page.locator('[data-conversation-response-files]')).toHaveCount(1);
    const footer = page.locator('[data-conversation-response-footer]').first();
    await footer.getByRole("button", { name: "Copy message", exact: true }).focus();
    await footer.getByRole("button", { name: "Copy message", exact: true }).click();
    const closedCopy = await page.evaluate(() => (globalThis as typeof globalThis & { __copiedProcess?: string }).__copiedProcess);
    expect(closedCopy).toBeTruthy();
    await page.screenshot({ path: info.outputPath(`${surface}-process-collapsed.png`) });
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-conversation-timeline-kind="commandBatch"]')).toHaveCount(1);
    await expect(page.locator('[data-conversation-response-footer]')).toHaveCount(1);
    await expect(page.locator('[data-conversation-process-group] [data-conversation-response-files]')).toHaveCount(0);
    await footer.getByRole("button", { name: "Copy message", exact: true }).focus();
    await footer.getByRole("button", { name: "Copy message", exact: true }).click();
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __copiedProcess?: string }).__copiedProcess)).toBe(closedCopy);
    await page.screenshot({ path: info.outputPath(`${surface}-process-expanded.png`) });
  });
}

for (const surface of ["normal", "private", "channel"] as const) {
  for (const locale of ["zh-CN", "en-US"] as const) {
    test(`${surface} process duration uses ${locale} minutes and hours`, async ({ page }, info) => {
      // Browser locale remains en-US: the app's selected locale must own units.
      await page.addInitScript((value) => localStorage.setItem("ling-stack.locale", value), locale);
      const state = createBaseState({ approvalStatus: "expired" });
      const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
      const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
      const channel = surface === "channel" ? installChannelWorkCellFixture(state, "duration") : undefined;
      const runId = channel?.runId ?? state.runs[0]?.id;
      expect(runId).toBeTruthy();
      const applyDuration = (ms: number) => {
        state.runs = state.runs.map(run => run.id === runId ? {
          ...run, endedAt: new Date(Date.parse(run.startedAt!) + ms).toISOString(),
        } : run);
      };
      applyDuration(1_189_300);
      await mockDaemon(page, state);
      const open = async () => {
        await page.goto("/");
        if (title) await page.getByRole("button", { name: /Open recent conversation \d+|打开最近对话 \d+/u }).filter({ hasText: title }).click();
        if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
        if (surface === "channel") await openEngineeringChannel(page);
      };
      await open();
      const header = page.locator('[data-conversation-process-header]').first();
      const minutes = locale === "zh-CN" ? "19分钟49秒" : "19m 49s";
      await expect(header).toContainText(minutes);
      await expect(header).toHaveAccessibleName(new RegExp(minutes));
      await expect(header).not.toContainText("1,189");
      await page.screenshot({ path: info.outputPath(`${surface}-${locale}-minutes.png`) });
      applyDuration(3_661_000);
      await open();
      await expect(header).toContainText(locale === "zh-CN" ? "1小时1分钟1秒" : "1h 1m 1s");
      await page.screenshot({ path: info.outputPath(`${surface}-${locale}-hours.png`) });
    });
  }
}

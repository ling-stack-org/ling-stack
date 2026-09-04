import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  installNormalWorkCellFixture,
  installTeammateWorkCellFixture,
} from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/shared-conversation-work-cell-shell-artifacts/",
  import.meta.url,
));

test("Channel WorkCell keeps terminal report changes, references, and file-path disclosure contained", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    reducedMotion: true,
    workCellDemo: true,
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const timeline = feed.locator('[data-conversation-timeline-depth="0"]').first();
  await expect(timeline).toBeVisible();
  const agentSpans = timeline.locator('[data-conversation-timeline-kind="subAgentActivity"]');
  await expect(agentSpans).toHaveCount(4);
  await expect(timeline.locator('[data-conversation-timeline-kind="diagnostic"]')).toHaveCount(0);
  const terminalReport = timeline.locator('[data-conversation-timeline-kind="terminalReport"]');
  await expect(terminalReport).toBeVisible();
  await terminalReport.locator(".conversation-timeline-activity-main").click();
  const changedSection = terminalReport.locator('[data-terminal-report-section="changes"]');
  const firstChangedEntry = changedSection.locator(".conversation-timeline-terminal-entry").first();
  const changedFileReferences = firstChangedEntry.locator(".conversation-timeline-file-ref");
  await expect(terminalReport).toBeVisible();
  await expect(changedSection).toBeVisible();
  await expect(changedFileReferences).toHaveCount(3);

  const changedFile = changedFileReferences.first();
  const changedFilePath = (await changedFile.getAttribute("title")) ?? "";
  expect(changedFilePath).not.toBe("");
  await captureEvidence(page, "1280x800-ling-dark-channel-terminal-report-file-path.png");

  const composer = page.getByRole("textbox", { name: "Message this channel or @ an AI teammate", exact: true });
  await composer.fill("Please inspect apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await page.locator(".channel-composer").getByRole("button", { name: "Send" }).click();
  await expect.poll(() => state.lastChannelTurnRequest?.fileRefs?.[0]?.path)
    .toBe("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  const references = feed.getByLabel("References").last();
  const fileReference = references.getByRole("button", { name: /WorkspaceClientView\.tsx/u });
  await expect(fileReference).toBeVisible();
  await fileReference.focus();
  const referenceTooltip = references.getByRole("tooltip");
  await expect(referenceTooltip).toBeVisible();
  await expect(referenceTooltip).toContainText("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await captureEvidence(page, "1280x800-ling-dark-channel-reference-focus.png");
  await captureElementEvidence(referenceTooltip, "ling-dark-channel-reference-tooltip-detail.png");
  await fileReference.press("Tab");
  await expect(references.getByRole("tooltip")).toHaveCount(0);

  await expectReducedMotion(page, [timeline, changedSection, changedFile]);
  await expectDocumentContained(page);
  expect(runtimeErrors).toEqual([]);
});

test("Normal conversation renders the shared WorkCell shell without document overflow", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openRecentConversation(page, title);

  const conversation = page.getByLabel("Conversation page");
  const timeline = conversation.locator('[data-conversation-timeline-depth="0"]').first();
  await expect(timeline).toBeVisible();
  const commandBatch = timeline.locator('[data-conversation-timeline-kind="commandBatch"]');
  await expect(commandBatch).toHaveCount(1);
  await expectDocumentContained(page);
  await captureEvidence(page, "1440x960-ling-light-normal-work-cell-shell.png");
  expect(runtimeErrors).toEqual([]);
});

test("Terminal report summaries keep Markdown paragraphs and fenced code", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  if (!state.terminalReports[0]) throw new Error("Normal WorkCell fixture did not create a terminal report.");
  state.terminalReports = state.terminalReports.map((report, index) => index === 0
    ? {
        ...report,
        outcome: {
          ...report.outcome,
          summary: "完成说明：\n\n- 已创建文件\n- 已验证内容\n\n```bash\nnode app.js\n```",
        },
      }
    : report);
  for (const run of state.runs) {
    if (run.threadId === "thread_ui2_normal_work_cell") state.eventsByRun[run.id] = [];
  }
  await mockDaemon(page, state);

  await page.goto("/");
  await openRecentConversation(page, title);

  const report = page.getByLabel("Conversation page").locator('[data-conversation-timeline-kind="terminalReport"]');
  await expect(report).toBeVisible();
  await report.locator(".conversation-timeline-activity-main").click();
  const reportDetail = report.locator(".conversation-timeline-terminal-report");
  await expect(reportDetail.locator(".message-body-paragraph")).toHaveCount(3);
  await expect(reportDetail.locator(".message-body-list")).toHaveCount(1);
  await expect(reportDetail.locator(".message-code-block")).toHaveCount(1);
  await expect(reportDetail.locator(".message-code-block")).toContainText("node app.js");
  expect(runtimeErrors).toEqual([]);
});

test("WorkCell command evidence preserves multiline output formatting", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, reducedMotion: true });
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  const firstAction = state.executionActions.find((action) => action.id.includes("typecheck"));
  if (!firstAction?.commandEvidence) throw new Error("Normal WorkCell fixture did not create command evidence.");
  state.executionActions = state.executionActions.map((action) => action.id.includes("typecheck")
    ? {
        ...action,
        commandEvidence: {
          ...firstAction.commandEvidence,
          outputTail: [{
            ...firstAction.commandEvidence.outputTail[0],
            text: "first output line\nsecond output line\nthird output line\n",
          }],
          outputLineCount: 3,
        },
      }
    : action);
  await mockDaemon(page, state);

  await page.goto("/");
  await openRecentConversation(page, title);

  const timeline = page.getByLabel("Conversation page").locator('[data-conversation-timeline-depth="0"]').first();
  const commandBatch = timeline.locator('[data-conversation-timeline-kind="commandBatch"]');
  await commandBatch.locator(".conversation-command-batch-header").click();
  const commandRow = commandBatch.locator('[data-conversation-timeline-kind="commandExecution"][data-conversation-timeline-id="action:execution_action_typecheck_normal"]');
  await expect(commandRow).toHaveCount(1);
  await commandRow.locator(".conversation-timeline-activity-main").click();
  const output = timeline.locator(".conversation-timeline-output").filter({ hasText: "first output line" }).first();
  await expect(output).toBeVisible();
  await expect(output).toHaveCSS("white-space", "pre-wrap");
  expect(await output.textContent()).toBe("first output line\nsecond output line\nthird output line\n");
  expect(await output.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("SFMono-Regular");
});

test("Teammate conversation renders the shared WorkCell shell in reduced motion", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    reducedMotion: true,
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammate = installTeammateWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await page.getByRole("button", { name: teammate.displayName, exact: true }).click();

  const feed = page.getByLabel("Private message feed", { exact: true });
  const timeline = feed.locator('[data-conversation-timeline-depth="0"]').first();
  await expect(timeline).toBeVisible();
  const commandBatch = timeline.locator('[data-conversation-timeline-kind="commandBatch"]');
  await expect(commandBatch).toHaveCount(1);
  await expectReducedMotion(page, [timeline, commandBatch]);
  await expectDocumentContained(page);
  await captureEvidence(page, "1280x800-ling-dark-teammate-work-cell-shell.png");
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(page: Page, input: {
  readonly theme: "light" | "dark";
  readonly width: number;
  readonly height: number;
  readonly reducedMotion?: boolean;
  readonly workCellDemo?: boolean;
}): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ reducedMotion: input.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript(({ theme, workCellDemo }) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
    if (workCellDemo) localStorage.setItem("ling-stack.workCellDemo", "true");
  }, { theme: input.theme, workCellDemo: input.workCellDemo });
}

async function openRecentConversation(page: Page, title: string): Promise<void> {
  await page
    .getByRole("button", { name: /Open recent conversation \d+/u })
    .filter({ hasText: title })
    .click();
}

async function expectReducedMotion(page: Page, locators: readonly Locator[]): Promise<void> {
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  for (const locator of locators) {
    const activeAnimations = await locator.evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        duration: style.animationDuration,
        name: style.animationName,
      };
    }).filter((entry) => entry.name !== "none" && entry.duration !== "0s"));
    expect(activeAnimations).toEqual([]);
  }
}

async function expectDocumentContained(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
  });
}

async function captureElementEvidence(locator: Locator, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await locator.screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
}

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  installActiveChannelWorkCellFixture,
  installChannelWorkCellFixture,
  installExplorationWorkCellFixture,
  installNormalWorkCellFixture,
  installTeammateWorkCellFixture,
} from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/shared-conversation-work-cell-activity/",
  import.meta.url,
));

test("Channel multi-agent Activity keeps rows and command batches keyboard-operable", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, workCellDemo: true });
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator('.conversation-work-cell[data-operation-source="workflow"]').first();
  await expect(workCell).toBeVisible();
  await expect(workCell.locator("[data-conversation-timeline-sub-agent]")).toHaveCount(4);

  const engineer = workCell.locator('[data-conversation-timeline-sub-agent][data-agent-participant-id="engineer"]');
  const editRow = engineer.locator('[data-conversation-timeline-kind="fileChange"]').filter({ hasText: /ConversationWorkCell\.tsx/u });
  const editTrigger = editRow.locator(".conversation-timeline-activity-main");
  await editTrigger.focus();
  await editTrigger.press("Space");
  await expect(editTrigger).toHaveAttribute("aria-expanded", "true");

  const batch = engineer.locator(".conversation-command-batch");
  const batchTrigger = batch.locator(".conversation-command-batch-header");
  await batchTrigger.focus();
  await batchTrigger.press("Space");
  await expect(batchTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(batch.locator('.conversation-command-batch-list [data-conversation-timeline-kind="commandExecution"]')).toHaveCount(3);
  await expectWorkCellMotionTokens(workCell);
  await batchTrigger.click();
  await batchTrigger.click();
  await expect(batchTrigger).toHaveAttribute("aria-expanded", "true");
  await expectContained(page, [feed, workCell, engineer, batch]);
  await captureEvidence(page, "1440x960-ling-light-channel-activity-active.png");
  expect(runtimeErrors).toEqual([]);
});

test("Active WorkCell shimmer pauses offscreen and resumes when visible", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId } = installActiveChannelWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(`.conversation-work-cell.active[data-thread-id="${threadId}"]`);
  await expect(workCell).toBeVisible();

  const runningRow = workCell.locator('.conversation-timeline-activity[data-conversation-timeline-kind="commandExecution"].status-running').first();
  await expect(runningRow).toBeVisible();
  const runningIcon = runningRow.locator(".conversation-timeline-activity-main > svg").first();
  await expect(runningIcon).toBeVisible();
  await expect(workCell).toHaveAttribute("data-work-cell-activity", "running");
  await expectAnimationName(runningIcon, "conversation-active-spin");

  const originalTransform = await feed.evaluate((element) => element.style.transform);
  await feed.evaluate((element) => { element.style.transform = "translateY(200vh)"; });
  await expect(workCell).not.toBeInViewport();
  await expect(workCell).toHaveAttribute("data-work-cell-activity", "paused");
  await expectAnimationName(runningIcon, "none");

  await feed.evaluate((element, transform) => { element.style.transform = transform; }, originalTransform);
  await workCell.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-work-cell-activity", "running");
  await expectAnimationName(runningIcon, "conversation-active-spin");
});

test("Channel Details exposes loading, loaded evidence, and one cached request", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId } = installChannelWorkCellFixture(state, "loaded");
  await mockDaemon(page, state);
  let evidenceRequests = 0;
  await page.route(new RegExp(`/threads/${threadId}/evidence(?:\\?.*)?$`, "u"), async (route) => {
    evidenceRequests += 1;
    await wait(240);
    await route.fallback();
  });

  await page.goto("/");
  await openEngineeringChannel(page);
  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(`.conversation-work-cell[data-thread-id="${threadId}"]`);
  await expect(workCell).toBeVisible();

  const evidenceTrigger = workCell.locator(".conversation-work-cell-evidence-summary");
  await evidenceTrigger.focus();
  await evidenceTrigger.press("Enter");
  await expect(workCell.locator(".conversation-work-cell-details-state")).toContainText("Loading details");
  await expect(workCell.locator(".conversation-work-cell-details")).toContainText("corepack pnpm --filter @ling-stack/web typecheck");
  expect(evidenceRequests).toBe(1);

  await evidenceTrigger.click();
  await expect(evidenceTrigger).toHaveAttribute("aria-expanded", "false");
  await evidenceTrigger.click();
  await expect(evidenceTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(workCell.locator(".conversation-work-cell-details")).toContainText("corepack pnpm --filter @ling-stack/web typecheck");
  expect(evidenceRequests).toBe(1);
  await expectContained(page, [feed, workCell, workCell.locator(".conversation-work-cell-details")]);
  await captureEvidence(page, "1440x960-ling-light-channel-details-loaded.png");
  expect(runtimeErrors).toEqual([]);
});

test("Channel Details error retries by keyboard and disables WorkCell motion", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId } = installChannelWorkCellFixture(state, "retry");
  await mockDaemon(page, state);
  let evidenceRequests = 0;
  await page.route(new RegExp(`/threads/${threadId}/evidence(?:\\?.*)?$`, "u"), async (route) => {
    evidenceRequests += 1;
    if (evidenceRequests === 1) {
      await route.fulfill({
        status: 503,
        json: { error: "focused_evidence_unavailable", message: "Focused evidence is temporarily unavailable." },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await openEngineeringChannel(page);
  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(`.conversation-work-cell[data-thread-id="${threadId}"]`);
  await expect(workCell).toBeVisible();

  const evidenceTrigger = workCell.locator(".conversation-work-cell-evidence-summary");
  await evidenceTrigger.focus();
  await evidenceTrigger.press("Space");
  const failure = workCell.locator(".conversation-work-cell-details-state.failed");
  await expect(failure).toContainText("Focused evidence is temporarily unavailable");
  await captureEvidence(page, "1280x800-ling-dark-channel-details-error.png");

  const retry = failure.getByRole("button", { name: "Retry evidence" });
  await retry.focus();
  await retry.press("Enter");
  await expect(workCell.locator(".conversation-work-cell-details")).toContainText("corepack pnpm --filter @ling-stack/web typecheck");
  expect(evidenceRequests).toBe(2);

  const batch = workCell.locator(".conversation-command-batch").first();
  const batchTrigger = batch.locator(".conversation-command-batch-header");
  await batchTrigger.focus();
  await batchTrigger.press("Space");
  await expect(batchTrigger).toHaveAttribute("aria-expanded", "true");
  await expectWorkCellMotionDisabled(workCell);
  await expectContained(page, [feed, workCell, batch]);
  await captureEvidence(page, "1280x800-ling-dark-channel-command-batch-expanded.png");
  expect(runtimeErrors).toEqual([]);
});

test("Normal conversation keeps the completed command batch in the shared WorkCell", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").locator(".sidebar-recent-row").filter({ hasText: title }).click();
  const conversation = page.getByLabel("Conversation page");
  const workCell = conversation.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expect(workCell).toHaveAttribute("data-work-cell-activity", "paused");
  await expectCommandBatchKeyboardFlow(workCell);
  await expectNoWorkCellShimmer(workCell);
  await expectContained(page, [conversation, workCell]);
  await captureEvidence(page, "1440x960-ling-light-normal-work-cell.png");
  expect(runtimeErrors).toEqual([]);
});

test("Completed WorkCell collapses adjacent read actions into an expandable exploration batch", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId } = installExplorationWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(`.conversation-work-cell[data-thread-id="${threadId}"]`);
  await expect(workCell).toBeVisible();
  await expect(workCell.getByRole("button", { name: "Read 3 items. Expand read records" })).toBeVisible();

  const batch = workCell.locator(".conversation-exploration-batch");
  const trigger = batch.locator(".conversation-exploration-batch-header");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.focus();
  await trigger.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(batch.locator('.conversation-exploration-batch-list [data-conversation-timeline-kind="exploration"]')).toHaveCount(3);
  await expectContained(page, [feed, workCell, batch]);
  expect(runtimeErrors).toEqual([]);
});

test("Dense exploration activity stays scrollable after ten atomic rows", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 600 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId } = installExplorationWorkCellFixture(state, 11);
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const workCell = feed.locator(`.conversation-work-cell[data-thread-id="${threadId}"]`);
  await expect(workCell).toBeVisible();
  await expect(workCell.getByRole("button", { name: "Read 11 items. Expand read records" })).toBeVisible();

  const stream = workCell.locator('[data-conversation-work-stream="primary"]');
  await expect(stream).toHaveAttribute("data-activity-density", "dense");
  await expect(stream).toHaveCSS("overflow-y", "auto");
  await expect.poll(() => stream.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))).toEqual(expect.objectContaining({
    scrollHeight: expect.any(Number),
  }));
  const dimensions = await stream.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  const batch = workCell.locator(".conversation-exploration-batch");
  const trigger = batch.locator(".conversation-exploration-batch-header");
  await trigger.focus();
  await trigger.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(batch.locator('.conversation-exploration-batch-list [data-conversation-timeline-kind="exploration"]')).toHaveCount(11);
  await expectContained(page, [feed, workCell, stream, batch]);
  expect(runtimeErrors).toEqual([]);
});

test("Teammate conversation keeps command activity contained in dark reduced motion", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammate = installTeammateWorkCellFixture(state);
  await mockDaemon(page, state);

  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammate.displayName }).click();
  const feed = page.getByLabel("Private message feed", { exact: true });
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expectCommandBatchKeyboardFlow(workCell);
  await expectWorkCellMotionDisabled(workCell);
  await expectContained(page, [feed, workCell]);
  await captureEvidence(page, "1280x800-ling-dark-teammate-work-cell.png");
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

async function expectCommandBatchKeyboardFlow(workCell: Locator): Promise<void> {
  const batch = workCell.locator(".conversation-command-batch");
  const trigger = batch.locator(".conversation-command-batch-header");
  await expect(batch).toHaveCount(1);
  await trigger.focus();
  await trigger.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(batch.locator('.conversation-command-batch-list [data-conversation-timeline-kind="commandExecution"]')).toHaveCount(3);

  const firstCommand = batch.locator('[data-conversation-timeline-kind="commandExecution"]').first();
  const firstCommandTrigger = firstCommand.locator(".conversation-timeline-activity-main");
  const firstCommandTitle = (await firstCommand.locator(".conversation-timeline-activity-copy strong").innerText()).trim();
  await firstCommandTrigger.focus();
  await firstCommandTrigger.press("Space");
  await expect(firstCommandTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(firstCommand.locator(".conversation-timeline-activity-detail")).toContainText(firstCommandTitle);
  await expect(firstCommand.locator(".conversation-timeline-activity-detail")).toContainText("exit 0");
}

async function expectWorkCellMotionDisabled(workCell: Locator): Promise<void> {
  await expect.poll(() => workCell.page().evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const animated = await workCell.evaluate((root) => [
    root,
    ...root.querySelectorAll<HTMLElement>([
      ".conversation-timeline-activity",
      ".conversation-command-batch",
      ".conversation-timeline-sub-agent",
      ".conversation-timeline-activity.status-running .conversation-timeline-activity-main > svg",
      ".conversation-work-cell-evidence-summary span",
    ].join(", ")),
  ].map((element) => ({
    duration: getComputedStyle(element).animationDuration,
    name: getComputedStyle(element).animationName,
  })).filter((entry) => entry.name !== "none" && entry.duration !== "0s"));
  expect(animated).toEqual([]);
  const transitioning = await workCell.evaluate((root) => [
    ...root.querySelectorAll<HTMLElement>([
      ".conversation-timeline-activity-chevron",
      ".conversation-command-batch-toggle",
      ".conversation-command-batch-toggle svg",
    ].join(", ")),
  ].map((element) => getComputedStyle(element).transitionDuration)
    .filter((duration) => duration.split(",").some((part) => part.trim() !== "0s")));
  expect(transitioning).toEqual([]);
}

async function expectWorkCellMotionTokens(workCell: Locator): Promise<void> {
  const durations = await workCell.evaluate((root) => [
    ...root.querySelectorAll<HTMLElement>([
      ".conversation-timeline-activity-chevron",
      ".conversation-command-batch-toggle",
      ".conversation-command-batch-toggle svg",
    ].join(", ")),
  ].map((element) => getComputedStyle(element).transitionDuration));
  expect(durations.length).toBeGreaterThan(0);
  expect(durations.every((duration) => duration.split(",").some((part) => part.trim() !== "0s"))).toBe(true);
}

async function expectAnimationName(element: Locator, expected: string): Promise<void> {
  await expect.poll(() => element.evaluate((node) => getComputedStyle(node).animationName)).toBe(expected);
}

async function expectNoWorkCellShimmer(workCell: Locator): Promise<void> {
  const animationNames = await workCell.locator([
    ".conversation-timeline-activity.status-running .conversation-timeline-activity-main > svg",
    ".conversation-work-cell-evidence-summary span",
  ].join(", ")).evaluateAll((elements) => elements.map((element) => getComputedStyle(element).animationName));
  expect(animationNames.every((name) => name === "none")).toBe(true);
}

async function expectContained(page: Page, elements: readonly Locator[]): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  for (const element of elements) {
    await expect.poll(() => element.evaluate((node) => node.scrollWidth - node.clientWidth))
      .toBeLessThanOrEqual(1);
  }
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

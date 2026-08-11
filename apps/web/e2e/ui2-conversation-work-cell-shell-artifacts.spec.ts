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

test("Channel WorkCell keeps artifacts, changed files, references, and hover preview contained", async ({ page }) => {
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
  const transcript = feed
    .locator('.conversation-turn-assistant-row:has(.conversation-work-cell[data-operation-source="workflow"])')
    .first();
  const workCell = transcript.locator('.conversation-work-cell[data-operation-source="workflow"]').first();
  await expect(workCell).toBeVisible();
  await expandOperationShell(workCell);
  await expectShellMotionDisabled(workCell);

  const artifactSurface = transcript.locator(".conversation-turn-artifacts");
  const artifactRows = artifactSurface.locator(".conversation-work-cell-artifact-row");
  const changedGroup = artifactSurface.locator(".conversation-work-cell-change-group");
  await expect(artifactSurface).toBeVisible();
  await expect(artifactRows).toHaveCount(2);
  await expect(changedGroup).toBeVisible();

  const referenceTrigger = workCell.locator(".conversation-work-cell-evidence-summary");
  await expect(referenceTrigger).toHaveAttribute("aria-expanded", "false");
  await referenceTrigger.focus();
  await referenceTrigger.press("Enter");
  await expect(referenceTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(workCell.locator(".conversation-work-cell-evidence-links > *")).not.toHaveCount(0);

  const changedFile = changedGroup.locator(".conversation-work-cell-change-file").first();
  const changedFileLabel = (await changedFile.locator("code").innerText()).trim();
  await page.mouse.move(0, 0);
  await changedFile.hover();
  const hoverPreview = page.locator(".conversation-artifact-hover-preview");
  await expect(hoverPreview).toBeVisible({ timeout: 4_000 });
  await expect(hoverPreview).toContainText(changedFileLabel);
  await expect(hoverPreview.locator(".conversation-artifact-hover-preview-body")).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-channel-artifact-hover.png");

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

  await expectReducedMotion(page, [
    workCell,
    artifactRows.first(),
    changedGroup,
    hoverPreview,
  ]);
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
  await page.getByLabel("Ling Stack navigation").locator(".sidebar-recent-row").filter({ hasText: title }).click();

  const conversation = page.getByLabel("Conversation page");
  const workCell = conversation.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expandOperationShell(workCell);
  await expect(workCell.locator(".conversation-operation-shell")).toBeVisible();
  await expect(workCell.locator(".conversation-command-batch")).toHaveCount(1);
  await expectShellMotionTokens(workCell);
  await expectDocumentContained(page);
  await captureEvidence(page, "1440x960-ling-light-normal-work-cell-shell.png");
  expect(runtimeErrors).toEqual([]);
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
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammate.displayName }).click();

  const feed = page.getByLabel("Private message feed", { exact: true });
  const workCell = feed.locator(".conversation-work-cell");
  await expect(workCell).toBeVisible();
  await expandOperationShell(workCell);
  const commandBatch = workCell.locator(".conversation-command-batch");
  await expect(commandBatch).toHaveCount(1);
  await expectReducedMotion(page, [workCell, commandBatch]);
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

async function expandOperationShell(workCell: Locator): Promise<void> {
  const trigger = workCell.locator(".conversation-operation-shell-head");
  if (await trigger.getAttribute("aria-expanded") === "false") {
    await trigger.focus();
    await trigger.press("Enter");
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
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

async function expectShellMotionDisabled(workCell: Locator): Promise<void> {
  const transitioning = await workCell.evaluate((root) => [
    ...root.querySelectorAll<HTMLElement>([
      ".conversation-operation-shell-toggle svg",
      ".conversation-work-cell-evidence-summary svg",
      ".conversation-work-cell-artifact-strip svg",
      ".conversation-work-cell-change-more svg",
    ].join(", ")),
  ].map((element) => getComputedStyle(element).transitionDuration)
    .filter((duration) => duration.split(",").some((part) => part.trim() !== "0s")));
  expect(transitioning).toEqual([]);
}

async function expectShellMotionTokens(workCell: Locator): Promise<void> {
  const durations = await workCell.evaluate((root) => {
    const evidenceToggle = root.querySelector<SVGElement>(".conversation-work-cell-evidence-summary svg");
    return {
      shellToggle: getComputedStyle(root.querySelector<SVGElement>(".conversation-operation-shell-toggle svg")!).transitionDuration,
      evidenceToggle: evidenceToggle ? getComputedStyle(evidenceToggle).transitionDuration : null,
    };
  });
  expect(durations.shellToggle).toBe("0.18s");
  if (durations.evidenceToggle !== null) expect(durations.evidenceToggle).toBe("0.18s");
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

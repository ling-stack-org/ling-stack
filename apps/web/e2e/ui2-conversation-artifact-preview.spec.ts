import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockArtifact, type MockState } from "./support/mock-state";
import { openMainRunHistory } from "./support/runs-threads-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

test("shared text attachment preview contains loading, content, feedback, error, and focus", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = textAttachmentState();
  await mockDaemon(page, state);
  await routeTextAttachmentPreviews(page);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const textTrigger = feed.getByRole("button", { name: `Preview: ${textAttachmentName}` });
  await textTrigger.click();

  const preview = page.getByLabel("File preview");
  const panel = preview.locator(".artifact-preview-panel");
  await expect(preview.locator(".artifact-preview-loading")).toBeVisible();
  await expect(preview.locator(".artifact-preview-text-panel")).toBeVisible();
  await expect(preview).toContainText("Focused attachment preview keeps long content contained");
  await expect(preview.getByRole("button", { name: "Close preview" })).toBeFocused();
  await expect(panel).toHaveCSS("animation-name", "conversation-settle-in");
  await expect(panel).toHaveCSS("animation-duration", "0.18s");
  await expect(panel).toHaveCSS("animation-timing-function", "cubic-bezier(0.2, 0.8, 0.2, 1)");
  await expectContainedGeometry(page, preview, panel, preview.locator(".artifact-preview-body"));

  const panelGeometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(Math.round(panelGeometry.width)).toBe(920);
  expect(Math.round(panelGeometry.height)).toBe(760);

  const download = preview.getByRole("link", { name: "Download file" });
  await expect(download).toHaveAttribute("download", textAttachmentName);
  await download.evaluate((element) => {
    element.addEventListener("click", (event) => event.preventDefault(), { once: true });
  });
  await download.click();
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="artifact-preview:attachment:attachment_ui2_preview_text:download"]')).toContainText("Download started");

  await preview.getByRole("button", { name: "Close preview" }).click();
  await expect(preview).toHaveCount(0);
  await expect(textTrigger).toBeFocused();

  const errorTrigger = feed.getByRole("button", { name: `Preview: ${errorAttachmentName}` });
  await errorTrigger.click();
  const errorPreview = page.getByLabel("File preview");
  await expect(errorPreview.locator(".artifact-preview-error")).toBeVisible();
  await expect(errorPreview.getByRole("alert")).toContainText("Preview unavailable");
  await expectContainedGeometry(page, errorPreview, errorPreview.locator(".artifact-preview-panel"));
  await errorPreview.getByRole("button", { name: "Close preview" }).click();
  await expect(errorTrigger).toBeFocused();

  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("shared image artifact preview covers every compare mode in dark reduced motion", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = imageArtifactState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openMainRunHistory(page, "Inspect workspace");

  const detail = page.getByLabel("Run detail");
  const trigger = detail.getByRole("button", { name: `Preview: ${imageArtifactTitle}` });
  await trigger.click();

  const preview = page.getByLabel("File preview");
  const panel = preview.locator(".artifact-preview-panel");
  const body = preview.locator(".artifact-preview-body");
  const viewer = preview.locator(".image-compare-viewer");
  await expect(viewer).toBeVisible();
  await expect(panel).toHaveCSS("animation-name", "none");
  await expectContainedGeometry(page, preview, panel, body, viewer);

  const single = preview.getByRole("button", { name: "Single", exact: true });
  const sideBySide = preview.getByRole("button", { name: "Side by side", exact: true });
  const sliderMode = preview.getByRole("button", { name: "Slider", exact: true });
  const diffOverlay = preview.getByRole("button", { name: "Diff overlay", exact: true });
  await expect(single).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.locator(".image-compare-frame")).toHaveCount(1);

  await sideBySide.click();
  await expect(sideBySide).toHaveAttribute("aria-pressed", "true");
  const compareFrames = viewer.locator(".image-compare-side-by-side .image-compare-frame");
  await expect(compareFrames).toHaveCount(2);
  await expectContainedGeometry(page, body, compareFrames.nth(0), compareFrames.nth(1));

  await sliderMode.click();
  await expect(sliderMode).toHaveAttribute("aria-pressed", "true");
  const range = viewer.getByRole("slider", { name: "Slider" });
  await range.fill("73");
  await expect(range).toHaveValue("73");
  const sliderStage = viewer.locator(".image-compare-slider-stage");
  const sliderHandle = viewer.locator(".image-compare-slider-handle");
  await expect(sliderHandle).toHaveAttribute("style", /left:\s*73%/u);
  expect(await viewer.locator(".image-compare-slider-after").evaluate((element) => getComputedStyle(element).clipPath)).toContain("73%");
  await expectContainedGeometry(page, body, sliderStage, sliderHandle);

  await diffOverlay.click();
  await expect(diffOverlay).toHaveAttribute("aria-pressed", "true");
  const difference = viewer.locator(".image-compare-diff-overlay");
  await expect(difference.locator("img")).toHaveCount(2);
  await expect(difference.locator("img").nth(1)).toHaveCSS("mix-blend-mode", "difference");
  await expect(difference.locator("img").nth(1)).toHaveCSS("opacity", "0.72");
  await expectContainedGeometry(page, body, difference);

  await expectNoDocumentOverflow(page);
  await preview.getByRole("button", { name: "Close preview" }).click();
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

const textAttachmentName = "focused-preview-notes.txt";
const errorAttachmentName = "unavailable-preview.txt";
const imageArtifactTitle = "UI2 comparison artifact";

function textAttachmentState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [{
    id: "message_ui2_artifact_preview",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: "Inspect both focused attachment preview states.",
    mentions: [],
    attachmentIds: ["attachment_ui2_preview_text", "attachment_ui2_preview_error"],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-23T08:00:00.000Z",
    updatedAt: "2026-07-23T08:00:00.000Z",
  }];
  state.channelAttachments = [
    channelAttachment("attachment_ui2_preview_text", textAttachmentName),
    channelAttachment("attachment_ui2_preview_error", errorAttachmentName),
  ];
  return state;
}

function channelAttachment(id: string, fileName: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    messageId: "message_ui2_artifact_preview",
    kind: "text",
    fileName,
    contentType: "text/plain; charset=utf-8",
    sizeBytes: 4096,
    path: `.ling-stack/attachments/${fileName}`,
    materializationStatus: "available",
    previewStatus: "available",
    createdAt: "2026-07-23T08:00:00.000Z",
  };
}

async function routeTextAttachmentPreviews(page: Page): Promise<void> {
  await page.route(/\/attachments\/(attachment_ui2_preview_text|attachment_ui2_preview_error)\/preview(?:\?.*)?$/u, async (route) => {
    const attachmentId = new URL(route.request().url()).pathname.split("/").at(-2);
    if (attachmentId === "attachment_ui2_preview_error") {
      await route.fulfill({
        status: 503,
        json: { error: "focused_preview_failure", message: "Focused attachment preview is unavailable." },
      });
      return;
    }
    await wait(220);
    await route.fulfill({
      json: {
        ref: {
          id: "attachment_ui2_preview_text",
          source: "attachment",
          scope: "channel",
          label: textAttachmentName,
          displayPath: `.ling-stack/attachments/${textAttachmentName}`,
          contentType: "text/plain; charset=utf-8",
          sizeBytes: 4096,
          previewable: true,
        },
        kind: "plain_text",
        text: `Focused attachment preview keeps long content contained.\n\n${"LongUnbrokenPreviewToken".repeat(48)}`,
        truncated: true,
        sizeBytes: 4096,
        redactionNotes: ["Sensitive values were removed"],
      },
    });
  });
}

function imageArtifactState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const artifact: MockArtifact = {
    id: "artifact_ui2_image_compare",
    runId: "run_failed",
    type: "image",
    path: "run_failed/ui2-image-compare.svg",
    title: imageArtifactTitle,
    contentType: "image/svg+xml",
    sizeBytes: 8192,
    compareBeforeImageUrl: svgDataUrl("Before", "#f4f4f5", "#18181b"),
    compareAfterImageUrl: svgDataUrl("After", "#dbeafe", "#1d4ed8"),
    compareBeforeLabel: "Previous image",
    compareAfterLabel: "Current image",
    createdAt: "2026-07-23T08:30:00.000Z",
  };
  state.artifactsByRun.run_failed = [artifact];
  return state;
}

function svgDataUrl(label: string, background: string, foreground: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="${background}"/><text x="480" y="285" text-anchor="middle" font-family="sans-serif" font-size="54" fill="${foreground}">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectContainedGeometry(page: Page, owner: Locator, ...children: Locator[]): Promise<void> {
  const ownerBox = await owner.boundingBox();
  expect(ownerBox).not.toBeNull();
  for (const child of children) {
    const childBox = await child.boundingBox();
    expect(childBox).not.toBeNull();
    expect(childBox!.x).toBeGreaterThanOrEqual(ownerBox!.x - 1);
    expect(childBox!.y).toBeGreaterThanOrEqual(ownerBox!.y - 1);
    expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(ownerBox!.x + ownerBox!.width + 1);
    expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(ownerBox!.y + ownerBox!.height + 1);
    expect(await child.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  const viewport = page.viewportSize();
  expect(ownerBox!.x).toBeGreaterThanOrEqual(-1);
  expect(ownerBox!.y).toBeGreaterThanOrEqual(-1);
  expect(ownerBox!.x + ownerBox!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  expect(ownerBox!.y + ownerBox!.height).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console:${message.text()}`);
    }
  });
  return errors;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

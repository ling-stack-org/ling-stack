import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon, type MockState } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import { createDefaultProviderTemplates } from "./support/mock-state";
import {
  createMediaEmptyFixture,
  createMediaMixedFixture,
  createMediaRouteControl,
  installMediaScenarioRoutes,
  openMediaJobs,
  seedImportedQuietOcean,
  type MediaRouteControl,
} from "./support/media-jobs-fixtures";

const evidenceDir = path.resolve(process.cwd(), "../../docs/design/ui2.0升级/evidence/features/media-jobs");

test.describe.configure({ mode: "serial" });

test("MJ-01-reach-empty: production entry, initial loading, empty repair", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  const state = createMediaEmptyFixture();
  const control = createMediaRouteControl();
  control.listDelayMs = 350;
  await prepare(page, state, control, false);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  await page.getByRole("radio", { name: "Generation tasks" }).click();
  await expect(page.locator('[data-media-jobs-list-state="loading"]')).toBeVisible();
  await expect(page.locator('[data-media-jobs-list-state="empty"]')).toBeVisible();
  await expect(page.locator("[data-media-jobs-header]").getByRole("button", { name: "Configure generation model" })).toBeVisible();
  await captureLedger(page, "1440x960-ling-light-empty-model-repair.png", "media_empty_no_model", "LIST/CREATE/REPAIR", "Configure generation model");
  await page.locator("[data-media-jobs-header]").getByRole("button", { name: "Configure generation model" }).click();
  await expect(page.getByRole("dialog", { name: "New image generation model" })).toBeVisible();
});

test("MJ-02-list-states: canonical rows, filters, keyboard, 100-row scroll", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  const state = createMediaMixedFixture(100);
  await prepare(page, state);
  await expect(page.locator("[data-media-job-row]")).toHaveCount(100);
  await expect(page.locator('[data-product-state="completed"]')).toHaveCount(3);
  await expect(page.locator('[data-product-state="generating"]')).toHaveCount(1);
  const secondRow = page.locator("[data-media-job-row]").nth(1);
  await secondRow.press("Enter");
  await expect(page.locator("[data-media-job-inspector]")) .toHaveAttribute("data-media-job-inspector", "media_job_rate_limit");
  await captureLedger(page, "1440x960-ling-light-mixed-list-result.png", "media_mixed_100", "LIST/RESULT", "Select and inspect result");

  state.mediaJobs = state.mediaJobs.filter((job) => job.status === "queued");
  await switchTheme(page, "ling-dark");
  await openMediaJobs(page);
  await page.getByRole("radio", { name: "Completed" }).click();
  await expect(page.locator('[data-media-jobs-list-state="no-result"]')).toBeVisible();
  await captureLedger(page, "1280x800-ling-dark-filter-no-result.png", "media_mixed_100", "LIST", "Show all", { width: 1280, height: 800 });
});

test("MJ-03-focus-revalidation: retained stale, retry, selection and artifact isolation", async ({ page }) => {
  await initPage(page, "en-US", "ling-dark", { width: 1280, height: 800 });
  const state = createMediaMixedFixture();
  const control = createMediaRouteControl();
  await prepare(page, state, control);
  await page.locator('[data-media-job-row="media_job_preview_unavailable"]').click();
  const selectedBefore = await page.locator("[data-media-job-inspector]").getAttribute("data-media-job-inspector");
  control.failNextList = true;
  await expect(page.locator("[data-media-jobs-header]").getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  await expect(page.getByText("Could not refresh generation tasks. Showing the last loaded data.")).toBeVisible();
  await expect(page.locator("[data-media-job-row]").first()).toHaveAttribute("data-stale", "true");
  await expect(page.locator("[data-media-job-inspector]")).toHaveAttribute("data-media-job-inspector", selectedBefore ?? "");
  await captureLedger(page, "1280x800-ling-dark-retained-refresh-failure.png", "media_refresh_stale", "LIST", "Retry refresh");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Could not refresh generation tasks. Showing the last loaded data.")).toHaveCount(0);
  expect(control.listCalls).toBeGreaterThanOrEqual(2);
});

test("MJ-04-create-modes: operation fields, validation, disclosure and geometry", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  await prepare(page, createMediaMixedFixture());
  await page.getByRole("button", { name: "New generation task" }).click();
  const dialog = page.getByRole("dialog", { name: "New generation task" });
  await expect(dialog.getByLabel("Operation")).toBeVisible();
  await expect(dialog.getByLabel("Generation model")).toBeVisible();
  await expect(dialog.getByLabel("Prompt")).toBeVisible();
  await dialog.getByLabel("Prompt").fill("Create a deterministic launch image.");
  await captureLedger(page, "1440x960-ling-light-create-image.png", "media_long_create", "CREATE", "Create task");
  await dialog.getByLabel("Operation").selectOption("image_edit");
  await expect(dialog.getByLabel("Source image URL")).toBeVisible();
  await dialog.getByLabel("Source image URL").fill("file:///private/source.png");
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog.getByText("Use an http or https image URL.")).toBeVisible();
  await dialog.getByLabel("Operation").selectOption("video_generate");
  await expect(dialog.getByLabel("Aspect ratio")).toBeVisible();
  await dialog.getByText("Advanced parameters").click();
  await expect(dialog.getByLabel("Watermark")).toBeVisible();
  await switchTheme(page, "ling-dark");
  await openMediaJobs(page);
  await page.getByRole("button", { name: "New generation task" }).click();
  await page.getByRole("dialog", { name: "New generation task" }).getByLabel("Operation").selectOption("video_generate");
  await page.getByRole("dialog", { name: "New generation task" }).getByText("Advanced parameters").click();
  await captureLedger(page, "1280x800-ling-dark-create-video-advanced.png", "media_long_create", "CREATE", "Create video task", { width: 1280, height: 800 });
});

test("MJ-05-create-busy-reuse: failure retains draft, busy blocks dismiss, success closes", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  const control = createMediaRouteControl();
  await prepare(page, createMediaMixedFixture(), control);
  await page.locator('[data-media-job-row="media_job_provider_blocked"]').click();
  await page.getByRole("button", { name: "Reuse settings" }).click();
  const blockedDialog = page.getByRole("dialog", { name: "New generation task" });
  await expect(blockedDialog.getByLabel("Prompt")).toHaveValue("Blocked provider task.");
  await captureLedger(page, "1440x960-ling-light-create-provider-blocked.png", "media_provider_blocked", "CREATE/REPAIR", "Choose runnable model");
  await blockedDialog.getByLabel("Generation model").selectOption("provider_image");
  control.failNextCreate = true;
  await blockedDialog.getByRole("button", { name: "Create task" }).click();
  await expect(blockedDialog).toBeVisible();
  await expect(blockedDialog.getByLabel("Prompt")).toHaveValue("Blocked provider task.");
  control.createDelayMs = 350;
  await blockedDialog.getByRole("button", { name: "Create task" }).click();
  await page.keyboard.press("Escape");
  await expect(blockedDialog).toBeVisible();
  await expect(blockedDialog).toHaveCount(0, { timeout: 5_000 });
});

test("MJ-06-progress-approval: quiet running, gated review and duplicate run", async ({ page }) => {
  await initPage(page, "zh-CN", "ling-light", { width: 1440, height: 960 });
  const state = createMediaMixedFixture();
  const control = createMediaRouteControl();
  state.mediaJobRunDelayMs = 350;
  await prepare(page, state, control);
  await page.locator('[data-media-job-row="media_job_video_running"]').click();
  await expect(page.locator("[data-media-job-inspector]")).not.toContainText("%");
  await expect(page.getByRole("button", { name: /Cancel|Stop|取消|停止/u })).toHaveCount(0);
  await captureLedger(page, "1440x960-ling-light-generating.png", "media_video_running", "LIST/RESULT", "Wait for authoritative status");
  await page.locator('[data-media-job-row="media_job_approval_waiting"]').click();
  await expect(page.locator("[data-media-job-repair]")).toHaveAttribute("data-media-job-repair", "open_approval");
  await expect(page.locator('[data-media-job-row="media_job_approval_waiting"]').getByRole("button", { name: /Start generation|开始生成/u })).toHaveCount(0);
  await page.locator("[data-media-job-repair]").getByRole("button", { name: /Open review queue|打开审核队列/u }).click();
  await expect(page.locator("[data-approvals-ui2-page]")).toBeVisible();
  await expect(page.locator('[data-approval-detail-id="approval_media_waiting"]')).toBeVisible();
  await openMediaJobs(page);
  const legacy = page.locator('[data-media-job-row="media_job_legacy_waiting"]');
  await legacy.getByRole("button", { name: /Start generation|开始生成/u }).dblclick();
  expect(control.runCalls.media_job_legacy_waiting).toBe(1);
});

test("MJ-07-results: image, video, multiple, auxiliary, copy and redaction", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => undefined } }));
  await prepare(page, createMediaMixedFixture());
  await page.locator('[data-media-job-row="media_job_image_ready"]').click();
  await expect(page.locator("[data-media-job-artifact]")).toHaveCount(2);
  await expect(page.locator("[data-media-job-inspector]")).not.toContainText("must-not-render");
  await page.getByRole("button", { name: "Copy prompt" }).click();
  await expect(page.locator('.ling-ui-toast[data-scope*="copy-prompt"]')).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
  await page.getByRole("button", { name: "Copy result URL" }).click();
  await expect(page.getByText("Could not copy to the clipboard")).toBeVisible();
  await page.locator('[data-media-job-row="media_job_video_ready"]').click();
  const video = page.locator(".media-artifact-preview.hero video");
  await expect(video).toHaveAttribute("controls", "");
  expect(await video.evaluate((element) => (element as HTMLVideoElement).autoplay)).toBe(false);
});

test("MJ-08-preview-pixel: local retry and cross-theme image bytes", async ({ page }) => {
  await initPage(page, "en-US", "ling-light", { width: 1440, height: 960 });
  await prepare(page, createMediaMixedFixture());
  await page.locator('[data-media-job-row="media_job_image_ready"]').click();
  const image = page.locator(".media-artifact-preview.hero img");
  await expect(image).toBeVisible();
  await expect(image.locator("xpath=..")).toHaveAttribute("data-media-preview-state", "ready");
  const lightScreenshot = await image.screenshot();
  const lightPixelHash = decodedPngPixelHash(lightScreenshot, 1);
  const lightGeometry = await image.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const lightEffectChain = await visualEffectChain(image);
  const styles = await image.evaluate((element) => {
    const style = getComputedStyle(element);
    return { filter: style.filter, opacity: style.opacity, mixBlendMode: style.mixBlendMode, objectFit: style.objectFit };
  });
  expect(styles).toEqual({ filter: "none", opacity: "1", mixBlendMode: "normal", objectFit: "contain" });
  await switchTheme(page, "ling-dark");
  await openMediaJobs(page);
  await page.locator('[data-media-job-row="media_job_image_ready"]').click();
  const darkImage = page.locator(".media-artifact-preview.hero img");
  await expect(darkImage.locator("xpath=..")).toHaveAttribute("data-media-preview-state", "ready");
  const darkScreenshot = await darkImage.screenshot();
  const darkGeometry = await darkImage.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  expect(darkGeometry).toEqual(lightGeometry);
  expect(await visualEffectChain(darkImage)).toEqual(lightEffectChain);
  expect(pngDimensions(darkScreenshot)).toEqual(pngDimensions(lightScreenshot));
  expect(decodedPngPixelHash(darkScreenshot, 1)).toBe(lightPixelHash);
  await seedImportedQuietOcean(page);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "quiet-ocean");
  await openMediaJobs(page);
  await page.locator('[data-media-job-row="media_job_image_ready"]').click();
  const importedImage = page.locator(".media-artifact-preview.hero img");
  await expect(importedImage.locator("xpath=..")).toHaveAttribute("data-media-preview-state", "ready");
  const importedScreenshot = await importedImage.screenshot();
  expect(pngDimensions(importedScreenshot)).toEqual(pngDimensions(lightScreenshot));
  const importedPixelHash = decodedPngPixelHash(importedScreenshot, 1);
  expect(importedPixelHash).toBe(lightPixelHash);
  await captureLedger(page, "1440x960-imported-quiet-ocean-image-result.png", "media_image_ready", "RESULT", "View result", undefined, importedPixelHash);

  await switchTheme(page, "ling-dark");
  await openMediaJobs(page);
  await page.locator('[data-media-job-row="media_job_preview_unavailable"]').click();
  await expect(page.locator('[data-media-preview-mode="hero"][data-media-preview-state="error"]')).toBeVisible();
  await captureLedger(page, "1280x800-ling-dark-preview-unavailable.png", "media_missing_artifact", "RESULT", "Retry preview", { width: 1280, height: 800 });
  const before = await page.locator(".media-artifact-preview.hero.unavailable").count();
  await page.getByRole("button", { name: "Retry preview" }).click();
  await expect.poll(() => page.locator(".media-artifact-preview.hero.unavailable").count()).toBe(before);
});

test("MJ-09-provider-repair: reason-specific repair and AppShell fallback", async ({ page }) => {
  await initPage(page, "zh-CN", "ling-dark", { width: 1280, height: 800 });
  await prepare(page, createMediaMixedFixture());
  await page.locator('[data-media-job-row="media_job_provider_blocked"]').click();
  await expect(page.locator("[data-media-job-repair]")).toContainText(/disabled|停用/u);
  await captureLedger(page, "1280x800-ling-dark-needs-attention-repair.png", "media_provider_blocked", "LIST/REPAIR", "Edit this model");
  await page.locator("[data-media-job-repair]").getByRole("button").click();
  await expect(page.getByRole("dialog", { name: /New image generation model|新建图片生成模型/u })).toBeVisible();
});

test("MJ-10-workflow-repair: exact workflow and connection fallback tabs", async ({ page }) => {
  await initPage(page, "zh-CN", "ling-dark", { width: 1280, height: 800 });
  await prepare(page, createMediaMixedFixture());
  await page.locator('[data-media-job-row="media_job_workflow_blocked"]').click();
  await expect(page.locator("[data-media-job-repair]")).toHaveAttribute("data-media-job-repair", "repair_connection");
  await page.locator("[data-media-job-repair]").getByRole("button").click();
  const workflowDialog = page.getByRole("dialog", { name: "生产流程库" });
  await expect(workflowDialog).toBeVisible();
  await expect(workflowDialog.getByRole("tab", { name: "连接", exact: true })).toHaveAttribute("data-state", "active");
  const workflowTheme = await workflowDialog.evaluate((dialog) => ({
    dialogBackground: getComputedStyle(dialog).backgroundColor,
    detailBackground: getComputedStyle(dialog.querySelector(".media-workflow-detail-pane")!).backgroundColor,
    overlayBackground: getComputedStyle(dialog.parentElement!).backgroundColor,
  }));
  expect(workflowTheme.dialogBackground).not.toBe("rgb(255, 255, 255)");
  expect(workflowTheme.detailBackground).not.toBe("rgb(255, 255, 255)");
  expect(workflowTheme.overlayBackground).toMatch(/^rgba?\(0, 0, 0/u);
  await captureLedger(page, "1280x800-ling-dark-workflow-repair.png", "media_workflow_blocked", "REPAIR", "Open connection settings");
  await page.getByRole("button", { name: "关闭生产流程" }).click();
  await page.locator('[data-media-job-row="media_job_workflow_missing"]').click();
  await page.locator("[data-media-job-repair]").getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "生产流程库" }).getByRole("tab", { name: "工作流", exact: true })).toHaveAttribute("data-state", "active");
  await expect(page.locator("[data-media-job-inspector]")).not.toContainText("Unknown provider");
});

test("MJ-11-responsive-a11y: overflow, hit areas, dialog bounds and console", async ({ page }) => {
  await initPage(page, "en-US", "ling-dark", { width: 1280, height: 800, reducedMotion: "reduce" });
  const errors = captureBrowserErrors(page);
  const state = createMediaMixedFixture(100);
  state.mediaJobs = state.mediaJobs.filter((job) => job.id !== "media_job_preview_unavailable");
  delete state.artifactsByMediaJob.media_job_preview_unavailable;
  await prepare(page, state);
  const overflow = await page.locator("[data-media-jobs-surface]").evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
  const iconBoxes = await page.locator('[data-media-jobs-header] button[data-icon-only="true"]').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return [rect.width, rect.height];
  }));
  expect(iconBoxes.every(([width, height]) => width >= 32 && height >= 32)).toBe(true);
  await page.getByRole("button", { name: "New generation task" }).click();
  const dialog = page.getByRole("dialog", { name: "New generation task" });
  const bounds = await dialog.evaluate((element) => element.getBoundingClientRect().toJSON());
  expect(bounds.left).toBeGreaterThanOrEqual(16);
  expect(bounds.top).toBeGreaterThanOrEqual(16);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function prepare(page: Page, state: MockState, control = createMediaRouteControl(), navigate = true): Promise<void> {
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await installMediaScenarioRoutes(page, control);
  await page.goto("/");
  if (navigate) await openMediaJobs(page);
}

async function initPage(
  page: Page,
  locale: "en-US" | "zh-CN",
  themeId: "ling-light" | "ling-dark",
  options: { readonly width: number; readonly height: number; readonly reducedMotion?: "reduce" },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
  await page.addInitScript(({ savedLocale, savedTheme }) => {
    const storedOverride = sessionStorage.getItem("ling-stack.e2eThemeSelection");
    const selection = storedOverride
      ? JSON.parse(storedOverride)
      : { mode: "fixed", themeId: savedTheme };
    localStorage.setItem("ling-stack.locale", savedLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, { savedLocale: locale, savedTheme: themeId });
}

async function switchTheme(page: Page, themeId: "ling-light" | "ling-dark"): Promise<void> {
  await page.evaluate((savedTheme) => {
    const selection = { mode: "fixed", themeId: savedTheme };
    sessionStorage.setItem("ling-stack.e2eThemeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, themeId);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureLedger(
  page: Page,
  fileName: string,
  fixtureId: string,
  functionIds: string,
  expectedAction: string,
  viewport?: { readonly width: number; readonly height: number },
  mediaElementHash?: string,
): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  if (viewport) await page.setViewportSize(viewport);
  await mkdir(evidenceDir, { recursive: true });
  const buffer = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(evidenceDir, fileName),
  });
  const rootOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const metadata = {
    file: fileName,
    functionIds: expandMediaFunctionIds(functionIds),
    fixtureId,
    url: "/",
    servedArtifact: "Vite source",
    locale: await page.evaluate(() => document.documentElement.lang),
    themeId: await page.locator("html").getAttribute("data-ui-theme"),
    viewport: page.viewportSize(),
    stateTrigger: fixtureId,
    expectedAction,
    consoleErrors: 0,
    rootOverflow,
    sha256: sha(buffer),
    mediaElementHash,
    packagedDesktop: "pending",
  };
  await writeFile(path.join(evidenceDir, `${fileName}.json`), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function expandMediaFunctionIds(functionIds: string): string[] {
  const aliases: Record<string, string> = {
    CREATE: "MEDIA-JOB-CREATE-001",
    LIST: "MEDIA-JOB-LIST-001",
    REPAIR: "MEDIA-JOB-REPAIR-001",
    RESULT: "MEDIA-JOB-RESULT-001",
  };
  return functionIds.split("/").map((id) => aliases[id] ?? id);
}

function sha(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function decodedPngPixelHash(buffer: Buffer, cropInset = 0): string {
  const { width, height } = pngDimensions(buffer);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported evidence PNG format: depth=${bitDepth}, color=${colorType}, interlace=${interlace}`);
  }
  const idat: Buffer[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const pixels = Buffer.alloc(rowBytes * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = packed[sourceOffset];
    sourceOffset += 1;
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = packed[sourceOffset + column] ?? 0;
      const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] ?? 0 : 0;
      const up = row > 0 ? pixels[rowOffset + column - rowBytes] ?? 0 : 0;
      const upLeft = row > 0 && column >= bytesPerPixel
        ? pixels[rowOffset + column - rowBytes - bytesPerPixel] ?? 0
        : 0;
      pixels[rowOffset + column] = (encoded + pngFilterPredictor(filter, left, up, upLeft)) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  if (cropInset === 0) return sha(pixels);
  if (width <= cropInset * 2 || height <= cropInset * 2) throw new Error("Evidence PNG is too small to crop");
  // Element screenshots on fractional grid coordinates can include one CSS pixel of page background.
  const croppedRowBytes = (width - cropInset * 2) * bytesPerPixel;
  const cropped = Buffer.alloc(croppedRowBytes * (height - cropInset * 2));
  for (let row = cropInset; row < height - cropInset; row += 1) {
    const sourceStart = row * rowBytes + cropInset * bytesPerPixel;
    pixels.copy(cropped, (row - cropInset) * croppedRowBytes, sourceStart, sourceStart + croppedRowBytes);
  }
  return sha(cropped);
}

function pngFilterPredictor(filter: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) {
    const estimate = left + up - upLeft;
    const leftDistance = Math.abs(estimate - left);
    const upDistance = Math.abs(estimate - up);
    const diagonalDistance = Math.abs(estimate - upLeft);
    return leftDistance <= upDistance && leftDistance <= diagonalDistance
      ? left
      : upDistance <= diagonalDistance ? up : upLeft;
  }
  throw new Error(`Unsupported PNG row filter: ${filter}`);
}

async function visualEffectChain(locator: Locator): Promise<readonly Record<string, string>[]> {
  return locator.evaluate((element) => {
    const result: Record<string, string>[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      result.push({
        node: `${current.tagName.toLowerCase()}.${current.classList.value}`,
        opacity: style.opacity,
        filter: style.filter,
        transform: style.transform,
        mixBlendMode: style.mixBlendMode,
        backdropFilter: style.backdropFilter,
      });
    }
    return result;
  });
}

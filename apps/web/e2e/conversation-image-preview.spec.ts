import { expect, test, type Page } from "@playwright/test";
import type { mountImagePreviewFixture } from "./support/image-preview-harness.js";

const firstImage = "/e2e/fixtures/fronalpstock-3840.jpg";
const secondImage = "/themes/ling-ocean/salt-coast-v1-thumb.webp";

async function mount(page: Page, input: Parameters<typeof mountImagePreviewFixture>[0] = {}) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async (options) => {
    const path = "/e2e/support/image-preview-harness.tsx";
    window.imagePreviewHarness = (await import(/* @vite-ignore */ path)).mountImagePreviewFixture(options);
  }, input);
  return page.locator('[data-conversation-timeline-kind="imageView"]');
}

async function requestCount(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => window.imagePreviewHarness.requests().length)).toBe(count);
}

test("image activity loads a bounded artifact thumbnail and opens the full preview", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const row = await mount(page);
  await expect(row.getByLabel("Loading image preview")).toBeVisible();
  await requestCount(page, 1);
  expect(await page.evaluate(() => window.imagePreviewHarness.requests())).toEqual([
    { source: "artifact", cwd: "/workspace", artifactId: "artifact-image", maxBytes: 96_000 },
  ]);
  await page.evaluate(() => window.imagePreviewHarness.resolve(0));
  const thumbnail = row.locator(".conversation-timeline-image-preview");
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("image-thumbnail.png") });
  await thumbnail.focus();
  await page.keyboard.press("Enter");
  const lightbox = page.locator(".artifact-preview-lightbox");
  await expect(lightbox).toBeVisible();
  await requestCount(page, 2);
  await page.evaluate(() => window.imagePreviewHarness.resolve(1));
  await expect(lightbox.locator(".image-compare-viewer img")).toHaveAttribute("src", firstImage);
  await page.screenshot({ path: info.outputPath("image-lightbox.png") });
  await lightbox.getByRole("button", { name: "Close preview" }).click();
  await expect(lightbox).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
  await row.locator(".conversation-timeline-activity-main").click();
  await expect(thumbnail).toHaveCount(0);
  await row.locator(".conversation-timeline-activity-main").click();
  await expect(thumbnail).toBeVisible();
  await requestCount(page, 2);
  expect(errors).toEqual([]);
});

test("same artifact ID reloads its thumbnail on a newer item revision without remounting", async ({ page }) => {
  const row = await mount(page);
  await requestCount(page, 1);
  await page.evaluate(() => window.imagePreviewHarness.resolve(0));
  const image = row.locator(".conversation-timeline-image-preview img");
  await expect(image).toHaveAttribute("src", firstImage);
  await row.evaluate((element) => element.setAttribute("data-test-mounted", "preserved"));
  await page.evaluate(() => window.imagePreviewHarness.update({ revision: 2 }));
  await requestCount(page, 2);
  await expect(row).toHaveAttribute("data-test-mounted", "preserved");
  await expect(row).toHaveAttribute("data-conversation-timeline-revision", "2");
  await expect(row.getByLabel("Loading image preview")).toBeVisible();
  await expect(image).toHaveCount(0);
  await page.evaluate((imageUrl) => window.imagePreviewHarness.resolve(1, { imageUrl }), secondImage);
  await expect(image).toHaveAttribute("src", secondImage);
  expect(await page.evaluate(() => window.imagePreviewHarness.requests().map((request) => request.source === "artifact" ? request.artifactId : undefined)))
    .toEqual(["artifact-image", "artifact-image"]);
});

test("image resource failures fall back to the activity text", async ({ page }) => {
  const row = await mount(page);
  await requestCount(page, 1);
  await page.evaluate(() => window.imagePreviewHarness.resolve(0, { imageUrl: "/e2e/fixtures/missing-thumbnail.jpg" }));
  await expect(row.locator(".conversation-timeline-image-preview")).toHaveCount(0);
  await expect(row).toContainText("Opened workspace-preview.jpg");
});

test("full preview reports an image resource failure", async ({ page }) => {
  const row = await mount(page);
  await requestCount(page, 1);
  await page.evaluate(() => window.imagePreviewHarness.resolve(0));
  const thumbnail = row.locator(".conversation-timeline-image-preview");
  await expect(thumbnail).toBeVisible();
  await thumbnail.click();
  const lightbox = page.locator(".artifact-preview-lightbox");
  await expect(lightbox).toBeVisible();
  await requestCount(page, 2);
  await page.evaluate(() => window.imagePreviewHarness.resolve(1, { imageUrl: "/e2e/fixtures/missing-preview.jpg" }));
  await expect(lightbox.locator('[data-artifact-preview-feedback="preview"]')).toBeVisible();
  await expect(lightbox).toContainText("Preview unavailable");
  await expect(lightbox.locator("img")).toHaveCount(0);
});

test("timeline revisions do not restart an open full preview", async ({ page }) => {
  const row = await mount(page);
  await requestCount(page, 1);
  await page.evaluate(() => window.imagePreviewHarness.resolve(0));
  const thumbnail = row.locator(".conversation-timeline-image-preview");
  await expect(thumbnail).toBeVisible();
  await thumbnail.click();
  const lightbox = page.locator(".artifact-preview-lightbox");
  await expect(lightbox).toBeVisible();
  await requestCount(page, 2);
  await page.evaluate(() => window.imagePreviewHarness.resolve(1));
  await expect(lightbox.locator(".image-compare-viewer")).toBeVisible();
  await page.evaluate(() => window.imagePreviewHarness.update({ revision: 2 }));
  await expect.poll(() => page.evaluate(() => window.imagePreviewHarness.requests().length)).toBe(3);
  await expect(lightbox.locator(".image-compare-viewer")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.imagePreviewHarness.requests().length)).toBe(3);
});

for (const stale of ["success", "failure"] as const) {
  test(`obsolete ${stale} cannot replace a newer image or end its loading state`, async ({ page }) => {
    const row = await mount(page);
    await requestCount(page, 1);
    await page.evaluate(() => window.imagePreviewHarness.update({ revision: 2 }));
    await requestCount(page, 2);
    await page.evaluate((outcome) => {
      if (outcome === "success") window.imagePreviewHarness.resolve(0);
      else window.imagePreviewHarness.reject(0);
    }, stale);
    await expect(row.getByLabel("Loading image preview")).toBeVisible();
    await page.evaluate((imageUrl) => window.imagePreviewHarness.resolve(1, { imageUrl }), secondImage);
    await expect(row.locator("img")).toHaveAttribute("src", secondImage);
    await expect(row.getByLabel("Loading image preview")).toHaveCount(0);
  });
}

for (const outcome of ["failure", "unsupported", "empty"] as const) {
  test(`preview ${outcome} retains the image activity and text fallback`, async ({ page }) => {
    const row = await mount(page);
    await requestCount(page, 1);
    await page.evaluate((result) => {
      if (result === "failure") window.imagePreviewHarness.reject(0);
      else window.imagePreviewHarness.resolve(0, result === "empty" ? { imageUrl: undefined } : { kind: "unsupported" });
    }, outcome);
    await expect(row.getByLabel("Loading image preview")).toHaveCount(0);
    await expect(row).toContainText("Opened workspace-preview.jpg");
    await expect(row.locator(".conversation-timeline-image-preview")).toHaveCount(0);
    await expect(row).toHaveAttribute("data-conversation-timeline-status", "succeeded");
    await page.evaluate(() => window.imagePreviewHarness.update({ revision: 2 }));
    await requestCount(page, 2);
    await page.evaluate(() => window.imagePreviewHarness.resolve(1));
    await expect(row.locator("img")).toHaveAttribute("src", firstImage);
  });
}

for (const boundary of ["artifact", "cwd", "loader"] as const) {
  test(`missing ${boundary} keeps a text-only activity without fetching a path`, async ({ page }) => {
    const row = await mount(page, boundary === "artifact" ? { item: { artifactRef: undefined } }
      : boundary === "cwd" ? { cwd: "" } : { loader: false });
    await expect(row).toBeVisible();
    await row.locator(".conversation-timeline-activity-main").click();
    await expect(row).toContainText("Opened workspace-preview.jpg");
    await requestCount(page, 0);
    await expect(row.locator("img")).toHaveCount(0);
  });
}

test("thumbnail and preview stay inside desktop and narrow viewports across built-in themes", async ({ page }, info) => {
  const row = await mount(page);
  await requestCount(page, 1);
  await page.evaluate(() => window.imagePreviewHarness.resolve(0));
  const thumbnail = row.locator(".conversation-timeline-image-preview");
  await expect(thumbnail).toBeVisible();
  for (const theme of ["ling-light", "ling-dark", "ling-breeze", "ling-night", "ling-ocean", "ling-journey"]) {
    await page.evaluate((id) => window.imagePreviewHarness.setTheme(id), theme);
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
    for (const viewport of [{ width: 1440, height: 960 }, { width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const bounds = await thumbnail.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.height).toBeLessThanOrEqual(182);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: info.outputPath(`${theme}-${viewport.width}-thumbnail.png`) });
    }
  }
});

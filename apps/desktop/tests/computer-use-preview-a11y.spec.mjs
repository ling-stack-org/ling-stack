import { _electron as electron, expect, test } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const harnessDirectory = join(testsDirectory, "computer-use-preview-renderer-harness");

let electronApp;
let page;
let rendererErrors;

test.beforeEach(async ({}, testInfo) => {
  rendererErrors = [];
  electronApp = await electron.launch({
    args: [harnessDirectory],
    env: {
      ...process.env,
      LING_PREVIEW_HARNESS_DISPLAY_MEDIA: testInfo.title.includes("display-media") ? "1" : "0",
    },
  });
  page = await electronApp.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") {
      rendererErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await expect(page.locator(".preview-shell")).toBeVisible();
  await page.locator(".preview-shell").hover();
});

test.afterEach(async () => {
  expect(rendererErrors).toEqual([]);
  await electronApp?.close();
});

test("names the shell and toolbar and preserves the complete keyboard order", async () => {
  const shell = page.getByRole("region", {
    name: "Computer Use preview for Example Browser, status Live",
  });
  const toolbar = page.getByRole("toolbar", { name: "Computer Use preview actions" });
  await expect(shell).toBeVisible();
  await expect(toolbar).toBeVisible();

  await focusDocumentStart();
  await page.keyboard.press("Tab");
  await expect(toolbar.getByRole("button", { name: "Open task" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(toolbar.getByRole("button", { name: "Hide" })).toBeFocused();
  await page.keyboard.press("Tab");
  const moreButton = toolbar.getByRole("button", { name: "More preview actions" });
  await expect(moreButton).toBeFocused();

  await page.keyboard.press("Shift+Tab");
  await expect(toolbar.getByRole("button", { name: "Hide" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(toolbar.getByRole("button", { name: "Open task" })).toBeFocused();

  await moreButton.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Preview actions" });
  await expect(menu).toBeVisible();
  const menuItems = menu.getByRole("menuitem");
  await expect(menuItems).toHaveText([
    "Reset position",
    "Close window",
    "Stop Computer Use",
  ]);
  await expect(menuItems.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menuItems.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menuItems.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menuItems.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menuItems.nth(2)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(moreButton).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(menuItems.nth(0)).toBeFocused();
  await page.evaluate(() => window.lingPreviewTestHarness.clearCalls());
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(moreButton).toBeFocused();
  await expect.poll(async () => page.evaluate(() => window.lingPreviewTestHarness
    .getCalls()
    .filter((call) => call.name === "resetPosition").length)).toBe(1);
});

test("updates shell toolbar and status semantics after a locale switch", async () => {
  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({
    locale: "zh-CN",
    runtimeStatus: "paused",
    targetLabel: "示例浏览器",
  }));

  await expect(page.getByRole("region", {
    name: "示例浏览器的 Computer Use 预览，状态：已暂停",
  })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Computer Use 预览操作" })).toBeVisible();
  const status = page.getByRole("status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveAttribute("aria-atomic", "true");
  await expect(status).toContainText("已暂停");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page).toHaveTitle("示例浏览器 — 已暂停 — Ling Computer Use 预览");
  await expect(page.locator("[aria-live]")).toHaveCount(1);
});

test("keeps the display-media video label stable without creating frame live regions", async () => {
  const video = page.getByLabel("Live Computer Use preview");
  await expect(video).toBeVisible();
  await expect(video).not.toHaveAttribute("aria-live", /.+/);
  await expect(page.locator("[aria-live]")).toHaveCount(1);

  await page.waitForTimeout(250);
  await expect(video).toHaveAttribute("aria-label", "Live Computer Use preview");
  await expect(page.locator("[aria-live]")).toHaveCount(1);

  await page.evaluate(() => window.lingPreviewTestHarness.pushSnapshot({ locale: "zh-CN" }));
  await expect(page.getByLabel("实时 Computer Use 预览")).toBeVisible();
  await expect(page.locator("video")).not.toHaveAttribute("aria-live", /.+/);
  await expect(page.locator("[aria-live]")).toHaveCount(1);
});

async function focusDocumentStart() {
  await page.evaluate(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    document.body.tabIndex = -1;
    document.body.focus();
  });
}

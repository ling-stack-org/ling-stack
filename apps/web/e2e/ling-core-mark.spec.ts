import { expect, test, type Page } from "@playwright/test";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const acceptanceDir = resolve(process.cwd(), "../..", ".ling-stack/acceptance/ling-core-mark");
const themes = ["ling-light", "ling-dark", "ling-breeze", "ling-ocean", "ling-night"] as const;

async function openHome(page: Page): Promise<void> {
  page.on("pageerror", (error) => console.error("PAGE_ERROR", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("CONSOLE_ERROR", message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route("**/runtime/conversation-execution**", (route) => route.fulfill({
    json: { cwd: "", status: "not_selected", defaultRunnerId: "pi" },
  }));
  await page.goto("/");
  await expect(page.locator(".conversation-home")).toBeVisible();
}

async function selectTheme(page: Page, themeId: string): Promise<void> {
  await page
    .getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .getByRole("button", { name: /Settings|设置/u })
    .click();
  await page.getByLabel(/Settings sections|设置分组/u).getByRole("button", { name: /Interface preferences|界面偏好/u, exact: true }).click();
  await page.locator(`[data-theme-option-id="${themeId}"]`).click();
  await page.getByRole("button", { name: /Back to app|返回应用/u, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
}

test("Ling Core IP mark renders on the conversation home across themes and states", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  await mkdir(acceptanceDir, { recursive: true });
  await openHome(page);

  const mark = page.locator(".conversation-home-mark .ling-core-mark");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("data-state", "idle");
  await expect(mark.locator(".ling-core-mark-artwork")).toHaveCount(1);
  await expect(mark.locator(".ling-core-mark-orb")).toHaveCount(3);
  await expect(mark.locator(".ling-core-mark-overlay")).toHaveCount(1);

  for (const theme of themes) {
    await selectTheme(page, theme);
    await expect(page.locator(".conversation-home")).toBeVisible();
    await expect(mark).toBeVisible();
    await page.waitForTimeout(3200);
    await mark.screenshot({ path: resolve(acceptanceDir, `${theme}-idle-mark.png`) });
    await page.screenshot({ path: resolve(acceptanceDir, `${theme}-idle-home.png`) });
  }

  const states = ["thinking", "receiving", "completed", "blocked"] as const;
  for (const state of states) {
    await mark.evaluate((element, next) => {
      element.setAttribute("data-state", next);
    }, state);
    await page.waitForTimeout(320);
    await page
      .locator(".conversation-home-mark")
      .screenshot({ path: resolve(acceptanceDir, `state-${state}-mark.png`) });
  }
  await mark.evaluate((element) => element.setAttribute("data-state", "idle"));

  const emulated = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await emulated.newPage();
  await openHome(reducedPage);
  const reducedMark = reducedPage.locator(".conversation-home-mark .ling-core-mark");
  await expect(reducedMark).toBeVisible();
  const animationName = await reducedMark
    .locator(".ling-core-mark-artwork")
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(animationName).toBe("none");
  await reducedMark.screenshot({ path: resolve(acceptanceDir, "reduced-motion-mark.png") });
  await emulated.close();

  const recording = await browser.newContext({
    recordVideo: { dir: testInfo.outputPath("video"), size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
  });
  const videoPage = await recording.newPage();
  await openHome(videoPage);
  const videoMark = videoPage.locator(".conversation-home-mark .ling-core-mark");
  await expect(videoMark).toBeVisible();
  await videoPage.waitForTimeout(3200);
  await videoMark.evaluate((element) => element.setAttribute("data-state", "thinking"));
  await videoPage.waitForTimeout(2800);
  await videoMark.evaluate((element) => element.setAttribute("data-state", "completed"));
  await videoPage.waitForTimeout(1200);
  await videoPage.close();
  const videoFiles = await readdir(testInfo.outputPath("video"));
  const recorded = videoFiles.find((file) => file.endsWith(".webm"));
  expect(recorded).toBeTruthy();
  await copyFile(testInfo.outputPath("video", recorded!), resolve(acceptanceDir, "ling-core-mark-motion.webm"));
  await recording.close();
});

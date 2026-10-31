import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const themes = ["ling-light", "ling-dark", "ling-breeze", "ling-ocean", "ling-night", "ling-journey"] as const;

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

async function expectOriginalLogo(page: Page): Promise<Locator> {
  const mark = page.locator(".conversation-home-mark > img");
  await expect(mark).toHaveCount(1);
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  await expect(mark).toHaveAttribute("alt", "");
  await expect(mark).toHaveAttribute("src", /(?:^|\/)icons\/ling-mark-compact\.svg$/);
  await expect.poll(() => mark.evaluate((element: HTMLImageElement) => {
    const bounds = element.getBoundingClientRect();
    return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
      && bounds.width > 0 && bounds.height > 0;
  })).toBe(true);
  // theme-background-motion-contract: Core IP is paused; the original Logo remains.
  await expect(page.locator(".conversation-home .ling-core-mark")).toHaveCount(0);
  return mark;
}

test("original Ling Stack logo remains on the conversation home across themes and reduced motion", async ({ page, browser }, testInfo) => {
  await openHome(page);
  const mark = await expectOriginalLogo(page);
  const originalSource = await mark.getAttribute("src") ?? "";

  for (const theme of themes) {
    await selectTheme(page, theme);
    await expect(page.locator(".conversation-home")).toBeVisible();
    const themedMark = await expectOriginalLogo(page);
    await expect(themedMark).toHaveAttribute("src", originalSource);
    await themedMark.screenshot({ path: testInfo.outputPath(`${theme}-logo.png`) });
    await page.screenshot({ path: testInfo.outputPath(`${theme}-home.png`), fullPage: true });
  }

  const emulated = await browser.newContext({ reducedMotion: "reduce" });
  try {
    const reducedPage = await emulated.newPage();
    await openHome(reducedPage);
    const reducedMark = await expectOriginalLogo(reducedPage);
    await expect(reducedMark).toHaveAttribute("src", originalSource);
    await expect(reducedMark).toHaveCSS("animation-name", "none");
    await expect(reducedPage.locator(".conversation-home-mark")).toHaveCSS("animation-name", "none");
    expect(await reducedPage.locator(".conversation-home-mark").evaluate((element) => element.getAnimations({ subtree: true }).length))
      .toBe(0);
    await reducedMark.screenshot({ path: testInfo.outputPath("reduced-motion-logo.png") });
    await reducedPage.screenshot({ path: testInfo.outputPath("reduced-motion-home.png"), fullPage: true });
  } finally {
    await emulated.close();
  }
});

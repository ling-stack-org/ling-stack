import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { installNormalConversationFixture, normalConversationFixtureTitle } from "./support/normal-conversation-fixture";

const photographPath = process.env.LING_DARK_PHOTO_PATH;
const evidenceDirectory = process.env.LING_DARK_PHOTO_EVIDENCE;
const expectedPhotographSha256 = "36cfa069101785df232908458551dacf7c333d1398c03ddb3c913926dd907701";

test.skip(!photographPath || !evidenceDirectory, "Local visual acceptance requires explicit input and output paths.");

test("dark photograph remains visible in light and dark themes", async ({ page }) => {
  test.setTimeout(60_000);
  const failures = collectErrors(page);
  const photograph = await readFile(resolve(photographPath!));
  const photographSha256 = createHash("sha256").update(photograph).digest("hex");
  expect(photographSha256).toBe(expectedPhotographSha256);

  await prepare(page);
  const section = await openBackgroundSettings(page);
  await page.locator("[data-background-file]").setInputFiles({
    name: "dark-mountain-panorama.jpg",
    mimeType: "image/jpeg",
    buffer: photograph,
  });
  await expect(page.locator("[data-background-preview]")).toHaveAttribute("data-draft", "true");
  await page.locator("[data-background-opacity]").fill("60");
  await page.getByRole("button", { name: "Apply background", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-user-background", "ready");

  const results: Record<string, unknown> = {};
  const sidebarInteractionStates: Record<string, unknown> = {};
  let backgroundSource: string | null = null;
  const cases = [
    { theme: "ling-light", strength: "subtle", value: 45, opacity: "0.55" },
    { theme: "ling-light", strength: "balanced", value: 60, opacity: "0.4" },
    { theme: "ling-light", strength: "strong", value: 75, opacity: "0.25" },
    { theme: "ling-dark", strength: "balanced", value: 60, opacity: "0.4" },
  ] as const;
  for (const { theme, strength, value, opacity } of cases) {
    await page.locator(`[data-theme-option-id="${theme}"]`).click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
    await page.locator("[data-background-opacity]").fill(String(value));
    const applyButton = page.getByRole("button", { name: "Apply background", exact: true });
    if (await applyButton.count()) await applyButton.click();
    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(page.locator("[data-background-layer]")).toBeVisible();
    await expect(page.locator(".workspace-background-scrim")).toHaveCSS("opacity", opacity);

    const currentSource = await page.locator("[data-background-layer] img").getAttribute("src");
    backgroundSource ??= currentSource;
    expect(currentSource).toBe(backgroundSource);
    await expect(page.locator(".conversation-home h1")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

    results[`${theme}-${strength}`] = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      return {
        scrimOpacity: style(".workspace-background-scrim").opacity,
        appBackground: style(".app-shell").backgroundColor,
        workspaceBackground: style(".workspace").backgroundColor,
        titlebarBackground: style(".desktop-window-chrome").backgroundColor,
        titlebarShadow: style(".desktop-window-chrome").boxShadow,
        titlebarLeadingBackground: style(".desktop-window-chrome-leading").backgroundColor,
        titlebarSurfaceBackground: style(".desktop-window-titlebar-surface").backgroundColor,
        sidebarBackground: style(".left-nav").backgroundColor,
        sidebarItemBackground: style(".primary-nav .nav-item").backgroundColor,
        sidebarItemForeground: style(".primary-nav .nav-item").color,
        headingBackground: style(".conversation-home h1").backgroundColor,
        composerBackground: style("[data-conversation-composer]").backgroundColor,
      };
    });
    await expect(page.locator(".desktop-window-chrome")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".desktop-window-chrome")).toHaveCSS("box-shadow", "none");
    await expect(page.locator(".left-nav")).toHaveCSS("background-color", /\/ 0\.68\)/u);
    await expect(page.locator(".desktop-window-chrome-leading")).toHaveCSS("background-color", /\/ 0\.68\)/u);
    expect(await page.locator(".desktop-window-chrome-leading").evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(await page.locator(".left-nav").evaluate((element) => getComputedStyle(element).backgroundColor));
    expect(await page.locator(".desktop-window-titlebar-surface").evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(await page.locator(".workspace").evaluate((element) => getComputedStyle(element).backgroundColor));
    await expect(page.locator(".primary-nav .nav-item").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".sidebar-section-title").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".sidebar-row-shell").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: resolve(evidenceDirectory!, `${theme}-${strength}-dark-photo-home.png`),
      fullPage: true,
    });
    if (theme === "ling-light" && strength === "balanced") {
      const navItem = page.locator(".primary-nav .nav-item").nth(1);
      await navItem.hover();
      expect(await navItem.evaluate((element) => element.matches(":hover"))).toBe(true);
      await expect(navItem).toHaveCSS("background-color", "rgb(217, 216, 213)");
      await expect(navItem).toHaveCSS("color", "rgb(25, 28, 31)");
      sidebarInteractionStates.hover = await navItem.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element).color,
      }));
      await page.screenshot({ path: resolve(evidenceDirectory!, "ling-light-balanced-sidebar-hover.png"), fullPage: true });
      await navItem.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      expect(await navItem.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      await expect(navItem).toHaveCSS("outline-color", "rgb(79, 111, 150)");
      sidebarInteractionStates.focus = await navItem.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element).color,
        outline: getComputedStyle(element).outlineColor,
      }));
      await page.screenshot({ path: resolve(evidenceDirectory!, "ling-light-balanced-sidebar-focus.png"), fullPage: true });
      await page.locator(".sidebar-row-shell", { hasText: normalConversationFixtureTitle }).locator(".sidebar-row-main").click();
      const selectedRow = page.locator(".sidebar-row-shell.selected");
      await expect(selectedRow).toBeVisible();
      sidebarInteractionStates.selected = await selectedRow.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element).color,
      }));
      await page.screenshot({ path: resolve(evidenceDirectory!, "ling-light-balanced-sidebar-selected.png"), fullPage: true });
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
      await expect(page.locator(".conversation-home")).toBeVisible();
    }
    await openBackgroundSettings(page);
    await expect(page.locator("html")).toHaveAttribute("data-ui-surface-recipe", "solid");
    await expect(page.locator(".desktop-window-chrome")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".desktop-window-chrome")).not.toHaveCSS("box-shadow", "none");
  }

  expect(failures).toEqual([]);
  await writeFile(
    resolve(evidenceDirectory!, "browser-evidence.json"),
    JSON.stringify({
      source: {
        page: "https://commons.wikimedia.org/wiki/File:Dark_mountain_panorama.jpg",
        title: "Dark mountain panorama",
        author: "Dreamy Pixel / Ales Krivec",
        license: "CC BY 4.0",
        sha256: photographSha256,
        bytes: photograph.length,
      },
      servedArtifact: "Vite source",
      viewport: await page.viewportSize(),
      consoleAndPageErrors: failures,
      themes: results,
      sidebarInteractionStates,
    }, null, 2),
  );
});

async function prepare(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "background-provider",
    lastCheck: { ok: true, code: "ready", message: "Controlled fixture", checkedAt: "2026-10-20T00:00:00.000Z" },
  })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.route("**/runtime/conversation-execution**", (route) => route.fulfill({
    json: { cwd: "", status: "not_selected", defaultRunnerId: "pi" },
  }));
  await page.goto("/");
}

async function openBackgroundSettings(page: Page) {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections")
    .getByRole("button", { name: "Interface preferences", exact: true }).click();
  const section = page.locator("[data-background-settings]");
  await expect(section).toBeVisible();
  return section;
}

function collectErrors(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`page:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console:${message.text()}`);
  });
  return failures;
}

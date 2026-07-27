import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-controls/",
  import.meta.url,
));

test("Sidebar primary navigation and section menus keep one accessible interaction model", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  await mockDaemon(page, createControlsState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const primary = navigation.locator(".primary-nav");
  const primaryButtons = primary.getByRole("button");
  await expect(primaryButtons).toHaveCount(5);
  for (const button of await primaryButtons.all()) {
    await expectHitArea(button, 36);
  }

  const workBoard = primary.getByRole("button", { name: "Work Board" });
  await workBoard.click();
  await expect(workBoard).toHaveAttribute("aria-current", "page");
  await expect(primary.locator('[aria-current="page"]')).toHaveCount(1);

  const channelActions = navigation.getByRole("button", { name: "Channel actions" });
  await expectHitArea(channelActions, 32);
  await expect(channelActions).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await channelActions.click();
  await expect(channelActions).toHaveAttribute("data-state", "open");
  const channelMenu = page.getByRole("menu");
  await expect(channelMenu.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  expect(await channelMenu.evaluate((element) => element.closest("aside") === null)).toBe(true);
  await expectInsideViewport(channelMenu, page);
  await page.keyboard.press("Escape");
  await expect(channelMenu).toHaveCount(0);
  await expect(channelActions).toBeFocused();

  const recentActions = navigation.getByRole("button", { name: "Recent conversation actions" });
  await recentActions.click();
  const archiveAll = page.getByRole("menuitem", { name: "Archive all conversations" });
  await expect(archiveAll).toBeDisabled();
  await expect(archiveAll).toHaveAttribute("data-tone", "danger");
  await expect(archiveAll).toHaveAttribute("title", "No conversations to archive");
  await captureEvidence(page, "1440x960-ling-light-disabled-danger-menu.png");
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar compact rail switches one portal tooltip without motion or overflow", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareSurface(page, "dark", 1280, 800);
  await mockDaemon(page, createControlsState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const navigationToggle = page.getByRole("button", { name: "Hide navigation" });
  await expect(navigationToggle).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await navigationToggle.click();
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? 0)).toBe(48);

  const inbox = navigation.getByRole("button", { name: "Inbox" });
  const media = navigation.getByRole("button", { name: "Media Production" });
  const automations = navigation.getByRole("button", { name: "Automations" });
  for (const button of [inbox, media, automations]) {
    await expectHitArea(button, 36);
    await expect(button.locator('[data-ling-button-slot="label"]')).toHaveCSS("display", "none");
  }

  await inbox.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("Inbox");
  expect(await tooltip.evaluate((element) => element.closest("aside") === null)).toBe(true);
  await media.hover();
  await expect(tooltip).toHaveText("Media Production");
  await expect(page.getByRole("tooltip")).toHaveCount(1);
  await automations.focus();
  await expect(tooltip).toHaveText("Automations");
  await expect(tooltip).toHaveCSS("animation-name", "none");

  await expect(navigation.getByRole("button", { name: "Channel actions" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: /Teammate actions/i })).toBeHidden();
  const channelsToggle = navigation.getByRole("button", { name: "Channels" });
  await expectHitArea(channelsToggle, 32);
  await expect(channelsToggle.locator('[data-ling-button-slot="trailing"]')).toBeVisible();

  await automations.focus();
  await expect(tooltip).toHaveText("Automations");
  await expectNoHorizontalOverflow(page.locator("html"));
  await captureEvidence(page, "1280x800-ling-dark-collapsed-tooltip.png");
  expect(runtimeErrors).toEqual([]);
});

function createControlsState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_sidebar_controls", displayName: "Designer" })];
  state.threads = [];
  return state;
}

async function prepareSurface(page: Page, theme: "dark" | "light", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function expectHitArea(locator: Locator, minimum: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
}

async function expectInsideViewport(locator: Locator, page: Page): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  expect(await locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-section-disclosure/",
  import.meta.url,
));

test("Sidebar sections preserve geometry while channels and teammates load", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_loading", displayName: "Designer" })];
  await mockDaemon(page, state);
  await delayCollectionReads(page, 2_500);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation.locator('[data-sidebar-section="channels"] .sidebar-section-status')
    .getByRole("status", { name: "Loading channels..." })).toBeVisible();
  await expect(navigation.locator('[data-sidebar-section="teammates"] .sidebar-section-status')
    .getByRole("status", { name: "Loading teammates..." })).toBeVisible();
  await expect(navigation.locator(".sidebar-section-skeleton-row")).toHaveCount(5);
  await captureEvidence(page, "1440x960-ling-light-loading.png");

  await expect(navigation.getByRole("button", { name: "Engineering" })).toBeVisible({ timeout: 5_000 });
  await expect(navigation.getByRole("button", { name: "Designer", exact: true })).toBeVisible();
  await expect(navigation.locator(".sidebar-section-skeleton-row")).toHaveCount(0);
  const channelsToggle = navigation.getByRole("button", { name: "Channels" });
  const channelContent = navigation.locator('[data-sidebar-section="channels"] [data-ling-collapsible-content]');
  await expect(channelContent).toHaveCSS("animation-name", "none");
  await channelsToggle.click();
  await expect(channelsToggle).toHaveAttribute("aria-expanded", "false");
  await channelsToggle.click();
  await expect(channelsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(channelContent).toHaveCSS("animation-name", "ling-ui-collapsible-open");
  await expect(channelContent).toHaveCSS("animation-duration", "0.18s");
  await expectNoHorizontalOverflow(navigation);
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar disclosure supports keyboard, rapid reversal, stale state, and reduced motion", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_stale", displayName: "Designer" })];
  await mockDaemon(page, state, { healthResponses: [false, false, false, false] });
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const channelsToggle = navigation.getByRole("button", { name: "Channels" });
  await expect(navigation.getByRole("status", { name: "Channels: Stale" })).toBeVisible();
  await expect(navigation.getByRole("status", { name: "AI Teammates: Stale" })).toBeVisible();
  await expect(channelsToggle).toHaveAttribute("aria-expanded", "true");

  const content = navigation.locator('[data-sidebar-section="channels"] [data-ling-collapsible-content]');
  await expect(content).toHaveCSS("animation-duration", "0s");
  await channelsToggle.focus();
  await page.keyboard.press("Enter");
  await expect(channelsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(navigation.getByRole("button", { name: "No channel yet" })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-stale-collapsed.png");

  await page.keyboard.press("Enter");
  await expect(channelsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("button", { name: "No channel yet" })).toBeVisible();
  await channelsToggle.dblclick({ delay: 10 });
  await expect(channelsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("button", { name: "No channel yet" })).toBeVisible();
  await expectNoHorizontalOverflow(navigation);
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function delayCollectionReads(page: Page, delayMs: number): Promise<void> {
  await page.route(/^http:\/\/127\.0\.0\.1:17891\/(channels|teammates)(?:\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fallback();
  });
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
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

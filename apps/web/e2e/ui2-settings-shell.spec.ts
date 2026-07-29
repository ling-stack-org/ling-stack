import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openPendingStartupDiagnostics } from "./support/pending-settings-sections";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/settings-shell/",
  import.meta.url,
));

const settingsSectionLabels = [
  "Model Workbench",
  "Teammate Management",
  "Council Workspace",
  "Default authorization",
  "User profile",
  "Personalization",
  "Interface preferences",
  "External work",
  "MCP tool servers",
  "Skill library",
  "Archived items",
] as const;

test("Settings shell owns navigation, embedded tools, and exact return at 1440x960 light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const appNavigation = page.getByLabel("Ling Stack navigation");
  await appNavigation.getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await appNavigation.getByRole("button", { name: "Settings" }).click();

  const shell = page.locator("[data-ui2-settings-shell]");
  const settingsNavigation = page.getByLabel("Settings sections");
  const content = page.locator("[data-settings-content-state]");
  await expect(shell).toBeVisible();
  await expect(settingsNavigation).toBeVisible();
  await expect(appNavigation).toHaveCount(0);
  await expect(content).toHaveAttribute("data-settings-content-state", "section");

  for (const label of settingsSectionLabels) {
    const action = settingsNavigation.getByRole("button", { name: label, exact: true });
    await expect(action).toBeVisible();
    await expect(action).toHaveClass(/ling-ui-button/u);
    await expectMinimumHitArea(action, 32);
  }
  await expect(settingsNavigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(settingsNavigation.getByRole("button", { name: "User profile", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(settingsNavigation.getByRole("button", { name: "Startup and diagnostics", exact: true })).toHaveCount(0);
  await expect(settingsNavigation.locator('[data-settings-section="startup-diagnostics"]')).toBeHidden();
  await expect(settingsNavigation.getByRole("button", { name: "Back to app" })).toHaveClass(/ling-ui-button/u);
  await expectSettingsScrollOwnership(settingsNavigation, content);
  await captureEvidence(page, "1440x960-ling-light-settings-profile-shell.png");

  await settingsNavigation.getByRole("button", { name: "Model Workbench", exact: true }).click();
  await expect(page.locator(".provider-workbench")).toBeVisible();
  await expect(shell).toHaveAttribute("data-settings-active-section", "model-workbench");
  await expect(content).toHaveAttribute("data-settings-content-state", "workspace-tool");
  await expect(settingsNavigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(settingsNavigation.getByRole("button", { name: "Model Workbench", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".settings-tool-return-row")).toHaveCount(0);
  await expect(appNavigation).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-settings-embedded-model.png");

  await settingsNavigation.getByRole("button", { name: "User profile", exact: true }).click();
  await expect(content).toHaveAttribute("data-settings-content-state", "section");
  await settingsNavigation.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(appNavigation.getByRole("button", { name: "Engineering" })).toHaveAttribute("aria-current", "page");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Settings shell contains error, diagnostics, and desktop resize states at 1280x800 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route(/\/startup\/status(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "mock_settings_startup_unavailable", message: "Settings startup status is temporarily unavailable." },
    });
  });
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();

  const shell = page.locator("[data-ui2-settings-shell]");
  const settingsNavigation = page.getByLabel("Settings sections");
  const content = page.locator("[data-settings-content-state]");
  await openPendingStartupDiagnostics(page);
  await expect(shell).toHaveAttribute("data-settings-active-section", "startup-diagnostics");
  const startupFailure = content.getByRole("alert");
  await expect(startupFailure).toContainText("Startup status is unavailable");
  await expect(startupFailure.getByText("Error details", { exact: true })).toBeVisible();
  await expect(startupFailure.getByText("Settings startup status is temporarily unavailable.")).toBeHidden();
  await expectSettingsThemeTokens(settingsNavigation, content);
  await expectSettingsScrollOwnership(settingsNavigation, content);
  await captureEvidence(page, "1280x800-ling-dark-settings-startup-error.png");

  await page.getByRole("button", { name: "Open Run Diagnostics" }).click();
  await expect(page.getByRole("region", { name: "Run Diagnostics" })).toBeVisible();
  await expect(content).toHaveAttribute("data-settings-content-state", "run-diagnostics");
  await expect(settingsNavigation.locator('[data-settings-section="startup-diagnostics"]')).toHaveAttribute("aria-current", "page");

  await page.setViewportSize({ width: 980, height: 680 });
  await expect(shell).toBeVisible();
  await expectNoDocumentOverflow(page);
  await expectSettingsScrollOwnership(settingsNavigation, content);
  await captureEvidence(page, "980x680-ling-dark-settings-run-diagnostics.png");

  await settingsNavigation.getByRole("button", { name: "User profile", exact: true }).click();
  await expect(page.getByRole("region", { name: "Run Diagnostics" })).toHaveCount(0);
  await expect(content).toHaveAttribute("data-settings-content-state", "section");
  await expect(settingsNavigation.locator('[aria-current="page"]')).toHaveCount(1);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(page: Page, theme: "dark" | "light", width: number, height: number): Promise<void> {
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

async function expectMinimumHitArea(locator: Locator, minimum: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(minimum);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function expectSettingsScrollOwnership(navigation: Locator, content: Locator): Promise<void> {
  const contentElement = await content.elementHandle();
  expect(contentElement).not.toBeNull();
  const ownership = await navigation.evaluate((navigationElement, contentNode) => {
    const navigationStyle = getComputedStyle(navigationElement);
    const contentStyle = getComputedStyle(contentNode as Element);
    const workspace = navigationElement.closest("main.app-shell")?.querySelector<HTMLElement>(":scope > .workspace-settings-surface");
    const workspaceStyle = workspace ? getComputedStyle(workspace) : undefined;
    return {
      navigationOverflowY: navigationStyle.overflowY,
      contentOverflowY: contentStyle.overflowY,
      documentOverflowY: getComputedStyle(document.documentElement).overflowY,
      documentScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      workspaceOverflowX: workspaceStyle?.overflowX,
      workspaceOverflowY: workspaceStyle?.overflowY,
    };
  }, contentElement);
  expect(ownership.workspaceOverflowX).toBe("hidden");
  expect(ownership.workspaceOverflowY).toBe("hidden");
  expect(["auto", "scroll"]).toContain(ownership.navigationOverflowY);
  expect(["auto", "scroll"]).toContain(ownership.contentOverflowY);
  expect(ownership.documentScrolls).toBe(false);
}

async function expectSettingsThemeTokens(navigation: Locator, content: Locator): Promise<void> {
  const result = await navigation.evaluate((navigationElement, contentElement) => {
    const root = document.documentElement;
    const probe = document.createElement("span");
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.style.background = "var(--ling-bg-sidebar)";
    root.append(probe);
    const expectedNavigationBackground = getComputedStyle(probe).backgroundColor;
    probe.style.background = "var(--ling-bg-panel)";
    const expectedContentBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      navigationBackground: getComputedStyle(navigationElement).backgroundColor,
      expectedNavigationBackground,
      contentBackground: getComputedStyle(contentElement as Element).backgroundColor,
      expectedContentBackground,
    };
  }, await content.elementHandle());
  expect(result.navigationBackground).toBe(result.expectedNavigationBackground);
  expect(result.contentBackground).toBe(result.expectedContentBackground);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.height + 1);
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

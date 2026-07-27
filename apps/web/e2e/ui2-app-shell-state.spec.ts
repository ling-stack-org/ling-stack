import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolveAppPresentationSurface } from "../src/app/AppPresentationSurfaceBridge.js";
import type { ViewId } from "../src/app/view-types.js";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/app-shell-state/",
  import.meta.url,
));

test("AppShell returns from Settings to the exact view and selected channel without remounting", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  await mockDaemon(page, createShellState());
  await page.goto("/");

  const root = page.locator("html");
  const shell = page.locator("main.app-shell");
  const navigation = page.getByLabel("Ling Stack navigation");
  await shell.evaluate((element) => element.setAttribute("data-ui2-shell-state-marker", "preserved"));
  await expect(root).toHaveAttribute("data-ui-surface", "home");

  await navigation.getByRole("button", { name: "Work Board" }).click();
  await expect(page.locator(".work-board-page")).toBeVisible();
  await expect(root).toHaveAttribute("data-ui-surface", "management");
  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(navigation).toHaveCount(0);
  await expect(root).toHaveAttribute("data-ui-surface", "settings");
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(page.locator(".work-board-page")).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Work Board" })).toHaveAttribute("aria-current", "page");

  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(root).toHaveAttribute("data-ui-surface", "channel");
  await navigation.getByRole("button", { name: "Settings" }).click();
  await expect(root).toHaveAttribute("data-ui-surface", "settings");
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Engineering" })).toHaveAttribute("aria-current", "page");
  await expect(root).toHaveAttribute("data-ui-surface", "channel");
  await expect(shell).toHaveAttribute("data-ui2-shell-state-marker", "preserved");
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-channel-return.png");
  expect(runtimeErrors).toEqual([]);
});

test("AppShell keeps one fixed theme while route presentation surfaces change", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  await mockDaemon(page, createShellState());
  await page.goto("/");

  const root = page.locator("html");
  const shell = page.locator("main.app-shell");
  const navigation = page.getByLabel("Ling Stack navigation");
  await shell.evaluate((element) => element.setAttribute("data-ui2-route-marker", "preserved"));
  await expect(root).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(root).toHaveAttribute("data-theme-selection", "fixed");
  await expect(root).toHaveAttribute("data-ui-surface", "home");

  const recentConversation = navigation.getByRole("button", { name: "Open recent conversation 1" });
  await recentConversation.click();
  await expect(recentConversation).toHaveAttribute("aria-current", "page");
  await expect(root).toHaveAttribute("data-ui-surface", "conversation");
  await navigation.getByRole("button", { name: "Designer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Designer", level: 1 })).toBeVisible();
  await expect(root).toHaveAttribute("data-ui-surface", "conversation");

  await navigation.getByRole("button", { name: "Media Production" }).click();
  await expect(page.locator(".media-production-page")).toBeVisible();
  await expect(root).toHaveAttribute("data-ui-surface", "media-canvas");
  await navigation.getByRole("button", { name: "Inbox" }).click();
  await expect(page.locator(".approvals-panel")).toBeVisible();
  await expect(root).toHaveAttribute("data-ui-surface", "approvals");
  await expect(root).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(shell).toHaveAttribute("data-ui2-route-marker", "preserved");
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-approvals-surface.png");
  expect(runtimeErrors).toEqual([]);
});

test("Presentation surface resolver covers every ViewId and workspace identity state", () => {
  const surface = (activeView: ViewId, overrides: Partial<{
    hasSelectedChannel: boolean;
    hasSelectedConversation: boolean;
    hasSelectedTeammate: boolean;
  }> = {}) => resolveAppPresentationSurface({
    activeView,
    hasSelectedChannel: false,
    hasSelectedConversation: false,
    hasSelectedTeammate: false,
    ...overrides,
  });

  expect(surface("workspace")).toBe("home");
  expect(surface("workspace", { hasSelectedConversation: true })).toBe("conversation");
  expect(surface("workspace", { hasSelectedChannel: true, hasSelectedConversation: true })).toBe("channel");
  expect(surface("teammates")).toBe("management");
  expect(surface("teammates", { hasSelectedTeammate: true })).toBe("conversation");
  expect(surface("settings")).toBe("settings");
  expect(surface("media")).toBe("media-canvas");
  expect(surface("runs")).toBe("diagnostics");
  expect(surface("threads")).toBe("diagnostics");
  expect(surface("approvals")).toBe("approvals");

  const managementViews: readonly ViewId[] = ["councils", "automations", "providers", "plugins", "work_board", "profile"];
  for (const view of managementViews) expect(surface(view)).toBe("management");
});

function createShellState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id: "teammate_shell_designer", displayName: "Designer" })];
  state.threads = [{
    id: "thread_shell_conversation",
    workspaceId: "workspace_default",
    kind: "conversation",
    title: "Shell presentation conversation",
    objective: "Verify AppShell route state.",
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:01:00.000Z",
    metadata: { lastActivityAt: "2026-07-19T00:01:00.000Z" },
  }];
  return state;
}

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

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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

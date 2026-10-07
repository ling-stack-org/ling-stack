import { expect, test, type Locator, type Page } from "@playwright/test";
import { resolveAppViewportSize } from "../src/app/use-app-viewport-state.js";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";
import { openWorkBoardFromInbox } from "./support/open-work-board";

test("viewport resolver keeps Electron minimum, compact, standard, and large sizes deterministic", () => {
  expect(resolveAppViewportSize(980, 680)).toBe("minimum");
  expect(resolveAppViewportSize(1280, 800)).toBe("compact");
  expect(resolveAppViewportSize(1440, 960)).toBe("standard");
  expect(resolveAppViewportSize(2560, 1440)).toBe("large");
});

test("AppShell owns one portal root for Dialog and Toast ordering", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = [];
  state.channelBranches = [];
  await mockDaemon(page, state);
  await mockControlPlaneReads(page);
  await page.goto("/");

  const shell = page.locator("main.app-shell");
  const overlayRoot = page.locator("#ling-ui-overlay-root");
  await expect(shell).toHaveAttribute("data-ui2-shell-boundary", "true");
  await expect(shell).toHaveAttribute("data-ui2-viewport-size", "standard");
  await expect(shell).toHaveAttribute("data-ui2-client", "web");
  await expect(overlayRoot).toHaveCount(1);
  await expect(overlayRoot).toHaveAttribute("data-ling-overlay-root", "true");
  const toastViewport = overlayRoot.locator(".ling-ui-toast-viewport");
  await expect(toastViewport).toHaveCount(1);

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences" }).click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if (key === "ling-stack.themeSelection") throw new DOMException("Quota exceeded", "QuotaExceededError");
      original.call(this, key, value);
    };
  });
  await page.getByRole("radiogroup", { name: "Theme packs" }).getByRole("radio", { name: /Ling Dark/ }).click();
  const toast = overlayRoot.locator('.ling-ui-toast[data-scope="theme:storage"]');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-ling-overlay", "toast");

  await page.getByRole("button", { name: "Back to app" }).click();
  const dialogTrigger = navigation.getByRole("button", { name: "No channel yet" });
  await dialogTrigger.click();
  const dialog = overlayRoot.getByRole("dialog", { name: "New channel" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-ling-overlay", "dialog");
  await expect(overlayRoot.locator('[data-ling-overlay-scrim="dialog"]')).toBeVisible();

  const close = dialog.getByRole("button", { name: "Cancel" }).first();
  await expect(close).toHaveAttribute("title", "Cancel");
  await expect(overlayRoot.locator('[data-ling-overlay="tooltip"]')).toHaveCount(0);

  expect(await numericZIndex(dialog)).toBe(61);
  expect(await numericZIndex(toastViewport)).toBe(80);
  await expectNoPageOverflow(page);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(dialogTrigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("AppShell keeps Popover and active view while viewport size changes", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1440, 960);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await mockControlPlaneReads(page);
  await page.goto("/");

  const shell = page.locator("main.app-shell");
  const overlayRoot = page.locator("#ling-ui-overlay-root");
  await shell.evaluate((element) => element.setAttribute("data-ui2-resize-marker", "preserved"));
  await openWorkBoardFromInbox(page);
  const board = page.locator(".work-board-page");
  const filterTrigger = board.getByRole("button", { name: "Filter work" });
  await filterTrigger.click();
  const popover = overlayRoot.locator(".work-board-filter-popover");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-ling-overlay", "popover");
  expect(await numericZIndex(popover)).toBe(70);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(shell).toHaveAttribute("data-ui2-viewport-size", "compact");
  await expect(shell).toHaveAttribute("data-ui2-resize-marker", "preserved");
  await expect(board).toBeVisible();
  await expect(popover).toBeVisible();
  await expectInsideViewport(page, popover);
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 980, height: 680 });
  await expect(shell).toHaveAttribute("data-ui2-viewport-size", "minimum");
  await expect(shell).toHaveAttribute("data-ui2-resize-marker", "preserved");
  await expect(board).toBeVisible();
  await expect(popover).toBeVisible();
  await expectInsideViewport(page, popover);
  await expectNoPageOverflow(page);

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(board).toBeVisible();
  await expect(filterTrigger).toBeFocused();
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

async function mockControlPlaneReads(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:17891/control-plane/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/control-plane/snapshot") {
      const requestedDomains = (url.searchParams.get("domains") ?? "").split(",").map((domain) => domain.trim()).filter(Boolean);
      const domains = Object.fromEntries(requestedDomains.map((domain) => [domain, {
        ok: false,
        revision: 0,
        error: { code: "fixture_unavailable", message: "Use the mock daemon fallback for this domain." },
      }]));
      await route.fulfill({ json: { cwd, workspaceId: "workspace_default", generatedAt: "2026-07-19T00:00:00.000Z", latestEventSeq: 0, domains } });
      return;
    }
    if (url.pathname === "/control-plane/stream") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
}

async function numericZIndex(locator: Locator): Promise<number> {
  return locator.evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10));
}

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-collapse/",
  import.meta.url,
));

test("Sidebar collapse atomically swaps expanded navigation for an icon-only compact rail", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  await mockDaemon(page, createSidebarState({ dense: true }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? -1)).toBe(292);
  await expect(navigation.locator(".sidebar-product-row")).toHaveCount(0);

  await page.evaluate(() => {
    const frames: Array<{ readonly compactCount: number; readonly expandedCount: number; readonly expandedTextCount: number }> = [];
    Object.assign(window, { __lingSidebarCollapseFrames: frames });
    document.querySelector<HTMLButtonElement>(".desktop-window-sidebar-toggle")?.click();
    let remaining = 8;
    const sample = (): void => {
      frames.push({
        compactCount: document.querySelectorAll(".sidebar-compact-rail").length,
        expandedCount: document.querySelectorAll(".channel-left-drawer").length,
        expandedTextCount: document.querySelectorAll(".sidebar-section-title, .sidebar-row-shell").length,
      });
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await expect(page.locator("main.app-shell")).toHaveClass(/channel-sidebar-collapsed/u);
  await expect(navigation).toHaveAttribute("data-sidebar-mode", "compact");
  await page.waitForTimeout(180);
  const frames = await page.evaluate(() => (
    window as typeof window & {
      __lingSidebarCollapseFrames?: Array<{ readonly compactCount: number; readonly expandedCount: number; readonly expandedTextCount: number }>;
    }
  ).__lingSidebarCollapseFrames ?? []);
  expect(frames).toHaveLength(8);
  expect(frames.every((frame) => frame.compactCount === 1 && frame.expandedCount === 0 && frame.expandedTextCount === 0)).toBe(true);
  await expect(page.locator(".sidebar-rail-launcher")).toHaveCount(3);
  await expect(page.locator(".channel-left-drawer")).toHaveCount(0);
  await expect.poll(async () => page.locator("main.app-shell").evaluate((shell) => (
    Math.round(Number.parseFloat(getComputedStyle(shell).gridTemplateColumns))
  ))).toBe(48);
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-sidebar-compact.png");

  await page.getByRole("button", { name: "Show navigation" }).click();
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  await expect.poll(async () => Math.round((await page.getByLabel("Ling Stack navigation").boundingBox())?.width ?? -1)).toBe(292);
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar remains a single scrollable 292px surface in dense dark mode", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  await mockDaemon(page, createSidebarState({ dense: true }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const scrollRegion = navigation.locator(".sidebar-scroll-region");
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? -1)).toBe(292);
  const metrics = await scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(metrics.overflowX).toBe("hidden");
  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  await expect(navigation.locator(".sidebar-rail-launcher")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-sidebar-expanded.png");
  expect(runtimeErrors).toEqual([]);
});

test("narrow desktop starts with compact navigation and can open the full Sidebar", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 900, 800);
  await mockDaemon(page, createSidebarState());
  await page.goto("/");

  const shell = page.locator("main.app-shell");
  await expect(shell).toHaveClass(/channel-sidebar-collapsed/u);
  await expect(page.getByLabel("Ling Stack navigation")).toHaveAttribute("data-sidebar-mode", "compact");
  await expect(page.locator(".sidebar-rail-launcher")).toHaveCount(3);
  await expect.poll(async () => shell.evaluate((element) => (
    Math.round(Number.parseFloat(getComputedStyle(element).gridTemplateColumns))
  ))).toBe(48);

  await page.getByRole("button", { name: "Show navigation" }).click();
  const navigation = page.getByLabel("Ling Stack navigation");
  await expect(navigation).toBeVisible();
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? -1)).toBe(292);
  await expectNoHorizontalOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createSidebarState(options: { readonly dense?: boolean } = {}): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const channelCount = options.dense ? 14 : 3;
  const teammateCount = options.dense ? 10 : 3;
  const conversationCount = options.dense ? 9 : 3;
  state.channels = [
    ...state.channels,
    ...Array.from({ length: channelCount - 1 }, (_, index) => channel(
      `channel_sidebar_${index + 2}`,
      `Delivery channel ${index + 2}`,
    )),
  ];
  state.aiTeammates = Array.from({ length: teammateCount }, (_, index) => createMockTeammate({
    id: `teammate_sidebar_${index + 1}`,
    displayName: `Specialist ${index + 1}`,
  }));
  state.threads = Array.from({ length: conversationCount }, (_, index) => conversationThread(index));
  return state;
}

function channel(id: string, name: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    name,
    status: "active",
    boundPath: cwd,
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}

function conversationThread(index: number): Record<string, unknown> {
  const suffix = index + 1;
  const timestamp = `2026-07-24T00:${String(index).padStart(2, "0")}:00.000Z`;
  return {
    id: `thread_sidebar_${suffix}`,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: `Recent conversation ${suffix}`,
    objective: `Verify Sidebar conversation ${suffix}`,
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { lastActivityAt: timestamp, schemaVersion: 1 },
  };
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    const selection = { mode: "fixed", themeId: `ling-${resolvedTheme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.locator("html").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
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

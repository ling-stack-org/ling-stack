import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, cwd, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-object-rows/",
  import.meta.url,
));

test("UI 2.0 Sidebar object rows keep compact identity and actions in the expanded rail", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  await mockDaemon(page, createSidebarState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  const teammate = navigation.getByRole("button", { name: "Designer", exact: true });
  const avatar = teammate.locator(".teammate-avatar-image.compact");
  const label = teammate.locator('[data-ling-button-slot="label"]');
  const avatarBox = await avatar.boundingBox();
  const labelBox = await label.boundingBox();

  expect(avatarBox).not.toBeNull();
  expect(labelBox).not.toBeNull();
  expect(avatarBox!.width).toBeLessThanOrEqual(24);
  expect(labelBox!.x - (avatarBox!.x + avatarBox!.width)).toBeGreaterThanOrEqual(4);
  await teammate.hover();
  const teammateRow = navigation.locator('.sidebar-row-shell:has(.sidebar-row-main[aria-label="Designer"])');
  const archive = teammateRow.getByRole("button", { name: "Archive teammate" });
  await expect(archive).toBeVisible();
  await expectHitArea(archive, 32);

  const recent = navigation.locator(".sidebar-recent-row").filter({
    hasText: "A deliberately long conversation title",
  });
  await expect(recent).toContainText("A deliberately long conversation title");
  await expect(recent.locator(".sidebar-recent-copy")).toHaveCSS("min-width", "0px");
  await expectNoHorizontalOverflow(navigation);
  await captureEvidence(page, "1440x960-ling-light-expanded.png");
  expect(runtimeErrors).toEqual([]);
});

test("UI 2.0 Sidebar compact rail keeps object rows behind a section launcher in dark theme", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  await mockDaemon(page, createSidebarState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Engineering" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? 0)).toBe(48);

  await expect(navigation.locator(".sidebar-row-shell")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Engineering", exact: true })).toHaveCount(0);
  const channel = navigation.getByRole("button", { name: "Channels", exact: true });
  await expect(channel).toHaveAttribute("data-sidebar-rail-launcher", "channels");
  await expect(channel).toHaveAttribute("aria-pressed", "true");
  await expectHitArea(channel, 36);
  await expect(navigation.getByRole("button", { name: "Archive channel" })).toBeHidden();

  await channel.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText("Channels");
  await expect.poll(async () => Math.round((await tooltip.boundingBox())?.x ?? 0)).toBeGreaterThan(45);
  await channel.click();
  await expect.poll(async () => Math.round((await navigation.boundingBox())?.width ?? 0)).toBe(240);
  await expect(navigation.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoHorizontalOverflow(page.locator("html"));
  await captureEvidence(page, "1280x800-ling-dark-launcher-expanded.png");
  expect(runtimeErrors).toEqual([]);
});

function createSidebarState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_sidebar_designer", displayName: "Designer" }),
    createMockTeammate({ id: "teammate_sidebar_research", displayName: "Research" }),
  ];
  state.threads = Array.from({ length: 4 }, (_, index) => {
    const timestamp = `2026-07-19T00:0${index}:00.000Z`;
    return {
      id: `thread_sidebar_${index}`,
      workspaceId: "workspace_default",
      kind: "conversation" as const,
      teammateId: "ling_agent",
      title: index === 0
        ? "A deliberately long conversation title that must remain inside the Sidebar row"
        : `Recent conversation ${index + 1}`,
      objective: "Verify UI 2.0 Sidebar object-row geometry.",
      status: "open" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: { schemaVersion: 1 as const, lastActivityAt: timestamp },
    };
  });
  return state;
}

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

async function expectHitArea(locator: Locator, minimum: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
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

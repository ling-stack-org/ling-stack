import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/app-shell-geometry-p3/",
  import.meta.url,
));

const viewportCases = [
  { width: 900, height: 800 },
  { width: 901, height: 800 },
  { width: 1280, height: 800 },
  { width: 1440, height: 960 },
] as const;

for (const viewport of viewportCases) {
  test(`${viewport.width}x${viewport.height} keeps 292px to 48px Sidebar geometry synchronous`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    const theme = viewport.width === 1440 ? "light" : "dark";
    await prepareSurface(page, viewport.width, viewport.height, theme);
    await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
    await page.goto("/");

    const shell = page.locator("main.app-shell");
    const startsCompact = viewport.width <= 900;
    await expectShellGeometry(page, startsCompact ? 48 : 292);

    if (startsCompact) {
      await page.getByRole("button", { name: "Show navigation" }).click();
      await expectShellGeometry(page, 292);
    }

    await page.getByRole("button", { name: "Hide navigation" }).click();
    await expectShellGeometry(page, 48);
    await expect(page.getByLabel("Ling Stack navigation")).toHaveAttribute("data-sidebar-mode", "compact");
    await expect(page.locator(".sidebar-rail-launcher")).toHaveCount(3);
    await captureGeometryEvidence(page, runtimeErrors, `${viewport.width}x${viewport.height}-${theme}-compact.png`);

    await page.getByRole("button", { name: "Show navigation" }).click();
    await expectShellGeometry(page, 292);
    await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
    await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);
    const settingsShell = page.locator("main.app-shell.settings-fullscreen-shell");
    await expect(settingsShell).toBeVisible();
    await expect.poll(async () => settingsShell.evaluate((element) => (
      Math.round(element.getBoundingClientRect().width)
    ))).toBe(viewport.width);
    await expectNoDocumentOverflow(page);
    expect(runtimeErrors).toEqual([]);
  });
}

test("ordinary collapse has no width animation or transient navigation text", async ({ page }) => {
  await prepareSurface(page, 1280, 800, "light", "no-preference");
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const shell = page.locator("main.app-shell");
  const navigation = page.getByLabel("Ling Stack navigation");
  await expectShellGeometry(page, 292);
  const motion = await navigation.evaluate((element) => ({
    animationDuration: getComputedStyle(element).animationDuration,
    transitionDuration: getComputedStyle(element).transitionDuration,
  }));
  expect(cssTimeMs(motion.animationDuration)).toBe(0);
  expect(cssTimeMs(motion.transitionDuration)).toBe(0);

  const toggle = page.getByRole("button", { name: "Hide navigation" });
  const before = await toggle.boundingBox();
  await toggle.click();
  await expectShellGeometry(page, 48);
  await expect(page.getByLabel("Ling Stack navigation")).toHaveAttribute("data-sidebar-mode", "compact");
  await expect(page.locator(".sidebar-section-title, .sidebar-row-shell")).toHaveCount(0);
  await page.waitForTimeout(80);
  expect(await shell.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
  const after = await page.getByRole("button", { name: "Show navigation" }).boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(roundRect(after!)).toEqual(roundRect(before!));
});

async function prepareSurface(
  page: Page,
  width: number,
  height: number,
  theme: "dark" | "light",
  reducedMotion: "no-preference" | "reduce" = "reduce",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion });
  await page.addInitScript((resolvedTheme) => {
    const selection = { mode: "fixed", themeId: `ling-${resolvedTheme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function expectShellGeometry(page: Page, sidebarWidth: 48 | 292): Promise<void> {
  const geometry = await page.locator("main.app-shell").evaluate((shell) => {
    const navigation = shell.querySelector<HTMLElement>("[aria-label='Ling Stack navigation']");
    const workspace = shell.querySelector<HTMLElement>(":scope > .workspace");
    const shellBox = shell.getBoundingClientRect();
    const workspaceBox = workspace?.getBoundingClientRect();
    return {
      navigationCount: navigation ? 1 : 0,
      navigationWidth: navigation?.getBoundingClientRect().width ?? 0,
      shellFirstColumn: Number.parseFloat(getComputedStyle(shell).gridTemplateColumns),
      shellWidth: shellBox.width,
      workspaceLeft: workspaceBox?.left ?? -1,
      workspaceRight: workspaceBox?.right ?? -1,
    };
  });
  expect(geometry.navigationCount).toBe(1);
  expect(Math.round(geometry.navigationWidth)).toBe(sidebarWidth);
  expect(Math.round(geometry.shellFirstColumn)).toBe(sidebarWidth);
  expect(Math.round(geometry.workspaceLeft)).toBe(sidebarWidth);
  expect(Math.round(geometry.workspaceRight)).toBe(Math.round(geometry.shellWidth));
  await expectNoDocumentOverflow(page);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

function cssTimeMs(value: string): number {
  const normalized = value.trim();
  if (normalized.endsWith("ms")) return Number.parseFloat(normalized);
  if (normalized.endsWith("s")) return Number.parseFloat(normalized) * 1_000;
  return Number.parseFloat(normalized) || 0;
}

function roundRect(rectangle: { readonly height: number; readonly width: number; readonly x: number; readonly y: number }) {
  return {
    height: Math.round(rectangle.height),
    width: Math.round(rectangle.width),
    x: Math.round(rectangle.x),
    y: Math.round(rectangle.y),
  };
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureGeometryEvidence(page: Page, runtimeErrors: string[], filename: string): Promise<void> {
  if (!captureEvidence) return;
  expect(runtimeErrors).toEqual([]);
  await expectNoDocumentOverflow(page);
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

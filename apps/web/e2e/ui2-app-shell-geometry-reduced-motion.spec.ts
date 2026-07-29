import { expect, test, type Locator, type Page } from "@playwright/test";
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
  test(`${viewport.width}x${viewport.height} keeps reduced-motion Sidebar and AppShell geometry synchronous`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    const evidenceTheme = captureEvidence && viewport.width !== 1440 ? "dark" : "light";
    await prepareSurface(page, viewport.width, viewport.height, "reduce", evidenceTheme);
    await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
    await page.goto("/");

    const shell = page.locator("main.app-shell");
    const navigation = page.getByLabel("Ling Stack navigation");
    await expect(shell).toBeVisible();
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("button", { name: "Engineering" })).toBeVisible();

    await setSidebarCollapsed(page, false);
    await expectReducedMotionGeometry(page, viewport.width, 240);
    if (viewport.width === 1440) {
      await captureGeometryEvidence(page, runtimeErrors, "1440x960-ling-light-expanded.png");
    }
    if (viewport.width === 901) {
      await captureGeometryEvidence(page, runtimeErrors, "901x800-ling-dark-expanded-boundary.png");
    }
    await openSettingsAndExpectGeometry(page, viewport.width, false);

    await page.locator(".settings-app-return-button").click();
    await expect(navigation).toBeVisible();
    await setSidebarCollapsed(page, true);
    await expectReducedMotionGeometry(page, viewport.width, 48);
    if (viewport.width === 1280) {
      await captureGeometryEvidence(page, runtimeErrors, "1280x800-ling-dark-collapsed.png");
    }
    if (viewport.width === 900) {
      await captureGeometryEvidence(page, runtimeErrors, "900x800-ling-dark-collapsed-boundary.png");
    }
    await openSettingsAndExpectGeometry(page, viewport.width, true);
    if (viewport.width === 1280) {
      await captureGeometryEvidence(page, runtimeErrors, "1280x800-ling-dark-settings-fullscreen.png");
    }

    await page.locator(".settings-app-return-button").click();
    await expect(navigation).toBeVisible();
    await setSidebarCollapsed(page, false);
    await expectReducedMotionGeometry(page, viewport.width, 240);
    if (viewport.width === 1280) {
      await captureGeometryEvidence(page, runtimeErrors, "1280x800-ling-dark-reduced-motion-20ms-synchronized.png");
    }

    await expectNoDocumentOverflow(page);
    expect(runtimeErrors).toEqual([]);
  });
}

test("ordinary Sidebar motion uses one reversible 240ms shell transition", async ({ page }) => {
  await prepareSurface(page, 1280, 800, "no-preference");
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const motion = await page.locator("main.app-shell").evaluate((shell) => {
    const navigation = shell.querySelector<HTMLElement>(".channel-left-drawer");
    return {
      drawerAnimationName: navigation ? getComputedStyle(navigation).animationName : "",
      drawerAnimationDuration: navigation ? getComputedStyle(navigation).animationDuration : "",
      drawerTransitionDuration: navigation ? getComputedStyle(navigation).transitionDuration : "",
      drawerTransitionTimingFunction: navigation ? getComputedStyle(navigation).transitionTimingFunction : "",
      shellTransitionDuration: getComputedStyle(shell).transitionDuration,
      shellTransitionTimingFunction: getComputedStyle(shell).transitionTimingFunction,
    };
  });
  expect(motion.drawerAnimationName).toBe("none");
  expect(cssTimeMs(motion.drawerAnimationDuration)).toBe(0);
  expect(cssTimeMs(motion.drawerTransitionDuration)).toBe(240);
  expect(cssTimeMs(motion.shellTransitionDuration)).toBe(240);
  expect(motion.drawerTransitionTimingFunction).toMatch(/^cubic-bezier\(0\.2, 0, 0, 1\)/u);
  expect(motion.shellTransitionTimingFunction).toBe("cubic-bezier(0.2, 0, 0, 1)");

  const shell = page.locator("main.app-shell");
  const navigation = page.getByLabel("Ling Stack navigation");
  await expect.poll(async () => Math.round(await navigation.evaluate((element) => element.getBoundingClientRect().width))).toBe(240);

  await page.locator(".channel-sidebar-switch").evaluate((element: HTMLButtonElement) => element.click());
  await expect(shell).toHaveClass(/channel-sidebar-collapsed/u);
  await page.waitForTimeout(80);
  const collapsingWidth = await navigation.evaluate((element) => element.getBoundingClientRect().width);
  expect(collapsingWidth).toBeGreaterThan(48);
  expect(collapsingWidth).toBeLessThan(240);

  await page.locator(".channel-sidebar-switch").evaluate((element: HTMLButtonElement) => element.click());
  await expect(shell).not.toHaveClass(/channel-sidebar-collapsed/u);
  await page.waitForTimeout(80);
  const reversingWidth = await navigation.evaluate((element) => element.getBoundingClientRect().width);
  expect(reversingWidth).toBeGreaterThan(collapsingWidth);
  await expect.poll(async () => Math.round(await navigation.evaluate((element) => element.getBoundingClientRect().width))).toBe(240);
});

async function prepareSurface(
  page: Page,
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce",
  theme: "dark" | "light" = "light",
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

async function setSidebarCollapsed(page: Page, collapsed: boolean): Promise<void> {
  const shell = page.locator("main.app-shell");
  const currentlyCollapsed = await shell.evaluate((element) => element.classList.contains("channel-sidebar-collapsed"));
  const currentWidth = currentlyCollapsed ? 48 : 240;
  await expect.poll(async () => readSidebarGeometry(shell)).toEqual({
    navigationWidth: currentWidth,
    shellFirstColumn: currentWidth,
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  if (currentlyCollapsed !== collapsed) {
    await page.locator(".channel-sidebar-switch").click();
  }
  await expect(shell).toHaveClass(collapsed ? /channel-sidebar-collapsed/u : /^(?!.*channel-sidebar-collapsed)/u);
  await page.waitForTimeout(20);
}

async function readSidebarGeometry(shell: Locator): Promise<{ navigationWidth: number; shellFirstColumn: number }> {
  return shell.evaluate((element) => {
    const navigation = element.querySelector<HTMLElement>(".channel-left-drawer");
    return {
      navigationWidth: Math.round(navigation?.getBoundingClientRect().width ?? 0),
      shellFirstColumn: Math.round(Number.parseFloat(getComputedStyle(element).gridTemplateColumns)),
    };
  });
}

async function expectReducedMotionGeometry(page: Page, viewportWidth: number, sidebarWidth: number): Promise<void> {
  const geometry = await page.locator("main.app-shell").evaluate((shell) => {
    const navigation = shell.querySelector<HTMLElement>(".channel-left-drawer");
    const workspace = shell.querySelector<HTMLElement>(":scope > .workspace");
    const shellStyle = getComputedStyle(shell);
    const navigationStyle = navigation ? getComputedStyle(navigation) : undefined;
    const shellBox = shell.getBoundingClientRect();
    const navigationBox = navigation?.getBoundingClientRect();
    const workspaceBox = workspace?.getBoundingClientRect();
    return {
      navigationWidth: navigationBox?.width ?? 0,
      navigationAnimationDuration: navigationStyle?.animationDuration ?? "",
      navigationTransitionDuration: navigationStyle?.transitionDuration ?? "",
      shellFirstColumn: Number.parseFloat(shellStyle.gridTemplateColumns),
      shellTransitionDuration: shellStyle.transitionDuration,
      shellWidth: shellBox.width,
      workspaceLeft: workspaceBox?.left ?? -1,
      workspaceRight: workspaceBox?.right ?? -1,
    };
  });
  expect(cssTimeMs(geometry.shellTransitionDuration)).toBe(0);
  expect(cssTimeMs(geometry.navigationAnimationDuration)).toBe(0);
  expect(cssTimeMs(geometry.navigationTransitionDuration)).toBe(0);
  expect(Math.round(geometry.navigationWidth)).toBe(sidebarWidth);
  expect(Math.round(geometry.shellFirstColumn)).toBe(sidebarWidth);
  expect(Math.round(geometry.workspaceLeft)).toBe(sidebarWidth);
  expect(Math.round(geometry.workspaceRight)).toBe(viewportWidth);
  expect(Math.round(geometry.shellWidth)).toBe(viewportWidth);
  await expectNoDocumentOverflow(page);
}

async function openSettingsAndExpectGeometry(page: Page, viewportWidth: number, sidebarCollapsed: boolean): Promise<void> {
  await page.locator(".config-button").click();
  const shell = page.locator("main.app-shell.settings-fullscreen-shell");
  const workspace = shell.locator(":scope > .workspace-settings-surface");
  const settings = shell.locator(".settings-layout");
  const navigation = settings.locator(".settings-section-nav");
  const content = settings.locator(".settings-content-stack");
  await expect(settings).toBeVisible();
  await expect(shell).toHaveClass(sidebarCollapsed ? /channel-sidebar-collapsed/u : /^(?!.*channel-sidebar-collapsed)/u);
  await expect(page.getByLabel("Ling Stack navigation")).toHaveCount(0);

  const geometry = await shell.evaluate((element) => {
    const workspaceElement = element.querySelector<HTMLElement>(":scope > .workspace-settings-surface");
    const shellBox = element.getBoundingClientRect();
    const workspaceBox = workspaceElement?.getBoundingClientRect();
    const workspaceStyle = workspaceElement ? getComputedStyle(workspaceElement) : undefined;
    return {
      columns: getComputedStyle(element).gridTemplateColumns,
      shellWidth: shellBox.width,
      workspaceOverflowX: workspaceStyle?.overflowX,
      workspaceOverflowY: workspaceStyle?.overflowY,
      workspaceWidth: workspaceBox?.width ?? 0,
    };
  });
  expect(Math.round(Number.parseFloat(geometry.columns))).toBe(viewportWidth);
  expect(Math.round(geometry.shellWidth)).toBe(viewportWidth);
  expect(Math.round(geometry.workspaceWidth)).toBe(viewportWidth);
  expect(geometry.workspaceOverflowX).toBe("hidden");
  expect(geometry.workspaceOverflowY).toBe("hidden");
  await expect(navigation).toHaveCSS("overflow-y", "auto");
  await expect(content).toHaveCSS("overflow-y", "auto");
  await expectNoDocumentOverflow(page);
  await expect(workspace).toBeVisible();
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

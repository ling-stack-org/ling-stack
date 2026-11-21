import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { installNormalConversationFixture } from "./support/normal-conversation-fixture";
import { openMediaJobs } from "./support/media-jobs-fixtures";

const photo = await readFile(new URL("./fixtures/fronalpstock-3840.jpg", import.meta.url));

test("BG-25 ambient pages keep the backdrop while protected settings stay solid", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await prepare(page);

  await openBackgroundSettings(page);
  await page.locator("[data-background-file]").setInputFiles({
    name: "fronalpstock-3840.jpg",
    mimeType: "image/jpeg",
    buffer: photo,
  });
  await expect(page.locator("[data-background-preview]")).toHaveAttribute("data-draft", "true");
  await page.getByRole("button", { name: "Apply background", exact: true }).click();
  await expect(page.locator("[data-background-preview]")).toHaveAttribute("data-draft", "false");
  const evidence: Array<{
    readonly home: Awaited<ReturnType<typeof readWindowMaterial>>;
    readonly settings: Awaited<ReturnType<typeof readWindowMaterial>>;
    readonly themeId: string;
  }> = [];

  for (const [index, themeId] of (["ling-light", "ling-breeze", "ling-night"] as const).entries()) {
    if (index > 0) await openBackgroundSettings(page);
    await page.locator(`[data-theme-option-id="${themeId}"]`).click();
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
    await expect(page.locator("html")).toHaveAttribute("data-user-background", "ready");
    await expect(page.locator("html")).toHaveAttribute("data-ui-background-visible", "false");
    await expect(page.locator("[data-background-layer] img")).toBeHidden();

    const settingsMaterial = await readWindowMaterial(page, true);
    expect(isTransparent(settingsMaterial.settingsContent)).toBe(false);
    expect(isTransparent(settingsMaterial.settingsCard)).toBe(false);
    await page.locator(".settings-content-stack").evaluate((element) => element.scrollTo({ top: 0 }));
    await capture(page, testInfo, `${themeId}-settings-full-window.png`);

    await page.getByRole("button", { name: "Back to app", exact: true }).click();
    await expect(page.locator("[data-background-layer]")).toBeVisible();
    const homeMaterial = await readWindowMaterial(page, false);
    expect(homeMaterial.titlebarSurface).toBe(homeMaterial.workspace);
    expect(homeMaterial.titlebarSurface).toBe(homeMaterial.expectedTitlebar);
    expect(homeMaterial.titlebarLeading).toBe(homeMaterial.expectedSidebar);
    expect(homeMaterial.chrome).toBe("rgba(0, 0, 0, 0)");
    expect(homeMaterial.chromeShadow).toBe("none");
    await capture(page, testInfo, `${themeId}-home-full-window.png`);
    evidence.push({ themeId, settings: settingsMaterial, home: homeMaterial });
  }

  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-background-visible", "false");
  await expect(page.locator("[data-background-layer]")).toBeHidden();
  const evidencePath = process.env.LING_P0_EVIDENCE
    ? resolve(process.env.LING_P0_EVIDENCE, "evidence.json")
    : testInfo.outputPath("evidence.json");
  await writeFile(evidencePath, JSON.stringify({
    viewport: { width: 1440, height: 960 },
    background: "fronalpstock-3840.jpg",
    forcedColors: { backgroundVisible: false, layerHidden: true },
    themes: evidence,
    screenshots: evidence.flatMap(({ themeId }) => [
      `${themeId}-home-full-window.png`,
      `${themeId}-settings-full-window.png`,
    ]),
    scope: "Chromium production components and CSS with isolated daemon fixtures; no model invocation",
  }, null, 2));
});

test("BG-26 generation tasks keep the management surface solid over the ambient scene", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await prepare(page);

  await openBackgroundSettings(page);
  await page.locator("[data-background-file]").setInputFiles({
    name: "fronalpstock-3840.jpg",
    mimeType: "image/jpeg",
    buffer: photo,
  });
  await page.getByRole("button", { name: "Apply background", exact: true }).click();
  await expect(page.locator("[data-background-preview]")).toHaveAttribute("data-draft", "false");
  await expect(page.locator("html")).toHaveAttribute("data-ui-background-visible", "false");

  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-background-visible", "true");
  await openMediaJobs(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-background-visible", "true");
  await expect(page.locator("[data-background-layer] img")).toBeVisible();
  await expect(page.locator(".media-jobs-page")).toBeVisible();
  const material = await page.evaluate(() => {
    const style = (selector: string): CSSStyleDeclaration => getComputedStyle(document.querySelector(selector)!);
    const optionalStyle = (selector: string): CSSStyleDeclaration | undefined => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element) : undefined;
    };
    return {
      header: style(".media-jobs-header").backgroundColor,
      headerBorder: style(".media-jobs-header").borderBottomColor,
      inspector: optionalStyle(".media-job-inspector")?.backgroundColor ?? null,
      listBorder: style(".media-jobs-list-pane").borderRightColor,
      page: style(".media-jobs-page").backgroundColor,
      layout: style(".media-jobs-layout").backgroundColor,
      sidebarBorder: style(".left-nav").borderRightColor,
      sidebarBorderWidth: style(".left-nav").borderRightWidth,
      headerBorderWidth: style(".media-jobs-header").borderBottomWidth,
      listBorderWidth: style(".media-jobs-list-pane").borderRightWidth,
      sidebarShadow: style(".left-nav").boxShadow,
      workspaceShadow: style(".workspace").boxShadow,
    };
  });
  expect(isTransparent(material.page)).toBe(false);
  expect(isTransparent(material.header)).toBe(false);
  expect(isTransparent(material.headerBorder)).toBe(true);
  expect(material.headerBorderWidth).toBe("0px");
  expect(isTransparent(material.layout)).toBe(false);
  if (material.inspector !== null) expect(isTransparent(material.inspector)).toBe(false);
  expect(isTransparent(material.listBorder)).toBe(true);
  expect(material.listBorderWidth).toBe("0px");
  expect(material.sidebarBorderWidth).toBe("0px");
  expect(material.sidebarShadow).toBe("none");
  expect(material.workspaceShadow).toBe("none");
  await capture(page, testInfo, "generation-jobs-full-window.png");
});

test("BG-27 generation tasks keeps solid chrome when no backdrop is configured", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await prepare(page);

  await openMediaJobs(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-background-visible", "false");
  await expect(page.locator("[data-background-layer]")).toBeHidden();
  await expect(page.locator(".media-jobs-page")).toBeVisible();
  const material = await page.evaluate(() => {
    const style = (selector: string): CSSStyleDeclaration => getComputedStyle(document.querySelector(selector)!);
    const optionalStyle = (selector: string): CSSStyleDeclaration | undefined => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element) : undefined;
    };
    return {
      header: style(".media-jobs-header").backgroundColor,
      headerBorderWidth: style(".media-jobs-header").borderBottomWidth,
      inspector: optionalStyle(".media-job-inspector")?.backgroundColor ?? null,
      inspectorPresent: Boolean(document.querySelector(".media-job-inspector")),
      listBorderWidth: style(".media-jobs-list-pane").borderRightWidth,
      page: style(".media-jobs-page").backgroundColor,
    };
  });
  expect(isTransparent(material.page)).toBe(false);
  expect(isTransparent(material.header)).toBe(false);
  expect(material.headerBorderWidth).toBe("0px");
  if (material.inspectorPresent && material.inspector !== null) expect(isTransparent(material.inspector)).toBe(false);
  expect(material.listBorderWidth).toBe("0px");
  await page.setViewportSize({ width: 980, height: 680 });
  const narrowColumns = await page.locator(".media-jobs-layout").evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u).length);
  expect(narrowColumns).toBe(1);
  await page.setViewportSize({ width: 1440, height: 960 });
  await capture(page, testInfo, "generation-jobs-solid-full-window.png");
});

async function prepare(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "theme-p0-provider",
    lastCheck: { ok: true, code: "ready", message: "Controlled fixture", checkedAt: "2026-11-16T00:00:00.000Z" },
  })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.route(/\/notifications(?:\/stream)?$/u, (route) => route.fulfill({
    json: { schemaVersion: 1, notifications: [], nextSince: "" },
  }));
  await page.route("**/runtime/conversation-execution**", (route) => route.fulfill({
    json: { cwd: "", status: "not_selected", defaultRunnerId: "pi" },
  }));
  await page.goto("/");
}

async function openBackgroundSettings(page: Page): Promise<void> {
  const settingsButton = page.getByRole("button", { name: /^(Settings|设置)$/u }).last();
  await settingsButton.click({ timeout: 60_000 });
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences", exact: true }).click();
  await expect(page.locator("[data-background-settings]")).toBeVisible();
}

async function readWindowMaterial(page: Page, settings: boolean): Promise<{
  readonly chrome: string;
  readonly chromeShadow: string;
  readonly expectedSidebar: string;
  readonly expectedTitlebar: string;
  readonly settingsCard: string;
  readonly settingsContent: string;
  readonly sidebar: string;
  readonly titlebarLeading: string;
  readonly titlebarSurface: string;
  readonly workspace: string;
}> {
  return page.evaluate((settingsVisible) => {
    const style = (selector: string): CSSStyleDeclaration => getComputedStyle(document.querySelector(selector)!);
    const material = (color: string, alpha: string): string => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = `color-mix(in srgb, var(${color}) var(${alpha}, 100%), transparent)`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return value;
    };
    return {
      chrome: style(".desktop-window-chrome").backgroundColor,
      chromeShadow: style(".desktop-window-chrome").boxShadow,
      expectedSidebar: material("--ling-bg-sidebar", "--user-background-sidebar"),
      expectedTitlebar: material("--ling-bg-panel", "--user-background-workspace"),
      settingsCard: settingsVisible ? style(".settings-interface-section").backgroundColor : "rgba(0, 0, 0, 0)",
      settingsContent: settingsVisible ? style(".settings-content-stack").backgroundColor : "rgba(0, 0, 0, 0)",
      sidebar: style(settingsVisible ? ".settings-section-nav" : ".left-nav").backgroundColor,
      titlebarLeading: style(".desktop-window-chrome-leading").backgroundColor,
      titlebarSurface: style(".desktop-window-titlebar-surface").backgroundColor,
      workspace: style(".workspace").backgroundColor,
    };
  }, settings);
}

function isTransparent(value: string): boolean {
  return value === "transparent"
    || value === "rgba(0, 0, 0, 0)"
    || /^color\(srgb 0 0 0 \/ 0\)$/u.test(value);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.locator(".ling-ui-toast").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
  const directory = process.env.LING_P0_EVIDENCE;
  if (!directory) {
    await page.screenshot({ path: testInfo.outputPath(name), animations: "disabled" });
    return;
  }
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name), animations: "disabled" });
}

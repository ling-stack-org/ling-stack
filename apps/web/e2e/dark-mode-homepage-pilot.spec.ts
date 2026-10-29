import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const surfaceSelectors = {
  app: ".conversation-home",
  sidebar: ".channel-left-drawer",
  panel: ".conversation-home-shortcuts button",
  composer: '[data-conversation-composer="true"][data-surface="normal_conversation"]',
} as const;

test("Ling Dark homepage uses one neutral surface hierarchy", async ({ page }, testInfo) => {
  const browserErrors = collectBrowserErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
    localStorage.setItem("ling-stack.themeBootstrapPreference", "dark");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route("**/runtime/conversation-execution**", (route) => route.fulfill({
    json: { cwd: "", status: "not_selected", defaultRunnerId: "pi" },
  }));
  await page.goto("/");

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(root).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(root).toHaveAttribute("data-ui-surface", "home");
  await expect(page.getByLabel("对话首页")).toBeVisible();

  await assertSurfaceHierarchy(page);
  await assertTextContrast(page);
  await assertKeyboardFocus(page);
  await captureViewport(page, testInfo.outputPath("1440x960-ling-dark-homepage-pilot.png"), 1440, 960);
  await captureViewport(page, testInfo.outputPath("1280x800-ling-dark-homepage-pilot.png"), 1280, 800);

  expect(browserErrors).toEqual([]);
});

async function assertSurfaceHierarchy(page: Page): Promise<void> {
  const expected = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      app: resolveCssColor(style.getPropertyValue("--ling-bg-app")),
      sidebar: resolveCssColor(style.getPropertyValue("--ling-bg-sidebar")),
      panel: resolveCssColor(style.getPropertyValue("--ling-bg-panel")),
      composer: resolveCssColor(style.getPropertyValue("--ling-bg-composer")),
      hover: resolveCssColor(style.getPropertyValue("--ling-bg-subtle")),
    };

    function resolveCssColor(value: string): string {
      const probe = document.createElement("span");
      probe.style.backgroundColor = value.trim();
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }
  });

  const actual = {
    app: await backgroundColor(page, surfaceSelectors.app),
    sidebar: await backgroundColor(page, surfaceSelectors.sidebar),
    panel: await backgroundColor(page, surfaceSelectors.panel),
    composer: await backgroundColor(page, surfaceSelectors.composer),
  };

  expect(actual).toEqual({
    app: expected.app,
    sidebar: expected.sidebar,
    panel: expected.panel,
    composer: expected.composer,
  });
  expect(actual.app).toBe(actual.panel);
  expect(new Set(Object.values(actual)).size).toBe(3);
  for (const color of Object.values(actual)) {
    expect(isOpaquePureBlack(color)).toBe(false);
  }

  const shortcut = page.locator(surfaceSelectors.panel).first();
  await shortcut.hover();
  await expect.poll(() => shortcut.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(expected.hover);
}

async function assertTextContrast(page: Page): Promise<void> {
  const samples = await page.evaluate(() => [
    { selector: ".conversation-home h1", surface: ".conversation-home" },
    { selector: ".conversation-home-shortcuts button", surface: ".conversation-home-shortcuts button" },
    { selector: ".channel-left-drawer .nav-item", surface: ".channel-left-drawer" },
  ].map(({ selector, surface }) => {
    const element = document.querySelector(selector);
    const surfaceElement = document.querySelector(surface);
    if (!element || !surfaceElement) return undefined;
    return {
      selector,
      foreground: getComputedStyle(element).color,
      background: getComputedStyle(surfaceElement).backgroundColor,
    };
  }).filter((sample): sample is { selector: string; foreground: string; background: string } => Boolean(sample)));

  expect(samples).toHaveLength(3);
  for (const sample of samples) {
    expect(contrastRatio(sample.foreground, sample.background), sample.selector).toBeGreaterThanOrEqual(4.5);
  }
}

async function assertKeyboardFocus(page: Page): Promise<void> {
  const shortcut = page.locator(surfaceSelectors.panel).first();
  await shortcut.focus();
  const shortcutFocus = await shortcut.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(shortcutFocus.style).not.toBe("none");
  expect(shortcutFocus.width).toBeGreaterThanOrEqual(2);

  const input = page.locator(`${surfaceSelectors.composer} .tokenized-composer-input`);
  await input.focus();
  const composer = page.locator(surfaceSelectors.composer);
  await expect.poll(() => composer.evaluate((element) => getComputedStyle(element).borderColor)).toBe(
    await resolveTokenColor(page, "--ling-border-focus"),
  );
}

async function captureViewport(page: Page, path: string, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(width - 8, height - 8);
  await expectNoOverflow(page);
  await page.screenshot({ path, fullPage: true });
}

async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    documentX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    documentY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    shellX: Math.ceil(document.querySelector("main.app-shell")?.scrollWidth ?? 0)
      - Math.ceil(document.querySelector("main.app-shell")?.clientWidth ?? 0),
    shellY: Math.ceil(document.querySelector("main.app-shell")?.scrollHeight ?? 0)
      - Math.ceil(document.querySelector("main.app-shell")?.clientHeight ?? 0),
  }));
  expect(overflow.documentX).toBeLessThanOrEqual(0);
  expect(overflow.documentY).toBeLessThanOrEqual(0);
  expect(overflow.shellX).toBeLessThanOrEqual(0);
  expect(overflow.shellY).toBeLessThanOrEqual(0);
}

async function backgroundColor(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector).first();
  await expect(locator).toBeVisible();
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function resolveTokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = `var(${variable})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

function isOpaquePureBlack(color: string): boolean {
  const channels = color.match(/[\d.]+/gu)?.map(Number) ?? [];
  return channels.length >= 3
    && channels[0] === 0
    && channels[1] === 0
    && channels[2] === 0
    && (channels.length < 4 || channels[3] === 1);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number {
  const channels = color.match(/[\d.]+/gu)?.slice(0, 3).map((channel) => Number(channel) / 255) ?? [];
  if (channels.length !== 3) throw new Error(`Unable to parse color: ${color}`);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

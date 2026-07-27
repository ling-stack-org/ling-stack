import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, cwd } from "./support/mock-state";

test("Settings subnavigation uses shared Tabs with stable keyboard selection", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await mockControlPlaneReads(page);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Archived items/ }).click();

  const tabList = page.getByRole("tablist", { name: "Archived item categories" });
  const conversations = tabList.getByRole("tab", { name: /Conversations/ });
  const teammates = tabList.getByRole("tab", { name: /AI Teammates/ });
  const initialBox = await tabList.boundingBox();

  await expect(tabList).toHaveClass(/ling-ui-tabs-list/);
  await expect(conversations).toHaveAttribute("aria-selected", "true");
  await conversations.focus();
  await page.keyboard.press("ArrowRight");
  await expect(teammates).toHaveAttribute("aria-selected", "true");
  await teammates.click();
  await expect(teammates).toHaveAttribute("aria-selected", "true");

  const selectedBox = await tabList.boundingBox();
  expect(initialBox?.height).toBe(selectedBox?.height);
  expect(await tabList.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectNoPageOverflow(page);
  expect(browserErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("1440x960-ling-light-settings-tabs.png"),
    fullPage: true,
  });
});

test("Media Production view switcher keeps one shared segmented selection", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await mockControlPlaneReads(page);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Media Production" }).click();
  const switcher = page.getByRole("radiogroup", { name: "Media production views" });
  const studio = switcher.getByRole("radio", { name: "Production studio" });
  const jobs = switcher.getByRole("radio", { name: "Generation tasks" });
  const initialBox = await switcher.boundingBox();

  await expect(switcher).toHaveClass(/ling-ui-segmented-control/);
  await expect(studio).toHaveAttribute("aria-checked", "true");
  await studio.focus();
  await page.keyboard.press("ArrowRight");
  await expect(jobs).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".media-production-jobs-view")).toBeVisible();
  await jobs.click();
  await expect(jobs).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(studio).toHaveAttribute("aria-checked", "true");

  const finalBox = await switcher.boundingBox();
  expect(initialBox?.width).toBe(finalBox?.width);
  expect(initialBox?.height).toBe(finalBox?.height);
  await expectNoPageOverflow(page);
  expect(browserErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("1440x960-ling-light-media-segmented.png"),
    fullPage: true,
  });
});

test("Automation lightweight controls use one collision-safe Popover without closing the dialog", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_ui2", displayName: "中转站", model: "gpt-test" })];
  await mockDaemon(page, state);
  await mockAutomationReads(page);
  await mockControlPlaneReads(page);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "自动化" }).click();
  await page.locator(".automation-header-actions").getByRole("button", { name: "手动创建" }).click();
  const dialog = page.getByRole("dialog", { name: "手动创建" });
  const runtimeTrigger = dialog.getByRole("button", { name: /工作树|本地|对话/ }).first();
  await runtimeTrigger.click();

  let popover = page.locator(".automation-popover-panel");
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("data-ling-overlay", "popover");
  await expect(popover).not.toHaveCSS("position", "absolute");
  await expect(popover).toHaveCSS("animation-duration", "0s");
  await expectPopoverInsideViewport(page, popover);

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(runtimeTrigger).toBeFocused();

  await dialog.getByRole("button", { name: /每天 09:00/ }).click();
  await expect(page.locator(".automation-popover-panel")).toBeVisible();
  await dialog.getByRole("button", { name: /选择模型|中转站 · gpt-test/ }).click();
  popover = page.locator(".automation-popover-panel");
  await expect(popover).toHaveCount(1);
  await expect(popover).toBeVisible();
  await expectPopoverInsideViewport(page, popover);

  const colorChannels = await popover.evaluate((element) =>
    getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [],
  );
  expect(colorChannels).toHaveLength(3);
  expect(Math.max(...colorChannels)).toBeLessThan(64);
  await expectNoPageOverflow(page);
  expect(browserErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("1280x800-ling-dark-automation-popover.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

async function mockAutomationReads(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:17891/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/automations") {
      await route.fulfill({ json: { cwd, automations: [], templates: [] } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-drafts") {
      await route.fulfill({ json: { cwd, drafts: [], templates: [] } });
      return;
    }
    if (request.method() === "GET" && path === "/automation-runs") {
      await route.fulfill({ json: { cwd, automationRuns: [] } });
      return;
    }
    if (request.method() === "GET" && path === "/automations/scheduler") {
      await route.fulfill({ json: { cwd, schedulers: [] } });
      return;
    }
    await route.fallback();
  });
}

async function mockControlPlaneReads(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:17891/control-plane/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/control-plane/snapshot") {
      const requestedDomains = (url.searchParams.get("domains") ?? "")
        .split(",")
        .map((domain) => domain.trim())
        .filter(Boolean);
      const domains = Object.fromEntries(requestedDomains.map((domain) => [domain, {
        ok: false,
        revision: 0,
        error: { code: "fixture_unavailable", message: "Use the mock daemon fallback for this domain." },
      }]));
      await route.fulfill({
        json: {
          cwd,
          workspaceId: "workspace_default",
          generatedAt: "2026-07-18T00:00:00.000Z",
          latestEventSeq: 0,
          domains,
        },
      });
      return;
    }
    if (url.pathname === "/control-plane/stream") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
}

async function expectPopoverInsideViewport(page: Page, popover: Locator): Promise<void> {
  const box = await popover.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const source = message.location().url;
      errors.push(source ? `${message.text()} @ ${source}` : message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

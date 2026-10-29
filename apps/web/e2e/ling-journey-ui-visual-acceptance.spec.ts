import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { installNormalConversationFixture, normalConversationFixtureTitle } from "./support/normal-conversation-fixture";

const acceptanceDirectory = process.env.LING_JOURNEY_UI_EVIDENCE;
const sourceCommit = process.env.LING_THEME_COMMIT_SHA ?? "working-tree@912e3e8e835f68a0d62161e3d5694ce9f9f7c6cb";

interface ScreenshotEvidence {
  readonly file: string;
  readonly themeId: string;
  readonly surface: string;
  readonly backgroundSource: string;
  readonly backgroundOpacity: string;
  readonly colorScheme: string;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly commitSha: string;
}

interface BrowserEvidence {
  readonly sourceCommit: string;
  readonly viewport: { readonly width: number; readonly height: number } | null;
  readonly screenshots: readonly ScreenshotEvidence[];
  readonly computedStyles: Record<string, unknown>;
  readonly overflow: Record<string, number>;
  readonly consoleAndPageErrors: readonly string[];
}

test.describe.configure({ mode: "serial" });

test("Journey UI-01..UI-05 and UI-11: shell, home, composer and visual delta", async ({ page }, testInfo) => {
  const failures = collectBrowserErrors(page);
  const screenshots: ScreenshotEvidence[] = [];
  await prepare(page, "ling-journey");

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-journey");
  await expect(page.locator("html")).toHaveAttribute("data-background-source", "theme-scene");
  await expect(page.locator("[data-background-layer] svg[data-scene=\"farbound-journey\"]")).toBeVisible();
  await expect(page.locator("[data-background-layer] video")).toHaveCount(0);
  await expect(page.locator(".channel-left-drawer")).toBeVisible();
  await expect(page.locator(".desktop-window-chrome")).toBeVisible();
  await expect(page.locator(".conversation-home")).toBeVisible();
  await expect(page.getByLabel("New conversation composer", { exact: true })).toBeVisible();

  screenshots.push(await capture(page, testInfo, "ui-01-04-journey-home.png"));
  await page.getByRole("button", { name: "Hide navigation", exact: true }).click();
  await expect(page.locator(".sidebar-compact-rail")).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-02-journey-rail.png"));
  await page.getByRole("button", { name: "Show navigation", exact: true }).click();
  await expect(page.locator(".channel-left-drawer")).toBeVisible();

  const composer = page.getByLabel("New conversation composer", { exact: true });
  const textbox = composer.getByRole("textbox");
  await textbox.focus();
  await expect(composer).toHaveCSS("border-color", /rgb\(/u);
  screenshots.push(await capture(page, testInfo, "ui-05-journey-composer-focus.png"));

  const journeyStyles = await readSurfaceEvidence(page);
  expect(journeyStyles.sidebar.background).toMatch(/(?:rgba?|color\(srgb)/u);
  expect(journeyStyles.composer.background).toMatch(/(?:rgba?|color\(srgb)/u);
  expect(journeyStyles.send.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(journeyStyles.send.borderRadius).not.toBe("0px");

  await openSettings(page);
  await expect(page.locator("[data-theme-option-id=\"ling-journey\"]")).toHaveAttribute("aria-checked", "true");
  screenshots.push(await capture(page, testInfo, "ui-10-journey-settings.png"));
  await page.locator("[data-theme-option-id=\"ling-dark\"]").click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await expect(page.locator(".conversation-home")).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-11-ling-dark-comparison.png"));

  await writeEvidence(testInfo, screenshots, journeyStyles, failures, page);
  expect(failures).toEqual([]);
});

test("Journey UI-06..UI-12: conversation dock, overlays, fallback modes and containment", async ({ page }, testInfo) => {
  const failures = collectBrowserErrors(page, true);
  const screenshots: ScreenshotEvidence[] = [];
  const state = await prepare(page, "ling-journey");
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.getByRole("button", { name: /Open recent conversation \d+/u })
    .filter({ hasText: normalConversationFixtureTitle })
    .click();
  await expect(page.getByRole("heading", { name: normalConversationFixtureTitle })).toBeVisible();
  const conversation = page.locator(".normal-conversation-page");
  await expect(conversation).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-05-journey-conversation-default.png"));

  const composer = page.getByLabel("New conversation composer", { exact: true });
  const textbox = composer.getByRole("textbox");
  await textbox.fill("Keep this draft while checking Journey UI states");
  await textbox.focus();
  screenshots.push(await capture(page, testInfo, "ui-06-journey-composer-selected.png"));

  await page.route("**/conversations/attachments?**", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 500, json: { error: "controlled_upload_failure", message: "Controlled upload failure" } });
  });
  await composer.locator('input[type="file"]').setInputFiles({
    name: "journey-ui-error.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("controlled attachment error"),
  });
  await expect(composer.locator(".composer-preview-card.failed")).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-06-journey-composer-error.png"));

  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await expect(page.locator(".conversation-summary-popover")).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-09-journey-popover.png"));
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Show details", exact: true }).click();
  await expect(page.locator(".right-dock")).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-02-journey-right-dock.png"));

  const channelActions = page.getByRole("button", { name: "Channel actions", exact: true }).first();
  await channelActions.click();
  await expect(page.getByRole("menu")).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-09-journey-menu.png"));
  await page.getByRole("menuitem", { name: "New channel", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  screenshots.push(await capture(page, testInfo, "ui-09-journey-dialog.png"));
  await page.keyboard.press("Escape");

  await openSettings(page);
  await page.getByLabel("Settings sections").getByRole("button", { name: "Personalization", exact: true }).click();
  await expect(page.locator("[data-ui2-personalization]")).toBeVisible();
  const toneGroup = page.getByRole("radiogroup", { name: "Ling conversation tone" });
  await expect(toneGroup).toBeVisible();
  await expect(toneGroup.getByRole("radio", { name: "Pragmatic" })).toHaveAttribute("aria-checked", "true");
  await toneGroup.getByRole("radio", { name: "Friendly" }).click();
  await expect.poll(() => state.workspaceSettings.lingConversationTone).toBe("friendly");
  await expect(page.locator('.ling-ui-toast[data-scope="settings:personalization:tone:save"]')).toContainText(
    "Ling conversation tone applied",
  );
  screenshots.push(await capture(page, testInfo, "ui-09-journey-toast.png"));
  screenshots.push(await capture(page, testInfo, "ui-10-journey-settings-solid.png"));
  expect(await page.locator("html").getAttribute("data-ui-surface-recipe")).toBe("solid");
  await expect(page.locator("[data-background-layer]")).toBeHidden();

  await page.getByRole("button", { name: "Back to app", exact: true }).click();
  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.locator("[data-background-layer]")).toBeHidden();
  screenshots.push(await capture(page, testInfo, "ui-12-journey-forced-colors.png"));
  await page.emulateMedia({ forcedColors: "none" });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  await page.waitForTimeout(100);
  await expect(page.locator("html")).toHaveAttribute("data-ui-surface-recipe", "solid");
  screenshots.push(await capture(page, testInfo, "ui-12-journey-reduced-transparency.png"));
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });

  await page.setViewportSize({ width: 1170, height: 800 });
  await expect(page.locator("html")).toHaveAttribute("data-ui-surface-recipe", "solid");
  screenshots.push(await capture(page, testInfo, "ui-12-journey-narrow.png"));
  const overflow = await readOverflow(page);
  expect(overflow.documentX).toBeLessThanOrEqual(0);
  expect(overflow.shellX).toBeLessThanOrEqual(0);

  const styles = await readSurfaceEvidence(page);
  await writeEvidence(testInfo, screenshots, styles, failures, page, overflow);
  expect(failures).toEqual([]);
});

async function prepare(page: Page, themeId: "ling-journey" | "ling-dark") {
  await page.addInitScript((id) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = { mode: "fixed", themeId: id };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  }, themeId);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "journey-ui-provider",
    lastCheck: { ok: true, code: "ready", message: "Journey UI acceptance fixture", checkedAt: "2026-10-27T00:00:00.000Z" },
  })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.route("**/runtime/conversation-execution**", (route) => route.fulfill({
    json: { cwd: "", status: "not_selected", defaultRunnerId: "pi" },
  }));
  // The summary API was added after this fixture. Keep the visual acceptance
  // self-contained instead of falling through to the user's running daemon.
  await page.route("**/workspace/work-summary?**", (route) => route.fulfill({
    json: { cwd: "/tmp/ling-stack-workspace", sessions: [], workspaces: [], pullRequests: [], truncated: false, checkedAt: "2026-10-27T00:00:00Z" },
  }));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
  return state;
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Settings sections")
    .getByRole("button", { name: "Interface preferences", exact: true }).click();
  await expect(page.locator("[data-ui2-interface-preferences]")).toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, fileName: string): Promise<ScreenshotEvidence> {
  const directory = acceptanceDirectory ? resolve(acceptanceDirectory) : testInfo.outputDir;
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, fileName);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, fullPage: true });
  return {
    file: path,
    themeId: await page.locator("html").getAttribute("data-ui-theme") ?? "unknown",
    surface: await page.locator("html").getAttribute("data-ui-surface") ?? "unknown",
    backgroundSource: await page.locator("html").getAttribute("data-background-source") ?? "unknown",
    backgroundOpacity: await page.locator(".workspace-background-scrim").count()
      ? await page.locator(".workspace-background-scrim").evaluate((element) => getComputedStyle(element).opacity)
      : "not-applicable",
    colorScheme: await page.locator("html").getAttribute("data-color-scheme") ?? "unknown",
    viewport: page.viewportSize(),
    commitSha: sourceCommit,
  };
}

async function writeEvidence(
  testInfo: TestInfo,
  screenshots: readonly ScreenshotEvidence[],
  computedStyles: Record<string, unknown>,
  failures: readonly string[],
  page: Page,
  overflow?: Record<string, number>,
): Promise<void> {
  const directory = acceptanceDirectory ? resolve(acceptanceDirectory) : testInfo.outputDir;
  await mkdir(directory, { recursive: true });
  const evidence: BrowserEvidence = {
    sourceCommit,
    viewport: page.viewportSize(),
    screenshots,
    computedStyles,
    overflow: overflow ?? await readOverflow(page),
    consoleAndPageErrors: failures,
  };
  await writeFile(resolve(directory, `${testInfo.title.replace(/[^a-z0-9]+/giu, "-").toLowerCase()}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function readSurfaceEvidence(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return undefined;
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        color: style.color,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
      };
    };
    return {
      shell: read(".app-shell"),
      chrome: read(".desktop-window-chrome"),
      sidebar: read(".channel-left-drawer"),
      workspace: read(".workspace"),
      composer: read("[data-conversation-composer]"),
      send: read("[data-conversation-composer] .normal-conversation-send"),
      rightDock: read(".right-dock"),
      dialog: read('[role="dialog"]'),
      menu: read('[role="menu"]'),
      toast: read(".ling-ui-toast"),
    };
  });
}

async function readOverflow(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({
    documentX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    documentY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    shellX: Math.ceil(document.querySelector("main.app-shell")?.scrollWidth ?? 0)
      - Math.ceil(document.querySelector("main.app-shell")?.clientWidth ?? 0),
    shellY: Math.ceil(document.querySelector("main.app-shell")?.scrollHeight ?? 0)
      - Math.ceil(document.querySelector("main.app-shell")?.clientHeight ?? 0),
  }));
}

function collectBrowserErrors(page: Page, allowControlledFailure = false): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`page:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !(allowControlledFailure && /500 \(Internal Server Error\)/u.test(message.text()))) {
      failures.push(`console:${message.text()} [${message.location().url}]`);
    }
  });
  return failures;
}

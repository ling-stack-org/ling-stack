import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";
import { captureP6FeedbackEvidence } from "./support/p6-feedback-evidence";

const inspectorSourcePath = fileURLToPath(new URL(
  "../src/features/workspace/ChannelInspectorPanels.tsx",
  import.meta.url,
));

test.describe.configure({ mode: "serial" });

test("T13-P.8D protocol feedback is scoped to the global Toast and has no local success owner", async () => {
  const source = await readFile(inspectorSourcePath, "utf8");
  expect(source).toContain("scope: `channel:${channel.id}:protocol`");
  expect(source).toContain('tone: "info"');
  expect(source).toContain('tone: "success"');
  expect(source).toContain('<InlineFeedback className="compact" tone="danger" role="alert">');
  expect(source).not.toContain("inline-success");
  expect(source).not.toContain("setNotice");
  expect(source).not.toMatch(/setTimeout|setInterval/u);
});

test("T13-P.8D saves protocol changes through one scoped success Toast", async ({ page }) => {
  await initializePage(page, "ling-light", { width: 1440, height: 960 });
  const signals = collectBrowserSignals(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const editor = await openProtocolEditor(page);
  const language = editor.getByRole("combobox", { name: "AI response language" });
  await language.selectOption("zh-CN");
  await editor.getByRole("button", { name: "Save protocol" }).click();

  const toast = page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:protocol"]');
  await expect(toast).toContainText("Protocol updated");
  await expect(toast).toHaveAttribute("data-tone", "success");
  await expect(toast).toHaveCount(1);
  await expect(editor.locator(".inline-success")).toHaveCount(0);
  await expect(editor.locator(".ling-ui-inline-feedback")).toHaveCount(0);
  await expectNoOverflow(page, toast);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-P.8D keeps protocol save failure inline until a successful retry", async ({ page }) => {
  await initializePage(page, "ling-dark", { width: 1280, height: 800, reducedMotion: "reduce" });
  const signals = collectBrowserSignals(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  let saveAttempts = 0;
  await page.route(/\/channels\/channel_engineering\/protocol(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    saveAttempts += 1;
    if (saveAttempts === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: "channel_protocol_save_failed",
          message: "Protocol changes could not be saved.",
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");

  const editor = await openProtocolEditor(page);
  await editor.getByRole("combobox", { name: "AI response language" }).selectOption("follow_user");
  const save = editor.getByRole("button", { name: "Save protocol" });
  await save.click();

  const failure = editor.getByRole("alert");
  await expect(failure).toContainText("Protocol changes could not be saved.");
  await expect(failure).toHaveAttribute("data-tone", "danger");
  await page.waitForTimeout(3_200);
  await expect(failure).toBeVisible();
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:protocol"]')).toHaveCount(0);

  await save.click();
  await expect(failure).toHaveCount(0);
  const toast = page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:protocol"]');
  await expect(toast).toContainText("Protocol updated");
  await expect(toast).toHaveAttribute("data-tone", "success");
  expect(saveAttempts).toBe(2);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-P.6-F resets once through a busy-safe Dialog, restores focus, and emits the global Toast", async ({ page }) => {
  await initializePage(page, "ling-light", { width: 1440, height: 960 });
  const signals = collectBrowserSignals(page);
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => browserDialogs.push(dialog.type()));
  const state = createBaseState({ approvalStatus: "expired" });
  const engineeringChannel = state.channels[0];
  if (!isRecord(engineeringChannel)) throw new Error("Engineering channel fixture is missing");
  state.channels.push({
    ...engineeringChannel,
    id: "channel_research",
    name: "Research",
  });
  await mockDaemon(page, state);

  let resetRequests = 0;
  await page.route(/\/channels\/[^/]+\/protocol\/revert(?:\?.*)?$/u, async (route) => {
    resetRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fallback();
  });
  await page.goto("/");
  const editor = await openProtocolEditor(page);
  const trigger = editor.getByRole("button", { name: "Reset", exact: true });

  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "Reset channel protocol?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await captureP6FeedbackEvidence(
    page,
    "conversations/channel-protocol-reset-dialog",
    "1440x960-ling-light-confirm.png",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(resetRequests).toBe(0);

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "Reset channel protocol?" });
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
    .getByRole("button", { name: "Research", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Research", level: 1 })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(resetRequests).toBe(0);
  const currentDock = page.getByRole("complementary", { name: "Channel workspace dock" });
  if (await currentDock.isVisible().catch(() => false)) {
    await currentDock.getByRole("button", { name: "Close" }).click();
  }
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Engineering" }).first().click();
  await expect(page.getByRole("heading", { name: "Engineering", level: 1 })).toBeVisible();
  const reopenedEditor = await openProtocolEditor(page);
  const reopenedTrigger = reopenedEditor.getByRole("button", { name: "Reset", exact: true });

  await reopenedTrigger.click();
  dialog = page.getByRole("dialog", { name: "Reset channel protocol?" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(reopenedTrigger).toBeFocused();
  expect(resetRequests).toBe(0);

  await reopenedTrigger.click();
  dialog = page.getByRole("dialog", { name: "Reset channel protocol?" });
  const confirm = dialog.locator('.ling-ui-button[data-variant="danger"]');
  await confirm.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  await expect(reopenedTrigger).toBeFocused();
  expect(resetRequests).toBe(1);

  const toast = page.locator('.ling-ui-toast[data-scope="channel:channel_engineering:protocol-reset"]');
  await expect(toast).toContainText("Protocol reset");
  await expect(toast).toHaveAttribute("data-tone", "success");
  await expect(reopenedEditor.locator(".inline-success")).toHaveCount(0);
  await expectNoOverflow(page, toast);
  await captureP6FeedbackEvidence(
    page,
    "conversations/channel-protocol-reset-dialog",
    "1440x960-ling-light-success-toast.png",
  );
  expect(browserDialogs).toEqual([]);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-P.6-F keeps reset failure inline in the dark reduced-motion Dialog", async ({ page }) => {
  await initializePage(page, "ling-dark", { width: 1280, height: 800, reducedMotion: "reduce" });
  const signals = collectBrowserSignals(page);
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => browserDialogs.push(dialog.type()));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));

  let resetRequests = 0;
  await page.route(/\/channels\/channel_engineering\/protocol\/revert(?:\?.*)?$/u, async (route) => {
    resetRequests += 1;
    await route.fulfill({
      status: 500,
      json: {
        error: "channel_protocol_reset_failed",
        message: "Protocol reset failed for evidence.",
      },
    });
  });
  await page.goto("/");
  const editor = await openProtocolEditor(page);
  const trigger = editor.getByRole("button", { name: "Reset", exact: true });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Reset channel protocol?" });
  await dialog.getByRole("button", { name: "Reset", exact: true }).click();
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText("Protocol reset failed for evidence.");
  await page.waitForTimeout(350);
  await expect(failure).toBeVisible();
  await expect(page.locator(".inline-error")).toHaveCount(0);
  await expect(dialog).not.toHaveAttribute("aria-busy", "true");
  expect(resetRequests).toBe(1);
  await expect(page.locator('.ling-ui-toast[data-scope="channel:channel_engineering:protocol-reset"]')).toHaveCount(0);
  await expect(dialog).toHaveCSS("animation-name", "none");
  await expectNoOverflow(page, dialog);
  await captureP6FeedbackEvidence(
    page,
    "conversations/channel-protocol-reset-dialog",
    "1280x800-ling-dark-persistent-failure.png",
  );

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(browserDialogs).toEqual([]);
  expect(signals.consoleErrors).toEqual([]);
  expect(signals.pageErrors).toEqual([]);
});

test("T13-P.6-F production owner has no browser confirmation call", async () => {
  const source = await readFile(inspectorSourcePath, "utf8");
  expect(source).not.toMatch(/(?:window|globalThis)\.confirm\s*\(/u);
  expect(source).toContain("<ChannelProtocolResetDialog");
});

async function openProtocolEditor(page: Page): Promise<Locator> {
  const heading = page.getByRole("heading", { name: "Engineering", level: 1 });
  if (!(await heading.isVisible().catch(() => false))) {
    await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Engineering" }).first().click();
  }
  await expect(heading).toBeVisible();
  await page.getByRole("toolbar", { name: "Workspace task toolbar" })
    .getByRole("button", { name: "Show details" })
    .click();
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  await expect(dock).toBeVisible();
  const inspector = dock.getByRole("region", { name: "Channel inspector" });
  if (!(await inspector.isVisible().catch(() => false))) {
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
  }
  await expect(inspector).toBeVisible();
  await inspector.getByRole("button", { name: "Protocol", exact: true }).click();
  const editor = inspector.locator(".channel-protocol-editor");
  await expect(editor.getByRole("button", { name: "Reset", exact: true })).toBeEnabled();
  return editor;
}

async function initializePage(
  page: Page,
  themeId: "ling-light" | "ling-dark",
  viewport: { readonly width: number; readonly height: number; readonly reducedMotion?: "reduce" },
): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.emulateMedia({
    colorScheme: themeId === "ling-dark" ? "dark" : "light",
    reducedMotion: viewport.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ savedThemeId }) => {
    const selection = { mode: "fixed", themeId: savedThemeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", savedThemeId === "ling-dark" ? "dark" : "light");
    localStorage.setItem("ling-stack.themeBootstrapPreference", savedThemeId === "ling-dark" ? "dark" : "light");
  }, { savedThemeId: themeId });
}

async function expectNoOverflow(page: Page, target: Locator): Promise<void> {
  const geometry = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      right: rect.right,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

function collectBrowserSignals(page: Page): { readonly consoleErrors: string[]; readonly pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

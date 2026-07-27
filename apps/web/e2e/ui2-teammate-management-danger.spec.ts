import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  isRecord,
  type MockState,
} from "./support/mock-state";

const ordinaryId = "teammate_danger_reviewer";
const ordinaryName = "Lifecycle reviewer with a deliberately long identity for containment";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-danger/",
  import.meta.url,
));

test("ordinary Danger uses shared controls, contained Input focus, one-Esc close, and trigger restore", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const browserDialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    browserDialogs.push(dialog.message());
    await dialog.dismiss();
  });
  const state = createDangerState();
  await mockDaemon(page, state);
  await page.goto("/");

  const panel = await openDanger(page, ordinaryName);
  await expect(panel.getByRole("button", { name: "Disable" })).toHaveClass(/ling-ui-button/);
  const trigger = panel.getByRole("button", { name: "Hard delete" });
  await expect(trigger).toHaveClass(/ling-ui-button/);
  await captureEvidence(page, "1440x960-ling-light-danger-default.png");

  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Hard delete private data" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const reason = dialog.getByRole("textbox", { name: "Reason" });
  const shell = reason.locator("..");
  await page.waitForTimeout(250);
  const beforeFocus = await inputGeometry(shell, reason);
  await reason.focus();
  await reason.fill("Documented cleanup reason ".repeat(18));
  const afterFocus = await inputGeometry(shell, reason);
  expect(Math.abs(afterFocus.shellHeight - beforeFocus.shellHeight)).toBeLessThanOrEqual(0.5);
  expect(afterFocus.nativeTop).toBeGreaterThanOrEqual(afterFocus.shellTop - 0.5);
  expect(afterFocus.nativeBottom).toBeLessThanOrEqual(afterFocus.shellBottom + 0.5);
  expect(afterFocus.nativeBorderWidth).toBe("0px");
  expect(afterFocus.nativeBoxShadow).toBe("none");
  await captureEvidence(page, "1440x960-ling-light-delete-dialog-focus.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(browserDialogs).toEqual([]);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("hard-delete protects busy dismissal, retains reason on failure, retries, removes, and focuses fallback", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createDangerState();
  const failureGate = deferred<void>();
  const requestBodies: Record<string, unknown>[] = [];
  let attempts = 0;
  await mockDaemon(page, state);
  await routeTeammateMutation(page, async (route, teammateId, action) => {
    if (teammateId !== ordinaryId || action !== "hard-delete") {
      await route.fallback();
      return;
    }
    attempts += 1;
    requestBodies.push(await route.request().postDataJSON() as Record<string, unknown>);
    if (attempts === 1) {
      await failureGate.promise;
      await route.fulfill({
        status: 503,
        json: { error: "retention_unavailable", message: "Retention cleanup is unavailable." },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");

  const panel = await openDanger(page, ordinaryName);
  await panel.getByRole("button", { name: "Hard delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Hard delete private data" });
  const reason = dialog.getByRole("textbox", { name: "Reason" });
  await reason.fill("retain this reason after failure");
  const confirm = dialog.getByRole("button", { name: "Hard delete" });
  await confirm.click();
  await expect(confirm).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  failureGate.resolve();

  await expect(dialog.getByText("Retention cleanup is unavailable.", { exact: true })).toBeVisible();
  await expect(reason).toHaveValue("retain this reason after failure");
  await captureEvidence(page, "1280x800-ling-dark-delete-failure.png");
  await confirm.click();

  await expect(dialog).toHaveCount(0);
  const fallback = page.getByRole("textbox", { name: "Search teammates" });
  await expect(fallback).toBeVisible();
  await expect(fallback).toBeFocused();
  expect(requestBodies).toEqual([
    { reason: "retain this reason after failure" },
    { reason: "retain this reason after failure" },
  ]);
  expect(state.aiTeammates.some((item) => isRecord(item) && item.id === ordinaryId)).toBe(false);
  await captureEvidence(page, "1280x800-ling-dark-delete-success-fallback.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("disable busy and failure stay scoped while other danger and settings actions remain available", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createDangerState();
  const failureGate = deferred<void>();
  await mockDaemon(page, state);
  await routeTeammateMutation(page, async (route, teammateId, action) => {
    if (teammateId === ordinaryId && action === "disable") {
      await failureGate.promise;
      await route.fulfill({
        status: 503,
        json: { error: "disable_unavailable", message: "Disable is unavailable." },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");

  const panel = await openDanger(page, ordinaryName);
  const disable = panel.getByRole("button", { name: "Disable" });
  const hardDelete = panel.getByRole("button", { name: "Hard delete" });
  await disable.click();
  await expect(disable).toHaveAttribute("aria-busy", "true");
  await expect(hardDelete).toBeEnabled();
  const settings = page.getByLabel("Settings sections");
  await expect(settings.getByRole("button", { name: "Profile" })).toBeEnabled();
  await settings.getByRole("button", { name: "Profile" }).click();
  failureGate.resolve();
  await settings.getByRole("button", { name: "Danger zone" }).click();

  const reopened = page.locator("[data-ui2-teammate-danger]");
  await expect(reopened.getByText("Disable is unavailable.", { exact: true })).toBeVisible();
  await expect(reopened.getByRole("button", { name: "Disable" })).not.toHaveAttribute("aria-busy", "true");
  await expect(reopened.getByRole("button", { name: "Hard delete" })).toBeEnabled();
  await captureEvidence(page, "1280x800-ling-dark-disable-failure.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("delayed disable result cannot cross a teammate identity switch", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const secondId = "teammate_danger_second";
  const secondName = "Second lifecycle reviewer";
  const state = createDangerState([
    createOrdinaryTeammate(),
    createMockTeammate({ id: secondId, displayName: secondName, providerPresetId: "provider_ready" }),
  ]);
  const oldRequestGate = deferred<void>();
  await mockDaemon(page, state);
  await routeTeammateMutation(page, async (route, teammateId, action) => {
    if (teammateId === ordinaryId && action === "disable") {
      await oldRequestGate.promise;
      await route.fulfill({
        status: 503,
        json: { error: "old_disable_failure", message: "Old teammate mutation failed." },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");

  const oldPanel = await openDanger(page, ordinaryName);
  await oldPanel.getByRole("button", { name: "Disable" }).click();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: secondName }).click();
  const currentPanel = await openDanger(page, secondName);
  oldRequestGate.resolve();
  await expect(currentPanel.getByText("Unknown error", { exact: true })).toHaveCount(0);
  await expect(currentPanel.getByRole("button", { name: "Disable" })).not.toHaveAttribute("aria-busy", "true");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("protected Ling Agent has a truthful read-only Danger surface and zero mutation controls", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createDangerState([
    createMockTeammate({
      id: "ling_agent",
      kind: "system_teammate",
      systemRole: "ling_agent",
      protectedProfile: true,
      displayName: "Ling Agent",
      providerPresetId: "provider_ready",
    }),
    createMockTeammate({
      id: "system_coordinator",
      kind: "system_teammate",
      displayName: "系统协调器",
      providerPresetId: "provider_ready",
    }),
    createMockTeammate({
      id: "protected_reviewer",
      protectedProfile: true,
      displayName: "受保护审查员",
      providerPresetId: "provider_ready",
    }),
  ]);
  let mutationRequests = 0;
  await mockDaemon(page, state);
  await routeTeammateMutation(page, async (route, _teammateId, action) => {
    if (action === "disable" || action === "hard-delete") mutationRequests += 1;
    await route.fallback();
  });
  await page.goto("/");

  const panel = await openDanger(page, "Ling Agent", chineseLabels);
  await expect(panel.getByText("受保护的队友", { exact: true })).toBeVisible();
  await expect(panel.getByText("Ling Agent 的生命周期和权限由 Ling Stack 管理。", { exact: true })).toBeVisible();
  await expect(panel.getByText("只读", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "停用" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "硬删除" })).toHaveCount(0);
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  expect(mutationRequests).toBe(0);
  await captureEvidence(page, "1280x800-ling-dark-protected-read-only-zh-CN.png");

  for (const teammateName of ["系统协调器", "受保护审查员"]) {
    const managedPanel = await openDanger(page, teammateName, chineseLabels);
    await expect(managedPanel.getByText("受保护的队友", { exact: true })).toBeVisible();
    await expect(managedPanel.getByText("由 Ling Stack 管理", { exact: true })).toBeVisible();
    await expect(managedPanel.getByRole("button", { name: "停用" })).toHaveCount(0);
    await expect(managedPanel.getByRole("button", { name: "硬删除" })).toHaveCount(0);
    await expect(managedPanel.getByRole("textbox")).toHaveCount(0);
  }
  expect(mutationRequests).toBe(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createOrdinaryTeammate(): Record<string, unknown> {
  return createMockTeammate({
    id: ordinaryId,
    displayName: ordinaryName,
    description: "Reviews irreversible lifecycle boundaries without expanding retention semantics.",
    providerPresetId: "provider_ready",
  });
}

function createDangerState(teammates: unknown[] = [createOrdinaryTeammate()]): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ready",
    displayName: "Ready chat route",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "ready", checkedAt: "2026-07-22T00:00:00.000Z" },
  })];
  state.aiTeammates = teammates;
  return state;
}

const englishLabels = {
  danger: "Danger zone",
  details: "Show details",
  dock: "Private chat workspace dock",
  settings: "Settings",
  settingsSections: "Settings sections",
} as const;

const chineseLabels = {
  danger: "危险操作区",
  details: "显示详情",
  dock: "私聊工作区面板",
  settings: "设置",
  settingsSections: "设置分组",
} as const;

type DangerLabels = typeof englishLabels | typeof chineseLabels;

async function openDanger(
  page: Page,
  teammateName: string,
  labels: DangerLabels = englishLabels,
): Promise<Locator> {
  const navButton = page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName });
  await expect(navButton).toBeVisible();
  await navButton.click();
  const chatHeader = page.locator("[data-ui2-teammate-chat-header]");
  await expect(chatHeader).toBeVisible();
  if (await page.getByLabel(labels.dock).count() === 0) {
    await chatHeader.getByRole("button", { name: labels.details }).click();
  }
  await page.getByLabel(labels.dock).getByRole("button", { name: labels.settings }).click();
  const settings = page.getByLabel(labels.settingsSections);
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: labels.danger }).click();
  const panel = page.locator("[data-ui2-teammate-danger]");
  await expect(panel).toBeVisible();
  return panel;
}

async function routeTeammateMutation(
  page: Page,
  handler: (route: Route, teammateId: string, action: "disable" | "hard-delete" | "other") => Promise<void>,
): Promise<void> {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const match = /^\/teammates\/([^/]+)(?:\/(hard-delete))?$/.exec(new URL(request.url()).pathname);
    if (!match) {
      await route.fallback();
      return;
    }
    const teammateId = decodeURIComponent(match[1]);
    const action = match[2] === "hard-delete"
      ? "hard-delete"
      : request.method() === "DELETE"
        ? "disable"
        : "other";
    await handler(route, teammateId, action);
  });
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = `ling-${theme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function inputGeometry(shell: Locator, input: Locator): Promise<{
  readonly nativeBorderWidth: string;
  readonly nativeBottom: number;
  readonly nativeBoxShadow: string;
  readonly nativeTop: number;
  readonly shellBottom: number;
  readonly shellHeight: number;
  readonly shellTop: number;
}> {
  return await shell.evaluate((shellElement, inputElement) => {
    const shellRect = shellElement.getBoundingClientRect();
    const nativeRect = (inputElement as HTMLElement).getBoundingClientRect();
    const nativeStyle = getComputedStyle(inputElement as HTMLElement);
    return {
      nativeBorderWidth: nativeStyle.borderTopWidth,
      nativeBottom: nativeRect.bottom,
      nativeBoxShadow: nativeStyle.boxShadow,
      nativeTop: nativeRect.top,
      shellBottom: shellRect.bottom,
      shellHeight: shellRect.height,
      shellTop: shellRect.top,
    };
  }, await input.elementHandle());
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve: (value?: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

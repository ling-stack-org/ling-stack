import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/app-shell-feedback-permission/",
  import.meta.url,
));

test("offline feedback preserves the active view and scopes reconnect loading", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, {
    healthResponseDelayMs: 350,
    healthResponses: [false, false, true],
  });
  await page.goto("/");

  const shell = page.locator("main.app-shell");
  const navigation = page.getByLabel("Ling Stack navigation");
  const connectionStatus = page.locator(".app-connection-status");
  const feedback = page.getByRole("alert").filter({ hasText: "Local service is unavailable" });
  await expect(feedback).toBeVisible();
  await shell.evaluate((element) => element.setAttribute("data-ui2-feedback-marker", "preserved"));

  await navigation.getByRole("button", { name: "Work Board" }).click();
  const workBoard = page.locator(".work-board-page");
  await expect(workBoard).toBeVisible();
  await expect(feedback).toContainText("Some information may be out of date");
  await expect(connectionStatus).toHaveCSS("z-index", "59");
  await captureEvidence(page, "1440x960-ling-light-offline-feedback.png");

  const reconnect = feedback.getByRole("button", { name: "Reconnect" });
  await reconnect.click();
  await expect(reconnect).toHaveAttribute("aria-busy", "true");
  await expect(reconnect).toBeDisabled();
  await expect(workBoard).toBeVisible();
  await expect(shell).toHaveAttribute("data-ui2-feedback-marker", "preserved");
  await expect(feedback).toHaveCount(0);
  await expect(workBoard).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("full access confirmation preserves draft, focus, and permission evidence", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const state = createFullAccessState();
  await mockDaemon(page, state, { healthResponses: [true] });
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "New conversation" }).click();
  const home = page.getByLabel("Conversation home");
  await expect(home.getByRole("button", { name: /Selected permission preset Full access/ })).toBeVisible();
  await expect(home.getByRole("button", { name: /Selected model gpt-5\.5/ })).toBeVisible();
  const input = home.getByRole("textbox", { name: "Conversation message" });
  const send = home.getByRole("button", { name: "Send" });
  await input.fill("Inspect trusted files without losing this draft");
  await send.click();

  let dialog = page.locator("#ling-ui-overlay-root").getByRole("dialog", { name: "Confirm full access" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-ling-overlay", "dialog");
  await expect(dialog).toHaveCSS("z-index", "61");
  expect(await numericZIndex(dialog)).toBeGreaterThan(59);
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await expect(dialog.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Cancel" })).toBeFocused();
  await captureEvidence(page, "1280x800-ling-dark-full-access-confirmation.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(send).toBeFocused();
  await expect(input).toHaveAttribute("data-value", "Inspect trusted files without losing this draft");
  expect(state.runs).toHaveLength(0);

  await send.click();
  dialog = page.locator("#ling-ui-overlay-root").getByRole("dialog", { name: "Confirm full access" });
  await dialog.getByRole("button", { name: "Start with full access" }).click();
  await expect.poll(() => state.runs.length).toBe(1);
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? snapshot.permissionConfirmation : undefined;
  }).toMatchObject({
    confirmed: true,
    mode: "full_access",
    reason: "user_confirmed_full_access",
  });
  await expect.poll(() => {
    const snapshot = state.runs[0]?.requestSnapshot;
    return isRecord(snapshot) ? [snapshot.authorizationMode, snapshot.workspaceAccessMode] : [];
  }).toEqual(["always", "full_access"]);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createFullAccessState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "provider_full_access_ui2", displayName: "Local Relay", model: "gpt-5.5" })];
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultAuthorizationMode: "always",
    defaultWorkspaceAccessMode: "full_access",
    defaultPermissionMode: "full_access",
    defaultPermissionPreset: "full_access",
  };
  state.runs = [];
  return state;
}

async function prepareSurface(page: Page, theme: "dark" | "light", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function numericZIndex(locator: Locator): Promise<number> {
  return locator.evaluate((element) => Number.parseInt(getComputedStyle(element).zIndex, 10));
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

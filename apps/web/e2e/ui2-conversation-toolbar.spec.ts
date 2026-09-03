import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/shared-toolbar/",
  import.meta.url,
));

for (const fixture of [
  { theme: "light" as const, width: 1440, height: 960 },
  { theme: "dark" as const, width: 1280, height: 800 },
]) {
  test(`conversation toolbars share UI 2.0 controls at ${fixture.width}x${fixture.height} ${fixture.theme}`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await prepareSurface(page, fixture.theme, fixture.width, fixture.height);
    const teammateName = "Ling Engineer";
    const state = createBaseState({ approvalStatus: "expired" });
    state.providers = [createChatProvider({
      id: "provider_ui2_conversation_toolbar",
      displayName: "Local Relay",
      model: "gpt-5.5",
      lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-24T03:00:00.000Z" },
    })];
    state.aiTeammates = [createMockTeammate({
      id: "teammate_ui2_conversation_toolbar",
      displayName: teammateName,
    })];
    await mockDaemon(page, state);
    await page.goto("/");

    await openEngineeringChannel(page);
    const channelToolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
    await expectToolbarContract(channelToolbar, ["search", "teammates", "summary", "terminal", "details"]);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-channel-toolbar.png`);

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
    const teammateToolbar = page.getByRole("toolbar", { name: "Private chat actions" });
    await expectToolbarContract(teammateToolbar, ["search", "summary", "terminal", "details"]);
    await teammateToolbar.getByRole("button", { name: "Search" }).hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "Search" })).toBeVisible();
    await page.mouse.move(0, 0);
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-teammate-toolbar.png`);

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "New conversation" }).click();
    const home = page.getByLabel("Conversation home");
    await home.getByRole("textbox", { name: "Conversation message" }).fill("Verify the shared conversation toolbar");
    await home.getByRole("button", { name: "Send" }).click();
    const conversationToolbar = page.getByRole("toolbar", { name: "Conversation workspace toolbar" });
    await expectToolbarContract(conversationToolbar, ["search", "summary", "terminal", "details"]);
    const summary = conversationToolbar.getByRole("button", { name: "Summary" });
    await summary.click();
    await expect(summary).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".normal-conversation-summary-popover")).toBeVisible();
    await captureEvidence(page, `${fixture.width}x${fixture.height}-ling-${fixture.theme}-normal-toolbar-summary.png`);

    await expectNoDocumentOverflow(page);
    expect(runtimeErrors).toEqual([]);
  });
}

async function expectToolbarContract(toolbar: Locator, expectedActions: readonly string[]): Promise<void> {
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute("data-conversation-toolbar", "true");
  await expect(toolbar).toHaveClass(/ling-conversation-toolbar/u);

  const actionIds = await toolbar.locator("[data-conversation-action]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-conversation-action")),
  );
  expect(actionIds).toEqual(expectedActions);

  for (const button of await toolbar.getByRole("button").all()) {
    await expect(button).toHaveClass(/ling-ui-button/u);
    await expect(button).toHaveAttribute("data-icon-only", "true");
    await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
    await expect(button).toHaveAttribute("data-size", "sm");
    const box = await button.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBeGreaterThanOrEqual(32);
    expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(32);
  }
}

async function prepareSurface(
  page: Page,
  theme: "light" | "dark",
  width: number,
  height: number,
): Promise<void> {
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

async function expectNoDocumentOverflow(page: Page): Promise<void> {
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

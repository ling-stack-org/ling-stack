import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createDefaultProviderTemplates,
  createMediaProvider,
} from "./support/mock-state";

async function openModelWorkbench(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: /^(Settings|设置)$/ }).click();
  await page.getByLabel(/^(Settings sections|设置分组)$/).getByRole("button", { name: /^(Model Workbench|模型工作台)$/ }).click();
  await expect(page.locator(".provider-workbench")).toBeVisible();
}

test("P13 shows one neutral summary and one product state per model route", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const readyCheck = {
    ok: true,
    code: "ready",
    message: "Provider is reachable.",
    checkedAt: "2026-07-10T00:00:00.000Z",
  };
  state.providers = [
    createChatProvider({ id: "chat_ready", displayName: "Chat Ready", lastCheck: readyCheck }),
    createMediaProvider({ id: "image_ready", displayName: "Image Ready", lastCheck: readyCheck }),
    createChatProvider({
      id: "missing_key",
      displayName: "Missing Key",
      apiKeyConfigured: false,
      apiKeyRef: "env:MISSING_KEY",
    }),
    createChatProvider({ id: "disabled", displayName: "Disabled Route", enabled: false }),
  ];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await openModelWorkbench(page);
  const summary = page.locator(".provider-readiness-summary");
  await expect(summary).toContainText("4 models");
  await expect(summary).toContainText("1 chat ready");
  await expect(summary).toContainText("1 generation ready");
  await expect(summary).toContainText("1 need API key");
  await expect(summary).toContainText("1 disabled");
  await expect(page.locator(".provider-readiness-strip")).toHaveCount(0);

  await expect(page.locator(".provider-table thead th")).toHaveCount(4);
  await expect(page.locator(".provider-row")).toHaveCount(4);
  for (const row of await page.locator(".provider-row").all()) {
    await expect(row.locator(".provider-primary-status")).toHaveCount(1);
  }
  await expect(page.locator(".provider-row-technical-details")).toHaveCount(0);
  await expect(page.locator(".provider-key-status-stack")).toHaveCount(0);
  const refreshButton = page.getByRole("button", { name: "Refresh" });
  await expect(refreshButton).toHaveAttribute("aria-label", "Refresh");
  await expect(refreshButton).toHaveAttribute("title", "Refresh");
  await expect(refreshButton).toHaveAttribute("data-icon-only", "true");

  const overflow = await page.locator(".provider-table-shell").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test("P13.1 uses model-first identity and keeps routine row actions visible", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const readyCheck = {
    ok: true,
    code: "ready",
    message: "Provider is reachable.",
    checkedAt: "2026-07-10T00:00:00.000Z",
  };
  state.providers = [
    createChatProvider({
      id: "custom_default",
      displayName: "Custom · gpt-5.5",
      providerId: "custom-openai-compatible",
      model: "gpt-5.5",
      lastCheck: readyCheck,
    }),
    createChatProvider({
      id: "ready_chat",
      displayName: "Ready Relay · gpt-5.4",
      providerId: "local-relay",
      model: "gpt-5.4",
      lastCheck: readyCheck,
    }),
  ];
  state.workspaceSettings.defaultProviderPresetId = "custom_default";
  await mockDaemon(page, state);
  await page.goto("/");

  await openModelWorkbench(page);
  const customRow = page.locator(".provider-row").filter({
    has: page.locator(".provider-name-copy strong", { hasText: /^gpt-5\.5$/ }),
  });
  await expect(customRow.locator(".provider-name-copy strong")).toHaveText("gpt-5.5");
  await expect(customRow.locator(".provider-name-copy small")).toHaveCount(0);
  await expect(customRow).not.toContainText("Custom · gpt-5.5");
  await expect(customRow.locator(".provider-avatar")).toHaveAttribute("title", "Custom access");
  await expect(customRow.getByRole("button", { name: "Check" })).toBeVisible();
  await expect(customRow.getByRole("button", { name: "Edit" })).toBeVisible();

  const readyRow = page.locator(".provider-row").filter({
    has: page.locator(".provider-name-copy strong", { hasText: /^gpt-5\.4$/ }),
  });
  await expect(readyRow.locator(".provider-name-copy small")).toHaveText("Ready Relay");
  await expect(readyRow.getByRole("button", { name: "Set default" })).toBeVisible();
  await expect(readyRow.getByRole("button", { name: "Check" })).toBeVisible();
  await expect(readyRow.getByRole("button", { name: "Edit" })).toBeVisible();

  for (const label of ["Check", "Edit", "More"]) {
    const box = await customRow.getByRole("button", { name: label }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(32);
    expect(box?.height).toBeGreaterThanOrEqual(32);
  }

  const moreButton = customRow.getByRole("button", { name: "More" });
  await moreButton.focus();
  await moreButton.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Check" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Clear default" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Disable" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(moreButton).toBeFocused();
});

test("P13 provider editor progressively discloses supplier-specific technical fields", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");

  await openModelWorkbench(page);
  await page.getByRole("button", { name: "Add model" }).click();
  const editor = page.getByRole("dialog", { name: "New preset" });
  const supplier = editor.getByLabel("Model supplier");

  await supplier.selectOption("openai-gpt");
  await expect(editor.getByLabel("Model", { exact: true })).toBeVisible();
  await expect(editor.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(editor.getByLabel("Provider name")).toBeHidden();
  await expect(editor.getByLabel("Base URL")).toBeHidden();
  await expect(editor.getByLabel("API protocol")).toBeHidden();
  await expect(editor.getByText("Secret headers")).toBeHidden();
  await expect(editor.getByText("Optional manual override")).toHaveCount(0);

  await editor.getByText("Advanced settings").click();
  await expect(editor.getByLabel("Provider name")).toBeVisible();
  await expect(editor.getByLabel("Base URL")).toBeVisible();
  await expect(editor.getByLabel("API protocol")).toBeVisible();
  await expect(editor.getByText("Secret headers")).toBeVisible();
  await expect(editor.getByLabel("Enabled")).toHaveCount(0);

  await editor.getByText("Advanced settings").click();
  await supplier.selectOption("custom-openai-compatible");
  await expect(editor.getByLabel("Provider name")).toBeVisible();
  await expect(editor.getByLabel("Base URL")).toBeVisible();
  await expect(editor.getByLabel("API protocol")).toBeVisible();
  await expect(editor.getByText("Secret headers")).toBeHidden();
  await expect(editor.getByRole("button", { name: "Add model" })).toBeVisible();
});

test("P13 keeps failed row feedback visible until the route changes", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_failed",
      displayName: "Auth Failed Gateway",
      lastCheck: undefined,
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openModelWorkbench(page);
  const row = page.locator(".provider-row").filter({ hasText: "Auth Failed Gateway" });
  await row.getByRole("button", { name: "Check" }).click();
  const failure = page.locator(".provider-check-feedback-row.bad");
  await expect(failure).toContainText("Check failed");
  await page.waitForTimeout(2200);
  await expect(failure).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Edit preset" })).toBeVisible();
});

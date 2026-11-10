import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createChatProvider,
  createDefaultProviderTemplates,
} from "./support/mock-state";
import { captureP6FeedbackEvidence } from "./support/p6-feedback-evidence";

async function useEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

async function openWorkbench(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  await expect(page.locator(".provider-workbench")).toBeVisible();
}

function toast(page: Page, scope: string) {
  return page.locator(`[data-ling-overlay="toast"][data-scope="${scope}"]`);
}

test("provider save and model import use one global success toast without a local success row", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_feedback_ready",
    displayName: "Feedback Relay",
    model: "feedback-model",
  })];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");
  await openWorkbench(page);

  const providerRow = page.locator(".provider-row").filter({ hasText: "feedback-model" });
  await providerRow.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog", { name: "Edit preset" }).getByRole("button", { name: "Save changes" }).click();

  const saveToast = toast(page, "model-workbench:provider-save");
  await expect(saveToast).toHaveCount(1);
  await expect(saveToast).toContainText("Model preset saved successfully.");
  await expect(saveToast).toHaveAttribute("data-tone", "success");
  await expect(page.locator(".provider-batch-result.ok")).toHaveCount(0);
  await saveToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(saveToast).toHaveCount(0);

  await page.getByRole("button", { name: "Add model" }).first().click();
  const editor = page.getByRole("dialog", { name: "New preset" });
  await editor.getByLabel("Model supplier").selectOption("custom-openai-compatible");
  await editor.getByLabel("API key", { exact: true }).fill("test-visible-key");
  await editor.getByRole("button", { name: "Fetch models" }).click();
  const models = editor.locator(".provider-model-card");
  await models.filter({ hasText: "cliproxy-gpt-4o" }).click();
  await models.filter({ hasText: "doubao-1-5-pro-32k-250115" }).click();
  await editor.getByRole("button", { name: "Import selected models (2)" }).click();

  const importToast = toast(page, "model-workbench:model-import");
  await expect(importToast).toHaveCount(1);
  await expect(importToast).toContainText("Imported 2 model presets.");
  await expect(importToast).toHaveAttribute("data-tone", "success");
  await expect(page.locator(".provider-batch-result.ok")).toHaveCount(0);
  await expect(page.locator(".provider-operation-warning")).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  await captureP6FeedbackEvidence(
    page,
    "features/model-workbench-feedback",
    "1440x960-ling-light-import-success-toast.png",
  );
  expect(runtimeErrors).toEqual([]);
});

test("batch all-success uses Toast while partial failure stays persistent with repair guidance", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, true);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({ id: "provider_batch_ready_a", displayName: "Ready Relay A", model: "ready-a" }),
    createChatProvider({ id: "provider_batch_ready_b", displayName: "Ready Relay B", model: "ready-b" }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openWorkbench(page);

  await page.getByRole("button", { name: "Check all" }).click();
  const successToast = toast(page, "model-workbench:batch-check");
  await expect(successToast).toHaveCount(1);
  await expect(successToast).toContainText("Checked 2 model presets: 2 ready, 0 failed.");
  await expect(page.locator(".provider-batch-result")).toHaveCount(0);

  state.providers = [
    createChatProvider({ id: "provider_batch_ready", displayName: "Ready Relay", model: "ready-model" }),
    createChatProvider({ id: "provider_batch_failed", displayName: "Auth Failed Relay", model: "failed-model" }),
  ];
  await page.reload();
  await openWorkbench(page);
  await page.getByRole("button", { name: "Check all" }).click();

  const partialFailure = page.locator(".provider-batch-result.bad");
  await expect(partialFailure).toContainText("Checked 2 model presets: 1 ready, 1 failed.");
  await expect(partialFailure).toContainText("Review the failed provider checks");
  await expect(toast(page, "model-workbench:batch-check")).toHaveCount(0);
  await page.waitForTimeout(2_200);
  await expect(partialFailure).toBeVisible();
  await expect(page.locator(".provider-batch-result.ok")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expectNoDocumentOverflow(page);
  await captureP6FeedbackEvidence(
    page,
    "features/model-workbench-feedback",
    "1280x800-ling-dark-partial-failure.png",
  );
  expect(runtimeErrors).toEqual([]);
});

test("row check success uses one provider-scoped Toast without a duplicate row result", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providerCheckDelayMs = 50;
  state.providers = [createChatProvider({
    id: "provider_row_success",
    displayName: "Row Success Relay",
    model: "row-success-model",
    lastCheck: undefined,
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openWorkbench(page);

  const providerRow = page.locator(".provider-row").filter({ hasText: "row-success-model" });
  const checkButton = providerRow.getByRole("button", { name: "Check" });
  await checkButton.click();

  const successToast = toast(page, "provider:provider_row_success:check");
  await expect(successToast).toHaveCount(1);
  await expect(successToast).toContainText("Check passed");
  await expect(successToast).toContainText("Provider is reachable and accepted the configured model.");
  await expect(successToast).toHaveAttribute("data-tone", "success");
  await expect(page.locator(".provider-check-feedback-row.ok")).toHaveCount(0);
  await expect(page.locator(".provider-check-feedback-row")).toHaveCount(0);

  await expect(checkButton).toBeEnabled();
  await checkButton.click();
  await expect(successToast).toHaveCount(1);
  await expect(page.locator(".provider-check-feedback-row.ok")).toHaveCount(0);
  await expect(successToast).toHaveCount(0, { timeout: 5_000 });
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("row check failure persists until retry or provider identity changes", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providerCheckDelayMs = 50;
  state.providers = [createChatProvider({
    id: "provider_row_failure",
    displayName: "Auth Failed Row Relay",
    model: "row-failure-model",
    lastCheck: undefined,
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openWorkbench(page);

  const failedRow = page.locator(".provider-row").filter({ hasText: "row-failure-model" });
  await failedRow.getByRole("button", { name: "Check" }).click();
  const failure = page.locator(".provider-check-feedback-row.bad");
  await expect(failure).toContainText("Check failed");
  await expect(failure).toContainText("Invalid API key.");
  await page.waitForTimeout(3_200);
  await expect(failure).toBeVisible();
  await expect(toast(page, "provider:provider_row_failure:check")).toHaveCount(0);

  state.providerCheckDelayMs = 600;
  state.providers[0] = {
    ...(state.providers[0] as Record<string, unknown>),
    displayName: "Recovered Row Relay",
  };
  await failedRow.getByRole("button", { name: "Check" }).click();
  await expect(failure).toHaveCount(0);
  const recoveryToast = toast(page, "provider:provider_row_failure:check");
  await expect(recoveryToast).toHaveCount(1);
  await recoveryToast.getByRole("button", { name: "Dismiss notification" }).click();

  state.providerCheckDelayMs = 50;
  state.providers[0] = {
    ...(state.providers[0] as Record<string, unknown>),
    displayName: "Auth Failed Identity Relay",
    model: "identity-failure-model",
  };
  await triggerFocusRevalidation(page);
  const identityRow = page.locator(".provider-row").filter({ hasText: "identity-failure-model" });
  await identityRow.getByRole("button", { name: "Check" }).click();
  await expect(failure).toContainText("Invalid API key.");

  state.providers[0] = {
    ...(state.providers[0] as Record<string, unknown>),
    model: "identity-replacement-model",
  };
  await triggerFocusRevalidation(page);
  await expect(failure).toHaveCount(0);
  await expect(page.locator(".provider-row").filter({ hasText: "identity-replacement-model" })).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
  reducedMotion = false,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({
    colorScheme: theme,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await useEnglish(page);
  await page.addInitScript((value) => {
    const selection = { mode: "fixed", themeId: `ling-${value}` };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", value);
    localStorage.setItem("ling-stack.themeBootstrapPreference", value);
  }, theme);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  )).toBeLessThanOrEqual(1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console:${message.text()}`);
    }
  });
  return errors;
}

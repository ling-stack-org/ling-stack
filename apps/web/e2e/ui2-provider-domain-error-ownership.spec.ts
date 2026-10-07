import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";

const providerDomainSourcePath = fileURLToPath(new URL(
  "../src/domains/providers/use-providers-domain.ts",
  import.meta.url,
));

test("T13-P.9C Provider domain has no generic error writer and preserves precise feedback owners", async () => {
  const source = await readFile(providerDomainSourcePath, "utf8");
  const saveProvider = readFunctionSlice(source, "async function saveProviderWithPreflight", "async function importModelsFromProviderForm");
  const importModels = readFunctionSlice(source, "async function importModelsFromProviderForm", "function providerCheckBlocksSave");
  const rowCheck = readFunctionSlice(source, "async function runProviderCheck", "async function runProviderBatchCheck");

  expect(source).not.toContain("setErrorMessage");
  expect(source).toContain("const error = providerMutationError ?? providerListError ?? providerTemplateError;");
  expect(source).toContain('setProviderListError(readProviderDomainError("load", caught))');
  expect(source).toContain('setProviderTemplateError(readProviderDomainError("load", caught))');
  expect(source).toContain('setProviderMutationError(readProviderDomainError("mutation", caught))');

  expect(saveProvider).not.toContain("setProviderMutationError");
  expect(saveProvider).toContain("return { ok: false, errorMessage: message }");
  expect(importModels).not.toContain("setProviderMutationError");
  expect(importModels).toContain("return { ok: false, errorMessage: message }");

  expect(rowCheck).toContain("setProviderCheck({");
  expect(rowCheck).toContain('code: "request_failed"');
  expect(rowCheck).not.toContain("setProviderMutationError");
});

test("T13-P.9C save failure remains in the editor and does not create a Provider page error", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_save_failure",
    displayName: "Save Failure Relay",
    model: "save-failure-model",
  })];
  await mockDaemon(page, state);
  await page.route(/\/providers\/provider_save_failure(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 503,
      json: { error: "provider_save_failed", message: "Synthetic provider save failure" },
    });
  });
  await page.goto("/");
  await openWorkbench(page);

  const row = page.locator(".provider-row").filter({ hasText: "save-failure-model" });
  await row.getByRole("button", { name: "Edit" }).click();
  const editor = page.getByRole("dialog", { name: "Edit preset" });
  await editor.getByRole("button", { name: "Save changes" }).click();

  await expect(editor.locator(".provider-editor-error")).toContainText("Synthetic provider save failure");
  await expect(page.locator(".provider-page-error")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="model-workbench:provider-save"]')).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("T13-P.9C row transport failure remains in the P8 row feedback owner", async ({ page }) => {
  await prepareSurface(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_row_request_failure",
    displayName: "Request Failure Relay",
    model: "request-failure-model",
    lastCheck: undefined,
  })];
  await mockDaemon(page, state);
  await page.route(/\/providers\/provider_row_request_failure\/check(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: "provider_check_failed", message: "Synthetic row transport failure" },
    });
  });
  await page.goto("/");
  await openWorkbench(page);

  const row = page.locator(".provider-row").filter({ hasText: "request-failure-model" });
  await row.getByRole("button", { name: "Check" }).click();

  const feedback = page.locator(".provider-check-feedback-row.bad");
  await expect(feedback).toContainText("Check failed");
  await expect(feedback).toContainText("Synthetic row transport failure");
  await expect(page.locator(".provider-page-error")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="provider:provider_row_request_failure:check"]')).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

function readFunctionSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `${start} must exist`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `${end} must follow ${start}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

async function prepareSurface(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
  });
}

async function openWorkbench(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  await expect(page.locator(".provider-workbench")).toBeVisible();
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

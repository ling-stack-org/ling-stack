import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";

const providerDomainSourcePath = fileURLToPath(new URL(
  "../src/domains/providers/use-providers-domain.ts",
  import.meta.url,
));

test("T13-P.9C Provider domain localizes boundary errors and preserves precise feedback owners", async () => {
  const source = await readFile(providerDomainSourcePath, "utf8");
  const saveProvider = readFunctionSlice(source, "async function saveProviderWithPreflight", "async function importModelsFromProviderForm");
  const importModels = readFunctionSlice(source, "async function importModelsFromProviderForm", "function providerCheckBlocksSave");
  const removeProvider = readFunctionSlice(source, "async function removeProvider", "async function runProviderCheck");
  const rowCheck = readFunctionSlice(source, "async function runProviderCheck", "async function runProviderBatchCheck");

  expect(source).not.toContain("setErrorMessage");
  expect(source).not.toContain("caught instanceof Error ? caught.message : String(caught)");
  expect(source).toContain("const error = providerMutationError ?? providerListError ?? providerTemplateError;");
  expect(source).toContain('readProviderDomainError("load", caught, input.translate)');
  expect(source).toContain('readProviderDomainError("mutation", caught, input.translate)');

  expect(saveProvider).not.toContain("setProviderMutationError");
  expect(saveProvider).toContain("errorTechnicalMessage: error.technicalMessage");
  expect(importModels).not.toContain("setProviderMutationError");
  expect(importModels).toContain("errorTechnicalMessage: error.technicalMessage");
  expect(removeProvider).not.toContain("setProviderMutationError(readProviderDomainError");
  expect(removeProvider).toContain("errorTechnicalMessage: error.technicalMessage");
  expect(removeProvider).toContain("let cleanupError: ProductError | undefined;");
  expect(removeProvider).toContain("return { ok: true };");

  expect(rowCheck).toContain("setProviderCheck({");
  expect(rowCheck).toContain('code: "request_failed"');
  expect(rowCheck).not.toContain("setProviderMutationError");
});

test("T13-P.9C unknown Chinese load failures use the localized operation fallback", async ({ page }) => {
  await prepareSurface(page, "zh-CN");
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.route(/\/providers(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 418,
      json: { error: "provider_list_unknown", message: "Synthetic unknown provider list failure" },
    });
  });
  await page.goto("/");
  await openWorkbench(page);

  const feedback = page.locator(".provider-page-error");
  await expect(feedback).toContainText("无法加载模型预设，请检查本地服务后重试。");
  const technicalMessage = feedback.getByText("Synthetic unknown provider list failure");
  await expect(technicalMessage).not.toBeVisible();
  await feedback.getByText("技术详情", { exact: true }).click();
  await expect(technicalMessage).toBeVisible();
});

test("T13-P.9C repeated delete failures with identical product copy remain recoverable", async ({ page }) => {
  await prepareSurface(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_delete_failure",
    displayName: "Delete Failure Relay",
    model: "delete-failure-model",
  })];
  await mockDaemon(page, state);
  let attempts = 0;
  await page.route(/\/providers\/provider_delete_failure(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    attempts += 1;
    await route.fulfill({
      status: 503,
      json: { error: "provider_delete_failed", message: `Synthetic delete failure ${attempts}` },
    });
  });
  await page.goto("/");
  await openWorkbench(page);

  const row = page.locator(".provider-row").filter({ hasText: "delete-failure-model" });
  await row.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete delete-failure-model" });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toContainText("The service is temporarily unavailable. Try again shortly.");
  await dialog.getByText("Technical details", { exact: true }).click();
  await expect(dialog.getByText("Synthetic delete failure 1")).toBeVisible();

  await dialog.getByRole("button", { name: "Delete" }).click();
  await dialog.getByText("Technical details", { exact: true }).click();
  await expect(dialog.getByText("Synthetic delete failure 2")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await expect(page.locator(".provider-page-error")).toHaveCount(0);
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

  const feedback = editor.locator(".provider-editor-error");
  await expect(feedback).toContainText("The service is temporarily unavailable. Try again shortly.");
  const technicalMessage = feedback.getByText("Synthetic provider save failure");
  await expect(technicalMessage).not.toBeVisible();
  await feedback.getByText("Technical details", { exact: true }).click();
  await expect(technicalMessage).toBeVisible();
  await expect(page.locator(".provider-page-error")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="model-workbench:provider-save"]')).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("T13-P.9C Chinese editor errors keep raw daemon text in folded technical details", async ({ page }) => {
  await prepareSurface(page, "zh-CN");
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_localized_save_failure",
    displayName: "Localized Save Failure Relay",
    model: "localized-save-failure-model",
  })];
  await mockDaemon(page, state);
  await page.route(/\/providers\/provider_localized_save_failure(?:\?.*)?$/u, async (route) => {
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

  const row = page.locator(".provider-row").filter({ hasText: "localized-save-failure-model" });
  await row.getByRole("button", { name: "编辑" }).click();
  const editor = page.getByRole("dialog", { name: "编辑预设" });
  await editor.getByRole("button", { name: "保存修改" }).click();

  const feedback = editor.locator(".provider-editor-error");
  await expect(feedback).toContainText("服务暂时不可用，请稍后重试。");
  const technicalMessage = feedback.getByText("Synthetic provider save failure");
  await expect(technicalMessage).not.toBeVisible();
  await feedback.getByText("技术详情", { exact: true }).click();
  await expect(technicalMessage).toBeVisible();
  await expect(page.locator(".provider-page-error")).toHaveCount(0);
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
  await expect(feedback).toContainText("Provider check failed. Review technical details and try again.");
  const technicalMessage = feedback.getByText(/Synthetic row transport failure/u);
  await expect(technicalMessage).not.toBeVisible();
  await feedback.getByText("Technical details", { exact: true }).click();
  await expect(technicalMessage).toBeVisible();
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

async function prepareSurface(page: Page, locale = "en-US"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  if (locale === "zh-CN") {
    await page.addInitScript(() => {
      localStorage.setItem("ling-stack.locale", "zh-CN");
      localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
    });
    return;
  }
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
  });
}

async function openWorkbench(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: /Settings|设置/u }).click();
  await page.getByLabel(/Settings sections|设置分组/u).getByRole("button", { name: /Model Workbench|模型工作台/u }).click();
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

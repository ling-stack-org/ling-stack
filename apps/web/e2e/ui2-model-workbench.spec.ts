import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createChatProvider,
  createDefaultProviderTemplates,
  createMediaProvider,
} from "./support/mock-state";

const evidenceDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/design/ui2.0升级/evidence/features/model-workbench",
);

const readyCheck = {
  ok: true,
  code: "ready",
  message: "Provider is reachable.",
  checkedAt: "2026-07-20T00:00:00.000Z",
};

async function useEnglish(page: Page, theme: "light" | "dark" = "light"): Promise<void> {
  await page.addInitScript(({ selectedTheme }) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", selectedTheme);
  }, { selectedTheme: theme });
}

async function openWorkbench(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  await expect(page.locator(".provider-workbench")).toBeVisible();
}

function row(page: Page, model: string): Locator {
  return page.locator(".provider-row").filter({ has: page.locator(".provider-name-copy strong", { hasText: model }) });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureEvidence(
  page: Page,
  runtimeErrors: readonly string[],
  fileName: string,
  expectedHttpStatuses: readonly number[] = [],
): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const expectedStatusPattern = expectedHttpStatuses.length > 0
    ? new RegExp(`status of (?:${expectedHttpStatuses.join("|")})\\b`)
    : undefined;
  expect(runtimeErrors.filter((message) => !(
    expectedStatusPattern &&
    message.startsWith("Failed to load resource:") &&
    expectedStatusPattern.test(message)
  ))).toEqual([]);
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow.horizontal).toBeLessThanOrEqual(1);
  expect(overflow.vertical).toBeLessThanOrEqual(1);
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: path.join(evidenceDirectory, fileName),
  });
}

function createMatrixState() {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({ id: "model_missing_key", displayName: "Missing Relay", model: "missing-model", apiKeyConfigured: false, apiKeyRef: "env:MISSING" }),
    createChatProvider({ id: "model_check_failed", displayName: "Failed Relay", model: "failed-model", lastCheck: { ...readyCheck, ok: false, code: "auth_failed", message: "Authentication failed." } }),
    createChatProvider({ id: "model_ready_chat", displayName: "Ready Relay", model: "ready-model", lastCheck: readyCheck }),
    createChatProvider({ id: "model_default_chat", displayName: "Default Relay", model: "default-model", lastCheck: readyCheck }),
    createMediaProvider({ id: "model_ready_image", displayName: "Image Relay", model: "image-model", lastCheck: readyCheck }),
    createChatProvider({ id: "model_disabled", displayName: "Disabled Relay", model: "disabled-model", enabled: false, lastCheck: readyCheck }),
    createChatProvider({ id: "model_custom_long", displayName: "Custom · long", providerId: "custom-openai-compatible", model: "custom-model-with-a-very-long-identity-for-overflow-verification", lastCheck: readyCheck }),
  ];
  state.workspaceSettings.defaultProviderPresetId = "model_default_chat";
  return state;
}

test("UI2 model list exposes one state and the exact routine action matrix", async ({ page }) => {
  await useEnglish(page);
  const state = createMatrixState();
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");
  await openWorkbench(page);

  await expect(page.locator(".provider-row")).toHaveCount(7);
  for (const candidate of await page.locator(".provider-row").all()) {
    await expect(candidate.locator(".provider-primary-status")).toHaveCount(1);
  }

  const missing = row(page, "missing-model");
  await expect(missing.getByRole("button", { name: "Add API key" })).toBeVisible();
  await expect(missing.getByRole("button", { name: "Check", exact: true })).toHaveCount(0);
  await expect(missing.getByRole("button", { name: "Edit" })).toHaveCount(0);

  const failed = row(page, "failed-model");
  await expect(failed.getByRole("button", { name: "Check", exact: true })).toBeVisible();
  await expect(failed.getByRole("button", { name: "Edit" })).toBeVisible();

  const ready = row(page, "ready-model");
  await expect(ready.getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);
  await expect(ready.locator(".lucide-play")).toHaveCount(0);
  await expect(ready.getByRole("button", { name: "Check", exact: true })).toBeVisible();
  await expect(ready.getByRole("button", { name: "Edit" })).toBeVisible();

  const current = row(page, "default-model");
  await expect(page.locator(".provider-default-purpose-bar").getByLabel("Chat model")).toHaveValue("model_default_chat");
  await expect(current.getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);

  const image = row(page, "image-model");
  await expect(image).toContainText("Image");
  await expect(image.getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);

  const disabled = row(page, "disabled-model");
  await expect(disabled.getByRole("button", { name: "Enable" })).toBeVisible();
  await expect(disabled.getByRole("button", { name: "Edit" })).toBeVisible();

  for (const label of ["Check", "Edit", "More"]) {
    const box = await current.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(32);
    expect(box?.height).toBeGreaterThanOrEqual(32);
  }

  const tableGeometry = await page.locator(".provider-table").evaluate((table) => {
    const actionHead = table.querySelector<HTMLElement>("thead th:last-child");
    const firstRow = table.querySelector<HTMLElement>(".provider-row");
    const modelCell = firstRow?.firstElementChild as HTMLElement | null;
    const actionCell = firstRow?.lastElementChild as HTMLElement | null;
    const actionCellStyle = actionCell ? getComputedStyle(actionCell) : undefined;
    const actionGroupsFit = Array.from(table.querySelectorAll<HTMLElement>(".provider-row")).every((routeRow) => {
      const cell = routeRow.lastElementChild?.getBoundingClientRect();
      const actions = routeRow.querySelector<HTMLElement>(".provider-actions")?.getBoundingClientRect();
      return Boolean(cell && actions && actions.left >= cell.left - 0.5 && actions.right <= cell.right + 0.5);
    });
    return {
      actionColumnWidth: actionCell?.getBoundingClientRect().width ?? 0,
      actionHeadAlignment: actionHead ? getComputedStyle(actionHead).textAlign : "",
      actionLeftBorderWidth: actionCellStyle?.borderLeftWidth ?? "",
      modelColumnWidth: modelCell?.getBoundingClientRect().width ?? 0,
      actionGroupsFit,
    };
  });
  expect(Math.abs(tableGeometry.actionColumnWidth - 184)).toBeLessThanOrEqual(1);
  expect(tableGeometry.actionHeadAlignment).toBe("right");
  expect(tableGeometry.actionLeftBorderWidth).toBe("0px");
  expect(tableGeometry.modelColumnWidth).toBeGreaterThan(tableGeometry.actionColumnWidth);
  expect(tableGeometry.actionGroupsFit).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  const compactGeometry = await page.locator(".provider-table-shell").evaluate((shell) => {
    const actionCell = shell.querySelector<HTMLElement>(".provider-row td:last-child");
    const actionGroupsFit = Array.from(shell.querySelectorAll<HTMLElement>(".provider-row")).every((routeRow) => {
      const cell = routeRow.lastElementChild?.getBoundingClientRect();
      const actions = routeRow.querySelector<HTMLElement>(".provider-actions")?.getBoundingClientRect();
      return Boolean(cell && actions && actions.left >= cell.left - 0.5 && actions.right <= cell.right + 0.5);
    });
    return {
      actionColumnWidth: actionCell?.getBoundingClientRect().width ?? 0,
      horizontalOverflow: shell.scrollWidth - shell.clientWidth,
      actionGroupsFit,
    };
  });
  expect(Math.abs(compactGeometry.actionColumnWidth - 184)).toBeLessThanOrEqual(1);
  expect(compactGeometry.horizontalOverflow).toBeLessThanOrEqual(1);
  expect(compactGeometry.actionGroupsFit).toBe(true);

  const more = current.getByRole("button", { name: "More" });
  await more.hover();
  await expect(page.getByRole("menuitem", { name: "Clear default" })).toHaveCount(0);
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Clear default" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Disable" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

test("UI2 model list presents persisted background preflight as checking", async ({ page }) => {
  await useEnglish(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "model_import_checking",
    displayName: "Background Relay",
    model: "background-model",
    lastCheck: {
      ok: false,
      code: "checking",
      message: "Provider check is running.",
      checkedAt: "2026-08-04T09:01:14.000Z",
    },
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openWorkbench(page);

  const target = row(page, "background-model");
  await expect(target.locator(".provider-primary-status")).toHaveText("Checking");
  await expect(target.getByRole("button", { name: "Check", exact: true })).toHaveCount(0);
  await expect(target.locator(".provider-status-hint")).toHaveCount(0);
});

test("UI2 model search, filter, and destructive confirmation stay scoped", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await useEnglish(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMatrixState();
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");
  await openWorkbench(page);

  const search = page.getByLabel("Search model presets");
  await search.fill("does-not-exist");
  await expect(page.getByText("No model presets match the current filters")).toBeVisible();
  await captureEvidence(page, runtimeErrors, "1440x960-ling-light-search-no-result.png");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".provider-row")).toHaveCount(7);
  await search.fill("ready-model");
  await search.press("Escape");
  await expect(search).toHaveValue("");

  const target = row(page, "ready-model");
  await target.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete ready-model" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This cannot be undone");
  await captureEvidence(page, runtimeErrors, "1440x960-ling-light-delete-confirm.png");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(target).toBeVisible();
});

test("UI2 model capability tabs filter video, image, and chat independently from status and search", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await useEnglish(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({ id: "capability_chat", displayName: "Chat Relay", model: "chat-model", lastCheck: readyCheck }),
    createMediaProvider({ id: "capability_image", displayName: "Image Relay", model: "image-model", lastCheck: readyCheck }),
    createMediaProvider({
      id: "capability_video_ready",
      displayName: "Ready Video Relay",
      model: "ready-video-model",
      capabilities: ["video_generate"],
      lastCheck: readyCheck,
    }),
    createMediaProvider({
      id: "capability_video_disabled",
      displayName: "Disabled Video Relay",
      model: "disabled-video-model",
      capabilities: ["video_generate"],
      enabled: false,
      lastCheck: readyCheck,
    }),
  ];
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");
  await openWorkbench(page);

  const capabilityTabs = page.getByRole("radiogroup", { name: "Model capability filters" });
  await expect(capabilityTabs.getByRole("radio")).toHaveText(["All models", "Video", "Image", "Chat"]);
  const statusFilter = page.getByLabel("Filter model presets");
  const [statusBox, capabilityBox] = await Promise.all([
    statusFilter.boundingBox(),
    capabilityTabs.boundingBox(),
  ]);
  expect(statusBox).not.toBeNull();
  expect(capabilityBox).not.toBeNull();
  expect(capabilityBox!.x).toBeGreaterThanOrEqual(statusBox!.x + statusBox!.width);

  await capabilityTabs.getByRole("radio", { name: "Video", exact: true }).click();
  await expect(page.locator(".provider-row")).toHaveCount(2);
  await expect(row(page, "ready-video-model")).toBeVisible();
  await expect(row(page, "disabled-video-model")).toBeVisible();

  await statusFilter.selectOption("disabled");
  await expect(page.locator(".provider-row")).toHaveCount(1);
  await expect(row(page, "disabled-video-model")).toBeVisible();
  await page.getByLabel("Search model presets").fill("ready-video");
  await expect(page.getByText("No model presets match the current filters")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".provider-row")).toHaveCount(4);

  await capabilityTabs.getByRole("radio", { name: "Image", exact: true }).click();
  await expect(page.locator(".provider-row")).toHaveCount(1);
  await expect(row(page, "image-model")).toBeVisible();
  await capabilityTabs.getByRole("radio", { name: "Chat", exact: true }).click();
  await expect(page.locator(".provider-row")).toHaveCount(1);
  await expect(row(page, "chat-model")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("UI2 model focus revalidation retains stale rows and blocked delete remains actionable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await useEnglish(page);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMatrixState();
  let failRefresh = false;
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.route("**/providers?*", async (route) => {
    if (failRefresh && route.request().method() === "GET") {
      await route.fulfill({ status: 503, json: { error: "provider_list_unavailable", message: "Synthetic provider list failure" } });
      return;
    }
    await route.fallback();
  });
  await page.route("**/providers/model_ready_chat?*", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 409, json: { error: "provider_in_use", message: "Provider is still used by this workspace." } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openWorkbench(page);

  failRefresh = true;
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  await expect(page.locator(".provider-row")).toHaveCount(7);
  await expect(page.locator(".provider-page-error")).toContainText("Synthetic provider list failure");
  await expect(page.locator(".provider-page-error").getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator(".provider-readiness-summary")).toContainText("Stale");
  await captureEvidence(page, runtimeErrors, "1440x960-ling-light-retained-refresh-error.png", [503]);

  const target = row(page, "ready-model");
  await target.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete ready-model" });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Provider is still used by this workspace.");
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeEnabled();
  await captureEvidence(page, runtimeErrors, "1440x960-ling-light-delete-blocked.png", [503, 409]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("UI2 row check scopes busy state and keeps failure details", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await useEnglish(page, "dark");
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providerCheckDelayMs = 6_000;
  state.providers = [createChatProvider({
    id: "model_check_failed",
    displayName: "Auth Failed Relay",
    model: "failed-model",
    lastCheck: undefined,
  })];
  await mockDaemon(page, state);
  await page.goto("/");
  await openWorkbench(page);

  const target = row(page, "failed-model");
  const check = target.locator(".provider-main-action");
  await expect(check).toHaveAccessibleName("Check");
  await check.click();
  await expect(check).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Check all" })).toBeDisabled();
  const failure = page.locator(".provider-check-feedback-row.bad");
  await expect(failure).toBeVisible({ timeout: 10_000 });
  await expect(failure).toContainText("Check failed");
  await failure.getByText("Check details").click();
  await expect(failure).toContainText("API key");
  await captureEvidence(page, runtimeErrors, "1280x800-ling-dark-check-failure-details.png");
});

test("UI2 model editor uses shared fields, discovery rows, checkbox, and advanced disclosure", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await useEnglish(page, "dark");
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
  await page.goto("/");
  await openWorkbench(page);

  const trigger = page.getByRole("button", { name: "Add model" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New preset" });
  await expect(dialog).toBeVisible();
  const supplier = dialog.getByLabel("Model supplier");
  await supplier.selectOption("custom-openai-compatible");
  await expect(dialog.getByLabel("Provider name")).toBeVisible();
  await expect(dialog.getByLabel("Base URL")).toBeVisible();
  await expect(dialog.getByLabel("API protocol")).toBeVisible();
  await supplier.selectOption("doubao-ark");
  await dialog.getByLabel("API key", { exact: true }).fill("ark-test-key");
  await dialog.getByRole("button", { name: "Fetch models" }).click();
  await expect(dialog.locator(".provider-model-card").first()).toBeVisible();
  const checkbox = dialog.getByRole("checkbox").first();
  const checkboxBox = await checkbox.evaluate((element) => {
    const rect = element.parentElement?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : undefined;
  });
  await checkbox.locator("xpath=..").click();
  await expect(dialog.getByText(/1 selected/)).toBeVisible();
  expect(checkboxBox?.height ?? 32).toBeGreaterThanOrEqual(18);

  await dialog.getByText("Advanced settings").click();
  await expect(dialog.getByText("Secret headers")).toBeVisible();
  await expect(dialog.getByLabel("Auth header")).toBeVisible();
  await expect(dialog.getByLabel("Reasoning")).toBeVisible();
  const bodyOverflow = await dialog.locator(".provider-sheet-body").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    offenders: Array.from(element.querySelectorAll<HTMLElement>("*")).filter((candidate) => {
      const style = getComputedStyle(candidate);
      return candidate.scrollWidth > candidate.clientWidth + 1 && style.overflowX !== "hidden" && style.overflowX !== "clip";
    }).slice(0, 8).map((candidate) => ({
      className: candidate.className,
      clientWidth: candidate.clientWidth,
      scrollWidth: candidate.scrollWidth,
    })),
  }));
  expect(bodyOverflow.offenders).toEqual([]);
  expect(bodyOverflow.scrollWidth).toBeLessThanOrEqual(bodyOverflow.clientWidth + 1);
  await captureEvidence(page, runtimeErrors, "1280x800-ling-dark-editor-advanced.png");
  await dialog.getByRole("button", { name: "Close model preset editor" }).click();
  await expect(trigger).toBeFocused();
});

test("UI2 model editor keeps its header and footer anchored after selecting four models", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 960 });
  await useEnglish(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const providerModels = Array.from({ length: 22 }, (_, index) => ({
    id: index === 18 ? "gpt-5.4-mini" : index === 19 ? "gpt-5.5" : index === 20 ? "gpt-5.6-terra" : index === 21 ? "gpt-5.6-pro" : `fixture-model-${index + 1}`,
    ownedBy: "fixture",
  }));
  await mockDaemon(page, state, { templates: createDefaultProviderTemplates(), providerModels });
  await page.goto("/");
  await openWorkbench(page);

  await page.getByRole("button", { name: "Add model" }).click();
  const dialog = page.getByRole("dialog", { name: "New preset" });
  await dialog.getByLabel("Model supplier").selectOption("custom-openai-compatible");
  await dialog.getByLabel("API key", { exact: true }).fill("test-visible-key");
  await dialog.getByRole("button", { name: "Fetch models" }).click();

  const modelCards = dialog.locator(".provider-model-card");
  await expect(modelCards).toHaveCount(22);
  for (let index = 18; index < 22; index += 1) {
    await modelCards.nth(index).click();
  }
  await expect(dialog.getByText("4 selected", { exact: true })).toBeVisible();

  const geometry = await dialog.evaluate((element) => {
    const header = element.querySelector<HTMLElement>(".provider-sheet-header");
    const body = element.querySelector<HTMLElement>(".provider-sheet-body");
    const footer = element.querySelector<HTMLElement>(".provider-sheet-footer");
    const dialogRect = element.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      dialogTop: dialogRect.top,
      dialogBottom: dialogRect.bottom,
      headerTop: headerRect?.top ?? -1,
      footerBottom: footerRect?.bottom ?? -1,
      bodyScrollTop: body?.scrollTop ?? -1,
      display: getComputedStyle(element).display,
      flexDirection: getComputedStyle(element).flexDirection,
      gridTemplateRows: getComputedStyle(element).gridTemplateRows,
    };
  });
  expect(geometry.display).toBe("flex");
  expect(geometry.flexDirection).toBe("column");
  expect(geometry.headerTop).toBeGreaterThanOrEqual(geometry.dialogTop - 1);
  expect(Math.abs(geometry.dialogBottom - geometry.footerBottom)).toBeLessThanOrEqual(1);
  expect(geometry.bodyScrollTop).toBe(0);
});

for (const scenario of [
  { width: 1440, height: 960, theme: "light" as const },
  { width: 1280, height: 800, theme: "dark" as const },
]) {
  test(`UI2 model workbench contains layout at ${scenario.width}x${scenario.height} ${scenario.theme}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await useEnglish(page, scenario.theme);
    const errors = collectRuntimeErrors(page);
    const state = createMatrixState();
    await mockDaemon(page, state, { templates: createDefaultProviderTemplates() });
    await page.goto("/");
    await openWorkbench(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.theme);

    const measurements = await page.locator(".provider-workbench").evaluate((element) => {
      const table = element.querySelector<HTMLElement>(".provider-table-shell");
      const defaultPurpose = element.querySelector<HTMLElement>(".provider-default-purpose-bar");
      const defaultPurposeFields = Array.from(
        element.querySelectorAll<HTMLElement>(".provider-default-purpose-field"),
      );
      const defaultPurposeRect = defaultPurpose?.getBoundingClientRect();
      const tableRect = table?.getBoundingClientRect();
      return {
        documentClient: document.documentElement.clientWidth,
        documentScroll: document.documentElement.scrollWidth,
        surfaceClient: element.clientWidth,
        surfaceScroll: element.scrollWidth,
        tableClient: table?.clientWidth ?? 0,
        tableScroll: table?.scrollWidth ?? 0,
        defaultPurposeBottom: defaultPurposeRect?.bottom ?? 0,
        defaultPurposeFieldBottom: Math.max(
          0,
          ...defaultPurposeFields.map((field) => field.getBoundingClientRect().bottom),
        ),
        tableTop: tableRect?.top ?? 0,
      };
    });
    expect(measurements.documentScroll).toBeLessThanOrEqual(measurements.documentClient + 1);
    expect(measurements.surfaceScroll).toBeLessThanOrEqual(measurements.surfaceClient + 1);
    expect(measurements.tableScroll).toBeLessThanOrEqual(measurements.tableClient + 1);
    expect(measurements.defaultPurposeFieldBottom).toBeLessThanOrEqual(measurements.defaultPurposeBottom + 1);
    expect(measurements.defaultPurposeBottom).toBeLessThanOrEqual(measurements.tableTop - 1);
    expect(errors).toEqual([]);
    await captureEvidence(
      page,
      errors,
      `${scenario.width}x${scenario.height}-ling-${scenario.theme}-list-ready.png`,
    );
  });
}

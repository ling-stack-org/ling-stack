import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMediaProvider,
  createMockTeammate,
  isRecord,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-model/",
  import.meta.url,
));

test("ready model uses one header action owner with reset, guarded save, and expiring toast", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    readyProvider({ id: "provider_primary", displayName: "Local Relay", model: "gpt-5.5" }),
    readyProvider({ id: "provider_secondary", displayName: "Review Relay", model: "claude-sonnet-5" }),
  ];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_model_ready",
    displayName: "Model Systems Engineer",
    providerPresetId: "provider_primary",
  })];
  await mockDaemon(page, state, { teammateUpdateDelayMs: 160 });
  await page.goto("/");

  const model = await openModel(page, "Model Systems Engineer");
  const header = page.getByLabel("Single agent settings");
  const select = model.getByLabel("Assigned model");
  await expect(select).toHaveClass(/ling-ui-select/u);
  await expect(select).toHaveValue("provider_primary");
  await expect(model.getByText("Ready for replies", { exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: "Save model" })).toBeDisabled();
  await expect(model.getByRole("button", { name: "Save model" })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-ready.png");

  await select.selectOption("provider_secondary");
  await expect(header.getByRole("button", { name: "Reset model" })).toBeEnabled();
  await header.getByRole("button", { name: "Reset model" }).click();
  await expect(select).toHaveValue("provider_primary");

  await select.selectOption("provider_secondary");
  await header.getByRole("button", { name: "Save model" }).click();
  await expect(header.getByRole("button", { name: "Save model" })).toBeDisabled();
  await expect(page.getByText("Teammate model saved", { exact: true })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === "teammate_model_ready");
    return isRecord(teammate) ? teammate.providerPresetId : undefined;
  }).toBe("provider_secondary");
  await expect(page.getByText("Teammate model saved", { exact: true })).toHaveCount(0, { timeout: 5_000 });
  await expect(model.getByText("Saved", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("model state priority keeps missing, incompatible, disabled, key, check, and unassigned states truthful", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({
      id: "provider_missing_key",
      displayName: "Secure Relay",
      model: "gpt-5.5",
      apiKeyConfigured: false,
      lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-20T00:00:00.000Z" },
    }),
    createChatProvider({ id: "provider_unchecked", displayName: "Unchecked Relay", model: "gpt-5-mini" }),
    createChatProvider({
      id: "provider_failed",
      displayName: "Failing Relay",
      model: "gpt-5.4",
      lastCheck: { ok: false, code: "model_not_found", message: "Raw provider failure", checkedAt: "2026-07-20T00:00:00.000Z" },
    }),
    readyProvider({ id: "provider_disabled", displayName: "Paused Relay", model: "gpt-5.3", enabled: false }),
    createMediaProvider({ id: "provider_media", displayName: "Image Generator", model: "gpt-image-2" }),
  ];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_missing_key", displayName: "Missing Key Reviewer", providerPresetId: "provider_missing_key" }),
    createMockTeammate({ id: "teammate_unchecked", displayName: "Unchecked Reviewer", providerPresetId: "provider_unchecked" }),
    createMockTeammate({ id: "teammate_failed", displayName: "Failed Check Reviewer", providerPresetId: "provider_failed" }),
    createMockTeammate({ id: "teammate_disabled", displayName: "Disabled Model Reviewer", providerPresetId: "provider_disabled" }),
    createMockTeammate({ id: "teammate_media", displayName: "Media Model Reviewer", providerPresetId: "provider_media" }),
    createMockTeammate({ id: "teammate_missing", displayName: "Missing Model Reviewer", providerPresetId: "provider_removed" }),
    createMockTeammate({ id: "teammate_unassigned", displayName: "Unassigned Reviewer", providerPresetId: undefined }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  let model = await openModel(page, "Missing Key Reviewer");
  await expect(model.getByText("API key required", { exact: true })).toBeVisible();
  await expect(model).toContainText("Add an API key in Model Workbench.");
  await captureEvidence(page, "1280x800-ling-dark-missing-key.png");

  model = await openModel(page, "Unchecked Reviewer");
  await expect(model.getByText("Check required", { exact: true })).toBeVisible();

  model = await openModel(page, "Failed Check Reviewer");
  await expect(model.getByText("Model check failed", { exact: true })).toBeVisible();
  await expect(model).not.toContainText("Raw provider failure");

  model = await openModel(page, "Disabled Model Reviewer");
  await expect(model.getByText("Model disabled", { exact: true })).toBeVisible();

  model = await openModel(page, "Media Model Reviewer");
  await expect(model.getByText("Not chat compatible", { exact: true })).toBeVisible();

  model = await openModel(page, "Missing Model Reviewer");
  await expect(model.getByText("Model unavailable", { exact: true })).toBeVisible();
  await expect(model.getByLabel("Assigned model")).toHaveValue("provider_removed");

  model = await openModel(page, "Unassigned Reviewer");
  await expect(model.getByText("No model selected", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("protected Ling Agent uses a managed model path without editable assignment", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960, locale: "zh-CN" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  state.aiTeammates = [createMockTeammate({
    id: "ling_agent",
    kind: "system_teammate",
    systemRole: "ling_agent",
    protectedProfile: true,
    displayName: "Ling Agent",
    providerPresetId: undefined,
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const model = await openModel(page, "Ling Agent", chineseLabels);
  const header = page.getByLabel("单个智能体设置");
  await expect(model.getByText("由 Ling Stack 管理", { exact: true })).toBeVisible();
  await expect(model).toContainText("Ling Agent 使用当前频道或工作区选择的模型。");
  await expect(model.getByLabel("已分配模型")).toHaveCount(0);
  await expect(header.getByRole("button", { name: "重置模型" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "保存模型" })).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-dark-protected-managed.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("failed model save stays local and preserves the selected draft", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    readyProvider({ id: "provider_primary", displayName: "Primary Relay", model: "gpt-5.5" }),
    readyProvider({ id: "provider_secondary", displayName: "Secondary Relay", model: "claude-sonnet-5" }),
  ];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_model_failure",
    displayName: "Model Failure Reviewer",
    providerPresetId: "provider_primary",
  })];
  await mockDaemon(page, state, { failTeammateProfileUpdates: true });
  await page.goto("/");

  const model = await openModel(page, "Model Failure Reviewer");
  await model.getByLabel("Assigned model").selectOption("provider_secondary");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save model" }).click();
  await expect(model.getByText("Model changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expect(model.getByLabel("Assigned model")).toHaveValue("provider_secondary");
  await expect(page.getByText("Teammate model saved", { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-light-save-failure.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("empty model inventory provides one workbench repair path", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_model_empty",
    displayName: "Unconfigured Teammate",
    providerPresetId: undefined,
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const model = await openModel(page, "Unconfigured Teammate");
  await expect(model.getByText("No models configured", { exact: true })).toBeVisible();
  await expect(model.getByLabel("Assigned model")).toHaveCount(0);
  await model.getByRole("button", { name: "Open Model Workbench" }).click();
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" })).toHaveClass(/active/u);
  expect(runtimeErrors).toEqual([]);
});

test("long model identity remains contained in compact dark layout", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    locale: "en-US",
    reducedMotion: "reduce",
  });
  const runtimeErrors = collectRuntimeErrors(page);
  const longModel = "provider-model-with-a-deliberately-long-identity-for-compact-layout-validation-2026-07-21";
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [readyProvider({
    id: "provider_long",
    displayName: "Long Identity Enterprise Relay With Regional Routing",
    model: longModel,
  })];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_model_long",
    displayName: "Long Model Layout Reviewer",
    providerPresetId: "provider_long",
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  const model = await openModel(page, "Long Model Layout Reviewer");
  await expect(model.getByText(longModel, { exact: true })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-long-model.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

const chineseLabels = {
  details: "显示详情",
  dock: "私聊工作区面板",
  settings: "设置",
  settingsSections: "设置分组",
  model: "模型",
  panel: "模型分配",
} as const;

function readyProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return createChatProvider({
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-20T00:00:00.000Z" },
    ...overrides,
  });
}

async function openModel(
  page: Page,
  teammateName: string,
  labels: {
    readonly details: string;
    readonly dock: string;
    readonly settings: string;
    readonly settingsSections: string;
    readonly model: string;
    readonly panel: string;
  } = {
    details: "Show details",
    dock: "Private chat workspace dock",
    settings: "Settings",
    settingsSections: "Settings sections",
    model: "Model",
    panel: "Model assignment",
  },
): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  const chatHeader = page.locator("[data-ui2-teammate-chat-header]");
  await expect(chatHeader).toBeVisible();
  if (await page.getByLabel(labels.dock).count() === 0) {
    await chatHeader.getByRole("button", { name: labels.details }).click();
  }
  await page.getByLabel(labels.dock).getByRole("button", { name: labels.settings }).click();
  await page.getByLabel(labels.settingsSections).getByRole("button", { name: labels.model, exact: true }).click();
  const model = page.getByLabel(labels.panel);
  await expect(model).toBeVisible();
  return model;
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
    const themeId = theme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          className: element.className,
          bottom: Math.round(rect.bottom),
          position: style.position,
        };
      })
      .filter((item) => item.bottom > window.innerHeight + 1 && item.position !== "fixed")
      .sort((left, right) => right.bottom - left.bottom)
      .slice(0, 12),
  }));
  expect(overflow.scrollWidth, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight, JSON.stringify(overflow.offenders)).toBeLessThanOrEqual(overflow.clientHeight + 1);
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

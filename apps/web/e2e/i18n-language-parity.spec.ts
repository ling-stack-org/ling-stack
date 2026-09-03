import { expect, test, type Page } from "@playwright/test";
import { SUPPORTED_LOCALES, loadCatalog } from "@ling-stack/localization";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const REPRESENTATIVE_LOCALES = new Set([
  "de-DE",
  "es-419",
  "hi-IN",
  "ja-JP",
  "ko-KR",
  "pt-BR",
  "th-TH",
  "zh-TW",
]);

test("switches and persists every supported product locale without runtime fallback errors", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences" }).click();

  const panel = page.locator("[data-ui2-interface-preferences]");
  const productLanguage = panel.locator("select[data-product-language]");
  const responseLanguage = panel.locator("select[data-response-language]");
  await expect(productLanguage).toBeVisible();
  await expect(productLanguage.locator("option")).toHaveCount(SUPPORTED_LOCALES.length);
  await expect(responseLanguage.locator("option")).toHaveCount(SUPPORTED_LOCALES.length + 1);
  expect(await productLanguage.locator("option").evaluateAll((options) => options.map((option) => option.getAttribute("value"))))
    .toEqual([...SUPPORTED_LOCALES]);

  for (const locale of SUPPORTED_LOCALES) {
    const catalog = await loadCatalog(locale);
    await productLanguage.selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(productLanguage).toHaveValue(locale);
    await expect.poll(() => state.workspaceSettings.locale).toBe(locale);
    await expect(panel.getByRole("heading", { name: catalog.messages.Language, exact: true })).toBeVisible();
    await expect(productLanguage).toHaveAttribute("aria-label", catalog.messages["Product language"]);
    await expect(responseLanguage).toHaveAttribute("aria-label", catalog.messages["AI response language"]);
    await responseLanguage.selectOption(locale);
    await expect(responseLanguage).toHaveValue(locale);
    await expect.poll(() => state.workspaceSettings.responseLanguage).toBe(locale);
    await expect(panel).not.toContainText("settings.language.load_failed");
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow, `horizontal overflow for ${locale}`).toEqual({ body: 0, document: 0 });
    if (REPRESENTATIVE_LOCALES.has(locale)) {
      expect(
        await clippedSettingsNavigationText(page),
        `clipped settings navigation text for ${locale}`,
      ).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${locale}-light.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  }

  const persistedLocale = SUPPORTED_LOCALES.at(-1)!;
  const persistedCatalog = await loadCatalog(persistedLocale);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", persistedLocale);
  await page.getByRole("button", { name: persistedCatalog.messages.Settings, exact: true }).click();
  await page.getByLabel(persistedCatalog.messages["Settings sections"])
    .getByRole("button", { name: persistedCatalog.messages["Interface preferences"], exact: true })
    .click();
  await expect(page.locator("select[data-product-language]")).toHaveValue(persistedLocale);
  await expect(page.locator("select[data-response-language]")).toHaveValue(persistedLocale);

  expect(runtimeErrors).toEqual([]);
});

test("renders representative long and complex scripts in dark mode", async ({ page }, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-dark" }));
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences" }).click();

  const productLanguage = page.locator("select[data-product-language]");
  for (const locale of ["de-DE", "hi-IN", "th-TH"] as const) {
    const catalog = await loadCatalog(locale);
    await productLanguage.selectOption(locale);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(productLanguage).toHaveAttribute("aria-label", catalog.messages["Product language"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath(`${locale}-dark.png`),
      fullPage: true,
      animations: "disabled",
    });
  }

  expect(runtimeErrors).toEqual([]);
});

test("keeps the previous locale when workspace persistence fails", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  const englishCatalog = await loadCatalog("en-US");
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings.locale = "en-US";
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences" }).click();

  const productLanguage = page.locator("select[data-product-language]");
  state.failNextWorkspaceSettingsPatch = {
    error: "workspace_settings_unavailable",
    message: "Workspace settings are temporarily unavailable.",
    status: 503,
  };
  await productLanguage.selectOption("zh-CN");

  await expect(productLanguage).toHaveValue("en-US");
  await expect(productLanguage).not.toBeDisabled();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.getByRole("alert")).toContainText(englishCatalog.messages["settings.language.load_failed"]);
  expect(state.workspaceSettings.locale).toBe("en-US");
  expect(runtimeErrors).toEqual([
    "console: Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
  ]);
});

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  return errors;
}

async function clippedSettingsNavigationText(page: Page): Promise<string[]> {
  return page.locator([
    "[data-settings-shell-navigation] [data-ling-button-slot='label']",
    "[data-settings-shell-navigation] [data-settings-shell-group-label]",
  ].join(", ")).evaluateAll((elements) => elements.flatMap((element) => {
    if (!(element instanceof HTMLElement) || element.offsetParent === null) return [];
    const clipped = element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
    return clipped ? [element.textContent?.trim() ?? ""] : [];
  }));
}

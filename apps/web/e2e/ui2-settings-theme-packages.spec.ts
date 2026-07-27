import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";
import {
  lingLightTheme,
  type LingThemePackManifest,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/theme-packages/",
  import.meta.url,
));
const previewPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("local theme import, isolated preview, reimport, persistence, and active delete form one lifecycle", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await preparePage(page, {
    colorScheme: "light",
    locale: "en-US",
    selection: { mode: "fixed", themeId: "ling-light" },
    viewport: { width: 1440, height: 960 },
  });
  const panel = await openInterfacePreferences(page);
  const importButton = panel.getByRole("button", { name: "Import theme" });
  await importButton.click();

  const initialManifest = importedTheme({
    appBackground: "#edf5f1",
    id: "quiet-ocean",
    name: "Quiet Ocean",
  });
  const importDialog = page.getByRole("dialog", { name: "Import theme" });
  await importDialog.getByLabel("Choose a theme file").setInputFiles({
    name: "quiet-ocean.ling-theme",
    mimeType: "application/zip",
    buffer: createThemeArchive(initialManifest),
  });
  await expect(importDialog.getByRole("region", { name: "Theme package summary" })).toContainText("Quiet Ocean");
  await expect(importDialog.getByText("MIT", { exact: true })).toBeVisible();
  await expect(importDialog.getByRole("button", { name: "Import theme" })).toBeEnabled();
  await captureEvidence(page, "1440x960-ling-light-import-review.png");

  const candidatePreviewButton = importDialog.getByRole("button", { name: "Preview" });
  await candidatePreviewButton.click();
  const previewDialog = page.getByRole("dialog", { name: "Quiet Ocean" });
  await expect(previewDialog.locator("[data-theme-preview-fixture]")).toBeVisible();
  await expect(previewDialog.locator("[data-theme-preview-fixture]")).toContainText("Theme preview");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await captureEvidence(page, "1280x800-ling-light-preview-dialog.png");
  await previewDialog.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Close" }).click();
  await expect(candidatePreviewButton).toBeFocused();

  await importDialog.getByLabel("Use this theme after import").check();
  await importDialog.getByRole("button", { name: "Import theme" }).click();
  await expect(importDialog).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", initialManifest.id);
  await expect(page.locator('.ling-ui-toast[data-scope="theme:package:quiet-ocean"]')).toContainText("Theme imported");

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", initialManifest.id);
  const localOption = reloadedPanel.getByRole("radio", { name: /Quiet Ocean/ });
  await expect(localOption).toBeVisible();
  const actions = reloadedPanel.getByRole("button", { name: "Theme actions for Quiet Ocean" });
  await actions.click();
  await expect(page.getByRole("menuitem", { name: "Preview" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reimport" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await captureEvidence(page, "1440x960-quiet-ocean-installed-menu.png");

  await page.getByRole("menuitem", { name: "Preview" }).click();
  const installedPreview = page.getByRole("dialog", { name: "Quiet Ocean" });
  await expect(installedPreview.locator("img.ling-ui-theme-preview-artwork")).toBeVisible();
  await installedPreview.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Close" }).click();
  await expect(actions).toBeFocused();

  await actions.click();
  await page.getByRole("menuitem", { name: "Reimport" }).click();
  const replacement = importedTheme({
    appBackground: "#e8f1ec",
    id: "quiet-ocean",
    name: "Quiet Ocean Refined",
  });
  const reimportDialog = page.getByRole("dialog", { name: "Reimport theme" });
  await reimportDialog.getByLabel("Choose a theme file").setInputFiles({
    name: "quiet-ocean-refined.ling-theme",
    mimeType: "application/zip",
    buffer: createThemeArchive(replacement),
  });
  await expect(reimportDialog.getByRole("region", { name: "Theme package summary" })).toContainText("Quiet Ocean Refined");
  await page.setViewportSize({ width: 1280, height: 800 });
  await captureEvidence(page, "1280x800-quiet-ocean-reimport-review.png");
  await reimportDialog.getByRole("button", { name: "Reimport theme" }).click();
  await expect(reimportDialog).toHaveCount(0);
  await expect(reloadedPanel.getByRole("radio", { name: /Quiet Ocean Refined/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-app").trim())).toBe("#e8f1ec");
  await expect(page.locator('.ling-ui-toast[data-scope="theme:package:quiet-ocean"]')).toHaveCount(0, { timeout: 5_000 });

  const refinedActions = reloadedPanel.getByRole("button", { name: "Theme actions for Quiet Ocean Refined" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await refinedActions.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete theme Quiet Ocean Refined?" });
  await expect(deleteDialog).toContainText("matching built-in theme");
  await captureEvidence(page, "1440x960-quiet-ocean-delete-confirm.png");
  await deleteDialog.getByRole("button", { name: "Delete theme" }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(reloadedPanel.getByRole("radio", { name: /Quiet Ocean Refined/ })).toHaveCount(0);
  await expectStoredThemeAbsent(page, "quiet-ocean");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("runtime artwork and traversal archives are rejected without changing the active theme", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await preparePage(page, {
    colorScheme: "dark",
    locale: "zh-CN",
    selection: { mode: "fixed", themeId: "ling-dark" },
    viewport: { width: 1280, height: 800 },
  });
  const panel = await openInterfacePreferences(page, "zh-CN");
  await panel.getByRole("button", { name: "导入主题" }).click();
  const dialog = page.getByRole("dialog", { name: "导入主题" });
  const unsafeArtwork = {
    ...importedTheme({ id: "unsafe-artwork", name: "Unsafe Artwork" }),
    artwork: {
      assets: [{ image: "assets/preview.png", slot: "shell-background" }],
    },
  } as unknown as LingThemePackManifest;
  await dialog.getByLabel("选择主题文件").setInputFiles({
    name: "unsafe-artwork.ling-theme",
    mimeType: "application/zip",
    buffer: createThemeArchive(unsafeArtwork),
  });
  await expect(dialog.getByRole("alert")).toContainText("导入主题暂不支持运行时背景图");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await captureEvidence(page, "1280x800-ling-dark-artwork-blocked.png");

  await dialog.getByLabel("选择主题文件").setInputFiles({
    name: "traversal.ling-theme",
    mimeType: "application/zip",
    buffer: createThemeArchive(importedTheme({ id: "traversal", name: "Traversal" }), {
      "../escape.png": previewPng,
    }),
  });
  await expect(dialog.getByRole("alert")).toContainText("不安全的文件路径");
  await expect(dialog.getByRole("button", { name: "导入主题" })).toBeDisabled();
  await expect(panel.getByRole("radio", { name: /Unsafe Artwork|Traversal/ })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  expect(runtimeErrors).toEqual([]);
});

test("failed reimport keeps the previous registry, package, and visible theme", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await preparePage(page, {
    colorScheme: "light",
    locale: "en-US",
    selection: { mode: "fixed", themeId: "ling-light" },
    viewport: { width: 1440, height: 960 },
  });
  const panel = await openInterfacePreferences(page);
  const original = importedTheme({ appBackground: "#edf5f1", id: "steady-theme", name: "Steady Theme" });
  await importTheme(page, panel, original);
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    Object.defineProperty(window, "__restoreThemePut", { configurable: true, value: originalPut });
    IDBObjectStore.prototype.put = function put(value: unknown, key?: IDBValidKey): IDBRequest {
      if (this.name === "theme-packages") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });

  const actions = panel.getByRole("button", { name: "Theme actions for Steady Theme" });
  await actions.click();
  await page.getByRole("menuitem", { name: "Reimport" }).click();
  const changed = importedTheme({ appBackground: "#ddebe3", id: "steady-theme", name: "Changed Theme" });
  const dialog = page.getByRole("dialog", { name: "Reimport theme" });
  await dialog.getByLabel("Choose a theme file").setInputFiles({
    name: "changed-theme.ling-theme",
    mimeType: "application/zip",
    buffer: createThemeArchive(changed),
  });
  await dialog.getByRole("button", { name: "Reimport theme" }).click();
  await expect(dialog.getByRole("alert")).toContainText("previous theme is unchanged");
  await expect(panel.locator('[data-theme-option-id="steady-theme"]')).toContainText("Steady Theme");
  await expect(panel.locator('[data-theme-option-id="steady-theme"]')).not.toContainText("Changed Theme");
  const storedName = await readStoredThemeName(page, "steady-theme");
  expect(storedName).toBe("Steady Theme");
  await page.evaluate(() => {
    const restore = (window as typeof window & { __restoreThemePut?: typeof IDBObjectStore.prototype.put }).__restoreThemePut;
    if (restore) IDBObjectStore.prototype.put = restore;
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByRole("radio", { name: /Steady Theme/ })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("duplicate import, mismatched reimport, and failed delete preserve the installed package", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await preparePage(page, {
    colorScheme: "light",
    locale: "en-US",
    selection: { mode: "fixed", themeId: "ling-light" },
    viewport: { width: 1280, height: 800 },
  });
  const panel = await openInterfacePreferences(page);
  const original = importedTheme({ id: "protected-theme", name: "Protected Theme" });
  await importTheme(page, panel, original);

  await panel.getByRole("button", { name: "Import theme" }).click();
  const duplicateDialog = page.getByRole("dialog", { name: "Import theme" });
  await duplicateDialog.getByLabel("Choose a theme file").setInputFiles({
    name: "protected-theme.ling-theme",
    mimeType: "application/zip",
    buffer: createThemeArchive(original),
  });
  await expect(duplicateDialog.getByRole("alert")).toContainText("already installed");
  await expect(duplicateDialog.getByRole("button", { name: "Import theme" })).toBeDisabled();
  await duplicateDialog.getByRole("button", { name: "Cancel" }).click();

  const actions = panel.getByRole("button", { name: "Theme actions for Protected Theme" });
  await actions.click();
  await page.getByRole("menuitem", { name: "Reimport" }).click();
  const reimportDialog = page.getByRole("dialog", { name: "Reimport theme" });
  await reimportDialog.getByLabel("Choose a theme file").setInputFiles({
    name: "different-theme.ling-theme",
    mimeType: "application/zip",
    buffer: createThemeArchive(importedTheme({ id: "different-theme", name: "Different Theme" })),
  });
  await expect(reimportDialog.getByRole("alert")).toContainText("same theme ID");
  await expect(reimportDialog.getByRole("button", { name: "Reimport theme" })).toBeDisabled();
  await reimportDialog.getByRole("button", { name: "Cancel" }).click();

  await page.evaluate(() => {
    const originalDelete = IDBObjectStore.prototype.delete;
    Object.defineProperty(window, "__restoreThemeDelete", { configurable: true, value: originalDelete });
    IDBObjectStore.prototype.delete = function deleteValue(query: IDBValidKey | IDBKeyRange): IDBRequest<undefined> {
      if (this.name === "theme-packages") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return originalDelete.call(this, query);
    };
  });
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete theme Protected Theme?" });
  await deleteDialog.getByRole("button", { name: "Delete theme" }).click();
  await expect(deleteDialog.getByRole("alert")).toContainText("remains installed");
  await expect(panel.locator('[data-theme-option-id="protected-theme"]')).toContainText("Protected Theme");
  expect(await readStoredThemeName(page, "protected-theme")).toBe("Protected Theme");
  await page.evaluate(() => {
    const restore = (window as typeof window & {
      __restoreThemeDelete?: typeof IDBObjectStore.prototype.delete;
    }).__restoreThemeDelete;
    if (restore) IDBObjectStore.prototype.delete = restore;
  });
  await deleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByRole("radio", { name: /Protected Theme/ })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("an existing IndexedDB v1 manifest survives the v3 package-and-draft-store upgrade", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  const legacy = importedTheme({ id: "legacy-local-theme", name: "Legacy Local Theme" });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify({ mode: "fixed", themeId: "ling-light" }));
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/favicon.png");
  await seedVersionOneTheme(page, legacy);
  await page.goto("/");
  const panel = await openInterfacePreferences(page);
  await expect(panel.getByRole("radio", { name: /Legacy Local Theme/ })).toBeVisible();
  expect(await themeDatabaseShape(page)).toEqual({
    stores: ["theme-assets", "theme-draft-assets", "theme-drafts", "theme-packages", "themes"],
    version: 3,
  });

  const actions = panel.getByRole("button", { name: "Theme actions for Legacy Local Theme" });
  await actions.click();
  await page.getByRole("menuitem", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "Legacy Local Theme" });
  await expect(preview.locator("[data-theme-preview-fixture]")).toBeVisible();
  await expect(preview.locator("img.ling-ui-theme-preview-artwork")).toHaveCount(0);
  await preview.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Close" }).click();
  await actions.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete theme Legacy Local Theme?" });
  await deleteDialog.getByRole("button", { name: "Delete theme" }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expectStoredThemeAbsent(page, legacy.id);
  expect(runtimeErrors).toEqual([]);
});

async function preparePage(
  page: Page,
  input: {
    readonly colorScheme: "dark" | "light";
    readonly locale: "en-US" | "zh-CN";
    readonly selection: ThemeSelection;
    readonly viewport: { readonly height: number; readonly width: number };
  },
): Promise<void> {
  await page.setViewportSize(input.viewport);
  await page.emulateMedia({ colorScheme: input.colorScheme });
  await page.addInitScript(({ locale, selection }) => {
    localStorage.setItem("ling-stack.locale", locale);
    if (!localStorage.getItem("ling-stack.themeSelection")) {
      localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    }
    if (!localStorage.getItem("ling-stack.themeBootstrapSelection")) {
      localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    }
  }, { locale: input.locale, selection: input.selection });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
}

async function openInterfacePreferences(page: Page, locale: "en-US" | "zh-CN" = "en-US"): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: locale === "zh-CN" ? "设置" : "Settings" }).click();
  await page.getByLabel(locale === "zh-CN" ? "设置分组" : "Settings sections")
    .getByRole("button", { name: locale === "zh-CN" ? "界面偏好" : "Interface preferences" })
    .click();
  const panel = page.locator("[data-ui2-interface-preferences]");
  await expect(panel).toBeVisible();
  return panel;
}

async function importTheme(page: Page, panel: Locator, manifest: LingThemePackManifest): Promise<void> {
  await panel.getByRole("button", { name: "Import theme" }).click();
  const dialog = page.getByRole("dialog", { name: "Import theme" });
  await dialog.getByLabel("Choose a theme file").setInputFiles({
    name: `${manifest.id}.ling-theme`,
    mimeType: "application/zip",
    buffer: createThemeArchive(manifest),
  });
  await dialog.getByRole("button", { name: "Import theme" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole("radio", { name: new RegExp(manifest.name) })).toBeVisible();
}

function importedTheme(input: {
  readonly appBackground?: string;
  readonly id: string;
  readonly name: string;
}): LingThemePackManifest {
  const base = structuredClone(lingLightTheme);
  return {
    ...base,
    id: input.id,
    familyId: input.id,
    name: input.name,
    source: "local-import",
    author: "Ling Theme Test",
    license: "MIT",
    preview: "assets/preview.png",
    tokens: {
      ...base.tokens,
      background: {
        ...base.tokens.background,
        app: input.appBackground ?? base.tokens.background.app,
      },
    },
  };
}

function createThemeArchive(
  manifest: LingThemePackManifest,
  extraFiles: Readonly<Record<string, Uint8Array>> = {},
): Buffer {
  return Buffer.from(zipSync({
    "theme.json": strToU8(JSON.stringify(manifest)),
    "LICENSE.txt": strToU8("MIT License"),
    "assets/preview.png": previewPng,
    ...extraFiles,
  }, { level: 6 }));
}

async function expectStoredThemeAbsent(page: Page, themeId: string): Promise<void> {
  const state = await page.evaluate(async (id) => new Promise<{ assets: number; manifest: boolean; metadata: boolean }>((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["themes", "theme-packages", "theme-assets"], "readonly");
      const manifest = transaction.objectStore("themes").get(id);
      const metadata = transaction.objectStore("theme-packages").get(id);
      const assets = transaction.objectStore("theme-assets").index("themeId").count(IDBKeyRange.only(id));
      transaction.oncomplete = () => {
        resolve({ assets: assets.result, manifest: Boolean(manifest.result), metadata: Boolean(metadata.result) });
        database.close();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  }), themeId);
  expect(state).toEqual({ assets: 0, manifest: false, metadata: false });
}

async function readStoredThemeName(page: Page, themeId: string): Promise<string | undefined> {
  return page.evaluate(async (id) => new Promise<string | undefined>((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("themes", "readonly");
      const get = transaction.objectStore("themes").get(id);
      get.onsuccess = () => resolve((get.result as { name?: string } | undefined)?.name);
      get.onerror = () => reject(get.error);
      transaction.oncomplete = () => database.close();
    };
  }), themeId);
}

async function seedVersionOneTheme(page: Page, manifest: LingThemePackManifest): Promise<void> {
  await page.evaluate(async (value) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("themes", { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("themes", "readwrite");
      transaction.objectStore("themes").put(value);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  }), manifest);
}

async function themeDatabaseShape(page: Page): Promise<{ readonly stores: readonly string[]; readonly version: number }> {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      resolve({ stores: [...database.objectStoreNames].sort(), version: database.version });
      database.close();
    };
  }));
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

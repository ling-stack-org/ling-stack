import { expect, test, type Locator, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import {
  ThemeRegistry,
  lingLightTheme,
  resolvedThemeToBootstrapSnapshot,
  type LingThemePackManifest,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const previewPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const nativeTheme = Object.freeze({
  ...lingLightTheme,
  id: "native-calm",
  name: "Native Calm",
  source: "local-import",
}) satisfies LingThemePackManifest;

test("native install, preview, reimport, and hard reload use main-authoritative package state", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const rendererInitial = importedTheme({
    appBackground: "#eef4f1",
    id: "native-lifecycle",
    name: "Renderer Candidate",
  });
  const authoritativeInitial = importedTheme({
    appBackground: "#e6f0eb",
    id: rendererInitial.id,
    name: "Native Verified",
  });
  const rendererReplacement = importedTheme({
    appBackground: "#e3ece7",
    id: rendererInitial.id,
    name: "Renderer Replacement",
  });
  const authoritativeReplacement = importedTheme({
    appBackground: "#dce9e2",
    id: rendererInitial.id,
    name: "Native Refined",
  });
  await prepareDesktopPage(page, {
    packages: [],
    publications: [
      nativePublication(
        "native-lifecycle.ling-theme",
        readyDescriptor(authoritativeInitial, { checksum: "b".repeat(64), preview: true }),
      ),
      nativePublication(
        "native-lifecycle-refined.ling-theme",
        readyDescriptor(authoritativeReplacement, { checksum: "c".repeat(64), preview: true, revision: 2 }),
      ),
    ],
  });

  const panel = await openInterfacePreferences(page);
  await panel.getByRole("button", { name: "Import theme" }).click();
  const importDialog = page.getByRole("dialog", { name: "Import theme" });
  await importDialog.getByLabel("Choose a theme file").setInputFiles(themeFile(
    "native-lifecycle.ling-theme",
    rendererInitial,
  ));
  await expect(importDialog.getByRole("region", { name: "Theme package summary" }))
    .toContainText("Renderer Candidate");
  await importDialog.getByLabel("Use this theme after import").check();
  await importDialog.getByRole("button", { name: "Import theme" }).click();

  await expect(importDialog).toHaveCount(0);
  await expect(panel.getByRole("radio", { name: /Native Verified/ })).toBeVisible();
  await expect(panel.getByRole("radio", { name: /Renderer Candidate/ })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", rendererInitial.id);
  await expect.poll(() => harnessOperationCount(page, "install")).toBe(1);
  await expect.poll(() => desktopEvents(page)).toContain(`active:${rendererInitial.id}`);
  await expectIndexedDbThemeAbsent(page, rendererInitial.id);

  const initialActions = panel.getByRole("button", { name: "Theme actions for Native Verified" });
  await initialActions.click();
  await page.getByRole("menuitem", { name: "Preview" }).click();
  const initialPreview = page.getByRole("dialog", { name: "Native Verified" });
  await expect(initialPreview.locator("img.ling-ui-theme-preview-artwork")).toBeVisible();
  await expect(initialPreview).not.toContainText("private/native/preview.png");
  await initialPreview.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Close" }).click();
  await expect.poll(() => harnessOperationCount(page, "read")).toBe(1);

  await initialActions.click();
  await page.getByRole("menuitem", { name: "Reimport" }).click();
  const reimportDialog = page.getByRole("dialog", { name: "Reimport theme" });
  await reimportDialog.getByLabel("Choose a theme file").setInputFiles(themeFile(
    "native-lifecycle-refined.ling-theme",
    rendererReplacement,
  ));
  await expect(reimportDialog.getByRole("region", { name: "Theme package summary" }))
    .toContainText("Renderer Replacement");
  await reimportDialog.getByRole("button", { name: "Reimport theme" }).click();

  await expect(reimportDialog).toHaveCount(0);
  await expect(panel.getByRole("radio", { name: /Native Refined/ })).toBeVisible();
  await expect(panel.getByRole("radio", { name: /Renderer Replacement/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-app").trim()
  ))).toBe("#dce9e2");
  await expect.poll(() => harnessOperationCount(page, "reimport")).toBe(1);
  await expectIndexedDbThemeAbsent(page, rendererInitial.id);

  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", rendererInitial.id);
  await expect(reloadedPanel.getByRole("radio", { name: /Native Refined/ })).toBeVisible();
  await expect.poll(() => harnessOperationCount(page, "bootstrap")).toBeGreaterThanOrEqual(2);
  await expect.poll(() => desktopEvents(page)).toContain(`active:${rendererInitial.id}`);
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("Desktop install failure stays native and never writes an IndexedDB fallback", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const rendererCandidate = importedTheme({ id: "native-failure", name: "Native Failure" });
  await prepareDesktopPage(page, {
    failures: {
      install: { code: "disk_full", retryable: true, themeId: rendererCandidate.id },
    },
    packages: [],
    publications: [nativePublication(
      "native-failure.ling-theme",
      readyDescriptor(rendererCandidate, { checksum: "d".repeat(64), preview: true }),
    )],
  });

  const panel = await openInterfacePreferences(page);
  await panel.getByRole("button", { name: "Import theme" }).click();
  const dialog = page.getByRole("dialog", { name: "Import theme" });
  await dialog.getByLabel("Choose a theme file").setInputFiles(themeFile(
    "native-failure.ling-theme",
    rendererCandidate,
  ));
  await dialog.getByRole("button", { name: "Import theme" }).click();

  await expect(dialog.getByRole("alert")).toContainText("previous theme is unchanged");
  await expect(panel.getByRole("radio", { name: /Native Failure/ })).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect.poll(() => harnessOperationCount(page, "install")).toBe(1);
  expect(await harnessPackageIds(page)).toEqual([]);
  await expectIndexedDbThemeAbsent(page, rendererCandidate.id);

  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expect(reloadedPanel.getByRole("radio", { name: /Native Failure/ })).toHaveCount(0);
  await expectIndexedDbThemeAbsent(page, rendererCandidate.id);
  expect(errors).toEqual([]);
});

test("corrupt native packages can be reimported or deleted in dark zh-CN reduced motion", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const repairedManifest = importedTheme({ id: "broken-reimport", name: "Native Repaired" });
  await prepareDesktopPage(page, {
    colorScheme: "dark",
    locale: "zh-CN",
    packages: [
      corruptDescriptor("broken-reimport", 4),
      corruptDescriptor("broken-delete", 7),
    ],
    publications: [nativePublication(
      "broken-reimport.ling-theme",
      readyDescriptor(repairedManifest, { checksum: "e".repeat(64), preview: true, revision: 5 }),
    )],
    reducedMotion: "reduce",
    selectionThemeId: "broken-reimport",
    viewport: { height: 800, width: 1280 },
  });

  const panel = await openInterfacePreferences(page, "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-dark");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  expect((await desktopEvents(page)).filter((event) => event.startsWith("reported:"))[0]).toBe("reported:ling-dark");
  const repairs = panel.locator("[data-ui2-theme-package-repairs]");
  const reimportRow = repairs.locator('[data-theme-repair-kind="corrupt"]', { hasText: "broken-reimport" });
  await reimportRow.getByRole("button", { name: "重新导入" }).click();
  const reimportDialog = page.getByRole("dialog", { name: "重新导入主题" });
  await reimportDialog.getByLabel("选择主题文件").setInputFiles(themeFile(
    "broken-reimport.ling-theme",
    repairedManifest,
  ));
  await reimportDialog.getByRole("button", { name: "重新导入主题" }).click();
  await expect(reimportDialog).toHaveCount(0);
  await expect(panel.getByRole("radio", { name: /Native Repaired/ })).toBeVisible();
  await expect(repairs).not.toContainText("broken-reimport");
  await expect.poll(() => harnessOperationCount(page, "reimport")).toBe(1);

  const deleteRow = repairs.locator('[data-theme-repair-kind="corrupt"]', { hasText: "broken-delete" });
  await deleteRow.getByRole("button", { name: /删除主题/ }).click();
  const deleteDialog = page.getByRole("dialog", { name: /删除主题 broken-delete/ });
  await deleteDialog.getByRole("button", { name: "删除主题" }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(repairs).toHaveCount(0);
  await expect.poll(() => harnessOperationCount(page, "delete")).toBe(1);
  expect(await harnessPackageIds(page)).toEqual(["broken-reimport"]);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("legacy-only browser theme reimport installs native state and clears the legacy record", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const legacy = importedTheme({ id: "legacy-native-repair", name: "Legacy Browser Theme" });
  const authoritative = importedTheme({ id: legacy.id, name: "Native Legacy Repair" });
  await prepareDesktopPage(page, {
    legacyThemes: [legacy],
    packages: [],
    publications: [nativePublication(
      "legacy-native-repair.ling-theme",
      readyDescriptor(authoritative, { checksum: "f".repeat(64), preview: true }),
    )],
  });

  const panel = await openInterfacePreferences(page);
  const repairs = panel.locator("[data-ui2-theme-package-repairs]");
  const legacyRow = repairs.locator('[data-theme-repair-kind="legacy-browser-only"]');
  await expect(legacyRow).toContainText("Legacy Browser Theme");
  await legacyRow.getByRole("button", { name: "Reimport" }).click();
  const dialog = page.getByRole("dialog", { name: "Reimport theme" });
  await dialog.getByLabel("Choose a theme file").setInputFiles(themeFile(
    "legacy-native-repair.ling-theme",
    legacy,
  ));
  await dialog.getByRole("button", { name: "Reimport theme" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(repairs).toHaveCount(0);
  await expect(panel.getByRole("radio", { name: /Native Legacy Repair/ })).toBeVisible();
  await expect.poll(() => harnessOperationCount(page, "install")).toBe(1);
  expect(await harnessOperationCount(page, "reimport")).toBe(0);
  await expectIndexedDbThemeAbsent(page, legacy.id);

  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expect(reloadedPanel.locator("[data-ui2-theme-package-repairs]")).toHaveCount(0);
  await expect(reloadedPanel.getByRole("radio", { name: /Native Legacy Repair/ })).toBeVisible();
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("Desktop bootstrap restores a native theme and confirms the active guard", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await prepareDesktopPage(page, {
    packages: [readyDescriptor(nativeTheme)],
    selectionThemeId: nativeTheme.id,
  });

  const panel = await openInterfacePreferences(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", nativeTheme.id);
  await expect(panel.getByRole("radio", { name: /Native Calm/ })).toBeVisible();
  await expect.poll(() => desktopEvents(page)).toContain(`active:${nativeTheme.id}`);
  await expect(panel.locator("[data-ui2-theme-package-repairs]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Desktop first paint rejects a local snapshot when native authority is unavailable", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const manifest = importedTheme({
    appBackground: "#e2eee8",
    id: "authority-missing",
    name: "Authority Missing",
  });
  const selection = { mode: "fixed", themeId: manifest.id } satisfies ThemeSelection;
  const registry = new ThemeRegistry();
  const installed = registry.install(manifest, "local-import", "2026-07-26T00:00:00.000Z");
  if (!installed.ok) throw new Error("Failed to prepare authority-missing fixture");
  const snapshot = resolvedThemeToBootstrapSnapshot(registry.resolve(selection, "light"));
  if (!snapshot) throw new Error("Failed to prepare authority-missing bootstrap snapshot");

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "light" });
  await installDesktopHarness(page, {
    omitFirstPaint: true,
    packages: [readyDescriptor(manifest)],
    selectionThemeId: manifest.id,
  });
  await page.addInitScript(({ storedSelection, storedSnapshot }) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(storedSnapshot));
  }, { storedSelection: selection, storedSnapshot: snapshot });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", manifest.id);
  expect((await desktopEvents(page)).filter((event) => event.startsWith("reported:"))[0]).toBe("reported:ling-light");
  expect(errors).toEqual([]);
});

test("Desktop first paint rejects a stale checksum after same-ID native replacement", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const manifest = importedTheme({
    appBackground: "#e4eee9",
    id: "checksum-replaced",
    name: "Checksum Replaced",
  });
  const selection = { mode: "fixed", themeId: manifest.id } satisfies ThemeSelection;
  const registry = new ThemeRegistry();
  const installed = registry.install(manifest, "local-import", "2026-07-26T00:00:00.000Z");
  if (!installed.ok) throw new Error("Failed to prepare checksum fixture");
  const staleSnapshot = resolvedThemeToBootstrapSnapshot(
    registry.resolve(selection, "light"),
    "b".repeat(64),
  );
  if (!staleSnapshot) throw new Error("Failed to prepare checksum bootstrap snapshot");

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "light" });
  await installDesktopHarness(page, {
    packages: [readyDescriptor(manifest, { checksum: "a".repeat(64) })],
    selectionThemeId: manifest.id,
  });
  await page.addInitScript(({ storedSelection, storedSnapshot }) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(storedSnapshot));
  }, { storedSelection: selection, storedSnapshot: staleSnapshot });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", manifest.id);
  expect((await desktopEvents(page)).filter((event) => event.startsWith("reported:"))[0]).toBe("reported:ling-light");
  expect(errors).toEqual([]);
});

test("Desktop built-in selection ignores a forged local snapshot with the same theme ID", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const forgedManifest = importedTheme({
    appBackground: "#121212",
    id: "forged-built-in-source",
    name: "Forged Built In",
  });
  const registry = new ThemeRegistry();
  if (!registry.install(forgedManifest, "local-import").ok) throw new Error("Failed to prepare forged fixture");
  const forgedResolved = registry.resolve({ mode: "fixed", themeId: forgedManifest.id }, "dark");
  const forgedSnapshot = resolvedThemeToBootstrapSnapshot(forgedResolved, "a".repeat(64));
  if (!forgedSnapshot) throw new Error("Failed to prepare forged snapshot");

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "dark" });
  await installDesktopHarness(page, { packages: [], selectionThemeId: "ling-light" });
  await page.addInitScript((snapshot) => {
    const selection = { mode: "fixed", themeId: "ling-light" };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify({
      ...snapshot,
      themeId: "ling-light",
      colorScheme: "dark",
    }));
  }, forgedSnapshot);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect.poll(() => page.evaluate(() => (
    getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-app").trim()
  ))).toBe(lingLightTheme.tokens.background.app);
  expect(errors).toEqual([]);
});

test("Desktop malformed storage still follows the system Dark built-in on first paint", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await installDesktopHarness(page, { packages: [] });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", "{broken-json");
    localStorage.setItem("ling-stack.themeBootstrapSelection", "{broken-json");
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", "{broken-json");
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-dark");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  expect(errors).toEqual([]);
});

test("active Desktop theme deletion confirms the built-in fallback before native delete", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await prepareDesktopPage(page, {
    packages: [readyDescriptor(nativeTheme)],
    selectionThemeId: nativeTheme.id,
  });
  const panel = await openInterfacePreferences(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", nativeTheme.id);
  await expect.poll(() => desktopEvents(page)).toContain(`active:${nativeTheme.id}`);

  await panel.getByRole("button", { name: "Theme actions for Native Calm" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete theme Native Calm?" })
    .getByRole("button", { name: "Delete theme" })
    .click();

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(panel.getByRole("radio", { name: /Native Calm/ })).toHaveCount(0);
  const events = await desktopEvents(page);
  const fallbackIndex = events.indexOf("active:ling-light");
  const deleteIndex = events.indexOf(`delete:${nativeTheme.id}`);
  expect(fallbackIndex).toBeGreaterThanOrEqual(0);
  expect(deleteIndex).toBeGreaterThan(fallbackIndex);
  expect(errors).toEqual([]);
});

test("a failed Desktop fallback confirmation keeps the active package and prevents delete", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await prepareDesktopPage(page, {
    failActiveThemeId: "ling-light",
    packages: [readyDescriptor(nativeTheme)],
    selectionThemeId: nativeTheme.id,
  });
  const panel = await openInterfacePreferences(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", nativeTheme.id);

  await panel.getByRole("button", { name: "Theme actions for Native Calm" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete theme Native Calm?" });
  await dialog.getByRole("button", { name: "Delete theme" }).click();

  await expect(dialog.getByRole("alert")).toContainText("remains installed");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", nativeTheme.id);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByRole("radio", { name: /Native Calm/ })).toBeVisible();
  expect((await desktopEvents(page)).some((event) => event.startsWith("delete:"))).toBe(false);
  expect(errors).toEqual([]);
});

test("corrupt and legacy-only Desktop packages stay out of ThemePicker and share one repair owner", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const legacyTheme = { ...nativeTheme, id: "legacy-calm", name: "Legacy Calm" };
  const brokenTheme = { ...nativeTheme, id: "broken-calm", name: "Broken Calm" };
  const registry = new ThemeRegistry();
  if (!registry.install(brokenTheme, "local-import").ok) throw new Error("Failed to prepare corrupt snapshot fixture");
  const brokenSnapshot = resolvedThemeToBootstrapSnapshot(
    registry.resolve({ mode: "fixed", themeId: brokenTheme.id }, "light"),
    "d".repeat(64),
  );
  if (!brokenSnapshot) throw new Error("Failed to prepare corrupt bootstrap snapshot");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await installDesktopHarness(page, {
    packages: [{
      health: "corrupt",
      issueCode: "checksum_mismatch",
      recordRevision: 4,
      themeId: "broken-calm",
    }],
  });
  await page.addInitScript((snapshot) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "broken-calm" }));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify({ mode: "fixed", themeId: "broken-calm" }));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(snapshot));
  }, brokenSnapshot);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/favicon.png");
  await seedLegacyTheme(page, legacyTheme);
  await page.goto("/");

  const panel = await openInterfacePreferences(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  const repairs = panel.locator("[data-ui2-theme-package-repairs]");
  await expect(repairs).toHaveCount(1);
  await expect(repairs).toContainText("broken-calm");
  await expect(repairs).toContainText("Legacy Calm");
  await expect(panel.getByRole("radio", { name: /broken-calm|Legacy Calm/ })).toHaveCount(0);

  const corruptRow = repairs.locator('[data-theme-repair-kind="corrupt"]');
  await corruptRow.getByRole("button", { name: "Reimport" }).click();
  await expect(page.getByRole("dialog", { name: "Reimport theme" })).toBeVisible();
  await page.getByRole("dialog", { name: "Reimport theme" }).getByRole("button", { name: "Cancel" }).click();
  await expect(corruptRow.getByRole("button", { name: "Reimport" })).toBeFocused();
  expect(errors).toEqual([]);
});

type DesktopHarnessOperation = "bootstrap" | "delete" | "install" | "list" | "read" | "reimport" | "setActive";

interface DesktopHarnessFailure {
  readonly code: string;
  readonly retryable: boolean;
  readonly themeId?: string;
}

interface DesktopHarnessPublication {
  readonly descriptor: Record<string, unknown>;
  readonly licenseText?: string;
  readonly originalFileName: string;
  readonly previewBytes?: readonly number[];
}

interface DesktopHarnessOptions {
  readonly colorScheme?: "dark" | "light";
  readonly failActiveThemeId?: string;
  readonly failures?: Partial<Record<DesktopHarnessOperation, DesktopHarnessFailure>>;
  readonly legacyThemes?: readonly LingThemePackManifest[];
  readonly locale?: "en-US" | "zh-CN";
  readonly omitFirstPaint?: boolean;
  readonly packages: readonly Record<string, unknown>[];
  readonly publications?: readonly DesktopHarnessPublication[];
  readonly reducedMotion?: "no-preference" | "reduce";
  readonly selectionThemeId?: string;
  readonly viewport?: { readonly height: number; readonly width: number };
}

interface DesktopHarnessCall {
  readonly operation: DesktopHarnessOperation;
  readonly request: Readonly<Record<string, unknown>>;
}

async function prepareDesktopPage(page: Page, options: DesktopHarnessOptions): Promise<void> {
  await page.setViewportSize(options.viewport ?? { width: 1440, height: 960 });
  await page.emulateMedia({
    colorScheme: options.colorScheme ?? "light",
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await installDesktopHarness(page, options);
  await page.addInitScript(({ locale, selectionThemeId }) => {
    localStorage.setItem("ling-stack.locale", locale);
    const selection = { mode: "fixed", themeId: selectionThemeId };
    if (!localStorage.getItem("ling-stack.themeSelection")) {
      localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    }
    if (!localStorage.getItem("ling-stack.themeBootstrapSelection")) {
      localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    }
  }, {
    locale: options.locale ?? "en-US",
    selectionThemeId: options.selectionThemeId ?? (options.colorScheme === "dark" ? "ling-dark" : "ling-light"),
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  if (options.legacyThemes?.length) {
    await page.goto("/favicon.png");
    for (const manifest of options.legacyThemes) await seedLegacyTheme(page, manifest);
  }
  await page.goto("/");
}

async function installDesktopHarness(page: Page, options: DesktopHarnessOptions): Promise<void> {
  await page.addInitScript((harnessOptions) => {
    interface StoredPackage {
      readonly descriptor: Record<string, unknown>;
      readonly licenseText?: string;
      readonly previewBytes?: readonly number[];
    }
    interface HarnessState {
      activeThemeId?: string;
      calls: DesktopHarnessCall[];
      events: string[];
      packages: Record<string, StoredPackage>;
      repositoryRevision: number;
    }
    const storageKey = "ling-stack.e2e.desktop-theme-packages.v1";
    const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const seededPackages = Object.fromEntries(harnessOptions.packages.map((descriptor) => [
      String(descriptor.themeId),
      { descriptor: copy(descriptor) },
    ]));
    let state: HarnessState;
    try {
      const stored = localStorage.getItem(storageKey);
      state = stored
        ? JSON.parse(stored) as HarnessState
        : { calls: [], events: [], packages: seededPackages, repositoryRevision: 1 };
    } catch {
      state = { calls: [], events: [], packages: seededPackages, repositoryRevision: 1 };
    }
    const publications = new Map((harnessOptions.publications ?? []).map((publication) => [
      publication.originalFileName,
      publication,
    ]));
    const persist = (): void => localStorage.setItem(storageKey, JSON.stringify(state));
    const descriptors = (): Record<string, unknown>[] => Object.values(state.packages)
      .map((item) => copy(item.descriptor));
    const firstPaint = {
      repositoryRevision: state.repositoryRevision,
      authorityComplete: true,
      readyThemes: descriptors()
        .filter((descriptor) => descriptor.health === "ready")
        .map((descriptor) => ({
          themeId: String(descriptor.themeId),
          packageChecksumSha256: String(descriptor.packageChecksumSha256),
        }))
        .sort((left, right) => left.themeId < right.themeId ? -1 : left.themeId > right.themeId ? 1 : 0),
    };
    const success = <T,>(value: T) => ({ ok: true as const, value, warnings: [] });
    const failure = (
      operation: DesktopHarnessOperation,
      themeId?: string,
    ): { readonly error: DesktopHarnessFailure; readonly ok: false } | undefined => {
      const configured = harnessOptions.failures?.[operation];
      if (!configured) return undefined;
      return {
        ok: false,
        error: {
          code: configured.code,
          retryable: configured.retryable,
          ...(configured.themeId ?? themeId ? { themeId: configured.themeId ?? themeId } : {}),
        },
      };
    };
    const record = (operation: DesktopHarnessOperation, request: Record<string, unknown> = {}): void => {
      state.calls.push({ operation, request: copy(request) });
      persist();
    };
    const archiveRequest = (request: {
      readonly archiveBytes: ArrayBuffer;
      readonly expectedCurrentChecksumSha256?: string;
      readonly expectedRecordRevision?: number;
      readonly originalFileName: string;
      readonly rendererPackageChecksumSha256: string;
      readonly requestId: string;
      readonly themeId?: string;
    }): Record<string, unknown> => ({
      archiveByteLength: request.archiveBytes.byteLength,
      ...(request.expectedCurrentChecksumSha256 !== undefined
        ? { expectedCurrentChecksumSha256: request.expectedCurrentChecksumSha256 }
        : {}),
      ...(request.expectedRecordRevision !== undefined
        ? { expectedRecordRevision: request.expectedRecordRevision }
        : {}),
      originalFileName: request.originalFileName,
      rendererPackageChecksumSha256: request.rendererPackageChecksumSha256,
      requestId: request.requestId,
      ...(request.themeId !== undefined ? { themeId: request.themeId } : {}),
    });
    const notFound = (themeId: string) => ({
      ok: false as const,
      error: { code: "theme_not_found", retryable: false, themeId },
    });
    persist();
    Object.defineProperty(window, "__desktopThemeHarness", {
      configurable: true,
      value: {
        calls: state.calls,
        events: state.events,
        snapshot: () => copy(state),
      },
    });
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: "macos",
        daemonBaseUrl: "http://127.0.0.1:17891",
        appearance: {
          reportTheme(theme: { readonly themeId?: string }) {
            state.events.push(`reported:${String(theme.themeId ?? "unknown")}`);
            persist();
          },
        },
        themePackages: {
          ...(harnessOptions.omitFirstPaint ? {} : { firstPaint }),
          bootstrap: async () => {
            record("bootstrap");
            const rejected = failure("bootstrap");
            return rejected ?? success({
              activeGuardReady: true,
              packages: descriptors(),
              recoveryWarnings: [],
              repositoryRevision: state.repositoryRevision,
            });
          },
          list: async () => {
            record("list");
            const rejected = failure("list");
            return rejected ?? success(descriptors());
          },
          read: async ({ includePreviewBytes, themeId }: {
            readonly includePreviewBytes: boolean;
            readonly themeId: string;
          }) => {
            record("read", { includePreviewBytes, themeId });
            const rejected = failure("read", themeId);
            if (rejected) return rejected;
            const stored = state.packages[themeId];
            if (!stored) return notFound(themeId);
            return success({
              descriptor: copy(stored.descriptor),
              ...(stored.licenseText !== undefined ? { licenseText: stored.licenseText } : {}),
              ...(includePreviewBytes && stored.previewBytes
                ? { previewBytes: Uint8Array.from(stored.previewBytes).buffer }
                : {}),
            });
          },
          install: async (request: {
            readonly archiveBytes: ArrayBuffer;
            readonly originalFileName: string;
            readonly rendererPackageChecksumSha256: string;
            readonly requestId: string;
          }) => {
            state.events.push(`install:${request.originalFileName}`);
            record("install", archiveRequest(request));
            const publication = publications.get(request.originalFileName);
            const themeId = publication ? String(publication.descriptor.themeId) : undefined;
            const rejected = failure("install", themeId);
            if (rejected) return rejected;
            if (!publication || !themeId) {
              return { ok: false, error: { code: "invalid_request", retryable: false } };
            }
            if (state.packages[themeId]) {
              return { ok: false, error: { code: "theme_already_installed", retryable: false, themeId } };
            }
            state.repositoryRevision += 1;
            state.packages[themeId] = {
              descriptor: copy(publication.descriptor),
              ...(publication.licenseText !== undefined ? { licenseText: publication.licenseText } : {}),
              ...(publication.previewBytes !== undefined ? { previewBytes: [...publication.previewBytes] } : {}),
            };
            persist();
            return success(copy(publication.descriptor));
          },
          reimport: async (request: {
            readonly archiveBytes: ArrayBuffer;
            readonly expectedCurrentChecksumSha256?: string;
            readonly expectedRecordRevision: number;
            readonly originalFileName: string;
            readonly rendererPackageChecksumSha256: string;
            readonly requestId: string;
            readonly themeId: string;
          }) => {
            state.events.push(`reimport:${request.themeId}:${request.originalFileName}`);
            record("reimport", archiveRequest(request));
            const rejected = failure("reimport", request.themeId);
            if (rejected) return rejected;
            const current = state.packages[request.themeId];
            if (!current) return notFound(request.themeId);
            if (Number(current.descriptor.recordRevision) !== request.expectedRecordRevision) {
              return {
                ok: false,
                error: { code: "stale_repository_revision", retryable: false, themeId: request.themeId },
              };
            }
            const publication = publications.get(request.originalFileName);
            if (!publication || publication.descriptor.themeId !== request.themeId) {
              return {
                ok: false,
                error: { code: "theme_id_mismatch", retryable: false, themeId: request.themeId },
              };
            }
            state.repositoryRevision += 1;
            state.packages[request.themeId] = {
              descriptor: copy(publication.descriptor),
              ...(publication.licenseText !== undefined ? { licenseText: publication.licenseText } : {}),
              ...(publication.previewBytes !== undefined ? { previewBytes: [...publication.previewBytes] } : {}),
            };
            persist();
            return success(copy(publication.descriptor));
          },
          delete: async ({ expectedRecordRevision, requestId, themeId }: {
            readonly expectedRecordRevision: number;
            readonly requestId: string;
            readonly themeId: string;
          }) => {
            state.events.push(`delete:${themeId}`);
            record("delete", { expectedRecordRevision, requestId, themeId });
            const rejected = failure("delete", themeId);
            if (rejected) return rejected;
            const current = state.packages[themeId];
            if (!current) return notFound(themeId);
            if (state.activeThemeId === themeId) {
              return { ok: false, error: { code: "active_theme_protected", retryable: false, themeId } };
            }
            if (Number(current.descriptor.recordRevision) !== expectedRecordRevision) {
              return {
                ok: false,
                error: { code: "stale_repository_revision", retryable: false, themeId },
              };
            }
            delete state.packages[themeId];
            state.repositoryRevision += 1;
            persist();
            return success({ repositoryRevision: state.repositoryRevision });
          },
          setActive: async ({ themeId }: { readonly themeId: string }) => {
            state.events.push(`active:${themeId}`);
            record("setActive", { themeId });
            if (themeId === harnessOptions.failActiveThemeId) {
              return { ok: false, error: { code: "storage_unavailable", retryable: true, themeId } };
            }
            const rejected = failure("setActive", themeId);
            if (rejected) return rejected;
            const builtIn = themeId === "ling-dark" || themeId === "ling-light";
            const candidate = state.packages[themeId]?.descriptor;
            if (!builtIn && (!candidate || candidate.health !== "ready" || !candidate.manifest)) {
              return { ok: false, error: { code: "active_theme_unknown", retryable: false, themeId } };
            }
            state.activeThemeId = themeId;
            persist();
            return success({ activeThemeId: themeId });
          },
        },
        navigation: {
          acknowledgeIntent: async () => ({ accepted: true }),
          onIntent: () => () => undefined,
        },
        computerUse: {
          reportLocale() {},
          reportSelectedConversation() {},
          reportHostLayout() {},
          show: async () => ({ accepted: true }),
          hide: async () => ({ accepted: true }),
          stop: async () => ({ accepted: true }),
          getPreferences: async () => ({ previewAutoShow: true }),
          setAutoShow: async () => ({ accepted: true }),
          onSummaryChanged: () => () => undefined,
        },
      },
    });
  }, options);
}

function readyDescriptor(
  manifest: LingThemePackManifest,
  options: {
    readonly checksum?: string;
    readonly preview?: boolean;
    readonly revision?: number;
  } = {},
): Record<string, unknown> {
  return {
    health: "ready",
    installedAt: "2026-07-26T00:00:00.000Z",
    manifest,
    packageChecksumSha256: options.checksum ?? "a".repeat(64),
    ...(options.preview ? {
      preview: {
        byteLength: previewPng.byteLength,
        checksumSha256: "9".repeat(64),
        height: 1,
        mimeType: "image/png",
        path: "private/native/preview.png",
        width: 1,
      },
    } : {}),
    recordRevision: options.revision ?? 1,
    themeId: manifest.id,
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

function corruptDescriptor(themeId: string, recordRevision: number): Record<string, unknown> {
  return {
    health: "corrupt",
    issueCode: "checksum_mismatch",
    recordRevision,
    themeId,
  };
}

function nativePublication(
  originalFileName: string,
  descriptor: Record<string, unknown>,
): DesktopHarnessPublication {
  return {
    descriptor,
    licenseText: "MIT License",
    originalFileName,
    previewBytes: [...previewPng],
  };
}

async function desktopEvents(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as typeof window & {
    __desktopThemeHarness?: { readonly events: string[] };
  }).__desktopThemeHarness?.events ?? [])]);
}

async function desktopCalls(page: Page): Promise<DesktopHarnessCall[]> {
  return page.evaluate(() => [...((window as typeof window & {
    __desktopThemeHarness?: { readonly calls: DesktopHarnessCall[] };
  }).__desktopThemeHarness?.calls ?? [])]);
}

async function harnessOperationCount(page: Page, operation: DesktopHarnessOperation): Promise<number> {
  return (await desktopCalls(page)).filter((call) => call.operation === operation).length;
}

async function harnessPackageIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const state = (window as typeof window & {
      __desktopThemeHarness?: {
        snapshot(): { readonly packages: Readonly<Record<string, unknown>> };
      };
    }).__desktopThemeHarness?.snapshot();
    return Object.keys(state?.packages ?? {}).sort();
  });
}

function importedTheme(input: {
  readonly appBackground?: string;
  readonly id: string;
  readonly name: string;
}): LingThemePackManifest {
  const base = structuredClone(lingLightTheme);
  return {
    ...base,
    author: "Ling Desktop E2E",
    familyId: input.id,
    id: input.id,
    license: "MIT",
    name: input.name,
    preview: "assets/preview.png",
    source: "local-import",
    tokens: {
      ...base.tokens,
      background: {
        ...base.tokens.background,
        app: input.appBackground ?? base.tokens.background.app,
      },
    },
  };
}

function themeFile(name: string, manifest: LingThemePackManifest): {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly name: string;
} {
  return {
    buffer: Buffer.from(zipSync({
      "LICENSE.txt": strToU8("MIT License"),
      "assets/preview.png": previewPng,
      "theme.json": strToU8(JSON.stringify(manifest)),
    }, { level: 6 })),
    mimeType: "application/zip",
    name,
  };
}

async function expectIndexedDbThemeAbsent(page: Page, themeId: string): Promise<void> {
  const state = await page.evaluate(async (id) => new Promise<{
    readonly assets: number;
    readonly manifest: boolean;
    readonly metadata: boolean;
  }>((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2", 3);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("themes")) {
        request.result.createObjectStore("themes", { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains("theme-packages")) {
        request.result.createObjectStore("theme-packages", { keyPath: "themeId" });
      }
      if (!request.result.objectStoreNames.contains("theme-assets")) {
        const assets = request.result.createObjectStore("theme-assets", { keyPath: "key" });
        assets.createIndex("themeId", "themeId", { unique: false });
      }
      if (!request.result.objectStoreNames.contains("theme-drafts")) {
        request.result.createObjectStore("theme-drafts", { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains("theme-draft-assets")) {
        request.result.createObjectStore("theme-draft-assets", { keyPath: "key" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["themes", "theme-packages", "theme-assets"], "readonly");
      const manifest = transaction.objectStore("themes").get(id);
      const metadata = transaction.objectStore("theme-packages").get(id);
      const assets = transaction.objectStore("theme-assets").index("themeId").count(IDBKeyRange.only(id));
      transaction.oncomplete = () => {
        resolve({
          assets: assets.result,
          manifest: Boolean(manifest.result),
          metadata: Boolean(metadata.result),
        });
        database.close();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    };
  }), themeId);
  expect(state).toEqual({ assets: 0, manifest: false, metadata: false });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  ))).toBe(true);
}

async function seedLegacyTheme(page: Page, manifest: LingThemePackManifest): Promise<void> {
  await page.evaluate((storedManifest) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2", 3);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("themes")) request.result.createObjectStore("themes", { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("theme-packages")) request.result.createObjectStore("theme-packages", { keyPath: "themeId" });
      if (!request.result.objectStoreNames.contains("theme-assets")) {
        const assets = request.result.createObjectStore("theme-assets", { keyPath: "key" });
        assets.createIndex("themeId", "themeId", { unique: false });
      }
      if (!request.result.objectStoreNames.contains("theme-drafts")) request.result.createObjectStore("theme-drafts", { keyPath: "id" });
      if (!request.result.objectStoreNames.contains("theme-draft-assets")) request.result.createObjectStore("theme-draft-assets", { keyPath: "key" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("themes", "readwrite");
      transaction.objectStore("themes").put(storedManifest);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }), manifest);
}

async function openInterfacePreferences(
  page: Page,
  locale: "en-US" | "zh-CN" = "en-US",
): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation")
    .getByRole("button", { name: locale === "zh-CN" ? "设置" : "Settings" })
    .click();
  await page.getByLabel(locale === "zh-CN" ? "设置分组" : "Settings sections")
    .getByRole("button", { name: locale === "zh-CN" ? "界面偏好" : "Interface preferences" })
    .click();
  const panel = page.locator("[data-ui2-interface-preferences]");
  await expect(panel).toBeVisible();
  return panel;
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

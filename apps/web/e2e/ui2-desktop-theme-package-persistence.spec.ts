import { expect, test, type Locator, type Page } from "@playwright/test";
import type { DesktopDaemonStatus, LingDesktopCapabilities } from "../../desktop/shared/desktop-capabilities.js";
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

test("native bootstrap replaces stale renderer tokens and authorizes the next hard reload", async ({ page }) => {
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
  const registry = new ThemeRegistry();
  if (!registry.install(rendererInitial, "local-import").ok) throw new Error("Failed to prepare renderer snapshot");
  const staleSnapshot = resolvedThemeToBootstrapSnapshot(
    registry.resolve({ mode: "fixed", themeId: rendererInitial.id }, "light"),
    "c".repeat(64),
  );
  if (!staleSnapshot) throw new Error("Failed to prepare renderer bootstrap snapshot");
  await page.addInitScript((snapshot) => {
    if (!localStorage.getItem("ling-stack.themeBootstrapSnapshot")) {
      localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(snapshot));
    }
  }, staleSnapshot);
  await prepareDesktopPage(page, {
    packages: [readyDescriptor(authoritativeInitial, { checksum: "b".repeat(64), preview: true })],
    selectionThemeId: authoritativeInitial.id,
  });

  const panel = await openInterfacePreferences(page);
  await expectBuiltInPicker(panel);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", authoritativeInitial.id);
  await expect(panel.locator(".settings-interface-theme-heading strong")).toHaveText("Native Verified");
  await expect(panel).not.toContainText("Renderer Candidate");
  await expect(panel).not.toContainText("private/native/preview.png");
  await expect.poll(() => page.evaluate(() => (
    getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-app").trim()
  ))).toBe("#e6f0eb");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe(authoritativeInitial.id);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-stack.themeBootstrapSnapshot") ?? "null")))
    .toMatchObject({
      packageChecksumSha256: "b".repeat(64),
      themeId: authoritativeInitial.id,
      variableMap: { "--ling-bg-app": "#e6f0eb" },
    });
  await expectIndexedDbThemeRecord(page, authoritativeInitial.id);

  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expectBuiltInPicker(reloadedPanel);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", authoritativeInitial.id);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", authoritativeInitial.id);
  await expect(reloadedPanel.locator(".settings-interface-theme-heading strong")).toHaveText("Native Verified");
  await expect.poll(() => harnessOperationCount(page, "bootstrap")).toBeGreaterThanOrEqual(2);
  expect(await harnessOperationCount(page, "read")).toBe(0);
  await expectNoPackageMutations(page);
  await expectIndexedDbThemeRecord(page, authoritativeInitial.id);
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("Desktop bootstrap failure stays native and never writes an IndexedDB fallback", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const manifest = importedTheme({ id: "native-failure", name: "Native Failure" });
  await prepareDesktopPage(page, {
    failures: {
      bootstrap: { code: "storage_unavailable", retryable: true },
    },
    packages: [readyDescriptor(manifest)],
    selectionThemeId: manifest.id,
  });

  const panel = await openInterfacePreferences(page);
  const picker = await expectBuiltInPicker(panel);
  const feedback = panel.locator("[data-ui2-interface-theme]").getByRole("status");
  await expect(feedback).toContainText("Installed themes could not be loaded. Ling is using a built-in fallback.");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-light");
  const darkTheme = picker.getByRole("radio", { name: /Ling Dark/ });
  await darkTheme.click();
  await expect(darkTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-dark");
  await expect(feedback).toContainText("Installed themes could not be loaded.");
  expect(await harnessPackageIds(page)).toEqual([manifest.id]);
  await expectIndexedDbThemeRecord(page, manifest.id);

  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expectBuiltInPicker(reloadedPanel);
  await expect(reloadedPanel.locator("[data-ui2-interface-theme]").getByRole("status"))
    .toContainText("Installed themes could not be loaded.");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect.poll(() => harnessOperationCount(page, "bootstrap")).toBeGreaterThanOrEqual(2);
  await expectNoPackageMutations(page);
  await expectIndexedDbThemeRecord(page, manifest.id);
  expect(errors).toEqual([]);
});

test("corrupt native packages fall back without mutation in dark zh-CN reduced motion", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const packages = [corruptDescriptor("broken-reimport", 4), corruptDescriptor("broken-delete", 7)];
  await prepareDesktopPage(page, {
    colorScheme: "dark",
    locale: "zh-CN",
    packages,
    reducedMotion: "reduce",
    selectionThemeId: "broken-reimport",
    viewport: { height: 800, width: 1280 },
  });

  const panel = await openInterfacePreferences(page, "zh-CN");
  const picker = await expectBuiltInPicker(panel);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-dark");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  expect((await desktopEvents(page)).filter((event) => event.startsWith("reported:"))[0]).toBe("reported:ling-dark");
  await expect(picker.getByRole("radio", { name: /Ling Dark/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-dark");
  const lightTheme = picker.getByRole("radio", { name: /Ling Light/ });
  await lightTheme.focus();
  await page.keyboard.press("Space");
  await expect(lightTheme).toBeFocused();
  await expect(lightTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-light");
  expect((await desktopSnapshot(page)).packages).toEqual(Object.fromEntries(packages.map((descriptor) => [
    String(descriptor.themeId), { descriptor },
  ])));
  await expectNoPackageMutations(page);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  expect(await lightTheme.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe("0s");
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("legacy-only Desktop selection falls back without migrating or deleting the browser record", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const legacy = importedTheme({ id: "legacy-native-repair", name: "Legacy Browser Theme" });
  await prepareDesktopPage(page, {
    colorScheme: "dark",
    legacyThemes: [legacy],
    packages: [],
    selectionThemeId: legacy.id,
  });

  const panel = await openInterfacePreferences(page);
  const picker = await expectBuiltInPicker(panel);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-dark");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(picker.getByRole("radio", { name: /Ling Light/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-light");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-stack.themeSelection") ?? "null")))
    .toEqual({ mode: "fixed", themeId: "ling-light" });
  await expectIndexedDbThemeRecord(page, legacy.id, legacy);

  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expectBuiltInPicker(reloadedPanel);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  expect(await harnessPackageIds(page)).toEqual([]);
  await expectNoPackageMutations(page);
  await expectIndexedDbThemeRecord(page, legacy.id, legacy);
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("Desktop bootstrap restores a native theme and active guard without adding a picker option", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await prepareDesktopPage(page, {
    packages: [readyDescriptor(nativeTheme)],
    selectionThemeId: nativeTheme.id,
  });

  const panel = await openInterfacePreferences(page);
  const picker = await expectBuiltInPicker(panel);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", nativeTheme.id);
  await expect(panel.locator(".settings-interface-theme-heading strong")).toHaveText("Native Calm");
  await expect(picker.locator('[aria-checked="true"]')).toHaveCount(0);
  await expect(picker.locator('[data-active="true"]')).toHaveCount(0);
  await expect.poll(() => desktopEvents(page)).toContain(`active:${nativeTheme.id}`);
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe(nativeTheme.id);
  await expectNoPackageMutations(page);
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

test("Desktop built-in selection persists and confirms the active guard without deleting the native package", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await prepareDesktopPage(page, {
    packages: [readyDescriptor(nativeTheme)],
    selectionThemeId: nativeTheme.id,
  });
  const panel = await openInterfacePreferences(page);
  const picker = await expectBuiltInPicker(panel);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", nativeTheme.id);
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe(nativeTheme.id);
  const before = await desktopSnapshot(page);
  const eventsBeforeSelection = await desktopEvents(page);
  await picker.getByRole("radio", { name: /Ling Light/ }).click();

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(picker.getByRole("radio", { name: /Ling Light/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-light");
  const events = await desktopEvents(page);
  expect(events.slice(eventsBeforeSelection.length)).toContain("active:ling-light");
  expect((await desktopSnapshot(page)).packages).toEqual(before.packages);
  expect((await desktopSnapshot(page)).repositoryRevision).toBe(before.repositoryRevision);
  expect(await page.evaluate(() => ({
    selection: JSON.parse(localStorage.getItem("ling-stack.themeSelection") ?? "null"),
    bootstrapSelection: JSON.parse(localStorage.getItem("ling-stack.themeBootstrapSelection") ?? "null"),
    snapshot: localStorage.getItem("ling-stack.themeBootstrapSnapshot"),
  }))).toEqual({
    selection: { mode: "fixed", themeId: "ling-light" },
    bootstrapSelection: { mode: "fixed", themeId: "ling-light" },
    snapshot: null,
  });

  await page.reload();
  const reloadedPanel = await openInterfacePreferences(page);
  await expectBuiltInPicker(reloadedPanel);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-light");
  expect((await desktopSnapshot(page)).packages).toEqual(before.packages);
  await expectNoPackageMutations(page);
  await expectIndexedDbThemeRecord(page, nativeTheme.id);
  expect(errors).toEqual([]);
});

test("Desktop active-sync failure preserves the native guard and clears after a confirmed built-in selection", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  await prepareDesktopPage(page, {
    failActiveThemeId: "ling-light",
    packages: [readyDescriptor(nativeTheme)],
    selectionThemeId: nativeTheme.id,
  });
  const panel = await openInterfacePreferences(page);
  const picker = await expectBuiltInPicker(panel);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", nativeTheme.id);
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe(nativeTheme.id);
  const before = await desktopSnapshot(page);
  await picker.getByRole("radio", { name: /Ling Light/ }).click();

  const feedback = panel.locator("[data-ui2-interface-theme]").getByRole("status");
  await expect(feedback).toContainText("Desktop could not confirm the active theme. Destructive theme actions remain blocked.");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(picker.getByRole("radio", { name: /Ling Light/ })).toHaveAttribute("aria-checked", "true");
  expect((await desktopSnapshot(page)).activeThemeId).toBe(nativeTheme.id);
  expect((await desktopSnapshot(page)).packages).toEqual(before.packages);

  await picker.getByRole("radio", { name: /Ling Dark/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-dark");
  await expect(feedback).toHaveCount(0);
  expect((await desktopSnapshot(page)).packages).toEqual(before.packages);
  expect((await desktopSnapshot(page)).repositoryRevision).toBe(before.repositoryRevision);
  await expectNoPackageMutations(page);
  await expectIndexedDbThemeRecord(page, nativeTheme.id);
  expect(errors).toEqual([]);
});

test("corrupt native authority rejects a matching browser theme and snapshot without discarding legacy records", async ({ page }) => {
  const errors = collectRuntimeErrors(page);
  const legacyTheme = { ...nativeTheme, id: "legacy-calm", name: "Legacy Calm" };
  const brokenTheme = { ...nativeTheme, id: "broken-calm", name: "Broken Calm" };
  const descriptor = corruptDescriptor(brokenTheme.id, 4);
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
    packages: [descriptor],
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
  await seedLegacyTheme(page, brokenTheme);
  await page.goto("/");

  const panel = await openInterfacePreferences(page);
  const picker = await expectBuiltInPicker(panel);
  await expect(page.locator("html")).toHaveAttribute("data-theme-first-paint", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(picker.getByRole("radio", { name: /Ling Light/ })).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await desktopSnapshot(page)).activeThemeId).toBe("ling-light");
  expect((await desktopSnapshot(page)).packages).toEqual({ [brokenTheme.id]: { descriptor } });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-stack.themeSelection") ?? "null")))
    .toEqual({ mode: "fixed", themeId: "ling-light" });
  expect(await page.evaluate(() => localStorage.getItem("ling-stack.themeBootstrapSnapshot"))).toBeNull();
  await expectIndexedDbThemeRecord(page, legacyTheme.id, legacyTheme);
  await expectIndexedDbThemeRecord(page, brokenTheme.id, brokenTheme);
  await expectNoPackageMutations(page);
  await expectNoPageOverflow(page);
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

interface DesktopHarnessSnapshot {
  readonly activeThemeId?: string;
  readonly packages: Readonly<Record<string, { readonly descriptor: Record<string, unknown> }>>;
  readonly repositoryRevision: number;
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
    const daemonStatus: DesktopDaemonStatus = {
      state: "connected",
      baseUrl: "http://127.0.0.1:17891",
      ownedByDesktop: true,
    };
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: "macos",
        daemonBaseUrl: daemonStatus.baseUrl,
        daemon: {
          getStatus: async () => daemonStatus,
          restart: async () => daemonStatus,
          onStatusChanged(listener) {
            let subscribed = true;
            queueMicrotask(() => {
              if (subscribed) listener(daemonStatus);
            });
            return () => { subscribed = false; };
          },
        },
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
          reportSelectedDeckOwner() {},
          reportHostLayout() {},
          show: async () => ({ accepted: true }),
          hide: async () => ({ accepted: true }),
          stop: async () => ({ accepted: true }),
          getPreferences: async () => ({ previewAutoShow: true }),
          setAutoShow: async () => ({ accepted: true }),
          onSummaryChanged: () => () => undefined,
        },
      } satisfies Pick<LingDesktopCapabilities, "platform" | "daemonBaseUrl" | "daemon"> & Record<string, unknown>,
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
  return Object.keys((await desktopSnapshot(page)).packages).sort();
}

async function desktopSnapshot(page: Page): Promise<DesktopHarnessSnapshot> {
  return page.evaluate(() => {
    const harness = (window as typeof window & {
      __desktopThemeHarness?: {
        snapshot(): DesktopHarnessSnapshot;
      };
    }).__desktopThemeHarness;
    if (!harness) throw new Error("Desktop theme harness is unavailable");
    return harness.snapshot();
  });
}

async function expectNoPackageMutations(page: Page): Promise<void> {
  expect((await desktopCalls(page)).filter(({ operation }) => (
    operation === "install" || operation === "reimport" || operation === "delete"
  ))).toEqual([]);
}

async function expectBuiltInPicker(panel: Locator): Promise<Locator> {
  const picker = panel.getByRole("radiogroup", { name: /Theme packs|主题包/u });
  const options = picker.getByRole("radio");
  await expect(options).toHaveCount(6);
  expect(await options.evaluateAll((elements) => elements.map((element) => (
    element.getAttribute("data-theme-option-id")
  )).sort())).toEqual([
    "ling-breeze", "ling-dark", "ling-journey", "ling-light", "ling-night", "ling-ocean",
  ]);
  await expect(panel.getByRole("button", {
    name: /Import theme|Create theme|Theme actions for|导入主题|创建主题|的主题操作/u,
  })).toHaveCount(0);
  await expect(panel.locator("[data-ui2-theme-package-repairs]")).toHaveCount(0);
  return picker;
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

async function expectIndexedDbThemeRecord(
  page: Page,
  themeId: string,
  expectedManifest: LingThemePackManifest | null = null,
): Promise<void> {
  const state = await page.evaluate(async (id) => new Promise<{
    readonly assets: number;
    readonly manifest: LingThemePackManifest | null;
    readonly metadata: boolean;
  }>((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2");
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
          manifest: manifest.result ?? null,
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
  expect(state).toEqual({ assets: 0, manifest: expectedManifest, metadata: false });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
  ))).toBe(true);
}

async function seedLegacyTheme(page: Page, manifest: LingThemePackManifest): Promise<void> {
  await page.evaluate((storedManifest) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ling-stack-ui2");
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
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
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

import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { lingDarkTheme, type LingThemePackManifest, type ThemeSelection } from "@ling-stack/ui-react/theme";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/interface-preferences/",
  import.meta.url,
));

type DesktopPreferenceMode = "accepted" | "rejected" | "session-only" | "throw";

interface InterfaceDesktopTestControl {
  rejectPreferences(message?: string): void;
  resolvePreferences(enabled: boolean): void;
  setMode(mode: DesktopPreferenceMode): void;
  snapshot(): { readonly setCalls: readonly boolean[] };
}

declare global {
  interface Window {
    __interfaceDesktopTest: InterfaceDesktopTestControl;
  }
}

test("Web preferences preserve system and fixed themes, languages, keyboard flow, and compact geometry", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  const selection: ThemeSelection = {
    mode: "system",
    lightThemeId: "ling-light",
    darkThemeId: "ling-dark",
  };
  await prepareWebSurface(page, {
    colorScheme: "light",
    height: 960,
    locale: "en-US",
    reducedMotion: "reduce",
    selection,
    width: 1440,
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  const panel = await openInterfacePreferences(page);

  await expect(panel.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Language" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Interface preferences" })).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "Desktop" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Import theme" })).toBeVisible();
  await expect(panel.getByText(/Theme Studio|Density/i)).toHaveCount(0);

  const followSystem = panel.getByRole("switch", { name: "Follow system" });
  const themePicker = panel.getByRole("radiogroup", { name: "Theme packs" });
  const lightTheme = themePicker.getByRole("radio", { name: /Ling Light/ });
  const darkTheme = themePicker.getByRole("radio", { name: /Ling Dark/ });
  await expect(followSystem).toBeChecked();
  await expect(themePicker.getByRole("radio")).toHaveCount(2);
  await expect(lightTheme).toHaveAttribute("data-active", "true");
  await expect(lightTheme).toHaveAttribute("aria-checked", "false");
  await expect(panel.locator(".settings-interface-theme-heading")).toContainText("Ling Light");
  await expectReducedMotion(lightTheme);
  await expectReducedMotion(followSystem);
  await expectSwitchCentersAligned(followSystem);
  await expectNoHorizontalOverflow(panel);
  await captureEvidence(page, "1440x960-ling-light-system.png");

  await followSystem.uncheck();
  await expectSwitchCentersAligned(followSystem);
  await expect(lightTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme-selection", "fixed");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");

  await lightTheme.focus();
  await page.keyboard.press("ArrowRight");
  await expect(darkTheme).toBeFocused();
  await page.keyboard.press("Space");
  await expect(darkTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect.poll(() => state.workspaceSettings.theme).toBe("dark");

  await followSystem.check();
  await expect(page.locator("html")).toHaveAttribute("data-theme-selection", "system");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect.poll(() => state.workspaceSettings.theme).toBe("system");

  const responseLanguage = panel.getByLabel("AI response language");
  const productLanguage = panel.getByLabel("Product language");
  await responseLanguage.selectOption("zh-CN");
  await expect.poll(() => state.workspaceSettings.responseLanguage).toBe("zh-CN");
  await productLanguage.selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect.poll(() => state.workspaceSettings.locale).toBe("zh-CN");

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(panel.getByRole("heading", { name: "外观" })).toBeVisible();
  await expect(panel.getByLabel("产品语言")).toHaveValue("zh-CN");
  await expect(panel.getByLabel("AI 回复语言")).toHaveValue("zh-CN");
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-system-zh-CN.png");
  expect(runtimeErrors).toEqual([]);
});

test("registered local themes stay selectable and expose P7C management actions", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareWebSurface(page, {
    colorScheme: "dark",
    height: 800,
    locale: "en-US",
    selection: { mode: "fixed", themeId: "ling-dark" },
    width: 1280,
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await page.goto("/favicon.png");

  const manifest = longLocalThemeFixture();
  await seedStoredTheme(page, manifest);
  await page.goto("/");
  const panel = await openInterfacePreferences(page);
  const picker = panel.getByRole("radiogroup", { name: "Theme packs" });
  const localTheme = picker.getByRole("radio", { name: new RegExp(manifest.name) });
  await expect(picker.getByRole("radio")).toHaveCount(3);
  await expect(localTheme).toBeVisible();
  await expect(localTheme).toContainText("Local theme");
  await expect(panel.getByRole("button", { name: "Import theme" })).toBeVisible();
  const actions = panel.getByRole("button", { name: new RegExp(`Theme actions for ${manifest.name}`) });
  await actions.click();
  await expect(page.getByRole("menuitem", { name: "Preview" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reimport" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");

  await localTheme.click();
  await expect(localTheme).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", manifest.id);
  await expect(panel.locator(".settings-interface-theme-heading")).toContainText(manifest.name);
  const nameMetrics = await localTheme.locator("strong").first().evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(nameMetrics.scrollWidth).toBeGreaterThan(nameMetrics.clientWidth);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-local-theme-long-name.png");
  expect(runtimeErrors).toEqual([]);
});

test("theme persistence failure rolls back atomically and reports one global plus one local message", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareWebSurface(page, {
    colorScheme: "light",
    height: 800,
    locale: "en-US",
    selection: { mode: "fixed", themeId: "ling-light" },
    width: 1280,
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  const panel = await openInterfacePreferences(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if (key === "ling-stack.themeSelection") {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  });

  const picker = panel.getByRole("radiogroup", { name: "Theme packs" });
  const lightTheme = picker.getByRole("radio", { name: /Ling Light/ });
  const darkTheme = picker.getByRole("radio", { name: /Ling Dark/ });
  await darkTheme.click();

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(lightTheme).toHaveAttribute("aria-checked", "true");
  await expect(darkTheme).toHaveAttribute("aria-checked", "false");
  await expect(darkTheme).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator('.ling-ui-toast[data-scope="theme:storage"]')).toHaveCount(1);
  await expect(page.locator('.ling-ui-toast[data-scope="theme:storage"]')).toContainText(
    "Theme preference could not be saved",
  );
  await expect(panel.getByRole("status")).toContainText(
    "Theme preference could not be saved. The previous theme is still active.",
  );
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-light-storage-rollback.png");
  expect(runtimeErrors).toEqual([]);
});

test("Desktop preference scopes loading, session-only warning, and rejected rollback to its row", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await installDesktopPreferenceHarness(page);
  await prepareWebSurface(page, {
    colorScheme: "dark",
    height: 800,
    locale: "en-US",
    selection: { mode: "fixed", themeId: "ling-dark" },
    width: 1280,
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  const panel = await openInterfacePreferences(page);

  const desktopSection = panel.locator("[data-ui2-interface-desktop]");
  const autoShow = desktopSection.getByRole("switch", {
    name: "Automatically show Computer Use picture-in-picture",
  });
  await expect(desktopSection.getByRole("heading", { name: "Desktop" })).toBeVisible();
  await expect(autoShow).toHaveAttribute("aria-busy", "true");
  await expect(autoShow).toBeDisabled();
  await expect(panel.getByLabel("Product language")).toBeEnabled();
  await expect(panel.getByRole("radio", { name: /Ling Light/ })).toBeEnabled();

  await page.evaluate(() => window.__interfaceDesktopTest.resolvePreferences(true));
  await expect(autoShow).toBeChecked();
  await expect(autoShow).not.toHaveAttribute("aria-busy", "true");

  await page.evaluate(() => window.__interfaceDesktopTest.setMode("session-only"));
  await autoShow.uncheck();
  await expect(autoShow).not.toBeChecked();
  await expect(desktopSection.getByRole("status")).toContainText(
    "Changed for this session, but not saved. It may revert after restart.",
  );

  await page.evaluate(() => window.__interfaceDesktopTest.setMode("rejected"));
  await autoShow.click();
  await expect(autoShow).not.toBeChecked();
  await expect(desktopSection.getByRole("alert")).toContainText("Unable to save Desktop preview preference");
  expect((await page.evaluate(() => window.__interfaceDesktopTest.snapshot())).setCalls).toEqual([false, true]);
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-desktop-rejected.png");
  expect(runtimeErrors).toEqual([]);
});

test("Desktop preference turns an initial read failure into persistent row feedback", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await installDesktopPreferenceHarness(page);
  await prepareWebSurface(page, {
    colorScheme: "light",
    height: 800,
    locale: "en-US",
    selection: { mode: "fixed", themeId: "ling-light" },
    width: 1280,
  });
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  const panel = await openInterfacePreferences(page);
  const desktopSection = panel.locator("[data-ui2-interface-desktop]");
  const autoShow = desktopSection.getByRole("switch", {
    name: "Automatically show Computer Use picture-in-picture",
  });

  await page.evaluate(() => window.__interfaceDesktopTest.rejectPreferences());
  await expect(autoShow).not.toHaveAttribute("aria-busy", "true");
  await expect(autoShow).toBeEnabled();
  await expect(desktopSection.getByRole("alert")).toContainText("Unable to save Desktop preview preference");
  await expect(panel.getByLabel("AI response language")).toBeEnabled();
  expect(runtimeErrors).toEqual([]);
});

async function prepareWebSurface(
  page: Page,
  input: {
    readonly colorScheme: "dark" | "light";
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
    readonly selection: ThemeSelection;
    readonly width: number;
  },
): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({
    colorScheme: input.colorScheme,
    reducedMotion: input.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ locale, selection, bootstrapPreference }) => {
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", bootstrapPreference);
    localStorage.removeItem("ling-stack.themePreference");
  }, {
    locale: input.locale,
    selection: input.selection,
    bootstrapPreference: input.selection.mode === "system"
      ? "system"
      : input.selection.themeId === "ling-dark"
        ? "dark"
        : "light",
  });
}

async function openInterfacePreferences(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences" }).click();
  const panel = page.locator("[data-ui2-interface-preferences]");
  await expect(panel).toBeVisible();
  return panel;
}

async function expectSwitchCentersAligned(control: Locator): Promise<void> {
  const geometry = await control.evaluate((element) => {
    const rootRect = element.getBoundingClientRect();
    const thumb = element.querySelector<HTMLElement>(".ling-ui-switch-thumb");
    const thumbRect = thumb?.getBoundingClientRect();
    const trackStyle = getComputedStyle(element, "::before");
    const trackTransform = new DOMMatrixReadOnly(trackStyle.transform);
    const trackBorderBoxHeight = Number.parseFloat(trackStyle.height)
      + Number.parseFloat(trackStyle.borderTopWidth)
      + Number.parseFloat(trackStyle.borderBottomWidth);
    const trackCenter = Number.parseFloat(trackStyle.top)
      + trackTransform.m42
      + trackBorderBoxHeight / 2;
    return {
      rootCenter: rootRect.height / 2,
      thumbCenter: thumbRect ? thumbRect.top - rootRect.top + thumbRect.height / 2 : -1,
      trackCenter,
    };
  });
  expect(geometry.thumbCenter).toBeCloseTo(geometry.rootCenter, 5);
  expect(geometry.trackCenter).toBeCloseTo(geometry.rootCenter, 5);
}

function longLocalThemeFixture(): LingThemePackManifest {
  return {
    ...structuredClone(lingDarkTheme),
    id: "quiet-night-long-name",
    familyId: "quiet-night-long-name",
    name: "Quiet Night for Focused Local Workspaces with a Long Registered Theme Name",
    source: "local-import",
  };
}

async function seedStoredTheme(page: Page, manifest: LingThemePackManifest): Promise<void> {
  await page.evaluate(async (storedManifest) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ling-stack-ui2", 2);
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
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("themes", "readwrite");
        transaction.objectStore("themes").put(storedManifest);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
      };
    });
  }, manifest);
}

async function installDesktopPreferenceHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let resolvePreferences: ((value: { readonly previewAutoShow: boolean }) => void) | undefined;
    let rejectPreferences: ((error: Error) => void) | undefined;
    const preferences = new Promise<{ readonly previewAutoShow: boolean }>((resolve, reject) => {
      resolvePreferences = resolve;
      rejectPreferences = reject;
    });
    let mode: DesktopPreferenceMode = "accepted";
    const setCalls: boolean[] = [];
    window.__interfaceDesktopTest = {
      rejectPreferences(message = "Preference read failed") {
        rejectPreferences?.(new Error(message));
      },
      resolvePreferences(enabled) {
        resolvePreferences?.({ previewAutoShow: enabled });
      },
      setMode(nextMode) {
        mode = nextMode;
      },
      snapshot() {
        return { setCalls: [...setCalls] };
      },
    };
    Object.defineProperty(window, "lingDesktop", {
      configurable: true,
      value: {
        platform: "macos",
        daemonBaseUrl: "http://127.0.0.1:17891",
        appearance: { reportTheme() {} },
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
          getPreferences: () => preferences,
          setAutoShow: async (enabled: boolean) => {
            setCalls.push(enabled);
            if (mode === "throw") throw new Error("Preference write failed");
            if (mode === "rejected") return { accepted: false, reason: "desktop_preferences_rejected" };
            if (mode === "session-only") {
              return { accepted: true, reason: "desktop_preferences_not_persisted" };
            }
            return { accepted: true };
          },
          onSummaryChanged: () => () => undefined,
        },
      },
    });
  });
}

async function expectReducedMotion(locator: Locator): Promise<void> {
  const durations = await locator.evaluate((element) => getComputedStyle(element).transitionDuration
    .split(",")
    .map((value) => Number.parseFloat(value)));
  expect(durations.every((duration) => duration === 0)).toBe(true);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
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

import { expect, test, type Page } from "@playwright/test";
import {
  ThemeRegistry,
  lingLightTheme,
  resolvedThemeToBootstrapSnapshot,
  type LingThemePackManifest,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";

test("new fixed ThemeSelection wins over legacy preference on first and final paint", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: "ling-dark" }));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify({ mode: "fixed", themeId: "ling-dark" }));
    localStorage.setItem("ling-stack.themePreference", "light");
    localStorage.setItem("ling-stack.themeBootstrapPreference", "light");
  });
  await installBootstrapObserver(page);
  await prepareApp(page);
  await page.goto("/");

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(root).toHaveAttribute("data-color-scheme", "dark");
  await expect(root).toHaveAttribute("data-theme-selection", "fixed");
  await expect(root).toHaveAttribute("data-ui-presentation", "ling-standard");
  expect((await observedBootstrapThemes(page)).filter(Boolean)[0]).toBe("ling-dark");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-stack.themeSelection") ?? "null"))).toEqual({ mode: "fixed", themeId: "ling-dark" });
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("1440x960-ling-dark-fixed-selection.png"), fullPage: true });
});

test("system selection follows OS appearance without closing or remounting an open Drawer", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => {
    const selection = { mode: "system", lightThemeId: "ling-light", darkThemeId: "ling-dark" };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  });
  await prepareApp(page);
  await page.goto("/");
  await openCuaInstallDrawer(page);
  const drawer = page.getByRole("dialog", { name: "Install Cua Driver" });
  const close = drawer.getByRole("button", { name: "Close" });
  await drawer.evaluate((element) => { element.setAttribute("data-theme-test-node", "preserved"); });
  await close.focus();

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-selection", "system");
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("data-theme-test-node", "preserved");
  await expect(close).toBeFocused();
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("1280x800-ling-dark-system-drawer.png"), fullPage: true });
});

test("validated imported Theme Pack matches bootstrap and final runtime tokens", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "dark" });
  await prepareApp(page);
  await page.goto("/");
  await page.goto("/favicon.png");

  const fixture = importedThemeFixture();
  await seedImportedTheme(page, fixture.manifest, fixture.selection, fixture.snapshot);
  await installBootstrapObserver(page);
  await page.goto("/");

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-ui-theme", fixture.manifest.id);
  await expect(root).toHaveAttribute("data-color-scheme", "light");
  await expect(root).toHaveAttribute("data-theme-selection", "fixed");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ling-bg-app").trim())).toBe("#eef4f1");
  expect((await observedBootstrapThemes(page)).filter(Boolean)[0]).toBe(fixture.manifest.id);
  await page.waitForTimeout(250);
  await expect(root).toHaveAttribute("data-ui-theme", fixture.manifest.id);
  await expectNoPageOverflow(page);
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("1440x960-quiet-ocean-imported-theme.png"), fullPage: true });
});

test("invalid installed manifest cannot keep a bootstrap-only theme active", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await prepareApp(page);
  await page.goto("/");
  await page.goto("/favicon.png");

  const fixture = importedThemeFixture();
  const invalidManifest = {
    ...fixture.manifest,
    tokens: {
      ...fixture.manifest.tokens,
      background: { ...fixture.manifest.tokens.background, app: "url(https://invalid.example/theme.png)" },
    },
  };
  await seedImportedTheme(page, invalidManifest, fixture.selection, fixture.snapshot);
  await installBootstrapObserver(page);
  await page.goto("/");

  expect((await observedBootstrapThemes(page)).filter(Boolean)[0]).toBe(fixture.manifest.id);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(page.locator("html")).toHaveAttribute("data-theme-selection", "fixed");
  const repairedSelection = { mode: "fixed", themeId: "ling-light" };
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-stack.themeSelection") ?? "null"))).toEqual(repairedSelection);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-stack.themeBootstrapSelection") ?? "null"))).toEqual(repairedSelection);
  expect(await page.evaluate(() => localStorage.getItem("ling-stack.themeBootstrapSnapshot"))).toBeNull();
  expect(browserErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("1280x800-invalid-import-fallback.png"), fullPage: true });
});

test("storage failure rolls back the visual theme and reports one warning Toast", async ({ page }) => {
  const browserErrors = captureBrowserErrors(page);
  await page.addInitScript(() => {
    const selection = { mode: "fixed", themeId: "ling-light" };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  });
  await prepareApp(page);
  await page.goto("/");
  await openInterfacePreferences(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key: string, value: string): void {
      if (key === "ling-stack.themeSelection") throw new DOMException("Quota exceeded", "QuotaExceededError");
      original.call(this, key, value);
    };
  });

  await page.getByRole("radiogroup", { name: "Theme packs" }).getByRole("radio", { name: /Ling Dark/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await expect(page.locator('.ling-ui-toast[data-scope="theme:storage"]')).toContainText("Theme preference could not be saved");
  await expect(page.locator('.ling-ui-toast[data-scope="theme:storage"]')).toHaveCount(1);
  expect(browserErrors).toEqual([]);
});

function importedThemeFixture(): {
  readonly manifest: LingThemePackManifest;
  readonly selection: ThemeSelection;
  readonly snapshot: NonNullable<ReturnType<typeof resolvedThemeToBootstrapSnapshot>>;
} {
  const manifest: LingThemePackManifest = {
    ...structuredClone(lingLightTheme),
    id: "quiet-ocean",
    name: "Quiet Ocean",
    familyId: "quiet-ocean",
    source: "local-import",
    tokens: {
      ...structuredClone(lingLightTheme.tokens),
      background: {
        ...lingLightTheme.tokens.background,
        app: "#eef4f1",
        subtle: "#e5eeea",
        pressed: "#d8e5df",
        code: "#e9f0ed",
        sidebar: "#f5f9f7",
        composer: "#fbfdfc",
      },
      text: {
        ...lingLightTheme.tokens.text,
        strong: "#102019",
        default: "#243a31",
        muted: "#536b60",
        soft: "#6a7f76",
        link: "#2c6e58",
      },
      border: { default: "#cbd9d3", strong: "#9fb5ab", focus: "#2f745d" },
      action: {
        accent: "#173f32",
        accentHover: "#215443",
        accentPressed: "#0e2c23",
        accentForeground: "#ffffff",
        selection: "#cfe2da",
      },
      shadow: {
        low: "0 1px 2px rgb(15 45 34 / 8%)",
        medium: "0 6px 18px rgb(15 45 34 / 12%)",
        overlay: "0 12px 32px rgb(15 45 34 / 18%)",
      },
      native: { selection: "#bfd9ce", scrollbar: "#abc0b7", scrollbarHover: "#7f9c90" },
    },
    desktop: { ...lingLightTheme.desktop, windowBackground: "#eef4f1", titlebarForeground: "#243a31" },
  };
  const registry = new ThemeRegistry();
  const installed = registry.install(manifest, "local-import", "2026-07-18T00:00:00.000Z");
  if (!installed.ok) throw new Error(installed.issues?.map((item) => `${item.path}: ${item.message}`).join("; "));
  const selection: ThemeSelection = { mode: "fixed", themeId: manifest.id };
  const snapshot = resolvedThemeToBootstrapSnapshot(registry.resolve(selection, "dark"));
  if (!snapshot) throw new Error("Imported theme snapshot was not generated.");
  return { manifest, selection, snapshot };
}

async function seedImportedTheme(
  page: Page,
  manifest: LingThemePackManifest,
  selection: ThemeSelection,
  snapshot: NonNullable<ReturnType<typeof resolvedThemeToBootstrapSnapshot>>,
): Promise<void> {
  await page.evaluate(async ({ manifest: storedManifest, selection: storedSelection, snapshot: storedSnapshot }) => {
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(storedSnapshot));
    localStorage.setItem("ling-stack.themePreference", "dark");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ling-stack-ui2", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("themes")) request.result.createObjectStore("themes", { keyPath: "id" });
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
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
  }, { manifest, selection, snapshot });
}

async function prepareApp(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await mockControlPlaneReads(page);
}

async function openInterfacePreferences(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences" }).click();
  await expect(page.locator(".interface-settings-panel")).toBeVisible();
}

async function openCuaInstallDrawer(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Plugin Manager" }).click();
  await page.locator('.plugin-table-row[data-plugin-id="trusted-local:cua-driver"]').getByRole("button", { name: "Installation guide" }).click();
  await expect(page.getByRole("dialog", { name: "Install Cua Driver" })).toBeVisible();
}

async function installBootstrapObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & { __ui2ObservedThemes?: string[] };
    state.__ui2ObservedThemes = [];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== "attributes" || !(record.target instanceof HTMLElement)) continue;
        const themeId = record.target.dataset.uiTheme ?? "";
        if (state.__ui2ObservedThemes?.at(-1) !== themeId) state.__ui2ObservedThemes?.push(themeId);
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-ui-theme"] });
  });
}

async function observedBootstrapThemes(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (globalThis as typeof globalThis & { __ui2ObservedThemes?: string[] }).__ui2ObservedThemes ?? []);
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const source = message.location().url;
      errors.push(source ? `${message.text()} @ ${source}` : message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function mockControlPlaneReads(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:17891/control-plane/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/control-plane/snapshot") {
      const requestedDomains = (url.searchParams.get("domains") ?? "").split(",").map((domain) => domain.trim()).filter(Boolean);
      const domains = Object.fromEntries(requestedDomains.map((domain) => [domain, {
        ok: false,
        revision: 0,
        error: { code: "fixture_unavailable", message: "Use the mock daemon fallback for this domain." },
      }]));
      await route.fulfill({ json: { cwd, workspaceId: "workspace_default", generatedAt: "2026-07-18T00:00:00.000Z", latestEventSeq: 0, domains } });
      return;
    }
    if (url.pathname === "/control-plane/stream") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
}

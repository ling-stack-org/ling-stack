import { expect, test, type Page } from "@playwright/test";
import {
  ThemeRegistry,
  lingLightTheme,
  resolvedThemeToBootstrapSnapshot,
  type LingThemePackManifest,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, type MockState } from "./support/mock-state";

const profileCssPath = fileURLToPath(new URL("../src/styles/profile.css", import.meta.url));
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/profile/theme-pack-compatibility/",
  import.meta.url,
));

test("standalone Profile heatmap has no color-scheme-specific owner", async () => {
  const source = await readFile(profileCssPath, "utf8");
  expect(source).not.toContain(':root[data-theme="dark"] .profile-heatmap-cell');
  expect(source).toContain("color-mix(in srgb, var(--ling-action-accent) 18%, var(--ling-bg-subtle))");
  expect(source).toContain("color-mix(in srgb, var(--ling-action-accent) 34%, var(--ling-bg-subtle))");
  expect(source).toContain("color-mix(in srgb, var(--ling-action-accent) 58%, var(--ling-bg-subtle))");
  expect(source).toContain("background: var(--ling-action-accent)");
});

test("standalone Profile heatmap follows ling-light at 1440x960", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareBuiltInProfile(page, "ling-light", { width: 1440, height: 960 });

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  await assertProfileThemeAndGeometry(page);
  await captureEvidence(page, "1440x960-ling-light-profile-heatmap.png");
  expect(runtimeErrors).toEqual([]);
});

test("standalone Profile heatmap follows ling-dark at 1280x800", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareBuiltInProfile(page, "ling-dark", { width: 1280, height: 800 });

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await assertProfileThemeAndGeometry(page);
  await captureEvidence(page, "1280x800-ling-dark-profile-heatmap-focus.png");
  expect(runtimeErrors).toEqual([]);
});

test("standalone Profile heatmap follows an imported Theme Pack", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: "dark" });
  const state = createProfileState();
  await mockDaemon(page, state);
  await page.goto("/");
  await page.goto("/favicon.png");

  const fixture = importedThemeFixture();
  await seedImportedTheme(page, fixture.manifest, fixture.selection, fixture.snapshot);
  await page.goto("/");
  await mountStandaloneProfile(page);

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", fixture.manifest.id);
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light");
  await assertProfileThemeAndGeometry(page);
  await expect.poll(() => page.evaluate(() => (
    getComputedStyle(document.documentElement).getPropertyValue("--ling-action-accent").trim()
  ))).toBe("#173f32");
  await captureEvidence(page, "1440x960-quiet-ocean-profile-heatmap.png");
  expect(runtimeErrors).toEqual([]);
});

async function prepareBuiltInProfile(
  page: Page,
  themeId: "ling-light" | "ling-dark",
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: themeId === "ling-dark" ? "dark" : "light" });
  await page.addInitScript((savedThemeId) => {
    const selection = { mode: "fixed", themeId: savedThemeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", savedThemeId === "ling-dark" ? "dark" : "light");
  }, themeId);
  await mockDaemon(page, createProfileState());
  await page.goto("/");
  await mountStandaloneProfile(page);
}

function createProfileState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const baseRun = state.runs[0];
  if (!baseRun) throw new Error("Profile heatmap fixture needs one base run.");
  const now = new Date();
  state.runs = [32, 64, 96, 128].map((promptLength, index) => {
    const createdAt = new Date(now);
    createdAt.setDate(now.getDate() - index - 1);
    createdAt.setHours(12, 0, 0, 0);
    return {
      ...baseRun,
      id: `run_profile_heatmap_${index + 1}`,
      createdAt: createdAt.toISOString(),
      updatedAt: new Date(createdAt.getTime() + 300_000).toISOString(),
      taskSnapshot: { title: "x".repeat(promptLength) },
      requestSnapshot: {},
    };
  });
  return state;
}

async function mountStandaloneProfile(page: Page): Promise<void> {
  await page.evaluate(async ({ workspaceCwd }) => {
    const loadModule = (path: string): Promise<Record<string, unknown>> => import(path);
    const [reactModule, reactDomModule, profileModule, i18nModule, themeModule, uiModule] = await Promise.all([
      loadModule("/@id/react"),
      loadModule("/@id/react-dom/client"),
      loadModule("/src/features/profile/ProfilePage.tsx"),
      loadModule("/src/i18n.tsx"),
      loadModule("/src/theme.tsx"),
      loadModule("/src/shared/ui/index.ts"),
    ]);
    const react = reactModule.default as { createElement: (...args: unknown[]) => unknown };
    const reactDom = (reactDomModule.default ?? reactDomModule) as {
      createRoot: (container: Element) => { render: (element: unknown) => void };
    };
    const ProfilePage = profileModule.ProfilePage;
    const I18nProvider = i18nModule.I18nProvider;
    const ThemeProvider = themeModule.ThemeProvider;
    const LingUiProvider = uiModule.LingUiProvider;
    const appRoot = document.getElementById("root");
    if (appRoot) appRoot.hidden = true;
    const host = document.createElement("div");
    host.id = "ui2-profile-heatmap-host";
    document.body.append(host);
    reactDom.createRoot(host).render(
      react.createElement(
        I18nProvider,
        null,
        react.createElement(
          ThemeProvider,
          null,
          react.createElement(
            LingUiProvider,
            null,
            react.createElement(ProfilePage, { cwd: workspaceCwd }),
          ),
        ),
      ),
    );
  }, { workspaceCwd: cwd });
  await expect(page.locator(".profile-page")).toBeVisible();
  await expect(page.locator(".profile-page .profile-heatmap-cell.level-4")).toBeVisible();
}

async function assertProfileThemeAndGeometry(page: Page): Promise<void> {
  const profile = page.locator(".profile-page");
  const input = profile.getByLabel("Display name");
  const inputOwner = input.locator("xpath=..");
  const beforeFocus = await input.evaluate((element) => element.getBoundingClientRect().toJSON());
  await input.focus();
  await expect(input).toBeFocused();
  const focusGeometry = await input.evaluate((element) => {
    const inputRect = element.getBoundingClientRect();
    const ownerRect = element.parentElement?.getBoundingClientRect();
    if (!ownerRect) throw new Error("Profile input owner did not render.");
    return {
      input: inputRect.toJSON(),
      owner: ownerRect.toJSON(),
    };
  });
  expect(focusGeometry.input.height).toBeCloseTo(beforeFocus.height, 1);
  expect(focusGeometry.input.top).toBeGreaterThanOrEqual(focusGeometry.owner.top - 0.5);
  expect(focusGeometry.input.bottom).toBeLessThanOrEqual(focusGeometry.owner.bottom + 0.5);
  await expect(inputOwner).toHaveClass(/ling-ui-input/u);

  const themeResult = await page.evaluate(() => {
    const profileRoot = document.querySelector(".profile-page");
    if (!(profileRoot instanceof HTMLElement)) throw new Error("Profile did not render.");
    const readBackground = (selector: string): string => {
      const element = profileRoot.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing heatmap cell: ${selector}`);
      return getComputedStyle(element).backgroundColor;
    };
    const expectedBackground = (background: string): string => {
      const probe = document.createElement("span");
      probe.style.background = background;
      profileRoot.append(probe);
      const result = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return result;
    };
    return {
      actual: [
        readBackground(".profile-heatmap-cell.level-0"),
        readBackground(".profile-heatmap-cell.level-1"),
        readBackground(".profile-heatmap-cell.level-2"),
        readBackground(".profile-heatmap-cell.level-3"),
        readBackground(".profile-heatmap-cell.level-4"),
      ],
      expected: [
        expectedBackground("var(--ling-bg-panel)"),
        expectedBackground("color-mix(in srgb, var(--ling-action-accent) 18%, var(--ling-bg-subtle))"),
        expectedBackground("color-mix(in srgb, var(--ling-action-accent) 34%, var(--ling-bg-subtle))"),
        expectedBackground("color-mix(in srgb, var(--ling-action-accent) 58%, var(--ling-bg-subtle))"),
        expectedBackground("var(--ling-action-accent)"),
      ],
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      profileOverflow: profileRoot.scrollWidth - profileRoot.clientWidth,
    };
  });
  expect(themeResult.actual).toEqual(themeResult.expected);
  expect(new Set(themeResult.actual).size).toBe(5);
  expect(themeResult.documentOverflow).toBeLessThanOrEqual(1);
  expect(themeResult.profileOverflow).toBeLessThanOrEqual(1);
}

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
        panel: "#f8fbf9",
        subtle: "#e5eeea",
        sidebar: "#f5f9f7",
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
    },
    desktop: { ...lingLightTheme.desktop, windowBackground: "#eef4f1", titlebarForeground: "#243a31" },
  };
  const registry = new ThemeRegistry();
  const installed = registry.install(manifest, "local-import", "2026-07-26T00:00:00.000Z");
  if (!installed.ok) throw new Error(installed.issues?.map((issue) => issue.message).join("; "));
  const selection: ThemeSelection = { mode: "fixed", themeId: manifest.id };
  const snapshot = resolvedThemeToBootstrapSnapshot(registry.resolve(selection, "dark"));
  if (!snapshot) throw new Error("Imported Profile theme snapshot was not generated.");
  return { manifest, selection, snapshot };
}

async function seedImportedTheme(
  page: Page,
  manifest: LingThemePackManifest,
  selection: ThemeSelection,
  snapshot: NonNullable<ReturnType<typeof resolvedThemeToBootstrapSnapshot>>,
): Promise<void> {
  await page.evaluate(async ({ storedManifest, storedSelection, storedSnapshot }) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(storedSnapshot));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ling-stack-ui2", 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("themes")) {
          request.result.createObjectStore("themes", { keyPath: "id" });
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
  }, { storedManifest: manifest, storedSelection: selection, storedSnapshot: snapshot });
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

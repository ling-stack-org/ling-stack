import {
  ThemeRegistry,
  analyzeThemeImage,
  compileLingTheme,
  resolvedThemeToBootstrapSnapshot,
  type LingThemeBootstrapSnapshot,
  type LingThemePackManifest,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";

test("generated Presentation Profile changes route policy without remounting the AppShell", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await prepareApp(page);
  await page.goto("/favicon.png");
  const fixture = generatedThemeFixture();
  await seedGeneratedTheme(page, fixture.manifest, fixture.selection, fixture.snapshot);
  await page.goto("/");

  const root = page.locator("html");
  const shell = page.locator("main.app-shell");
  await expect(root).toHaveAttribute("data-ui-theme", fixture.manifest.id);
  await expect(root).toHaveAttribute("data-ui-presentation", "ling-immersive");
  await expect(root).toHaveAttribute("data-ui-surface", "home");
  await expect(root).toHaveAttribute("data-ui-surface-recipe", "translucent");
  await expect(root).toHaveAttribute("data-ui-artwork-policy", "strong");
  await shell.evaluate((element) => element.setAttribute("data-ui2-shell-marker", "preserved"));
  await expectNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("1440x960-generated-immersive-home.png"), fullPage: true });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expect(root).toHaveAttribute("data-ui-surface", "settings");
  await expect(root).toHaveAttribute("data-ui-surface-recipe", "solid");
  await expect(root).toHaveAttribute("data-ui-artwork-policy", "off");
  await expect(root).toHaveAttribute("data-ui-decoration-policy", "off");
  await expect(shell).toHaveAttribute("data-ui2-shell-marker", "preserved");
  await expectNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("1280x800-generated-immersive-settings.png"), fullPage: true });
  expect(browserErrors).toEqual([]);
});

function generatedThemeFixture(): {
  readonly manifest: LingThemePackManifest;
  readonly selection: ThemeSelection;
  readonly snapshot: LingThemeBootstrapSnapshot;
} {
  const pixels = new Uint8ClampedArray([
    220, 232, 226, 255, 220, 232, 226, 255, 42, 105, 82, 255, 28, 72, 58, 255,
    220, 232, 226, 255, 220, 232, 226, 255, 88, 150, 122, 255, 206, 164, 78, 255,
  ]);
  const analysis = analyzeThemeImage({ width: 4, height: 2, pixels });
  const compiled = compileLingTheme({
    identity: { id: "generated-quiet-forest", name: "Generated Quiet Forest" },
    colorScheme: "light",
    presentation: { profileId: "ling-immersive", surfaceIntensity: "balanced", artworkIntensity: "balanced" },
    paletteCandidate: { background: analysis.dominantColors[0], accent: analysis.accentCandidate },
    analysis,
    generation: { mode: "quick", createdAt: "2026-07-18T00:00:00.000Z", sourceAssetCount: 1 },
  });
  if (!compiled.readyToPublish) throw new Error("Generated fixture did not pass Theme Compiler verification.");
  const registry = new ThemeRegistry();
  const installed = registry.install(compiled.manifest, "local-generated", "2026-07-18T00:00:00.000Z");
  if (!installed.ok) throw new Error(installed.issues?.map((issue) => issue.message).join("; "));
  const selection: ThemeSelection = { mode: "fixed", themeId: compiled.manifest.id };
  const snapshot = resolvedThemeToBootstrapSnapshot(registry.resolve(selection, "light"));
  if (!snapshot) throw new Error("Generated fixture did not produce a bootstrap snapshot.");
  return { manifest: compiled.manifest, selection, snapshot };
}

async function seedGeneratedTheme(
  page: Page,
  manifest: LingThemePackManifest,
  selection: ThemeSelection,
  snapshot: LingThemeBootstrapSnapshot,
): Promise<void> {
  await page.evaluate(async ({ storedManifest, storedSelection, storedSnapshot }) => {
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(storedSelection));
    localStorage.setItem("ling-stack.themeBootstrapSnapshot", JSON.stringify(storedSnapshot));
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
  }, { storedManifest: manifest, storedSelection: selection, storedSnapshot: snapshot });
}

async function prepareApp(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
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

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

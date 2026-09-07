import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const webDirectory = fileURLToPath(new URL("../", import.meta.url));
const helperPath = fileURLToPath(new URL("../src/shared/ui/public-asset-url.ts", import.meta.url));
const avatarSourcePath = new URL("../src/features/teammates/default-teammate-avatars.ts", import.meta.url);
const emptyStateSourcePath = new URL("../src/features/workspace/NormalConversationEmptyState.tsx", import.meta.url);
const logoSourcePath = new URL("../src/shared/components/LingStackLogo.tsx", import.meta.url);

test("public image sources use the trusted build-base helper", async () => {
  const [helperSource, avatarSource, emptyStateSource, logoSource] = await Promise.all([
    readFile(helperPath, "utf8"),
    readFile(avatarSourcePath, "utf8"),
    readFile(emptyStateSourcePath, "utf8"),
    readFile(logoSourcePath, "utf8"),
  ]);

  expect(helperSource).toContain("import.meta.env.BASE_URL");
  expect(helperSource).toContain("assertLocalPublicAssetPath(assetPath)");
  expect(avatarSource).toContain("publicAssetUrl(`${AVATAR_BASE_PATH}/${fileName}`)");
  expect(avatarSource).not.toContain('AVATAR_BASE_PATH = "/avatars');
  expect(emptyStateSource).toContain("<LingStackLogo size={64}");
  expect(logoSource).toContain("publicAssetUrl(`icons/${file}`)");
  expect(emptyStateSource).not.toContain('src="/icons/');
});

test("Web dev renders the conversation mark from the origin public directory", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const mark = page.getByLabel("Conversation home").locator(".conversation-home-mark img");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("src", "/icons/ling-mark-compact.svg");
  const response = await page.request.get(new URL(await mark.getAttribute("src") ?? "", page.url()).href);
  expect(response.ok()).toBe(true);
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 1440]) {
    test.describe(`${theme} brand at ${width}px`, () => {
      test.use({ viewport: { width, height: width === 1280 ? 800 : 960 }, deviceScaleFactor: width === 1280 ? 1 : 2 });
      test("renders a sharp uncropped mark and keeps the homepage interactive", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
        await page.addInitScript((mode) => {
          localStorage.setItem("ling-stack.locale", "en-US");
          const selection = JSON.stringify({ mode: "fixed", themeId: `ling-${mode}` });
          localStorage.setItem("ling-stack.themeSelection", selection);
          localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
        }, theme);
        await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("data-ui-theme", `ling-${theme}`);
        const mark = page.locator(".conversation-home-mark img");
        await expect(mark).toBeVisible();
        await expect.poll(() => mark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
        const geometry = await mark.evaluate((img: HTMLImageElement) => {
          const rect = img.getBoundingClientRect();
          const parent = getComputedStyle(img.parentElement!);
          return { width: rect.width, height: rect.height, radius: parent.borderRadius, overflow: parent.overflow };
        });
        expect(geometry).toEqual({ width: 64, height: 64, radius: "0px", overflow: "visible" });
        await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", "./favicon.svg");
        const favicon = await page.request.get("/favicon.svg");
        expect(favicon.ok()).toBe(true);
        expect(await favicon.text()).not.toMatch(/<image|<filter/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const evidence = join(webDirectory, "../../.codex-artifacts/brand-icons");
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `home-${theme}-${width}.png`), fullPage: true });
        await page.getByRole("button", { name: "Slides", exact: true }).click();
        await expect(page.locator('[data-conversation-composer]')).toContainText("Draft a slide outline from the current context.");
        expect(errors).toEqual([]);
      });
    });
  }
}

test("Vite build bases resolve public images for Web and Electron file documents", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ling-public-asset-url-"));
  try {
    const webOutDir = join(temporaryDirectory, "web");
    const fileOutDir = join(temporaryDirectory, "file");
    const webModule = await buildHelper("/", webOutDir);
    const fileModule = await buildHelper("./", fileOutDir);

    const avatarPath = "avatars/teammates/engineer.png" as const;
    const iconPath = "icons/ling-mark-compact.svg" as const;
    expect(webModule.publicAssetUrl(avatarPath)).toBe("/avatars/teammates/engineer.png");
    expect(webModule.publicAssetUrl(iconPath)).toBe("/icons/ling-mark-compact.svg");
    expect(fileModule.publicAssetUrl(avatarPath)).toBe("./avatars/teammates/engineer.png");
    expect(fileModule.publicAssetUrl(iconPath)).toBe("./icons/ling-mark-compact.svg");

    expect(new URL(
      webModule.publicAssetUrl(avatarPath),
      "https://ling.example.test/workspaces/current",
    ).href).toBe("https://ling.example.test/avatars/teammates/engineer.png");
    expect(new URL(
      fileModule.publicAssetUrl(avatarPath),
      "file:///Applications/Ling%20Stack.app/Contents/Resources/web/index.html",
    ).href).toBe(
      "file:///Applications/Ling%20Stack.app/Contents/Resources/web/avatars/teammates/engineer.png",
    );

    const builtDocumentUrl = pathToFileURL(join(fileOutDir, "index.html"));
    const builtAvatarUrl = new URL(fileModule.publicAssetUrl(avatarPath), builtDocumentUrl);
    expect(fileURLToPath(builtAvatarUrl)).toBe(join(fileOutDir, avatarPath));
    expect(await readFile(builtAvatarUrl)).toEqual(
      await readFile(new URL("../public/avatars/teammates/engineer.png", import.meta.url)),
    );
    for (const file of ["ling-mark.svg", "ling-mark-compact.svg", "ling-mark-micro.svg"]) {
      const asset = `icons/${file}`;
      const builtIconUrl = new URL(fileModule.publicAssetUrl(asset), builtDocumentUrl);
      expect(await readFile(builtIconUrl)).toEqual(await readFile(new URL(`../public/${asset}`, import.meta.url)));
    }

    for (const unsafePath of [
      "/avatars/teammates/engineer.png",
      "https://example.test/avatar.png",
      "avatars/../secrets.txt",
    ]) {
      expect(() => fileModule.publicAssetUrl(unsafePath)).toThrow(
        "Public asset paths must be trusted local paths relative to the build base",
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

interface BuiltPublicAssetModule {
  publicAssetUrl(assetPath: string): string;
}

async function buildHelper(base: "/" | "./", outDir: string): Promise<BuiltPublicAssetModule> {
  await build({
    base,
    build: {
      emptyOutDir: true,
      lib: {
        entry: helperPath,
        fileName: "public-asset-url",
        formats: ["es"],
      },
      minify: false,
      outDir,
      rollupOptions: {
        output: {
          entryFileNames: "public-asset-url.mjs",
        },
      },
    },
    configFile: false,
    logLevel: "silent",
    root: webDirectory,
  });
  return import(`${pathToFileURL(join(outDir, "public-asset-url.mjs")).href}?base=${encodeURIComponent(base)}`);
}

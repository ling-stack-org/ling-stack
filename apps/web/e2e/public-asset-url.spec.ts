import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("public image sources use the trusted build-base helper", async () => {
  const [helperSource, avatarSource, emptyStateSource] = await Promise.all([
    readFile(helperPath, "utf8"),
    readFile(avatarSourcePath, "utf8"),
    readFile(emptyStateSourcePath, "utf8"),
  ]);

  expect(helperSource).toContain("import.meta.env.BASE_URL");
  expect(helperSource).toContain("assertLocalPublicAssetPath(assetPath)");
  expect(avatarSource).toContain("publicAssetUrl(`${AVATAR_BASE_PATH}/${fileName}`)");
  expect(avatarSource).not.toContain('AVATAR_BASE_PATH = "/avatars');
  expect(emptyStateSource).toContain('publicAssetUrl("icons/ling-stack-gpt-image-2-icon.png")');
  expect(emptyStateSource).not.toContain('src="/icons/');
});

test("Web dev renders the conversation mark from the origin public directory", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");

  const mark = page.getByLabel("Conversation home").locator(".conversation-home-mark img");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("src", "/icons/ling-stack-gpt-image-2-icon.png");
  const response = await page.request.get(new URL(await mark.getAttribute("src") ?? "", page.url()).href);
  expect(response.ok()).toBe(true);
});

test("Vite build bases resolve public images for Web and Electron file documents", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ling-public-asset-url-"));
  try {
    const webOutDir = join(temporaryDirectory, "web");
    const fileOutDir = join(temporaryDirectory, "file");
    const webModule = await buildHelper("/", webOutDir);
    const fileModule = await buildHelper("./", fileOutDir);

    const avatarPath = "avatars/teammates/engineer.png" as const;
    const iconPath = "icons/ling-stack-gpt-image-2-icon.png" as const;
    expect(webModule.publicAssetUrl(avatarPath)).toBe("/avatars/teammates/engineer.png");
    expect(webModule.publicAssetUrl(iconPath)).toBe("/icons/ling-stack-gpt-image-2-icon.png");
    expect(fileModule.publicAssetUrl(avatarPath)).toBe("./avatars/teammates/engineer.png");
    expect(fileModule.publicAssetUrl(iconPath)).toBe("./icons/ling-stack-gpt-image-2-icon.png");

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

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const forbiddenImports = [
  "electron",
  "@ling-stack/api-client",
  "@ling-stack/contracts",
  "@ling-stack/core",
  "apps/desktop",
  "computer-use",
];

test("shared UI output stays browser-safe and domain-neutral", async () => {
  const files = await collectFiles(new URL("../dist", import.meta.url));
  const productionFiles = files.filter((file) => file.endsWith(".js") || file.endsWith(".d.ts"));

  for (const file of productionFiles) {
    const source = await readFile(file, "utf8");
    for (const forbidden of forbiddenImports) {
      assert.doesNotMatch(source, new RegExp(escapeRegExp(forbidden), "u"), `${file} imports ${forbidden}`);
    }
  }
});

test("application features do not import Radix directly", async () => {
  const roots = [
    new URL("../../../apps/web/src/", import.meta.url),
    new URL("../../../apps/desktop/renderer/", import.meta.url),
  ];

  for (const root of roots) {
    const files = await collectFiles(root);
    const sourceFiles = files.filter((file) => /\.(?:ts|tsx|js|jsx)$/u.test(file));
    for (const file of sourceFiles) {
      const source = await readFile(file, "utf8");
      assert.doesNotMatch(source, /from\s+["']@radix-ui\//u, `${file} imports Radix directly`);
    }
  }
});

test("overlay declarations keep controlled, accessible, and busy-safe contracts", async () => {
  const dialog = await readFile(new URL("../dist/overlays/Dialog.d.ts", import.meta.url), "utf8");
  const drawer = await readFile(new URL("../dist/overlays/Drawer.d.ts", import.meta.url), "utf8");
  const context = await readFile(new URL("../dist/overlays/overlay-context.d.ts", import.meta.url), "utf8");

  assert.match(dialog, /title: ReactNode/u);
  assert.match(dialog, /description\?: ReactNode/u);
  assert.match(dialog, /closeLabel\?: string/u);
  assert.match(dialog, /size\?: DialogSize/u);
  assert.match(drawer, /side\?: DrawerSide/u);
  assert.match(context, /busy\?: boolean/u);
  assert.match(context, /dismissible\?: boolean/u);
  assert.match(context, /onOpenChange: \(open: boolean\) => void/u);
  assert.match(context, /open: boolean/u);
});

test("navigation and lightweight overlay declarations stay generic and controlled", async () => {
  const popover = await readFile(new URL("../dist/overlays/Popover.d.ts", import.meta.url), "utf8");
  const tabs = await readFile(new URL("../dist/navigation/Tabs.d.ts", import.meta.url), "utf8");
  const segmented = await readFile(new URL("../dist/navigation/SegmentedControl.d.ts", import.meta.url), "utf8");

  assert.match(popover, /PopoverSize = "sm" \| "md" \| "lg" \| "content"/u);
  assert.match(popover, /size\?: PopoverSize/u);
  assert.match(tabs, /TabsAppearance = "line" \| "contained"/u);
  assert.match(tabs, /appearance\?: TabsAppearance/u);
  assert.match(segmented, /onValueChange\?: \(value: string\) => void/u);
  assert.match(segmented, /value\?: string/u);
});

test("theme studio preview declaration stays controlled, synthetic, and viewport-bound", async () => {
  const preview = await readFile(
    new URL("../dist/theme-studio/ThemeStudioPreviewFixture.d.ts", import.meta.url),
    "utf8",
  );

  assert.match(preview, /ThemeStudioPreviewSurface = "home" \| "conversation" \| "settings" \| "dialog"/u);
  assert.match(preview, /readonly presentationPolicy: LingPresentationSurfacePolicy/u);
  assert.match(preview, /readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>/u);
  assert.match(preview, /readonly viewport: ThemeStudioPreviewViewport/u);
  assert.doesNotMatch(preview, /apiClient|daemon|router|workspaceId/u);
});

async function collectFiles(rootUrl) {
  const rootPath = rootUrl.pathname;
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(rootPath, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(new URL(`file://${child}/`)));
    else files.push(child);
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

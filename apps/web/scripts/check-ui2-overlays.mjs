import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const webRoot = process.cwd();
const indexSource = readFileSync(resolve(webRoot, "index.html"), "utf8");
const providerSource = readFileSync(resolve(webRoot, "src/shared/ui/LingUiProvider.tsx"), "utf8");
const toastProviderSource = readFileSync(resolve(webRoot, "src/shared/feedback/LingToastProvider.tsx"), "utf8");
const styleFiles = collectFiles(resolve(webRoot, "src/styles"), ".css");

const overlayRootCount = [...indexSource.matchAll(/id=["']ling-ui-overlay-root["']/gu)].length;
if (overlayRootCount !== 1 || !indexSource.includes('data-ling-overlay-root="true"')) {
  fail(`Expected one application overlay root, found ${overlayRootCount}.`);
}
if (!providerSource.includes("<OverlayPortalProvider container={overlayRoot}>")
  || !providerSource.includes("<LingToastProvider portalContainer={overlayRoot}>")) {
  fail("LingUiProvider must route shared overlays and Toasts through the application overlay root.");
}
if (!toastProviderSource.includes("createPortal(viewport, portalContainer)")) {
  fail("LingToastProvider must portal its single viewport into the application overlay root.");
}

let zIndexDeclarations = 0;
let highLiteralDeclarations = 0;
for (const file of styleFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/z-index\s*:\s*([^;]+);/gu)) {
    zIndexDeclarations += 1;
    const numericValue = Number(match[1].trim());
    if (Number.isFinite(numericValue) && numericValue >= 60) highLiteralDeclarations += 1;
  }
}

const legacyBudgets = { highLiteralDeclarations: 25, zIndexDeclarations: 97 };
if (zIndexDeclarations > legacyBudgets.zIndexDeclarations) {
  fail(`Web CSS z-index declarations grew from ${legacyBudgets.zIndexDeclarations} to ${zIndexDeclarations}.`);
}
if (highLiteralDeclarations > legacyBudgets.highLiteralDeclarations) {
  fail(`High literal z-index declarations grew from ${legacyBudgets.highLiteralDeclarations} to ${highLiteralDeclarations}.`);
}

console.log("UI 2.0 overlay root: 1 provider + 1 Toast viewport");
console.log(`UI 2.0 legacy z-index budget: total=${zIndexDeclarations}/${legacyBudgets.zIndexDeclarations}`);
console.log(`UI 2.0 high literal z-index budget: total=${highLiteralDeclarations}/${legacyBudgets.highLiteralDeclarations}`);

function collectFiles(root, extension) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(fullPath);
  }
  return files;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

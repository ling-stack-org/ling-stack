import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const webRoot = process.cwd();
const guardedRoots = ["app", "domains", "features"].map((directory) => resolve(webRoot, "src", directory));
const forbiddenImportPattern = /from\s+["'](?:@ling-stack\/ui-react(?:\/[^"']*)?|@radix-ui\/[^"']+)["']/gu;
const compatibilityBudgets = Object.freeze({
  SelectControl: 0,
  CreateDialogShell: 0,
  OperationEmptyState: 0,
  StatusBadge: 1,
});
const guardedFiles = guardedRoots.flatMap(collectSourceFiles);

const violations = guardedFiles.flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(forbiddenImportPattern)].map((match) => {
    const line = source.slice(0, match.index).split("\n").length;
    return `${relative(webRoot, file)}:${line} ${match[0]}`;
  });
});

if (violations.length > 0) {
  console.error("App, domain, and feature code must import UI primitives through src/shared/ui:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("UI 2.0 import boundary: app/domain/feature direct package imports = 0");
for (const [symbol, maximum] of Object.entries(compatibilityBudgets)) {
  const current = guardedFiles.filter((file) => new RegExp(`\\b${symbol}\\b`, "u").test(readFileSync(file, "utf8"))).length;
  if (current > maximum) {
    console.error(`Deprecated UI facade ${symbol} grew from its budget ${maximum} to ${current} caller files.`);
    process.exit(1);
  }
  console.log(`UI 2.0 compatibility budget: ${symbol}=${current}/${maximum}`);
}

function collectSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(fullPath));
    else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(fullPath);
  }
  return files;
}

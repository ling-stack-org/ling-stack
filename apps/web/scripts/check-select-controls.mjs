import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const webRoot = process.cwd();
const sourceRoot = resolve(webRoot, "src");

function collectTsxFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsxFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

const violations = collectTsxFiles(sourceRoot)
  .flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const matches = [...source.matchAll(/<select\b/g)];
    return matches.map((match) => {
      const line = source.slice(0, match.index).split("\n").length;
      return `${relative(webRoot, file)}:${line}`;
    });
  });

if (violations.length > 0) {
  console.error("Use Select from src/shared/ui for production select controls:");
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("select control contract: no bare production <select> elements found");

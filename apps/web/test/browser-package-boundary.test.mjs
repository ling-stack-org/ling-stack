import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(webRoot, "src");

async function listTypeScriptSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...await listTypeScriptSources(absolute));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) sources.push(absolute);
  }
  return sources;
}

test("browser production sources do not import the Node-backed Core root", async () => {
  const violations = [];
  for (const file of await listTypeScriptSources(sourceRoot)) {
    const source = await readFile(file, "utf8");
    if (/\b(?:from\s+|import\s*\()(["'])@ling-stack\/core\1/.test(source)) {
      violations.push(path.relative(webRoot, file));
    }
  }

  assert.deepEqual(
    violations,
    [],
    "browser code must use a browser-safe @ling-stack/core subpath or @ling-stack/contracts",
  );
});

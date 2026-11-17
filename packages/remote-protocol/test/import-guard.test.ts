import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : entry.name.endsWith(".ts") ? [absolute] : [];
  }));
  return nested.flat();
}

test("protocol runtime source has no Node-only or React dependency", async () => {
  for (const file of await sourceFiles(sourceRoot)) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["']node:/, file);
    assert.doesNotMatch(source, /from\s+["'](?:react|react-native)/, file);
    assert.doesNotMatch(source, /\b(?:Buffer|process|require)\b/, file);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)) {
      const specifier = match[1];
      assert.equal(
        specifier.startsWith(".") || specifier === "@ling-stack/contracts",
        true,
        `${file} imports forbidden runtime dependency ${specifier}`,
      );
    }
  }
});

test("CI scripts discover and type-check the TypeScript test suite", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const testConfig = JSON.parse(await readFile(new URL("../tsconfig.test.json", import.meta.url), "utf8"));

  assert.match(manifest.scripts["test:ci"], /test\/\*\.test\.ts/u);
  assert.match(manifest.scripts["typecheck:ci"], /tsconfig\.test\.json/u);
  assert.deepEqual(testConfig.include, ["test/**/*.ts"]);
});

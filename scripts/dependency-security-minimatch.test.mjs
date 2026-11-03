import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const universalRequire = createRequire(appBuilderRequire.resolve("@electron/universal"));
const mobileRequire = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
// Pi's public entry is import-only. Resolve its installed ESM entry, not a root copy.
const piRoot = realpathSync(join(root, "packages/runner-pi/node_modules/@earendil-works/pi-coding-agent"));
const piManifest = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
const piRequire = createRequire(join(piRoot, piManifest.exports["."].import));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = appBuilderRequire("yaml").parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));

test("Pi's actual model scoping preserves wildcard, case and thinking-level selection", async () => {
  const { resolveModelScopeFromModels } = await import(pathToFileURL(join(piRoot, "dist/core/model-resolver.js")).href);
  const models = [{ provider: "fixture", id: "alpha-model" }, { provider: "fixture", id: "beta-model" }];
  const result = resolveModelScopeFromModels(["FIXTURE/ALPHA*:high", "*beta*"], models);
  assert.deepEqual(result.scopedModels, [
    { model: models[0], thinkingLevel: "high" }, { model: models[1], thinkingLevel: undefined },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

const legacyAsarRequire = createRequire(appBuilderRequire.resolve("@electron/asar"));
const archiverRequire = createRequire(appBuilderRequire.resolve("archiver"));
const readdirRequire = createRequire(archiverRequire.resolve("readdir-glob"));
for (const [label, dependencyRequire, version] of [
  ["builder's legacy ASAR", legacyAsarRequire, "3.1.5"],
  ["archiver's readdir-glob", readdirRequire, "5.1.9"],
]) {
  test(`${label} keeps its declared legacy major without the affected preprocessor`, () => {
    const api = dependencyRequire("minimatch");
    assert.equal(dependencyRequire("minimatch/package.json").version, version);
    assert.equal(typeof api.Minimatch.prototype.firstPhasePreProcess, "undefined");
    assert.equal(typeof api.Minimatch.prototype.secondPhasePreProcess, "undefined");
    assert.equal(api("src/main.ts", "**/*.ts"), true);
  });
}

for (const [label, dependencyRequire, version] of [
  ["Pi", piRequire, "10.2.6"],
  ["Electron builder", appBuilderRequire, "10.2.6"],
  ["Electron universal", universalRequire, "9.0.9"],
  ["Expo CLI", cliRequire, "10.2.6"],
]) {
  const packagePath = dependencyRequire.resolve("minimatch/package.json");
  const packageRoot = dirname(packagePath);
  const dependency = JSON.parse(readFileSync(packagePath, "utf8"));
  const esmEntry = resolve(packageRoot, dependency.exports["."].import.default);
  const cjsEntry = dependencyRequire.resolve("minimatch");

  test(`${label} consumes the exact minimatch version and frozen patch`, () => {
    assert.equal(dependency.version, version);
    const key = `minimatch@${version}`;
    const patchPath = manifest.pnpm.patchedDependencies[key];
    assert.equal(patchPath, `patches/${key}.patch`);
    const bytes = readFileSync(join(root, patchPath), "utf8").replaceAll("\r\n", "\n");
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(lock.patchedDependencies[key].hash, digest);
    assert.ok(cjsEntry.includes(`patch_hash=${digest}`));
    assert.ok(esmEntry.includes(`patch_hash=${digest}`));
  });

  for (const [format, api] of [["CJS", dependencyRequire("minimatch")], ["ESM", await import(pathToFileURL(esmEntry).href)]]) {
    const { Minimatch } = api;
    test(`${label} ${format} bounds globstar-parent preprocessing at the default budget (GHSA-g3hv-75wg-m249)`, () => {
      const matcher = new Minimatch("literal", { optimizationLevel: 2 });
      // Start one slot below the real budget to probe growth without an unbounded PoC.
      const patterns = Array(99_999).fill(["literal"]);
      patterns[patterns.length - 1] = "**/../a/b/**/../c/d".split("/");
      assert.equal(matcher.firstPhasePreProcess(patterns).length, 100_000);
    });

    if (version === "10.2.6") {
      test(`${label} ${format} shares the explicit brace expansion budget with preprocessing`, () => {
        const matcher = new Minimatch(Array(8).fill("**/../a/b").join("/"), {
          optimizationLevel: 2, braceExpandMax: 64,
        });
        assert.equal(matcher.set.length, 64);
      });
    }

    test(`${label} ${format} skips quadratic deduplication only for large pattern sets`, () => {
      const small = new Minimatch("{x,*}/{0..9}", { optimizationLevel: 2 });
      assert.equal(small.set.length, 10);
      const large = new Minimatch("{x,*}/{0..999}", { optimizationLevel: 2 });
      assert.equal(large.set.length, 2000);
      assert.equal(large.match("x/5"), true);
      assert.equal(large.match("y/999"), true);
      assert.equal(large.match(".y/5"), false);
      let comparisons = 0;
      large.partsMatch = () => { comparisons++; return false; };
      const patterns = Array.from({ length: 1001 }, (_, i) => [String(i)]);
      assert.equal(large.secondPhasePreProcess(patterns), patterns);
      assert.equal(comparisons, 0);
    });

    test(`${label} ${format} preserves normal, negated, dotfile and Windows matching`, () => {
      const matcher = new Minimatch("**/../a/b/**/../c/d", { optimizationLevel: 2 });
      assert.equal(matcher.set.length, 4);
      assert.equal(matcher.match("../a/b/../c/d"), true);
      assert.equal(matcher.match("x/a/b/y/c/d"), true);
      assert.equal(api.minimatch("src/main.ts", "**/*.{ts,js}"), true);
      assert.equal(api.minimatch("src/main.css", "**/*.{ts,js}"), false);
      assert.equal(api.minimatch("src/main.ts", "!**/*.css"), true);
      assert.equal(api.minimatch(".env", "*"), false);
      assert.equal(api.minimatch(".env", "*", { dot: true }), true);
      for (const optimizationLevel of [0, 1, 2]) {
        const options = { platform: "win32", windowsPathsNoEscape: true, nocase: true, optimizationLevel };
        assert.equal(api.minimatch("C:\\src\\main.TS", "c:/src/*.ts", options), true);
        assert.equal(api.minimatch("//server/share/src/main.ts", "//server/share/**/*.ts", options), true);
        assert.equal(api.minimatch("//?/C:/src/main.ts", "C:/src/*.ts", options), true);
      }
    });
  }
}

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const mobileRequire = createRequire(new URL("../package.json", import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
// Use the same semver implementation as Expo's dependency checker.
const expoCliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const { intersects, satisfies }: {
  intersects(range: string, supportedRange: string): boolean;
  satisfies(version: string, range: string): boolean;
} = expoCliRequire("semver");
const { dependencies, devDependencies }: {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} = mobileRequire("./package.json");
const bundled: Record<string, string | undefined> = expoRequire("./bundledNativeModules.json");

for (const [name, declaredRange] of Object.entries({ ...dependencies, ...devDependencies })) {
  const supportedRange = bundled[name];
  if (!supportedRange) continue;

  test(`${name} stays compatible with the installed Expo SDK`, () => {
    assert.ok(intersects(declaredRange, supportedRange),
      `${name}: declared ${declaredRange}, Expo requires ${supportedRange}`);
    const { version }: { version: string } = mobileRequire(`${name}/package.json`);
    assert.ok(satisfies(version, supportedRange),
      `${name}: installed ${version}, Expo requires ${supportedRange}`);
    assert.ok(satisfies(version, declaredRange),
      `${name}: installed ${version} does not satisfy declared ${declaredRange}`);
  });
}

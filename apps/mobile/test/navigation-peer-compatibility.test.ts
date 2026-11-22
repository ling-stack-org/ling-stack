import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const mobileRequire = createRequire(new URL("../package.json", import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve("expo/package.json"));
const expoCliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const { satisfies }: { satisfies(version: string, range: string): boolean } = expoCliRequire("semver");
const stack: { version: string; peerDependencies: Record<string, string> } =
  mobileRequire("@react-navigation/native-stack/package.json");

for (const [name, supportedRange] of Object.entries(stack.peerDependencies)) {
  test(`native-stack ${stack.version} has a compatible ${name} peer`, () => {
    const { version }: { version: string } = mobileRequire(`${name}/package.json`);
    assert.ok(satisfies(version, supportedRange),
      `${name}: installed ${version}, native-stack requires ${supportedRange}`);
  });
}

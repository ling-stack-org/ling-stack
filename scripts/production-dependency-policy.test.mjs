import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const coreRequire = createRequire(new URL("../packages/core/package.json", import.meta.url));
const { parse } = coreRequire("yaml");
const configuration = parse(readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8"));
const npm = configuration.updates.find(update => update["package-ecosystem"] === "npm");

test("ordinary production updates cannot batch major migrations", () => {
  assert.deepEqual(npm.groups["production-dependencies"]["update-types"], ["minor", "patch"]);
});

test("execution and mobile SDK families stay outside the ordinary update group", () => {
  const patterns = npm.groups["production-dependencies"]["exclude-patterns"];
  for (const pattern of ["@earendil-works/*", "expo", "expo-*", "react", "react-dom", "react-native",
    "react-native-*", "@react-native-*/*", "@react-navigation/*"]) {
    assert.ok(patterns.includes(pattern), `${pattern} requires separate migration acceptance`);
  }
});

test("separate migrations remain eligible for Dependabot updates", () => {
  assert.equal(npm.ignore, undefined, "do not silence updates or security advisories");
  assert.equal(npm["open-pull-requests-limit"], 5);
  assert.equal(npm.groups["development-dependencies"]["dependency-type"], "development");
});

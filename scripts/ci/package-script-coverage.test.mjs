import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { classifyChangedFiles } from "./classify-scope.mjs";

const root = new URL("../../", import.meta.url);
const scope = classifyChangedFiles({ files: [], eventName: "schedule" });
const manifests = new Map();
const sourcePackages = [];
for (const directory of ["apps", "packages"]) {
  for (const entry of readdirSync(new URL(`${directory}/`, root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = new URL(`${directory}/${entry.name}/package.json`, root);
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifests.set(manifest.name, manifest);
      if (directory === "packages") sourcePackages.push(manifest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

test("workspace modules register local and CI validation entrypoints", () => {
  const entries = ["build", "build:ci", "typecheck", "typecheck:ci", "test", "test:ci"];
  const missing = sourcePackages.flatMap(({ name, scripts }) => entries
    .filter(task => typeof scripts?.[task] !== "string" || !scripts[task].trim())
    .map(task => `${name} ${task}`));
  assert.deepEqual(missing, []);
});

// Static coverage complements the runner's fail-closed selected-script check.
for (const [task, selected] of [["typecheck:ci", scope.typecheckPackages], ["test:ci", scope.testPackages]]) {
  test(`every package selected for ${task} has an executable CI entry`, () => {
    assert.ok(selected.length > 0, "full regression must select workspace packages");
    const missing = selected.filter(name => {
      const script = manifests.get(name)?.scripts?.[task];
      return typeof script !== "string" || script.trim().length === 0;
    });
    assert.deepEqual(missing, [], `selected packages missing ${task}: ${missing.join(", ")}`);
  });
}

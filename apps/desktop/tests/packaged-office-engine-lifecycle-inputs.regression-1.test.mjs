import assert from "node:assert/strict";
import test from "node:test";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS } from "../scripts/packaged-office-native-review-inputs.mjs";

// Regression: new literal runtime imports must be explicitly reviewed, never discovered by a build.
// Fixed-input coverage only: this test grants no Office approval or packaged acceptance.
for (const path of [
  "packages/contracts/src/engine-lifecycle.ts",
  "packages/daemon/src/features/execution-engines/engine-scanner.ts",
  "packages/daemon/src/features/execution-engines/managed-engine-installer.ts",
]) {
  test(`Office fixed closure uniquely includes ${path}`, () => {
    assert.equal(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.filter(candidate => candidate === path).length, 1,
      `Unreviewed or duplicate lifecycle runtime input: ${path}`);
  });
}

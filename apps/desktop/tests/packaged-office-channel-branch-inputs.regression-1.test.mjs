import assert from "node:assert/strict";
import test from "node:test";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS } from "../scripts/packaged-office-native-review-inputs.mjs";

// Regression: C03-PACKAGED-CLOSURE — explicitly review newly imported branch modules.
// Found by /qa on 2026-10-25.
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/c03-scope-findings.md
// Fixed-input coverage only; not approval, build or packaged GUI acceptance.
for (const path of [
  "packages/core/src/storage/sqlite/conversation-empty-fork-migration.ts",
  "packages/daemon/src/features/channels/channel-branch-origin.ts",
]) {
  test(`Office fixed closure includes ${path}`, () => {
    assert.ok(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(path), `unreviewed runtime input: ${path}`);
  });
}

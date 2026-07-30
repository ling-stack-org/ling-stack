import assert from "node:assert/strict";
import test from "node:test";
import { readBundledCuaDriverSetupMetadata } from "../dist/features/plugins/cua-driver-catalog-projection.js";

test("catalog projection keeps the complete Windows standard coverage tuple", () => {
  assert.deepEqual(readBundledCuaDriverSetupMetadata({
    providerVersion: "0.8.3",
    providerDistributionRevision: "ling.1",
    providerSealDigest: "a".repeat(64),
    providerCatalogDigest: "b".repeat(64),
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
    integrity: "verified",
    windowsReadiness: {
      interactiveSession: "ready",
      wgcApi: "supported",
      d3d11: "available",
      uiaRuntime: "available",
      contentObserved: false,
      integrityCoverage: "standard",
      uiaHelper: "not_required",
    },
  }, "win32"), {
    providerVersion: "0.8.3",
    providerDistributionRevision: "ling.1",
    providerSealDigest: "a".repeat(64),
    providerCatalogDigest: "b".repeat(64),
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
    integrity: "verified",
    windowsReadiness: {
      interactiveSession: "ready",
      wgcApi: "supported",
      d3d11: "available",
      uiaRuntime: "available",
      contentObserved: false,
      integrityCoverage: "standard",
      uiaHelper: "not_required",
    },
  });
});

test("catalog projection rejects partial coverage and bounded display metadata", () => {
  assert.deepEqual(readBundledCuaDriverSetupMetadata({
    providerVersion: "x".repeat(129),
    providerDistributionRevision: "y".repeat(129),
    providerSealDigest: "A".repeat(64),
    providerCatalogDigest: "not-a-digest",
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input"],
  }, "win32"), {});
});

test("catalog projection never exposes Windows coverage on another platform", () => {
  assert.deepEqual(readBundledCuaDriverSetupMetadata({
    providerVersion: "0.8.3",
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  }, "darwin"), {
    providerVersion: "0.8.3",
  });
});

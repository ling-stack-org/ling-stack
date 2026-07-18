import assert from "node:assert/strict";
import test from "node:test";
import {
  CUA_DRIVER_PROVIDER_LOCK_SCHEMA_VERSION,
  CUA_DRIVER_PROVIDER_STATES,
  CUA_DRIVER_SETUP_SCHEMA_VERSION,
  DEFAULT_CUA_DRIVER_FEATURE_FLAGS,
  DESKTOP_CUA_DRIVER_LEASE_SCHEMA_VERSION,
  isBundledEmbeddedCuaDriverEnabled,
  isCuaDriverProviderState,
  isDesktopCuaDriverLeaseV1,
  isWindowsSigningPromotionContract,
  legacySetupStateForCuaDriverProviderState,
  windowsVerdictCeilingForSigningTier,
} from "../dist/index.js";

test("Cua Driver schema versions and packaged feature gates are frozen", () => {
  assert.equal(CUA_DRIVER_SETUP_SCHEMA_VERSION, 2);
  assert.equal(CUA_DRIVER_PROVIDER_LOCK_SCHEMA_VERSION, 2);
  assert.equal(DESKTOP_CUA_DRIVER_LEASE_SCHEMA_VERSION, 1);
  assert.deepEqual(DEFAULT_CUA_DRIVER_FEATURE_FLAGS, {
    bundledEmbedded: { darwin: false, win32: false },
    packagedProvider: { darwin: false, win32: false },
  });
  assert.equal(isBundledEmbeddedCuaDriverEnabled(DEFAULT_CUA_DRIVER_FEATURE_FLAGS, "darwin"), false);
  assert.equal(isBundledEmbeddedCuaDriverEnabled(DEFAULT_CUA_DRIVER_FEATURE_FLAGS, "win32"), false);
  assert.equal(isBundledEmbeddedCuaDriverEnabled({
    bundledEmbedded: { darwin: true, win32: false },
    packagedProvider: { darwin: true, win32: false },
  }, "darwin"), true);
  assert.equal(isBundledEmbeddedCuaDriverEnabled({
    bundledEmbedded: { darwin: false, win32: true },
    packagedProvider: { darwin: false, win32: true },
  }, "win32"), true);
  assert.equal(isBundledEmbeddedCuaDriverEnabled({
    bundledEmbedded: { darwin: true, win32: true },
    packagedProvider: { darwin: true, win32: true },
  }, "linux"), false);
});

test("Cua Driver provider state keeps a deterministic legacy projection", () => {
  const expected = new Map([
    ["external_missing", "missing"],
    ["external_detected", "detected"],
    ["ready", "ready"],
    ["unsupported", "unsupported"],
  ]);
  for (const providerState of CUA_DRIVER_PROVIDER_STATES) {
    assert.equal(isCuaDriverProviderState(providerState), true);
    assert.equal(
      legacySetupStateForCuaDriverProviderState(providerState),
      expected.get(providerState) ?? "connected",
    );
  }
  assert.equal(isCuaDriverProviderState("install_the_public_driver"), false);
});

test("Windows signing promotion contract enforces tier, channel and verdict ceilings", () => {
  const internal = {
    signingTier: "test_signed_internal",
    distributionChannel: "internal",
    productionEligible: false,
    testAuthorityKind: "ephemeral-ci",
    verdictCeiling: "INTERNAL_TEST_PASS",
    promotionStatus: "INTERNAL_TEST_PASS",
    releaseReady: false,
  };
  const production = {
    signingTier: "production_signed",
    distributionChannel: "production",
    productionEligible: true,
    verdictCeiling: "RELEASE_PASS",
    promotionStatus: "RELEASE_PASS",
    releaseReady: true,
  };
  assert.equal(isWindowsSigningPromotionContract(internal), true);
  assert.equal(isWindowsSigningPromotionContract(production), true);
  assert.equal(isWindowsSigningPromotionContract({ ...internal, releaseReady: true }), false);
  assert.equal(isWindowsSigningPromotionContract({ ...internal, distributionChannel: "production" }), false);
  assert.equal(isWindowsSigningPromotionContract({ ...production, promotionStatus: "INTERNAL_TEST_PASS", releaseReady: false }), false);
  assert.equal(isWindowsSigningPromotionContract({ ...production, promotionStatus: "RELEASE_PASS", releaseReady: false }), false);
  assert.equal(windowsVerdictCeilingForSigningTier("unsigned_dev"), "DEVELOPMENT_ONLY");
  assert.equal(windowsVerdictCeilingForSigningTier("test_signed_internal"), "INTERNAL_TEST_PASS");
  assert.equal(windowsVerdictCeilingForSigningTier("production_signed"), "RELEASE_PASS");
});

test("Desktop Cua Driver lease guard requires versioned loopback and digest identity", () => {
  const digest = "a".repeat(64);
  const lease = {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-instance-1",
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-1",
    generation: 2,
    daemonAuthorityEpoch: "daemon-authority-1",
    workspaceCwd: "/workspace",
    endpoint: "http://127.0.0.1:43123/mcp",
    providerVersion: "0.8.3",
    distributionRevision: "ling.1",
    integrationMode: "embedded-stdio",
    expiresAt: "2026-07-18T00:01:00.000Z",
    lockDigest: digest,
    providerSealDigest: digest,
    providerCatalogDigest: "b".repeat(64),
    platform: "win32",
    architecture: "x86_64",
    integrityCoverage: "standard",
  };
  assert.equal(isDesktopCuaDriverLeaseV1(lease), true);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, schemaVersion: 2 }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, endpoint: "http://example.com/mcp" }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, providerCatalogDigest: "not-a-digest" }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, platform: "win32", architecture: "arm64" }), false);
});

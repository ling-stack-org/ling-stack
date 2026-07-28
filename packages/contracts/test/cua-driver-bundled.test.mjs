import assert from "node:assert/strict";
import test from "node:test";
import {
  CUA_DRIVER_PROVIDER_LOCK_SCHEMA_VERSION,
  CUA_DRIVER_PROVIDER_STATES,
  CUA_DRIVER_SETUP_SCHEMA_VERSION,
  CUA_DRIVER_LEASE_MAX_TTL_MS,
  CUA_DRIVER_LEASE_V1_CAPABILITY,
  cuaDriverProxyTokenMaterialV1,
  cuaDriverWorkspaceBindingMaterialV1,
  DEFAULT_CUA_DRIVER_FEATURE_FLAGS,
  DESKTOP_CUA_DRIVER_LEASE_SCHEMA_VERSION,
  isBundledEmbeddedCuaDriverEnabled,
  isCuaDriverProviderState,
  isCuaDriverDesktopBridgeHandshakeResponseV1,
  isDesktopCuaDriverAvailabilityV1,
  isDesktopCuaDriverLeaseRevokeV1,
  isDesktopCuaDriverLeaseV1,
  isWindowsSigningPromotionContract,
  legacySetupStateForCuaDriverProviderState,
  windowsVerdictCeilingForSigningTier,
} from "../dist/index.js";

test("Cua Driver proxy cryptographic material keeps one cross-process tuple order", () => {
  assert.equal(cuaDriverProxyTokenMaterialV1({
    daemonAuthorityEpoch: "authority-golden",
    bridgeConnectionId: "bridge-golden",
    desktopInstanceEpoch: 7,
    generation: 11,
    workspaceCwd: "/Users/test/Ling Workspace",
  }), [
    "ling-cua-driver-proxy-v1",
    "authority-golden",
    "bridge-golden",
    "7",
    "11",
    "/Users/test/Ling Workspace",
  ].join("\u001f"));
  assert.equal(
    cuaDriverWorkspaceBindingMaterialV1("/Users/test/Ling Workspace"),
    "/Users/test/Ling Workspace",
  );
  assert.throws(() => cuaDriverProxyTokenMaterialV1({
    daemonAuthorityEpoch: "authority-golden",
    bridgeConnectionId: "bridge-golden",
    desktopInstanceEpoch: 0,
    generation: 11,
    workspaceCwd: "/Users/test/Ling Workspace",
  }), /cua_driver_proxy_context_invalid/);
});

test("Cua Driver schema versions and packaged feature gates are frozen", () => {
  assert.equal(CUA_DRIVER_SETUP_SCHEMA_VERSION, 2);
  assert.equal(CUA_DRIVER_PROVIDER_LOCK_SCHEMA_VERSION, 2);
  assert.equal(DESKTOP_CUA_DRIVER_LEASE_SCHEMA_VERSION, 1);
  assert.equal(CUA_DRIVER_LEASE_MAX_TTL_MS, 120_000);
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
  assert.equal(isDesktopCuaDriverLeaseV1({
    ...lease,
    expiresAt: "Fri, 17 Jul 2026 23:59:59 GMT",
  }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({
    ...lease,
    expiresAt: "2026-07-18T00:01:00Z",
  }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({
    ...lease,
    expiresAt: "2026-07-18T01:01:00.000+01:00",
  }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, providerCatalogDigest: "not-a-digest" }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, platform: "win32", architecture: "arm64" }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({
    ...lease,
    platform: "darwin",
    architecture: "x86_64",
    providerCatalogDigest: undefined,
    integrityCoverage: undefined,
  }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, integrityCoverage: undefined }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({ ...lease, integrityCoverage: "uiaccess" }), false);
  assert.equal(isDesktopCuaDriverLeaseV1({
    ...lease,
    platform: "darwin",
    architecture: "arm64",
    providerCatalogDigest: undefined,
    integrityCoverage: undefined,
  }), true);
  assert.equal(isDesktopCuaDriverLeaseV1({
    ...lease,
    platform: "darwin",
    architecture: "arm64",
    integrityCoverage: "standard",
  }), false);
});

test("Desktop availability is non-authoritative and platform metadata is exact", () => {
  const report = {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-instance-1",
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-1",
    daemonAuthorityEpoch: "daemon-authority-1",
    workspaceCwd: "/workspace",
    generation: 2,
    sequence: 3,
    platform: "win32",
    providerState: "interactive_session_required",
    reason: "windows_interactive_session_required",
    integrityCoverage: "standard",
    limitations: ["elevated_pixel_input", "uwp_send_input"],
  };
  assert.equal(isDesktopCuaDriverAvailabilityV1(report), true);
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, providerState: "ready" }), false);
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, rawProviderPayload: "secret" }), false);
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, sequence: 0 }), false);
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, generation: -1 }), false);
  assert.equal(isDesktopCuaDriverAvailabilityV1({
    ...report,
    platform: "darwin",
    integrityCoverage: undefined,
    limitations: [],
    providerState: "permission_required",
  }), true);
  assert.equal(isDesktopCuaDriverAvailabilityV1({
    ...report,
    platform: "darwin",
  }), false, "Darwin cannot inherit Windows integrity limitations");

  for (const field of [
    "desktopInstanceId",
    "bridgeConnectionId",
    "daemonAuthorityEpoch",
    "workspaceCwd",
  ]) {
    assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, [field]: "  " }), false);
  }
  for (const reason of ["", "UPPERCASE", "/private/path", "a".repeat(257)]) {
    assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, reason }), false);
  }
  for (const limitations of [
    undefined,
    [],
    ["elevated_pixel_input"],
    ["elevated_pixel_input", "elevated_pixel_input"],
    ["elevated_pixel_input", "unknown"],
  ]) {
    assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, limitations }), false);
  }
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, integrityCoverage: "uiaccess" }), false);
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, platform: "unsupported" }), false);
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, desktopInstanceEpoch: 0 }), false);
  assert.equal(isDesktopCuaDriverAvailabilityV1({ ...report, sequence: Number.MAX_SAFE_INTEGER + 1 }), false);
});

test("Desktop bridge lease capability extends protocol V1 with an authority tuple", () => {
  const handshake = {
    protocolVersion: 1,
    capabilities: ["preview-source", CUA_DRIVER_LEASE_V1_CAPABILITY],
    bridgeTokenAccepted: true,
    routeTokenAccepted: true,
    defaultWorkspaceCwd: "/workspace",
    daemonAuthorityEpoch: "daemon-authority-1",
    bridgeConnectionId: "bridge-1",
    desktopInstanceEpoch: 1,
  };
  assert.equal(isCuaDriverDesktopBridgeHandshakeResponseV1(handshake), true);
  assert.equal(isCuaDriverDesktopBridgeHandshakeResponseV1({
    ...handshake,
    capabilities: ["preview-source"],
  }), false);
  assert.equal(isCuaDriverDesktopBridgeHandshakeResponseV1({
    ...handshake,
    desktopInstanceEpoch: 0,
  }), false);
});

test("Desktop Cua Driver revoke guard requires a complete positive handshake identity", () => {
  const revoke = {
    schemaVersion: 1,
    providerId: "cua-driver",
    desktopInstanceId: "desktop-instance-1",
    desktopInstanceEpoch: 1,
    bridgeConnectionId: "bridge-1",
    generation: 2,
    daemonAuthorityEpoch: "daemon-authority-1",
    workspaceCwd: "/workspace",
  };
  assert.equal(isDesktopCuaDriverLeaseRevokeV1(revoke), true);
  assert.equal(isDesktopCuaDriverLeaseRevokeV1({ ...revoke, generation: 0 }), false);
  assert.equal(isDesktopCuaDriverLeaseRevokeV1({ ...revoke, bridgeConnectionId: "" }), false);
});

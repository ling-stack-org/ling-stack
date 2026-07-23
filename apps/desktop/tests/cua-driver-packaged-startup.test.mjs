import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDesktopCuaDriverPackagedStartupAuthority,
} from "../dist/main/cua-driver/packaged-startup.js";

const DARWIN_AUTHORITY = Object.freeze({
  schemaVersion: 1,
  componentId: "cua-driver",
  distributionRevision: "0.8.3-ling.1",
  providerExpected: true,
  platform: "darwin",
  signingTier: "test_signed_internal",
  distributionChannel: "internal",
  capabilitiesSha256: "a".repeat(64),
  runtimeTrustPolicySha256: "b".repeat(64),
});

test("unpackaged and governed external-only startup leave bundled gates closed", async () => {
  const unpackaged = await resolveDesktopCuaDriverPackagedStartupAuthority({
    packaged: false,
    appPath: "/app",
    resourcesPath: "/resources",
    platform: "darwin",
  });
  assert.equal(unpackaged.runtimeEligible, false);
  assert.deepEqual(unpackaged.featureFlags.bundledEmbedded, { darwin: false, win32: false });

  const external = await resolveDesktopCuaDriverPackagedStartupAuthority(
    { packaged: true, appPath: "/app", resourcesPath: "/resources", platform: "darwin" },
    {
      async loadAuthority() {
        return {
          schemaVersion: 1,
          componentId: "cua-driver",
          distributionRevision: "0.8.3-ling.1",
          providerExpected: false,
        };
      },
    },
  );
  assert.equal(external.runtimeEligible, false);
  assert.deepEqual(external.featureFlags.packagedProvider, { darwin: false, win32: false });
});

test("verified signed authority supplies one runtime policy and one platform gate", async () => {
  const policy = Object.freeze({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    platform: "darwin",
    expectedTeamId: "ABCDEFGHIJ",
  });
  const startup = await resolveDesktopCuaDriverPackagedStartupAuthority(
    { packaged: true, appPath: "/app", resourcesPath: "/resources", platform: "darwin" },
    {
      async loadAuthority() { return DARWIN_AUTHORITY; },
      async loadCapabilities(_resourcesPath, options) {
        assert.equal(options.authority, DARWIN_AUTHORITY);
        return { schemaVersion: 1, resourcesValidated: true, darwin: true, win32: false };
      },
      async loadPolicy(options) {
        assert.equal(options.authority, DARWIN_AUTHORITY);
        return policy;
      },
    },
  );
  assert.equal(startup.runtimeEligible, true);
  assert.equal(startup.policy, policy);
  assert.deepEqual(startup.featureFlags.bundledEmbedded, { darwin: true, win32: false });
  assert.deepEqual(startup.featureFlags.packagedProvider, { darwin: true, win32: false });
});

test("corrupt loose authority replicas keep bundled selection but never become runtime eligible", async () => {
  const failure = new Error("capability_digest_mismatch");
  const startup = await resolveDesktopCuaDriverPackagedStartupAuthority(
    { packaged: true, appPath: "/app", resourcesPath: "/resources", platform: "darwin" },
    {
      async loadAuthority() { return DARWIN_AUTHORITY; },
      async loadCapabilities() { throw failure; },
    },
  );
  assert.equal(startup.runtimeEligible, false);
  assert.equal(startup.failure, failure);
  assert.deepEqual(startup.featureFlags.bundledEmbedded, { darwin: true, win32: false });
  assert.deepEqual(startup.featureFlags.packagedProvider, { darwin: true, win32: false });
});

test("malformed or cross-platform signed intent fails closed on the current host platform", async () => {
  for (const loadAuthority of [
    async () => { throw new Error("malformed_signed_intent"); },
    async () => ({ ...DARWIN_AUTHORITY, platform: "win32" }),
  ]) {
    const startup = await resolveDesktopCuaDriverPackagedStartupAuthority(
      { packaged: true, appPath: "/app", resourcesPath: "/resources", platform: "darwin" },
      { loadAuthority },
    );
    assert.equal(startup.runtimeEligible, false);
    assert.ok(startup.failure);
    assert.deepEqual(startup.featureFlags.bundledEmbedded, { darwin: true, win32: false });
    assert.deepEqual(startup.featureFlags.packagedProvider, { darwin: true, win32: false });
  }
});

test("capability intent mismatch and unsupported hosts remain selected but ineligible", async () => {
  const mismatch = await resolveDesktopCuaDriverPackagedStartupAuthority(
    { packaged: true, appPath: "/app", resourcesPath: "/resources", platform: "darwin" },
    {
      async loadAuthority() { return DARWIN_AUTHORITY; },
      async loadCapabilities() {
        return { schemaVersion: 1, resourcesValidated: true, darwin: false, win32: true };
      },
      async loadPolicy() {
        return {
          schemaVersion: 1,
          componentId: "cua-driver",
          distributionRevision: "0.8.3-ling.1",
          platform: "darwin",
          expectedTeamId: "ABCDEFGHIJ",
        };
      },
    },
  );
  assert.equal(mismatch.runtimeEligible, false);
  assert.match(String(mismatch.failure), /cua_driver_package_capability_intent_mismatch/u);
  assert.deepEqual(mismatch.featureFlags.bundledEmbedded, { darwin: true, win32: false });

  const unsupported = await resolveDesktopCuaDriverPackagedStartupAuthority(
    { packaged: true, appPath: "/app", resourcesPath: "/resources", platform: "linux" },
    { async loadAuthority() { return DARWIN_AUTHORITY; } },
  );
  assert.equal(unsupported.runtimeEligible, false);
  assert.ok(unsupported.failure);
  assert.deepEqual(unsupported.featureFlags.bundledEmbedded, { darwin: false, win32: false });
});

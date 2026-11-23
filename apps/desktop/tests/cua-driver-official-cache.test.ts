import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveDesktopCuaDriverPackagedStartupAuthority } from "../dist/main/cua-driver/packaged-startup.js";

const input = {
  packaged: true,
  platform: "darwin",
  appPath: "/app",
  resourcesPath: "/resources",
  lingVersion: "0.6.1",
} as const;
const authority = {
  schemaVersion: 1,
  componentId: "cua-driver",
  distributionRevision: "0.8.3-ling.1",
  providerExpected: true,
  providerSource: "official-cache",
  platform: "darwin",
  signingTier: "production_signed",
  distributionChannel: "production",
  capabilitiesSha256: "a".repeat(64),
  runtimeTrustPolicySha256: "b".repeat(64),
} as const;
const policy = {
  schemaVersion: 1,
  componentId: "cua-driver",
  distributionRevision: "0.8.3-ling.1",
  platform: "darwin",
  expectedTeamId: "ABCDEFGHIJ",
} as const;
const dependencies = {
  async loadAuthority() { return authority; },
  async loadCapabilities() {
    return { schemaVersion: 1, resourcesValidated: true, darwin: true, win32: false } as const;
  },
  async loadPolicy({ resourcesPath }: { resourcesPath: string }) {
    assert.equal(resourcesPath, input.resourcesPath);
    return policy;
  },
};

test("official cache selection keeps the Desktop policy and never falls back to an external command", async () => {
  const missing = await resolveDesktopCuaDriverPackagedStartupAuthority(input, {
    ...dependencies,
    async readOfficialRuntime() { return undefined; },
  });
  assert.equal(missing.runtimeEligible, false);
  assert.equal(missing.failure, undefined);
  assert.equal(missing.featureFlags.bundledEmbedded.darwin, true);

  const cachedRoot = join("/cache", "verified-package");
  const selected = await resolveDesktopCuaDriverPackagedStartupAuthority(input, {
    ...dependencies,
    async readOfficialRuntime(request) {
      assert.equal(request.lingVersion, input.lingVersion);
      assert.equal(request.executable, "runtime/providers/cua-driver/0.8.3-ling.1/darwin/ling-cua-driver");
      return { root: cachedRoot, executablePath: join(cachedRoot, request.executable), version: "0.2.0" };
    },
  });
  assert.equal(selected.runtimeEligible, true);
  assert.equal(selected.policy, policy);
  assert.equal(selected.providerResourcesPath, join(cachedRoot, "runtime"));
});

test("an invalid Desktop policy prevents selecting a downloaded provider", async () => {
  const failure = new Error("policy digest changed");
  const startup = await resolveDesktopCuaDriverPackagedStartupAuthority(input, {
    ...dependencies,
    async loadPolicy() { throw failure; },
    async readOfficialRuntime() { assert.fail("Provider cache was consulted before validating policy"); },
  });
  assert.equal(startup.failure, failure);
  assert.equal(startup.runtimeEligible, false);
  assert.equal(startup.featureFlags.bundledEmbedded.darwin, true);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CUA_DRIVER_RUNTIME_TRUST_POLICY_RESOURCE_SEGMENTS,
  CuaDriverRuntimeTrustPolicyError,
  loadCuaDriverRuntimeTrustPolicy,
  validateCuaDriverRuntimeTrustPolicy,
} from "../dist/main/cua-driver/runtime-trust-policy.js";

const CERTIFICATE_SHA = "a".repeat(64);

test("Darwin runtime trust policy is exact, platform-bound, and immutable", () => {
  const policy = validateCuaDriverRuntimeTrustPolicy({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    platform: "darwin",
    expectedTeamId: "ABCDEFGHIJ",
  }, "darwin");

  assert.equal(policy.expectedTeamId, "ABCDEFGHIJ");
  assert.equal(Object.isFrozen(policy), true);
  assert.throws(
    () => validateCuaDriverRuntimeTrustPolicy({ ...policy, candidateManifestPath: "/tmp/untrusted" }, "darwin"),
    schemaFailure,
  );
  assert.throws(
    () => validateCuaDriverRuntimeTrustPolicy(policy, "win32"),
    (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "platform_mismatch",
  );
});

test("Windows runtime policy freezes the internal signer tuple and rejects mixed tiers", () => {
  const policy = validateCuaDriverRuntimeTrustPolicy(internalWindowsPolicy(), "win32");

  assert.equal(policy.signingPolicy.signingTier, "test_signed_internal");
  assert.equal(policy.signingPolicy.distributionChannel, "internal");
  assert.equal(Object.isFrozen(policy.signingPolicy), true);
  assert.equal(Object.isFrozen(policy.signingPolicy.providerSigner), true);

  assert.throws(
    () => validateCuaDriverRuntimeTrustPolicy({
      ...internalWindowsPolicy(),
      signingPolicy: {
        ...internalWindowsPolicy().signingPolicy,
        distributionChannel: "production",
      },
    }, "win32"),
    schemaFailure,
  );
  assert.throws(
    () => validateCuaDriverRuntimeTrustPolicy({
      ...internalWindowsPolicy(),
      signingPolicy: {
        ...internalWindowsPolicy().signingPolicy,
        candidateDeclaredTier: "production_signed",
      },
    }, "win32"),
    schemaFailure,
  );
  assert.throws(
    () => validateCuaDriverRuntimeTrustPolicy({
      ...internalWindowsPolicy(),
      signingPolicy: {
        ...internalWindowsPolicy().signingPolicy,
        providerSigner: {
          ...internalWindowsPolicy().signingPolicy.providerSigner,
          certificateSha256: "0".repeat(64),
        },
      },
    }, "win32"),
    schemaFailure,
  );
});

test("Windows runtime policy accepts only the exact governed signing tier matrix", () => {
  const unsigned = validateCuaDriverRuntimeTrustPolicy({
    ...internalWindowsPolicy(),
    signingPolicy: {
      signingTier: "unsigned_dev",
      distributionChannel: "development",
    },
  }, "win32");
  assert.deepEqual(unsigned.signingPolicy, {
    signingTier: "unsigned_dev",
    distributionChannel: "development",
  });

  const production = validateCuaDriverRuntimeTrustPolicy({
    ...internalWindowsPolicy(),
    signingPolicy: {
      ...internalWindowsPolicy().signingPolicy,
      signingTier: "production_signed",
      distributionChannel: "production",
      catalogTimestampStatus: "Valid",
    },
  }, "win32");
  assert.equal(production.signingPolicy.signingTier, "production_signed");
  assert.equal(production.signingPolicy.catalogTimestampStatus, "Valid");

  for (const signingPolicy of [
    { signingTier: "unsigned_dev", distributionChannel: "internal" },
    { signingTier: "unsigned_dev", distributionChannel: "development", providerSigner: {} },
    { ...internalWindowsPolicy().signingPolicy, signingTier: "unknown" },
    { ...internalWindowsPolicy().signingPolicy, distributionChannel: "development" },
    { ...internalWindowsPolicy().signingPolicy, catalogTimestampStatus: "Expired" },
    {
      ...internalWindowsPolicy().signingPolicy,
      signingTier: "production_signed",
      distributionChannel: "production",
      catalogTimestampStatus: "NotRequired",
    },
    {
      ...internalWindowsPolicy().signingPolicy,
      providerSigner: { subject: " padded ", certificateSha256: CERTIFICATE_SHA },
    },
    {
      ...internalWindowsPolicy().signingPolicy,
      catalogSigner: { subject: "", certificateSha256: CERTIFICATE_SHA },
    },
    {
      ...internalWindowsPolicy().signingPolicy,
      providerSigner: { subject: "CN=Signer", certificateSha256: "A".repeat(64) },
    },
  ]) {
    assert.throws(
      () => validateCuaDriverRuntimeTrustPolicy({
        ...internalWindowsPolicy(),
        signingPolicy,
      }, "win32"),
      schemaFailure,
    );
  }
});

test("runtime policy rejects malformed envelopes and Darwin Team IDs", () => {
  const darwin = {
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    platform: "darwin",
    expectedTeamId: "ABCDEFGHIJ",
  };
  for (const value of [
    null,
    [],
    { ...darwin, schemaVersion: 2 },
    { ...darwin, componentId: "other" },
    { ...darwin, distributionRevision: "0.8.3" },
    { ...darwin, platform: "linux" },
    { ...darwin, expectedTeamId: "SHORT" },
    { ...darwin, expectedTeamId: "abcdefghij" },
    { ...darwin, expectedTeamId: "ABCDEFGHIJK" },
  ]) {
    assert.throws(
      () => validateCuaDriverRuntimeTrustPolicy(value, "darwin"),
      schemaFailure,
    );
  }
});

test("loader reads only the fixed resource path and fails closed on missing or oversized policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-runtime-policy-"));
  try {
    const policyPath = join(root, ...CUA_DRIVER_RUNTIME_TRUST_POLICY_RESOURCE_SEGMENTS);
    await mkdir(join(policyPath, ".."), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify(internalWindowsPolicy())}\n`, "utf8");

    const policy = await loadCuaDriverRuntimeTrustPolicy({
      resourcesPath: root,
      platform: "win32",
    });
    assert.equal(policy.platform, "win32");

    await assert.rejects(
      loadCuaDriverRuntimeTrustPolicy({ resourcesPath: root, platform: "darwin" }),
      (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "platform_mismatch",
    );
    await assert.rejects(
      loadCuaDriverRuntimeTrustPolicy({ resourcesPath: join(root, "missing"), platform: "win32" }),
      (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "unavailable",
    );
    await assert.rejects(
      loadCuaDriverRuntimeTrustPolicy({ resourcesPath: root, platform: "win32", maxBytes: 8 }),
      (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "oversized",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader rejects a symlinked policy even when the target has a valid schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-runtime-policy-link-"));
  try {
    const policyPath = join(root, ...CUA_DRIVER_RUNTIME_TRUST_POLICY_RESOURCE_SEGMENTS);
    const targetPath = join(root, "outside-policy.json");
    await mkdir(join(policyPath, ".."), { recursive: true });
    await writeFile(targetPath, `${JSON.stringify(internalWindowsPolicy())}\n`, "utf8");
    await symlink(targetPath, policyPath);

    await assert.rejects(
      loadCuaDriverRuntimeTrustPolicy({ resourcesPath: root, platform: "win32" }),
      (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "path_invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader rejects relative roots, non-files, malformed JSON, and invalid size bounds", async () => {
  await assert.rejects(
    loadCuaDriverRuntimeTrustPolicy({ resourcesPath: "relative/resources", platform: "win32" }),
    (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "path_invalid",
  );

  const root = await mkdtemp(join(tmpdir(), "ling-cua-runtime-policy-invalid-"));
  try {
    const policyPath = join(root, ...CUA_DRIVER_RUNTIME_TRUST_POLICY_RESOURCE_SEGMENTS);
    await mkdir(policyPath, { recursive: true });
    await assert.rejects(
      loadCuaDriverRuntimeTrustPolicy({ resourcesPath: root, platform: "win32" }),
      (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "path_invalid",
    );

    await rm(policyPath, { recursive: true, force: true });
    await writeFile(policyPath, "{not-json", "utf8");
    await assert.rejects(
      loadCuaDriverRuntimeTrustPolicy({ resourcesPath: root, platform: "win32" }),
      (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "json_invalid",
    );
    for (const maxBytes of [0, -1, 1.5, 1024 * 1024 + 1]) {
      await assert.rejects(
        loadCuaDriverRuntimeTrustPolicy({ resourcesPath: root, platform: "win32", maxBytes }),
        schemaFailure,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loader rejects an intermediate directory symlink that escapes resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-runtime-policy-escape-"));
  try {
    const resourcesPath = join(root, "resources");
    const outsideProviders = join(root, "outside-providers");
    const outsidePolicy = join(outsideProviders, "cua-driver", "runtime-trust-policy.json");
    await mkdir(resourcesPath, { recursive: true });
    await mkdir(join(outsidePolicy, ".."), { recursive: true });
    await writeFile(outsidePolicy, `${JSON.stringify(internalWindowsPolicy())}\n`, "utf8");
    await symlink(outsideProviders, join(resourcesPath, "providers"));

    await assert.rejects(
      loadCuaDriverRuntimeTrustPolicy({ resourcesPath, platform: "win32" }),
      (error) => error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "path_escape",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function internalWindowsPolicy() {
  return {
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    platform: "win32",
    signingPolicy: {
      signingTier: "test_signed_internal",
      distributionChannel: "internal",
      providerSigner: {
        subject: "CN=Ling Stack Internal Test",
        certificateSha256: CERTIFICATE_SHA,
      },
      catalogSigner: {
        subject: "CN=Ling Stack Internal Test",
        certificateSha256: CERTIFICATE_SHA,
      },
      catalogTimestampStatus: "NotRequired",
    },
  };
}

function schemaFailure(error) {
  return error instanceof CuaDriverRuntimeTrustPolicyError && error.policyCode === "schema_invalid";
}

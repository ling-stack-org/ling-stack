import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CuaDriverPackageRuntimePolicyError,
  createCuaDriverPackageAuthorityDocuments,
  packageAuthorityInputFromEnvironment,
  writeCuaDriverPackageAuthorityFiles,
} from "../scripts/cua-driver-package-runtime-policy.mjs";

const SHA = "a".repeat(64);

test("package authority emits exact Darwin capability and trust-policy documents", () => {
  const value = createCuaDriverPackageAuthorityDocuments({
    platform: "darwin",
    signingProfile: { signingTier: "production_signed" },
    expectedTeamId: "ABCDEFGHIJ",
  });
  assert.deepEqual(value.capabilities, {
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    resourcesValidated: true,
    darwin: true,
    win32: false,
  });
  assert.deepEqual(value.runtimeTrustPolicy, {
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    platform: "darwin",
    expectedTeamId: "ABCDEFGHIJ",
  });
});

test("package authority keeps Windows signing tiers and signer identities exact", () => {
  const unsigned = createCuaDriverPackageAuthorityDocuments({
    platform: "win32-x64",
    signingProfile: { signingTier: "unsigned_dev" },
  });
  assert.deepEqual(unsigned.runtimeTrustPolicy.signingPolicy, {
    signingTier: "unsigned_dev",
    distributionChannel: "development",
  });

  const internal = createCuaDriverPackageAuthorityDocuments({
    platform: "win32-x64",
    signingProfile: { signingTier: "test_signed_internal" },
    providerSigner: { subject: "CN=Internal", certificateSha256: SHA },
    catalogSigner: { subject: "CN=Catalog", certificateSha256: "b".repeat(64) },
  });
  assert.equal(internal.runtimeTrustPolicy.signingPolicy.signingTier, "test_signed_internal");
  assert.equal(internal.runtimeTrustPolicy.signingPolicy.catalogTimestampStatus, "NotRequired");
  assert.equal(internal.capabilities.win32, true);

  assert.throws(
    () => createCuaDriverPackageAuthorityDocuments({
      platform: "win32-x64",
      signingProfile: { signingTier: "production_signed" },
      providerSigner: { subject: "CN=Production", certificateSha256: SHA },
      catalogSigner: { subject: "CN=Catalog", certificateSha256: SHA },
      catalogTimestampStatus: "NotRequired",
    }),
    (error) => error instanceof CuaDriverPackageRuntimePolicyError
      && error.code === "catalog_timestamp_status_invalid",
  );
});

test("fixture signer environment derives the same internal runtime policy identity", () => {
  const input = packageAuthorityInputFromEnvironment("win32-x64", {
    LING_CUA_SIGNING_TIER: "test_signed_internal",
    LING_CUA_DISTRIBUTION_CHANNEL: "internal",
    LING_CUA_SIGNING_FIXTURE: "1",
    LING_CUA_FIXTURE_SIGNER_SUBJECT: "CN=Fixture",
  });
  assert.equal(input.providerSigner.subject, "CN=Fixture");
  assert.equal(input.providerSigner.certificateSha256, input.catalogSigner.certificateSha256);
  assert.match(input.providerSigner.certificateSha256, /^[a-f0-9]{64}$/u);
});

test("package authority writes both files exclusively under one owned root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-package-authority-"));
  try {
    const written = await writeCuaDriverPackageAuthorityFiles({
      outputRoot: root,
      platform: "win32-x64",
      signingProfile: { signingTier: "unsigned_dev" },
    });
    assert.equal(JSON.parse(await readFile(written.capabilitiesPath, "utf8")).win32, true);
    assert.equal(
      JSON.parse(await readFile(written.runtimeTrustPolicyPath, "utf8")).signingPolicy.signingTier,
      "unsigned_dev",
    );
    await assert.rejects(
      writeCuaDriverPackageAuthorityFiles({
        outputRoot: root,
        platform: "win32-x64",
        signingProfile: { signingTier: "unsigned_dev" },
      }),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package authority rejects incomplete or caller-shaped trust inputs", () => {
  for (const input of [
    { platform: "linux", signingProfile: { signingTier: "unsigned_dev" } },
    { platform: "darwin", signingProfile: { signingTier: "unsigned_dev" } },
    {
      platform: "win32-x64",
      signingProfile: { signingTier: "test_signed_internal" },
      providerSigner: { subject: " padded ", certificateSha256: SHA },
      catalogSigner: { subject: "CN=Catalog", certificateSha256: SHA },
    },
  ]) {
    assert.throws(() => createCuaDriverPackageAuthorityDocuments(input));
  }
});

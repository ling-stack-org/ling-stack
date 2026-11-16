import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lockedUseReleaseBuilderConfig, validatePreparedLockedUseRelease, verifyPackagedLockedUseAcceptance } from "../scripts/locked-use-release-build.ts";
import { sha256 } from "../scripts/locked-use-release-evidence.ts";

function fixture() {
  const authorityBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, platform: "darwin", nativeAcceptance: "passed",
    expectedTeamId: "ABCDE12345", expectedBuildManifestSha256: "a".repeat(64) }));
  const provenance = { schemaVersion: 1, architecture: process.arch, osBuild: "TEST1", team: "ABCDE12345",
    nativeBuildManifestSha256: "a".repeat(64), providerExecutableSha256: "b".repeat(64),
    providerCodeHash: "01".repeat(20), checklistSha256: "c".repeat(64), nativeReportSha256: "d".repeat(64),
    releaseAuthoritySha256: sha256(authorityBytes), accepted: true };
  const provenanceBytes = Buffer.from(JSON.stringify(provenance));
  return { authorityBytes, provenance, provenanceBytes };
}

test("release resources enter only the production provider pipeline and keep both metadata pins", async (t) => {
  assert.deepEqual(await lockedUseReleaseBuilderConfig({ signingTier: "unsigned_dev", providerExpected: false }), {});
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-release-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = fixture();
  await writeFile(join(root, "release-authority.json"), input.authorityBytes);
  await writeFile(join(root, "acceptance-provenance.json"), input.provenanceBytes);
  for (const lane of [{ signingTier: "unsigned_dev", providerExpected: true },
    { signingTier: "test_signed_internal", providerExpected: true },
    { signingTier: "production_signed", providerExpected: false }]) {
    await assert.rejects(lockedUseReleaseBuilderConfig({ ...lane, releaseRoot: root }), /production_provider_package/u);
  }
  const config = await lockedUseReleaseBuilderConfig({ releaseRoot: root, signingTier: "production_signed", providerExpected: true });
  assert.deepEqual(config.extraMetadata, {
    lingLockedUseReleaseAuthoritySha256: sha256(input.authorityBytes), lingLockedUseAcceptanceSha256: sha256(input.provenanceBytes),
  });
  assert.deepEqual(config.extraResources?.map((resource) => resource.to),
    ["locked-use/release-authority.json", "locked-use/acceptance-provenance.json"]);
  verifyPackagedLockedUseAcceptance({ ...input, metadata: config.extraMetadata, observedProviderCodeHash: input.provenance.providerCodeHash });
  assert.throws(() => verifyPackagedLockedUseAcceptance({ ...input, metadata: config.extraMetadata, observedProviderCodeHash: "02".repeat(20) }), /acceptance_mismatch/u);
  assert.throws(() => verifyPackagedLockedUseAcceptance({ ...input, metadata: {}, observedProviderCodeHash: input.provenance.providerCodeHash }), /acceptance_mismatch/u);

  const packageAuthority = { schemaVersion: 1, componentId: "cua-driver", distributionRevision: "0.8.3-ling.1",
    providerExpected: true, platform: "darwin", signingTier: "production_signed", distributionChannel: "production",
    capabilitiesSha256: "a".repeat(64), runtimeTrustPolicySha256: "b".repeat(64) };
  const module = new URL("../scripts/cua-driver-electron-builder.config.mjs", import.meta.url).href;
  const inspected = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import config from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify({ extraMetadata:config.extraMetadata, extraResources:config.extraResources,
      mac:config.mac, electronFuses:config.electronFuses, afterSign:config.afterSign }));
  `], { encoding: "utf8", env: { ...process.env,
    LING_CUA_DRIVER_PACKAGE_PROVIDER: "1", LING_CUA_PACKAGE_RESOURCES_ROOT: root,
    LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(packageAuthority),
    LING_CUA_SIGNING_TIER: "production_signed", LING_CUA_DISTRIBUTION_CHANNEL: "production",
    LING_LOCKED_USE_RELEASE_ROOT: root,
  } });
  assert.equal(inspected.status, 0, inspected.stderr);
  const integrated = JSON.parse(inspected.stdout);
  assert.deepEqual(integrated.extraMetadata.lingCuaDriverPackageAuthority, packageAuthority);
  assert.equal(integrated.extraMetadata.lingLockedUseReleaseAuthoritySha256, sha256(input.authorityBytes));
  assert.equal(integrated.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(integrated.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(integrated.mac.hardenedRuntime, true);
  assert.equal(integrated.mac.sign, "./scripts/cua-driver-signing/electron-builder-mac-sign.mjs");
  assert.equal(integrated.afterSign, "./scripts/after-sign.mjs");
  assert.ok(integrated.extraResources.some((resource: { to: string }) => resource.to === "providers/cua-driver"));
  assert.ok(integrated.extraResources.some((resource: { to: string }) => resource.to === "locked-use/release-authority.json"));
});

test("stale, cross-build and altered acceptance records cannot enter a signed package", () => {
  for (const mutation of [{ accepted: false }, { architecture: "unsupported" }, { team: "OTHER12345" },
    { nativeBuildManifestSha256: "e".repeat(64) }, { releaseAuthoritySha256: "f".repeat(64) },
    { providerCodeHash: "not-a-code-hash" }]) {
    const input = fixture();
    assert.throws(() => validatePreparedLockedUseRelease(input.authorityBytes,
      Buffer.from(JSON.stringify({ ...input.provenance, ...mutation }))), /preparation_invalid/u);
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLockedUseValidationFixturePath, lockedUseValidationBuilderConfig, verifyPackagedLockedUseValidation } from "../scripts/locked-use-validation-build.ts";
import { sha256 } from "../scripts/locked-use-release-evidence.ts";
import { parseLockedUseValidationCandidate, LOCKED_USE_VALIDATION_ENTRY, LOCKED_USE_VALIDATION_FIXTURE,
  LOCKED_USE_VALIDATION_FIXTURE_BINARY } from "../shared/locked-use-validation-contract.ts";
import { loadPackagedDarwinLockedUseBackend } from "../dist/main/locked-computer-control/packaged-release-authority.js";

test("candidate schema carries unaccepted build pins and rejects acceptance or unknown fields", () => {
  const candidate = { schemaVersion: 1, kind: "attended_candidate", platform: "darwin", architecture: "arm64", osBuild: "TEST1",
    expectedTeamId: "ABCDE12345", expectedBuildManifestSha256: "a".repeat(64), providerCodeHash: "b".repeat(40), fixtureExecutableSha256: "c".repeat(64) };
  assert.equal(Object.isFrozen(parseLockedUseValidationCandidate(candidate)), true);
  for (const mutation of [{ nativeAcceptance: "passed" }, { architecture: "x64" }, { expectedTeamId: "0000000000" },
    { providerCodeHash: "invalid" }, { kind: "production" }]) {
    assert.throws(() => parseLockedUseValidationCandidate({ ...candidate, ...mutation }), /candidate_invalid/u);
  }
});

test("presigned fixture exclusion is limited to the fixed candidate bundle", () => {
  const root = "/tmp/Ling Stack.app";
  for (const path of [root + "/Contents/Resources/locked-use/Locked Use Validation.app",
    "Resources/locked-use/Locked Use Validation.app/Contents/MacOS/LingLockedUseFixture",
    "Contents/Resources/locked-use/Locked Use Validation.app"]) {
    assert.equal(isLockedUseValidationFixturePath(path, root), true);
  }
  for (const path of ["Contents/MacOS/Ling Stack", "Resources/locked-use/Locked Use Validation.app.evil",
    "/tmp/other.app/Contents/Resources/locked-use/Locked Use Validation.app"]) {
    assert.equal(isLockedUseValidationFixturePath(path, root), false);
  }
});

test("candidate packaging selects a separate main and cannot coexist with release authority", async t => {
  const root = await mkdtemp(join(tmpdir(), "ling-locked-use-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixturePath = join(root, LOCKED_USE_VALIDATION_FIXTURE, "Contents/MacOS");
  await mkdir(fixturePath, { recursive: true });
  const fixtureBytes = Buffer.from("fixture executable");
  await writeFile(join(fixturePath, LOCKED_USE_VALIDATION_FIXTURE_BINARY), fixtureBytes);
  const candidate = { schemaVersion: 1, kind: "attended_candidate", platform: "darwin", architecture: "arm64", osBuild: "TEST1",
    expectedTeamId: "ABCDE12345", expectedBuildManifestSha256: "a".repeat(64), providerCodeHash: "b".repeat(40), fixtureExecutableSha256: sha256(fixtureBytes) };
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  await writeFile(join(root, "validation-candidate.json"), candidateBytes);
  assert.deepEqual(await lockedUseValidationBuilderConfig({ signingTier: "unsigned_dev", providerExpected: false }), {});
  for (const lane of [{ signingTier: "unsigned_dev", providerExpected: true },
    { signingTier: "test_signed_internal", providerExpected: true }, { signingTier: "production_signed", providerExpected: false },
    { signingTier: "production_signed", providerExpected: true, releaseRoot: root }]) {
    await assert.rejects(lockedUseValidationBuilderConfig({ candidateRoot: root, ...lane }), /separate_production_provider_candidate/u);
  }
  if (process.arch !== "arm64") {
    await assert.rejects(lockedUseValidationBuilderConfig({ candidateRoot: root, signingTier: "production_signed", providerExpected: true }), /architecture_mismatch/u);
    return;
  }
  const config = await lockedUseValidationBuilderConfig({ candidateRoot: root, signingTier: "production_signed", providerExpected: true });
  assert.deepEqual(config.extraMetadata, { main: LOCKED_USE_VALIDATION_ENTRY, lingLockedUseValidationCandidateSha256: sha256(candidateBytes) });
  verifyPackagedLockedUseValidation({ metadata: config.extraMetadata, candidateBytes,
    observedProviderCodeHash: candidate.providerCodeHash, observedFixtureSha256: candidate.fixtureExecutableSha256 });
  for (const metadata of [{ ...config.extraMetadata, main: "./dist/main/entry.js" },
    { ...config.extraMetadata, lingLockedUseReleaseAuthoritySha256: "d".repeat(64) }]) {
    assert.throws(() => verifyPackagedLockedUseValidation({ metadata, candidateBytes,
      observedProviderCodeHash: candidate.providerCodeHash, observedFixtureSha256: candidate.fixtureExecutableSha256 }), /validation_mismatch/u);
  }
  await writeFile(join(root, "package.json"), JSON.stringify(config.extraMetadata));
  let loaded = false;
  const backend = await loadPackagedDarwinLockedUseBackend({ packaged: true, platform: "darwin", appPath: root, resourcesRoot: root },
    { async loadBackend() { loaded = true; return undefined; } });
  assert.equal(backend, undefined); assert.equal(loaded, false);
  const packageAuthority = { schemaVersion: 1, componentId: "cua-driver", distributionRevision: "0.8.3-ling.1",
    providerExpected: true, platform: "darwin", signingTier: "production_signed", distributionChannel: "production",
    capabilitiesSha256: "a".repeat(64), runtimeTrustPolicySha256: "b".repeat(64) };
  const module = new URL("../scripts/cua-driver-electron-builder.config.mjs", import.meta.url).href;
  const environment = { ...process.env, LING_CUA_DRIVER_PACKAGE_PROVIDER: "1", LING_CUA_PACKAGE_RESOURCES_ROOT: root,
    LING_CUA_PACKAGE_HOST_AUTHORITY_JSON: JSON.stringify(packageAuthority), LING_CUA_SIGNING_TIER: "production_signed",
    LING_CUA_DISTRIBUTION_CHANNEL: "production", LING_LOCKED_USE_VALIDATION_ROOT: root };
  delete (environment as NodeJS.ProcessEnv).LING_LOCKED_USE_RELEASE_ROOT;
  const inspected = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import config from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify(config));
  `], { encoding: "utf8", env: environment });
  assert.equal(inspected.status, 0, inspected.stderr);
  const integrated = JSON.parse(inspected.stdout);
  assert.equal(integrated.extraMetadata.main, LOCKED_USE_VALIDATION_ENTRY);
  assert.equal(integrated.extraMetadata.lingLockedUseReleaseAuthoritySha256, undefined);
  assert.equal(integrated.electronFuses.enableEmbeddedAsarIntegrityValidation, true);
  assert.equal(integrated.electronFuses.onlyLoadAppFromAsar, true);
  assert.equal(integrated.mac.sign, "./scripts/cua-driver-signing/electron-builder-mac-sign.mjs");
  assert.equal(integrated.afterSign, "./scripts/after-sign.mjs");
});

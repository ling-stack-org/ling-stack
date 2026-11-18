import assert from "node:assert/strict";
import test from "node:test";
import { LOCKED_USE_ACCEPTANCE_CASES, LOCKED_USE_COMPONENTS, sha256, validateLockedUseReleaseEvidence } from "../scripts/locked-use-release-evidence.ts";

function fixture() {
  const hash = "a".repeat(64), codeHash = "01".repeat(20);
  const artifactSha256 = Object.fromEntries(Object.keys(LOCKED_USE_COMPONENTS).map((path) => [path, hash]));
  const manifest = {
    schemaVersion: 1, platform: "darwin", architecture: process.arch, team: "ABCDE12345", signing: "local_identity",
    productCapability: "disabled_by_build", nativeAcceptance: "not_run", upstreamCommit: "a".repeat(40),
    checks: { policy: "passed", authorizationPluginABI: "passed", kernelTaskVerifier: "identity_passed", xctest: "separate" },
    artifacts: artifactSha256,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const componentCodeHashes = { brokerHash: codeHash, guardianHash: codeHash, pluginHash: codeHash, clientHash: codeHash };
  const report = {
    schemaVersion: 2, leaseID: "12345678-1234-1234-1234-123456789012",
    evidence: { osBuild: "TEST1", ...componentCodeHashes }, ownerToken: Buffer.alloc(32, 1).toString("base64"),
    ownerCodeHash: Buffer.from(codeHash, "hex").toString("base64"), guiAndKeychainPassed: true,
    lockedAndReleased: true, afterManualUnlockPassed: true,
  };
  const checklist = {
    schemaVersion: 1, platform: "darwin", osBuild: "TEST1", team: manifest.team,
    nativeBuildManifestSha256: sha256(manifestBytes), providerExecutableSha256: hash,
    reviewer: "Release reviewer", reviewedAt: "2026-01-01T00:00:00.000Z",
    cases: Object.fromEntries(LOCKED_USE_ACCEPTANCE_CASES.map((name) =>
      [name, { result: "passed", evidencePath: name + ".log", evidenceSha256: hash }])),
  };
  const observed = { osBuild: "TEST1", team: manifest.team, providerSha256: hash, artifactSha256, componentCodeHashes };
  return { manifest, manifestBytes, report, checklist, observed };
}

test("release authority requires exact signed-build observations and separately reviewed physical evidence", () => {
  const input = fixture();
  const authority = JSON.parse(validateLockedUseReleaseEvidence(input).toString("utf8"));
  assert.deepEqual(authority, { schemaVersion: 1, platform: "darwin", nativeAcceptance: "passed",
    expectedTeamId: input.observed.team, expectedBuildManifestSha256: sha256(input.manifestBytes) });
  assert.equal(input.manifest.productCapability, "disabled_by_build");
  assert.equal(input.manifest.nativeAcceptance, "not_run");
});

test("source builds, stale native reports and missing physical cases cannot produce release authority", () => {
  const mutations = [
    (input: ReturnType<typeof fixture>) => { input.manifest.signing = "adhoc"; },
    (input: ReturnType<typeof fixture>) => {
      input.manifest.signing = "development_validation";
      input.manifest.checks.kernelTaskVerifier = "development_identity_passed";
    },
    (input: ReturnType<typeof fixture>) => { input.manifest.checks.kernelTaskVerifier = "denial_passed"; },
    (input: ReturnType<typeof fixture>) => { input.observed.osBuild = "OTHER"; },
    (input: ReturnType<typeof fixture>) => { input.report.evidence.clientHash = "02".repeat(20); },
    (input: ReturnType<typeof fixture>) => { input.report.ownerCodeHash = Buffer.alloc(20, 2).toString("base64"); },
    (input: ReturnType<typeof fixture>) => { input.report.lockedAndReleased = false; },
    (input: ReturnType<typeof fixture>) => { input.report.afterManualUnlockPassed = false; },
    (input: ReturnType<typeof fixture>) => { input.checklist.providerExecutableSha256 = "b".repeat(64); },
    (input: ReturnType<typeof fixture>) => { input.checklist.nativeBuildManifestSha256 = "b".repeat(64); },
    (input: ReturnType<typeof fixture>) => { input.checklist.reviewer = ""; },
    (input: ReturnType<typeof fixture>) => { input.checklist.cases.helper_exit!.result = "not_run"; },
    (input: ReturnType<typeof fixture>) => { delete input.checklist.cases.secure_surface_denied; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    assert.throws(() => validateLockedUseReleaseEvidence(input), /locked_use_release_/u);
  }
});

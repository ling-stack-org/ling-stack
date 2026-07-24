#!/usr/bin/env node

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_RESOURCE_ROOT,
  artifactDigestMap,
  sha256File,
  verifySourceBuildArtifactInventory,
  verifyProviderInputs,
} from "./cua-driver-source-build-lib.mjs";
import { runOwnedProcess } from "./cua-driver-owned-process.mjs";
import {
  inspectArm64MachO,
  inspectWindowsPe,
  verifyVersionOutput,
} from "./cua-driver-binary-identity.mjs";
import { verifyReferenceArtifactEvidence } from "./cua-driver-reference-artifacts.mjs";
import {
  readBoundedFileSnapshot,
  readBoundedJsonSnapshot,
} from "./cua-driver-package-staging-files.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_BUILD_JSON_MAX_BYTES = 8 * 1024 * 1024;
const SOURCE_BUILD_BINARY_MAX_BYTES = 128 * 1024 * 1024;
const SOURCE_BUILD_VERSION_TIMEOUT_MS = 15_000;
const SOURCE_BUILD_VERSION_MAX_BYTES = 64 * 1024;

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

async function main() {
const args = parseArgs(process.argv.slice(2));
const stagingExpectation = parseStagingExpectation(args);
if (stagingExpectation && !args.attestation) {
  fail("staging expectation requires --attestation");
}
const resourceRoot = resolve(args["resource-root"] || PROVIDER_RESOURCE_ROOT);
const verified = await verifyProviderInputs(resourceRoot);
if (args["attestation"]) {
  const attestationSnapshot = await readBoundedJsonSnapshot(
    resolve(args.attestation),
    SOURCE_BUILD_JSON_MAX_BYTES,
    "source_build_attestation",
  );
  const attestation = attestationSnapshot.value;
  verifyAttestationShape(attestation, verified.lock);
  if (!/^(darwin|win32-x64)$/u.test(attestation.platform ?? "")) fail("attestation platform mismatch");
  if (stagingExpectation?.platform !== undefined
    && attestation.platform !== stagingExpectation.platform) {
    fail("attestation platform does not match the staging expectation");
  }
  if (attestation.sourceDateEpoch !== verified.lock.upstream.sourceDateEpoch) fail("attestation source date epoch mismatch");
  if (!SHA256_PATTERN.test(attestation.checks.cargoMetadataSha256)) fail("cargo metadata digest is not a SHA-256");
  if (attestation.providerLockSha256 !== await sha256File(verified.lockPath)) fail("attestation provider lock digest mismatch");
  if (attestation.sourceBuildInputsSha256 !== await sha256File(verified.sourceInputsPath)) fail("attestation source inputs digest mismatch");
  if (attestation.patchSetSha256 !== verified.seriesSha256) fail("attestation patch digest mismatch");
  if (attestation.upstreamCommit !== verified.lock.upstream.commit) fail("attestation commit mismatch");
  if (attestation.upstreamTree !== verified.lock.upstream.tree) fail("attestation tree mismatch");
  if (attestation.packagingEligible !== false) fail("pre-sign attestation cannot claim packaging eligibility");
  if (attestation.signingState !== "pre-sign-only") fail("pre-sign attestation signing state mismatch");
  const toolchainKey = attestation.platform === "darwin" ? "darwin" : "win32X64";
  if (JSON.stringify(attestation.toolchain) !== JSON.stringify(verified.lock.toolchain[toolchainKey])) {
    fail("attestation toolchain lock mismatch");
  }
  verifyObservedToolchain(attestation.platform, attestation.checks?.toolchain, verified.lock);
  const expectedRustfmtPaths = verified.series.rustfmtPaths;
  if (
    attestation.checks?.rustfmt?.status !== "passed"
    || attestation.checks.rustfmt.scope !== "new-rust-files"
    || JSON.stringify(attestation.checks.rustfmt.paths) !== JSON.stringify(expectedRustfmtPaths)
  ) {
    fail("new-file rustfmt check was not recorded as passed");
  }
  if (attestation.checks?.cargoTests?.status !== "passed") fail("cargo test status was not recorded as passed");
  const runtimeProbe = verifyRuntimeProbe(
    attestation.platform,
    attestation.checks?.runtimeProbe,
    verified.lock,
  );
  try {
    const referenceKey = attestation.platform === "darwin" ? "darwin" : "win32X64";
    verifyReferenceArtifactEvidence({
      platform: attestation.platform,
      reference: verified.lock.referenceArtifacts[referenceKey],
      evidence: attestation.checks?.referenceArtifact,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const outputRoot = resolve(args["output-root"] || dirname(resolve(args.attestation)));
  const actual = await artifactDigestMap(outputRoot);
  if (Object.keys(actual).some((path) => path.startsWith(".git/") || path === ".git")) fail("source-build output must not contain a git repository");
  if (Object.keys(actual).some((path) => path.includes("cua-driver-rs-0.8.3-"))) fail("upstream reference archive must never enter output");
  if (Object.keys(actual).some((path) => path.endsWith("provider-seal.json"))) fail("pre-sign source build must not fabricate a provider seal");
  const manifestPath = resolve(outputRoot, "source-build-manifest.json");
  const manifestSnapshot = await readBoundedJsonSnapshot(
    manifestPath,
    SOURCE_BUILD_JSON_MAX_BYTES,
    "source_build_manifest",
  );
  const manifest = manifestSnapshot.value;
  if (manifest.schemaVersion !== 1 || manifest.kind !== "ling.cua-driver.source-build-manifest") fail("source-build manifest schema mismatch");
  verifyOutputMetadataBindings({ actual, attestation, manifest });
  if (JSON.stringify(manifest.files) !== JSON.stringify(actual)) fail("source-build manifest digest map mismatch");
  if (attestation.manifestSha256 !== manifestSnapshot.sha256) fail("source-build manifest digest mismatch");
  const promotionPath = resolve(outputRoot, "source-build-promotion-inputs.json");
  const promotionSnapshot = await readBoundedJsonSnapshot(
    promotionPath,
    SOURCE_BUILD_JSON_MAX_BYTES,
    "source_build_promotion_inputs",
  );
  const promotion = promotionSnapshot.value;
  try {
    verifySourceBuildArtifactInventory({
      artifactPaths: Object.keys(actual),
      binaries: attestation.binaries,
      platform: attestation.platform,
      promotionBinaries: promotion.providerSealInputs?.binaries,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const mainRelativePath = attestation.platform === "darwin"
    ? "darwin/ling-cua-driver"
    : "win32-x64/payload/ling-cua-driver.exe";
  const binarySnapshots = await readBuiltBinarySnapshots({
    actual,
    platform: attestation.platform,
    outputRoot,
  });
  if (stagingExpectation) {
    bindExpectedProviderSnapshot({
      expectedProviderSha256: stagingExpectation.providerSha256,
      relativePath: mainRelativePath,
      snapshot: binarySnapshots[mainRelativePath],
    });
  }
  const observedBinaryIdentity = inspectBuiltBinaryIdentity({
    binarySnapshots,
    platform: attestation.platform,
    lock: verified.lock,
  });
  if (JSON.stringify(attestation.checks?.binaryIdentity) !== JSON.stringify(observedBinaryIdentity)) fail("attestation binary identity mismatch");
  if (JSON.stringify(promotion.sourceBuild?.binaryIdentity) !== JSON.stringify(observedBinaryIdentity)) fail("promotion binary identity mismatch");
  const observedVersion = await resolveObservedProviderVersion({
    attestationVersionOutput: attestation.checks?.versionOutput,
    executablePath: resolve(outputRoot, mainRelativePath),
    expectedVersion: verified.lock.upstream.version,
    stagingExpected: stagingExpectation !== undefined,
  });
  verifyPromotionBindings({
    attestation,
    lock: verified.lock,
    observedBinaryIdentity,
    observedVersion,
    promotion,
    runtimeProbe,
    verified,
  });
  if (attestation.promotionInputsSha256 !== promotionSnapshot.sha256) fail("promotion input digest mismatch");
  for (const binary of attestation.binaries) {
    const observed = actual[binary.relativePath];
    if (!SHA256_PATTERN.test(binary.sha256BeforeSigning)) fail(`binary digest is not a SHA-256: ${binary.relativePath}`);
    if (!observed || observed !== binary.sha256BeforeSigning) fail(`binary digest mismatch: ${binary.relativePath}`);
    if (binary.role === "uia-audit" && binary.packaged !== false) fail("UIAccess audit binary cannot be packaged");
  }
  if (actual["cua-driver.spdx.json"] !== attestation.supplyChain.sbomSha256) fail("SBOM digest mismatch");
  if (actual["THIRD_PARTY_NOTICES.md"] !== attestation.supplyChain.noticesSha256) fail("notices digest mismatch");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    attestation: resolve(args.attestation),
    attestationSha256: attestationSnapshot.sha256,
    manifestSha256: manifestSnapshot.sha256,
    platform: attestation.platform,
    promotionInputsSha256: promotionSnapshot.sha256,
    files: actual,
  }, null, 2)}\n`);
  process.exit(0);
}
if (args["compare-a"] || args["compare-b"]) {
  if (!args["compare-a"] || !args["compare-b"]) fail("--compare-a and --compare-b must be supplied together");
  const left = await artifactDigestMap(resolve(args["compare-a"]));
  const right = await artifactDigestMap(resolve(args["compare-b"]));
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`repeated-build digest mismatch\nleft=${JSON.stringify(left)}\nright=${JSON.stringify(right)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, equal: true, files: Object.keys(left).length }, null, 2)}\n`);
  process.exit(0);
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  upstream: verified.lock.upstream,
  patchSetSha256: verified.seriesSha256,
  packagingEligible: verified.lock.packagingGate.eligible,
}, null, 2)}\n`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function parseStagingExpectation(args) {
  const platform = args["expected-platform"];
  const providerSha256 = args["expected-provider-sha256"];
  if (platform === undefined && providerSha256 === undefined) {
    return undefined;
  }
  if (platform === undefined || providerSha256 === undefined) {
    fail("staging expected platform and provider digest must be supplied together");
  }
  if (platform !== "darwin" && platform !== "win32-x64") {
    fail("staging expected platform is invalid");
  }
  if (!SHA256_PATTERN.test(providerSha256) || /^0{64}$/u.test(providerSha256)) {
    fail("staging expected provider digest is not a SHA-256");
  }
  return Object.freeze({ platform, providerSha256 });
}

function verifyObservedToolchain(platform, evidence, lock) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    fail("observed toolchain evidence is missing");
  }
  if (platform === "darwin") {
    const pin = lock.toolchain.darwin;
    if (
      evidence.xcodeVersion !== pin.xcodeVersion
      || evidence.xcodeBuildVersion !== pin.xcodeBuildVersion
      || evidence.macOSSDKVersion !== pin.macOSSDKVersion
      || evidence.developerDir !== pin.developerDir
      || evidence.codesignPath !== pin.postLinkIdentityNormalization.codesignPath
    ) {
      fail("observed macOS toolchain does not match the lock");
    }
    assertAbsoluteEvidencePaths(evidence, ["developerDir", "sdkPath", "clangPath", "codesignPath", "lipoPath"]);
    return;
  }
  const pin = lock.toolchain.win32X64;
  if (
    evidence.visualStudioVersion !== pin.visualStudioVersion
    || evidence.msvcToolsetVersion !== pin.msvcToolsetVersion
    || evidence.windowsSdkVersion !== pin.windowsSdkVersion
  ) {
    fail("observed Windows toolchain does not match the lock");
  }
  assertAbsoluteEvidencePaths(evidence, ["installationPath", "clPath", "linkPath", "rcPath"]);
}

export function verifyAttestationShape(attestation, lock) {
  if (attestation?.schemaVersion !== 2 || attestation?.kind !== "ling.cua-driver.source-build-attestation") {
    fail("source-build attestation schema mismatch");
  }
  assertExactKeys(attestation, [
    "binaries",
    "checks",
    "kind",
    "manifestSha256",
    "packagingEligible",
    "patchSetSha256",
    "platform",
    "promotionInputsSha256",
    "providerLockSha256",
    "schemaVersion",
    "signingState",
    "sourceBuildInputsSha256",
    "sourceDateEpoch",
    "supplyChain",
    "toolchain",
    "upstreamCommit",
    "upstreamTree",
  ], "source-build attestation");
  assertExactKeys(attestation.checks, [
    "binaryIdentity",
    "cargoMetadataSha256",
    "cargoTests",
    "machOIdentityNormalization",
    "referenceArtifact",
    "rustfmt",
    "runtimeProbe",
    "swiftArchiveNormalization",
    "toolchain",
    "versionOutput",
  ], "source-build attestation checks");
  assertExactKeys(attestation.supplyChain, ["noticesSha256", "sbomSha256"], "source-build attestation supply chain");
  assertExactKeys(attestation.checks.cargoTests, ["packages", "status"], "source-build cargo tests");
  assertExactKeys(attestation.checks.rustfmt, ["paths", "scope", "status"], "source-build rustfmt");
  verifySwiftArchiveNormalization(attestation.platform, attestation.checks.swiftArchiveNormalization);
  verifyMachOIdentityNormalization(
    attestation.platform,
    attestation.checks.machOIdentityNormalization,
    lock,
  );
  return true;
}

function verifyMachOIdentityNormalization(platform, evidence, lock) {
  if (platform === "win32-x64") {
    assertExactKeys(evidence, ["status"], "Mach-O identity normalization");
    if (evidence.status !== "not_applicable") {
      fail("Windows Mach-O identity normalization must be not applicable");
    }
    return;
  }
  const identityPin = lock?.toolchain?.darwin?.postLinkIdentityNormalization;
  const relinkPin = lock?.toolchain?.darwin?.swiftArchiveNormalization?.finalRelink;
  if (!identityPin || !relinkPin || relinkPin.strategy !== "bounded-canonical-source-identity-v1") {
    fail("canonical Mach-O identity policy is missing from the verified source inputs");
  }
  assertExactKeys(evidence, ["algorithm", "binaries", "status"], "Mach-O identity normalization");
  if (evidence.status !== "passed"
    || evidence.algorithm !== identityPin.algorithm
    || !Array.isArray(evidence.binaries)
    || JSON.stringify(evidence.binaries.map((entry) => entry?.target))
      !== JSON.stringify(["aarch64-apple-darwin"])) {
    fail("Mach-O identity normalization evidence mismatch");
  }
  for (const binary of evidence.binaries) {
    const targetPin = relinkPin.targets?.[binary.target];
    assertExactKeys(
      binary,
      ["adHocIdentifier", "relinkAttempts", "sha256", "sourceSha256", "target", "uuid"],
      "Mach-O identity normalization binary",
    );
    if (!targetPin
      || binary.adHocIdentifier !== identityPin.adHocIdentifier
      || !Number.isInteger(binary.relinkAttempts)
      || binary.relinkAttempts < 1
      || binary.relinkAttempts > targetPin.maxAttempts
      || !SHA256_PATTERN.test(binary.sha256)
      || binary.sourceSha256 !== targetPin.expectedSourceSha256
      || !/^[0-9A-F]{8}-[0-9A-F]{4}-3[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/u.test(binary.uuid)) {
      fail("Mach-O identity normalization binary evidence mismatch");
    }
  }
}

function verifySwiftArchiveNormalization(platform, evidence) {
  if (platform === "win32-x64") {
    assertExactKeys(evidence, ["status"], "Swift archive normalization");
    if (evidence.status !== "not_applicable") fail("Windows Swift archive normalization must be not applicable");
    return;
  }
  assertExactKeys(evidence, ["dwarfSegment", "section", "status", "targets"], "Swift archive normalization");
  if (evidence.status !== "passed"
    || evidence.section !== "__LLVM,__swift_modhash"
    || evidence.dwarfSegment !== "__DWARF") {
    fail("Swift archive normalization evidence mismatch");
  }
  const expectedTargets = ["aarch64-apple-darwin"];
  if (!Array.isArray(evidence.targets)
    || JSON.stringify(evidence.targets.map((entry) => entry?.target)) !== JSON.stringify(expectedTargets)) {
    fail("Swift archive normalization target inventory mismatch");
  }
  const expectedArchives = [
    { archive: "libapple_cf.rlib", machoMembers: 19, normalizedSections: 13, normalizedDwarfSections: 130 },
    { archive: "libscreencapturekit.rlib", machoMembers: 21, normalizedSections: 10, normalizedDwarfSections: 100 },
  ];
  for (const target of evidence.targets) {
    assertExactKeys(target, ["archives", "target"], "Swift archive normalization target");
    if (JSON.stringify(target.archives) !== JSON.stringify(expectedArchives)) {
      fail("Swift archive normalization member evidence mismatch");
    }
  }
}

export function verifyRuntimeProbe(platform, evidence, lock) {
  const expectedKeys = [
    "clientInitializeProtocolVersion",
    "healthCoreChecks",
    "healthProbeSkip",
    "healthSchemaVersion",
    "managedDeniedTools",
    "managedState",
    "platform",
    "serverInfo",
    "serverInitializeProtocolVersion",
    "stdinEof",
    "toolsListCanonicalSha256",
    ...(platform === "win32-x64" ? ["managedReadiness"] : []),
  ];
  assertExactKeys(evidence, expectedKeys, "runtime probe");
  if (evidence.platform !== platform) fail("runtime probe platform mismatch");
  if (evidence.clientInitializeProtocolVersion !== lock.compatibility.clientInitializeProtocolVersion) fail("MCP client initialize protocol mismatch");
  if (evidence.serverInitializeProtocolVersion !== lock.compatibility.serverInitializeProtocolVersion) fail("MCP server initialize protocol mismatch");
  assertExactKeys(evidence.serverInfo, ["name", "version"], "runtime probe server identity");
  if (evidence.serverInfo.name !== "cua-driver" || evidence.serverInfo.version !== lock.upstream.version) fail("runtime probe server identity mismatch");
  if (!SHA256_PATTERN.test(evidence.toolsListCanonicalSha256)) fail("runtime tools-list digest is not a SHA-256");
  if (evidence.healthSchemaVersion !== lock.compatibility.healthSchemaVersion) fail("health schema mismatch");
  if (JSON.stringify(evidence.healthProbeSkip) !== JSON.stringify(lock.runtime.healthProbeSkip)) fail("health skip list mismatch");
  if (JSON.stringify(evidence.managedDeniedTools) !== JSON.stringify(lock.runtime.managedDeniedTools)) fail("managed denied tools mismatch");
  if (JSON.stringify(evidence.healthCoreChecks) !== JSON.stringify({
    binaryVersion: "pass",
    platformSupported: "pass",
    sessionActive: "pass",
  })) fail("health core-check evidence mismatch");
  if (evidence.stdinEof !== "passed") fail("runtime stdin EOF probe was not recorded as passed");
  verifyManagedStateEvidence(platform, evidence.managedState);
  if (platform === "win32-x64") verifyManagedReadinessEvidence(evidence.managedReadiness);
  return evidence;
}

function verifyManagedReadinessEvidence(evidence) {
  const expected = {
    schemaVersion: 1,
    readinessSequence: 1,
    activeChildPidBound: true,
    childInstanceNonceBound: true,
    leaseGenerationBound: true,
    sameInteractiveSession: true,
    hostIntegrityLevel: "medium",
    providerIntegrityLevel: "medium",
    inputDesktop: "default_unlocked",
    jobObjectAssigned: true,
    killOnJobClose: true,
    uiaRuntime: "available",
    d3d11: "available",
    wgcApi: "supported",
    contentObserved: false,
  };
  if (JSON.stringify(evidence) !== JSON.stringify(expected)) fail("managed-readiness evidence mismatch");
}

export function stableRuntimeProbe(evidence, platform) {
  const stable = {
    platform: evidence.platform,
    clientInitializeProtocolVersion: evidence.clientInitializeProtocolVersion,
    serverInitializeProtocolVersion: evidence.serverInitializeProtocolVersion,
    serverInfo: evidence.serverInfo,
    toolsListCanonicalSha256: evidence.toolsListCanonicalSha256,
    healthSchemaVersion: evidence.healthSchemaVersion,
    healthProbeSkip: evidence.healthProbeSkip,
    healthCoreChecks: evidence.healthCoreChecks,
    managedDeniedTools: evidence.managedDeniedTools,
    stdinEof: evidence.stdinEof,
    managedState: evidence.managedState,
  };
  if (platform === "win32-x64") {
    const { readinessSequence: _readinessSequence, ...stableReadiness } = evidence.managedReadiness;
    stable.managedReadiness = stableReadiness;
  }
  return stable;
}

export function verifyOutputMetadataBindings({ actual, attestation, manifest }) {
  if (manifest.platform !== attestation.platform) fail("source-build manifest platform mismatch");
  if (actual["provider-lock.json"] !== attestation.providerLockSha256) fail("output provider lock digest mismatch");
  if (actual["source-build-inputs.json"] !== attestation.sourceBuildInputsSha256) fail("output source-build inputs digest mismatch");
  return true;
}

export function verifyPromotionBindings({
  attestation,
  lock,
  observedBinaryIdentity,
  observedVersion,
  promotion,
  runtimeProbe,
  verified,
}) {
  assertExactKeys(promotion, [
    "kind",
    "missingFinalIdentity",
    "platform",
    "promotionEligible",
    "providerLockSha256",
    "providerSealInputs",
    "runtimeProbe",
    "schemaVersion",
    "sourceBuild",
    "sourceBuildInputsSha256",
    "supplyChain",
  ], "promotion inputs");
  if (promotion.schemaVersion !== 1 || promotion.kind !== "ling.cua-driver.source-build-promotion-inputs") {
    fail("promotion input schema mismatch");
  }
  if (!verified?.sourceInputs || !verified?.series) fail("verified source-build inputs are required");
  if (promotion.promotionEligible !== false || promotion.platform !== attestation.platform) fail("promotion input gate mismatch");
  if (promotion.providerLockSha256 !== attestation.providerLockSha256) fail("promotion provider lock digest mismatch");
  if (promotion.sourceBuildInputsSha256 !== attestation.sourceBuildInputsSha256) fail("promotion source inputs digest mismatch");
  assertExactKeys(promotion.sourceBuild, [
    "binaryIdentity",
    "binariesSha256BeforeSigning",
    "cargoLockSha256",
    "cargoVersion",
    "clientInitializeProtocolVersion",
    "healthCoreChecks",
    "healthProbeSkip",
    "healthSchemaVersion",
    "managedDeniedTools",
    "patchSet",
    "rustcVersion",
    "serverInitializeProtocolVersion",
    "toolsListCanonicalSha256",
    "versionOutput",
  ], "promotion source-build");
  if (
    promotion.sourceBuild.cargoLockSha256 !== verified.sourceInputs.upstreamBuild.cargoLockSha256
    || promotion.sourceBuild.rustcVersion !== verified.sourceInputs.toolchain.rustcVersion
    || promotion.sourceBuild.cargoVersion !== verified.sourceInputs.toolchain.cargoVersion
  ) {
    fail("promotion toolchain bindings mismatch");
  }
  if (JSON.stringify(promotion.sourceBuild.patchSet) !== JSON.stringify({
    id: verified.series.id,
    sha256: verified.seriesSha256,
    patches: verified.series.patches,
    touchedPaths: verified.series.touchedPaths,
  })) {
    fail("promotion patch-set bindings mismatch");
  }
  if (JSON.stringify(attestation.checks?.binaryIdentity) !== JSON.stringify(observedBinaryIdentity)) fail("attestation binary identity mismatch");
  if (JSON.stringify(promotion.sourceBuild?.binaryIdentity) !== JSON.stringify(observedBinaryIdentity)) fail("promotion binary identity mismatch");
  if (attestation.checks?.versionOutput !== observedVersion || promotion.sourceBuild?.versionOutput !== observedVersion) fail("built provider version evidence mismatch");
  if (promotion.sourceBuild?.clientInitializeProtocolVersion !== lock.compatibility.clientInitializeProtocolVersion) fail("promotion MCP client protocol mismatch");
  if (promotion.sourceBuild?.serverInitializeProtocolVersion !== lock.compatibility.serverInitializeProtocolVersion) fail("promotion MCP server protocol mismatch");
  if (promotion.sourceBuild?.toolsListCanonicalSha256 !== runtimeProbe.toolsListCanonicalSha256) fail("promotion source-build tools digest mismatch");
  if (promotion.sourceBuild?.healthSchemaVersion !== runtimeProbe.healthSchemaVersion) fail("promotion source-build health schema mismatch");
  if (JSON.stringify(promotion.sourceBuild?.healthProbeSkip) !== JSON.stringify(runtimeProbe.healthProbeSkip)) fail("promotion source-build health skip mismatch");
  if (JSON.stringify(promotion.sourceBuild?.healthCoreChecks) !== JSON.stringify(runtimeProbe.healthCoreChecks)) fail("promotion source-build health checks mismatch");
  if (JSON.stringify(promotion.sourceBuild?.managedDeniedTools) !== JSON.stringify(runtimeProbe.managedDeniedTools)) fail("promotion source-build denied tools mismatch");
  const binaryDigestMap = Object.fromEntries(
    attestation.binaries.map((binary) => [binary.role, binary.sha256BeforeSigning]),
  );
  if (JSON.stringify(promotion.sourceBuild?.binariesSha256BeforeSigning) !== JSON.stringify(binaryDigestMap)) {
    fail("promotion pre-sign binary digest map mismatch");
  }
  verifyProviderSealInputs(attestation.platform, promotion.providerSealInputs, attestation, runtimeProbe, lock);
  if (JSON.stringify(promotion.runtimeProbe) !== JSON.stringify(stableRuntimeProbe(runtimeProbe, attestation.platform))) {
    fail("promotion runtime probe evidence mismatch");
  }
  assertExactKeys(promotion.supplyChain, ["noticesSha256", "sbomSha256"], "promotion supply chain");
  if (
    promotion.supplyChain.sbomSha256 !== attestation.supplyChain.sbomSha256
    || promotion.supplyChain.noticesSha256 !== attestation.supplyChain.noticesSha256
  ) {
    fail("promotion supply-chain bindings mismatch");
  }
  const expectedMissingFinalIdentity = attestation.platform === "darwin"
    ? ["cdhashes", "codeIdentifier", "teamId", "designatedRequirement", "entitlementsCanonicalSha256"]
    : ["authenticodeStatus", "providerSealSha256"];
  if (JSON.stringify(promotion.missingFinalIdentity) !== JSON.stringify(expectedMissingFinalIdentity)) {
    fail("promotion missing-final-identity bindings mismatch");
  }
  return true;
}

export function verifyProviderSealInputs(platform, evidence, attestation, runtimeProbe, lock) {
  const expectedKeys = [
    "binaries",
    "componentId",
    "distributionRevision",
    "healthSchemaVersion",
    "lockSha256",
    "providerVersion",
    "serverInitializeProtocolVersion",
    "stateSchemaVersion",
    "toolsListCanonicalSha256",
    ...(platform === "win32-x64" ? [
      "distributionChannel",
      "integrityCatalogRelativePath",
      "limitations",
      "productionEligible",
      "signingTier",
    ] : []),
  ];
  assertExactKeys(evidence, expectedKeys, "promotion provider-seal inputs");
  if (
    evidence.componentId !== (platform === "darwin" ? "cua-driver-darwin" : "cua-driver-win32-x64")
    || evidence.lockSha256 !== attestation.providerLockSha256
    || evidence.distributionRevision !== lock.distributionRevision
    || evidence.providerVersion !== lock.upstream.version
    || evidence.serverInitializeProtocolVersion !== runtimeProbe.serverInitializeProtocolVersion
    || evidence.healthSchemaVersion !== runtimeProbe.healthSchemaVersion
    || evidence.toolsListCanonicalSha256 !== runtimeProbe.toolsListCanonicalSha256
    || evidence.stateSchemaVersion !== lock.runtime.stateSchemaVersion
    || JSON.stringify(evidence.binaries) !== JSON.stringify(attestation.binaries)
  ) {
    fail("promotion provider-seal inputs are not bound to the attestation");
  }
  if (platform === "win32-x64" && (
    JSON.stringify(evidence.limitations) !== JSON.stringify(lock.runtime.limitations)
    || evidence.signingTier !== "unsigned_dev"
    || evidence.distributionChannel !== "development"
    || evidence.productionEligible !== false
    || evidence.integrityCatalogRelativePath !== null
  )) {
    fail("Windows promotion provider-seal tier inputs mismatch");
  }
}

function verifyManagedStateEvidence(platform, evidence) {
  const expectedAccessControl = platform === "darwin"
    ? { root: "0700", directories: "0700", files: "0600" }
    : {
        root: "current_user_only_protected_dacl",
        directories: "current_user_only_protected_dacl",
        files: "current_user_only_protected_dacl",
      };
  const expected = {
    preexistingLinkRejected: true,
    rootLinkRejectedBeforeInitialize: true,
    externalHomeUnchanged: true,
    restartPersistence: true,
    accessControl: expectedAccessControl,
    sameUserConcurrentReplacementBoundary: "out_of_scope_v1",
  };
  if (JSON.stringify(evidence) !== JSON.stringify(expected)) {
    fail("managed-state acceptance evidence mismatch");
  }
}

function assertAbsoluteEvidencePaths(evidence, keys) {
  for (const key of keys) {
    if (typeof evidence[key] !== "string" || !isAbsolute(evidence[key])) {
      fail(`observed toolchain path is invalid: ${key}`);
    }
  }
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} keys changed`);
}

async function readBuiltBinarySnapshots({ actual, outputRoot, platform }) {
  const relativePaths = platform === "darwin"
    ? ["darwin/ling-cua-driver"]
    : [
        "win32-x64/payload/ling-cua-driver.exe",
        "audit/win32-x64/cua-driver-uia.exe",
      ];
  const values = {};
  for (const relativePath of relativePaths) {
    const snapshot = await readBoundedFileSnapshot(
      resolve(outputRoot, relativePath),
      SOURCE_BUILD_BINARY_MAX_BYTES,
      "source_build_binary",
    );
    if (snapshot.sha256 !== actual[relativePath]) {
      fail(`source-build binary changed during verification: ${relativePath}`);
    }
    values[relativePath] = snapshot;
  }
  return Object.freeze(values);
}

/** Bind staging verification to the exact bounded snapshot trusted by the parent stage. */
export function bindExpectedProviderSnapshot({
  expectedProviderSha256,
  relativePath,
  snapshot,
}) {
  if (!snapshot || snapshot.sha256 !== expectedProviderSha256) {
    fail(`source-build provider changed after staging snapshot: ${relativePath}`);
  }
  return snapshot;
}

async function runVersionFromOutput(executable) {
  const { stdout } = await runOwnedProcess(executable, ["--version"], {
    encoding: "utf8",
    maxBuffer: SOURCE_BUILD_VERSION_MAX_BYTES,
    timeout: SOURCE_BUILD_VERSION_TIMEOUT_MS,
  });
  return stdout.trim();
}

async function resolveObservedProviderVersion({
  attestationVersionOutput,
  executablePath,
  expectedVersion,
  stagingExpected,
}, runVersion = runVersionFromOutput) {
  const versionOutput = stagingExpected
    ? attestationVersionOutput
    : await runVersion(executablePath);
  return verifyVersionOutput(versionOutput, expectedVersion);
}

/** Test-only closure proving package staging never executes candidate bytes. */
export function createObservedProviderVersionResolverForTest(runVersion) {
  if (typeof runVersion !== "function") {
    throw new TypeError("version runner test seam must be callable");
  }
  return async (input) => resolveObservedProviderVersion(input, runVersion);
}

function inspectBuiltBinaryIdentity({ binarySnapshots, platform, lock }) {
  if (platform === "darwin") {
    const identity = inspectArm64MachO(
      binarySnapshots["darwin/ling-cua-driver"].bytes,
      "verified darwin provider",
    );
    if (identity.minimumOSVersion !== lock.toolchain.darwin.deploymentTarget) {
      fail("verified darwin provider minimum OS mismatch");
    }
    if (identity.sdkVersion !== lock.toolchain.darwin.macOSSDKVersion) {
      fail("verified darwin provider SDK mismatch");
    }
    return { binaries: [{ role: "main", ...identity }] };
  }
  const values = [];
  for (const [role, relativePath, uiAccess] of [
    ["main", "win32-x64/payload/ling-cua-driver.exe", false],
    ["uia-audit", "audit/win32-x64/cua-driver-uia.exe", true],
  ]) {
    const identity = inspectWindowsPe(
      binarySnapshots[relativePath].bytes,
      `verified Windows ${role} provider`,
    );
    if (identity.embeddedCertificateTablePresent || identity.manifest.executionLevel !== "asInvoker" || identity.manifest.uiAccess !== uiAccess) {
      fail(`verified Windows ${role} identity mismatch`);
    }
    values.push({ role, ...identity });
  }
  return { binaries: values };
}

function fail(message) {
  throw new Error(message);
}

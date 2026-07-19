#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_RESOURCE_ROOT,
  artifactDigestMap,
  runText,
  sha256File,
  verifySourceBuildArtifactInventory,
  verifyProviderInputs,
} from "./cua-driver-source-build-lib.mjs";
import {
  inspectUniversalMachO,
  inspectWindowsPe,
  verifyVersionOutput,
} from "./cua-driver-binary-identity.mjs";
import { verifyReferenceArtifactEvidence } from "./cua-driver-reference-artifacts.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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
const resourceRoot = resolve(args["resource-root"] || PROVIDER_RESOURCE_ROOT);
const verified = await verifyProviderInputs(resourceRoot);
if (args["attestation"]) {
  const attestation = JSON.parse(await readFile(resolve(args.attestation), "utf8"));
  if (attestation.schemaVersion !== 2 || attestation.kind !== "ling.cua-driver.source-build-attestation") {
    fail("source-build attestation schema mismatch");
  }
  if (!/^(darwin|win32-x64)$/u.test(attestation.platform ?? "")) fail("attestation platform mismatch");
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
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.kind !== "ling.cua-driver.source-build-manifest") fail("source-build manifest schema mismatch");
  if (JSON.stringify(manifest.files) !== JSON.stringify(actual)) fail("source-build manifest digest map mismatch");
  if (attestation.manifestSha256 !== await sha256File(manifestPath)) fail("source-build manifest digest mismatch");
  const promotionPath = resolve(outputRoot, "source-build-promotion-inputs.json");
  const promotion = JSON.parse(await readFile(promotionPath, "utf8"));
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
  const observedBinaryIdentity = await inspectBuiltBinaryIdentity({
    outputRoot,
    platform: attestation.platform,
    lock: verified.lock,
  });
  if (JSON.stringify(attestation.checks?.binaryIdentity) !== JSON.stringify(observedBinaryIdentity)) fail("attestation binary identity mismatch");
  if (JSON.stringify(promotion.sourceBuild?.binaryIdentity) !== JSON.stringify(observedBinaryIdentity)) fail("promotion binary identity mismatch");
  const mainBinaryPath = resolve(outputRoot, attestation.platform === "darwin"
    ? "darwin/cua-driver"
    : "win32-x64/payload/cua-driver.exe");
  const observedVersion = verifyVersionOutput(await runText(mainBinaryPath, ["--version"]), verified.lock.upstream.version);
  verifyPromotionBindings({
    attestation,
    lock: verified.lock,
    observedBinaryIdentity,
    observedVersion,
    promotion,
    runtimeProbe,
  });
  if (promotion.supplyChain?.sbomSha256 !== attestation.supplyChain.sbomSha256 || promotion.supplyChain?.noticesSha256 !== attestation.supplyChain.noticesSha256) fail("promotion supply-chain digest mismatch");
  if (attestation.promotionInputsSha256 !== await sha256File(promotionPath)) fail("promotion input digest mismatch");
  for (const binary of attestation.binaries) {
    const observed = actual[binary.relativePath];
    if (!SHA256_PATTERN.test(binary.sha256BeforeSigning)) fail(`binary digest is not a SHA-256: ${binary.relativePath}`);
    if (!observed || observed !== binary.sha256BeforeSigning) fail(`binary digest mismatch: ${binary.relativePath}`);
    if (binary.role === "uia-audit" && binary.packaged !== false) fail("UIAccess audit binary cannot be packaged");
  }
  if (actual["cua-driver.spdx.json"] !== attestation.supplyChain.sbomSha256) fail("SBOM digest mismatch");
  if (actual["THIRD_PARTY_NOTICES.md"] !== attestation.supplyChain.noticesSha256) fail("notices digest mismatch");
  process.stdout.write(`${JSON.stringify({ ok: true, attestation: args.attestation }, null, 2)}\n`);
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
      || evidence.developerDir !== `/Applications/Xcode_${pin.xcodeVersion}.app/Contents/Developer`
    ) {
      fail("observed macOS toolchain does not match the lock");
    }
    assertAbsoluteEvidencePaths(evidence, ["developerDir", "sdkPath", "clangPath", "lipoPath"]);
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

export function verifyPromotionBindings({
  attestation,
  lock,
  observedBinaryIdentity,
  observedVersion,
  promotion,
  runtimeProbe,
}) {
  if (promotion.promotionEligible !== false || promotion.platform !== attestation.platform) fail("promotion input gate mismatch");
  if (promotion.providerLockSha256 !== attestation.providerLockSha256) fail("promotion provider lock digest mismatch");
  if (promotion.sourceBuildInputsSha256 !== attestation.sourceBuildInputsSha256) fail("promotion source inputs digest mismatch");
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

async function inspectBuiltBinaryIdentity({ outputRoot, platform, lock }) {
  if (platform === "darwin") {
    const identity = inspectUniversalMachO(await readFile(resolve(outputRoot, "darwin/cua-driver")), "verified darwin provider");
    if (!identity.slices.every((slice) => slice.minimumOSVersion === lock.toolchain.darwin.deploymentTarget)) {
      fail("verified darwin provider minimum OS mismatch");
    }
    if (!identity.slices.every((slice) => slice.sdkVersion === lock.toolchain.darwin.macOSSDKVersion)) {
      fail("verified darwin provider SDK mismatch");
    }
    return { binaries: [{ role: "main", ...identity }] };
  }
  const values = [];
  for (const [role, relativePath, uiAccess] of [
    ["main", "win32-x64/payload/cua-driver.exe", false],
    ["uia-audit", "audit/win32-x64/cua-driver-uia.exe", true],
  ]) {
    const identity = inspectWindowsPe(await readFile(resolve(outputRoot, relativePath)), `verified Windows ${role} provider`);
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

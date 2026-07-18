#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  PROVIDER_RESOURCE_ROOT,
  artifactDigestMap,
  loadProviderLock,
  sha256File,
  verifySourceBuildArtifactInventory,
  verifyProviderInputs,
} from "./cua-driver-source-build-lib.mjs";

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
  if (attestation.checks?.runtimeProbe?.stdinEof !== "passed") fail("runtime stdin EOF probe was not recorded as passed");
  if (attestation.checks?.runtimeProbe?.initializeProtocolVersion !== "2025-06-18") fail("MCP initialize protocol mismatch");
  if (attestation.checks?.runtimeProbe?.healthSchemaVersion !== "1") fail("health schema mismatch");
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
  if (promotion.promotionEligible !== false || promotion.platform !== attestation.platform) fail("promotion input gate mismatch");
  if (promotion.providerSealInputs?.lockSha256 !== attestation.providerLockSha256) fail("promotion provider-seal lock binding mismatch");
  if (promotion.providerSealInputs?.toolsListCanonicalSha256 !== attestation.checks.runtimeProbe.toolsListCanonicalSha256) fail("promotion tools-list digest mismatch");
  if (promotion.supplyChain?.sbomSha256 !== attestation.supplyChain.sbomSha256 || promotion.supplyChain?.noticesSha256 !== attestation.supplyChain.noticesSha256) fail("promotion supply-chain digest mismatch");
  if (attestation.promotionInputsSha256 !== await sha256File(promotionPath)) fail("promotion input digest mismatch");
  for (const binary of attestation.binaries) {
    const observed = actual[binary.relativePath];
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

function assertAbsoluteEvidencePaths(evidence, keys) {
  for (const key of keys) {
    if (typeof evidence[key] !== "string" || !isAbsolute(evidence[key])) {
      fail(`observed toolchain path is invalid: ${key}`);
    }
  }
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

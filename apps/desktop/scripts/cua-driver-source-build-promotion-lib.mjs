import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCuaDriverProviderLockContract } from "../shared/cua-driver-provider-lock-contract.mjs";
import { restoreDarwinCandidateExecutable } from "./cua-driver-source-build-darwin-executable.mjs";
import {
  PROVIDER_RESOURCE_ROOT,
  verifyDistributionLockV2,
  verifyProviderInputs,
} from "./cua-driver-source-build-lib.mjs";
import { runOwnedProcess } from "./cua-driver-owned-process.mjs";
import {
  CUA_DRIVER_COMMITTED_LOCK_SHA256,
  CUA_DRIVER_COMMITTED_SOURCE_BUILD_INPUTS_SHA256,
} from "./cua-driver-package-staging-contract.mjs";
import {
  assertCanonicalDisjointRoots,
  listTreeInventory,
  readBoundedFileSnapshot,
  readBoundedJsonSnapshot,
} from "./cua-driver-package-staging-files.mjs";
import {
  canonicalJson,
  sha256Bytes,
} from "./cua-driver-signing/signing-contract.mjs";
import {
  assertDeepEqual,
  createPlatformRecord,
  createProposedProviderLock,
  CuaDriverSourceBuildPromotionError,
  fail,
  normalizePlatform,
  requireSha256,
} from "./cua-driver-source-build-promotion-records.mjs";
import {
  preparePromotionOutput,
  publishPromotionOutput,
} from "./cua-driver-source-build-promotion-publish.mjs";

export {
  createPlatformRecord,
  createProposedProviderLock,
  CuaDriverSourceBuildPromotionError,
};

const VERIFY_SOURCE_BUILD_SCRIPT = fileURLToPath(
  new URL("./verify-cua-driver-source-build.mjs", import.meta.url),
);
const JSON_MAX_BYTES = 8 * 1024 * 1024;
const BINARY_MAX_BYTES = 128 * 1024 * 1024;
const VERIFIER_MAX_BYTES = 8 * 1024 * 1024;
const VERIFIER_TIMEOUT_MS = 180_000;
/**
 * Verify two native source-build outputs and produce review-only promotion
 * material. The function never edits committed resources and never copies a
 * candidate binary into the repository.
 */
export async function promoteCuaDriverSourceBuild(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("promotion_input_invalid", "promotion input must be an object");
  }
  if (Object.hasOwn(input, "verifyCandidate")) {
    fail("promotion_trust_override_forbidden", "production promotion cannot replace the verifier");
  }
  const {
    platform,
    candidateA,
    candidateB,
    outputDir,
    resourceRoot = PROVIDER_RESOURCE_ROOT,
  } = input;
  const normalizedPlatform = normalizePlatform(platform);
  const expectedHost = normalizedPlatform === "darwin" ? "darwin" : "win32";
  if (process.platform !== expectedHost) {
    fail(
      "promotion_host_platform_mismatch",
      `${normalizedPlatform} promotion must independently execute its candidate on ${expectedHost}`,
    );
  }
  return promoteCuaDriverSourceBuildInternal({
    platform: normalizedPlatform,
    candidateA,
    candidateB,
    outputDir,
    resourceRoot,
    expectedProviderLockSha256: CUA_DRIVER_COMMITTED_LOCK_SHA256,
    expectedSourceBuildInputsSha256:
      CUA_DRIVER_COMMITTED_SOURCE_BUILD_INPUTS_SHA256,
    verifyCandidate: verifyCandidateWithCommittedVerifier,
  });
}

/** Test-only factory; production callers cannot replace the verifier. */
export function createCuaDriverSourceBuildPromoterForTest(
  verifyCandidate,
  {
    expectedProviderLockSha256 = CUA_DRIVER_COMMITTED_LOCK_SHA256,
    expectedSourceBuildInputsSha256 =
      CUA_DRIVER_COMMITTED_SOURCE_BUILD_INPUTS_SHA256,
  } = {},
) {
  if (typeof verifyCandidate !== "function") {
    throw new TypeError("source-build promotion verifier test seam must be callable");
  }
  return (input) => promoteCuaDriverSourceBuildInternal({
    ...input,
    expectedProviderLockSha256,
    expectedSourceBuildInputsSha256,
    verifyCandidate,
  });
}

async function promoteCuaDriverSourceBuildInternal({
  platform,
  candidateA,
  candidateB,
  outputDir,
  resourceRoot,
  expectedProviderLockSha256,
  expectedSourceBuildInputsSha256,
  verifyCandidate,
}) {
  const normalizedPlatform = normalizePlatform(platform);
  const candidateARoot = resolveRequired(candidateA, "candidate_a_missing");
  const candidateBRoot = resolveRequired(candidateB, "candidate_b_missing");
  const outputRoot = resolveRequired(outputDir, "output_dir_missing");
  const resources = resolveRequired(resourceRoot, "resource_root_missing");

  await assertPromotionRoots({ candidateARoot, candidateBRoot, outputRoot, resources });
  if (normalizedPlatform === "darwin") {
    await restoreDarwinCandidateExecutable(candidateARoot);
    await restoreDarwinCandidateExecutable(candidateBRoot);
  }
  const outputAuthority = await preparePromotionOutput(outputRoot);

  const verifiedInputs = await verifyProviderInputs(resources);
  const committedLock = await readBoundedJsonSnapshot(
    join(resources, "provider-lock.json"),
    JSON_MAX_BYTES,
    "promotion_provider_lock",
  );
  const committedSourceInputs = await readBoundedJsonSnapshot(
    join(resources, "source-build-inputs.json"),
    JSON_MAX_BYTES,
    "promotion_source_build_inputs",
  );
  bindCommittedInputs({
    committedLock,
    committedSourceInputs,
    expectedProviderLockSha256,
    expectedSourceBuildInputsSha256,
    verifiedInputs,
  });
  validateEnabledPlatformRecords(committedLock.value);

  // These are deliberately two separate owned child invocations. Directory
  // equality alone is not evidence that either candidate passed verification.
  const verifierA = await verifyCandidate({
    candidateRoot: candidateARoot,
    resourceRoot: resources,
  });
  const verifierB = await verifyCandidate({
    candidateRoot: candidateBRoot,
    resourceRoot: resources,
  });
  const evidenceA = await readVerifiedCandidate({
    candidateRoot: candidateARoot,
    committedLock,
    committedSourceInputs,
    expectedPlatform: normalizedPlatform,
    verifierResult: verifierA,
  });
  const evidenceB = await readVerifiedCandidate({
    candidateRoot: candidateBRoot,
    committedLock,
    committedSourceInputs,
    expectedPlatform: normalizedPlatform,
    verifierResult: verifierB,
  });
  assertDeepEqual(
    evidenceA.artifactDigests,
    evidenceB.artifactDigests,
    "candidate_artifact_digest_mismatch",
    "candidate A and B stable artifact digest maps differ",
  );

  const platformKey = normalizedPlatform === "darwin" ? "darwin" : "win32X64";
  if (committedLock.value.enabledPlatforms.includes(normalizedPlatform)
    || committedLock.value.platforms?.[platformKey] !== undefined) {
    fail(
      "platform_already_promoted",
      `${normalizedPlatform} already has a committed platform record; promotion cannot overwrite it`,
    );
  }

  const platformRecord = createPlatformRecord({
    evidence: evidenceA,
    platform: normalizedPlatform,
    sourceInputs: committedSourceInputs.value,
  });
  const proposedProviderLock = createProposedProviderLock({
    baseLock: committedLock.value,
    platform: normalizedPlatform,
    platformRecord,
  });
  validateEnabledPlatformRecords(proposedProviderLock);
  assertExistingPlatformRecordsPreserved(committedLock.value, proposedProviderLock);

  const proposedProviderLockBytes = Buffer.from(
    `${JSON.stringify(proposedProviderLock, null, 2)}\n`,
    "utf8",
  );
  const platformRecordSha256 = sha256Bytes(canonicalJson(platformRecord));
  const proposedProviderLockSha256 = sha256Bytes(proposedProviderLockBytes);
  const promotionReceipt = {
    schemaVersion: 1,
    kind: "ling.cua-driver.source-build-promotion-receipt",
    promotionStatus: "MANUAL_REVIEW_REQUIRED",
    platform: normalizedPlatform,
    baseProviderLockSha256: committedLock.sha256,
    sourceBuildInputsSha256: committedSourceInputs.sha256,
    stableArtifactDigests: evidenceA.artifactDigests,
    candidateEvidence: {
      a: receiptCandidateEvidence(evidenceA),
      b: receiptCandidateEvidence(evidenceB),
    },
    platformRecordSha256,
    proposedProviderLockSha256,
    nextNativeBuild: {
      required: true,
      providerLockSha256: proposedProviderLockSha256,
      candidateEvidenceReusable: false,
    },
    preservedEnabledPlatforms: [...committedLock.value.enabledPlatforms],
    sourceBuildInputsMutation: "forbidden",
    reviewBlockers: [
      "independent runner and build-invocation provenance is outside the candidate payload and must be reviewed before committing the proposed lock",
      "final macOS or Windows signing identity remains outside pre-sign source-build promotion",
    ],
  };
  const promotionReceiptBytes = Buffer.from(
    `${JSON.stringify(promotionReceipt, null, 2)}\n`,
    "utf8",
  );

  const { proposedLockPath, receiptPath } = await publishPromotionOutput({
    outputAuthority,
    proposedProviderLockBytes,
    promotionReceiptBytes,
  });
  return Object.freeze({
    ok: true,
    platform: normalizedPlatform,
    promotionStatus: promotionReceipt.promotionStatus,
    proposedLockPath,
    proposedProviderLockSha256,
    receiptPath,
    receiptSha256: sha256Bytes(promotionReceiptBytes),
  });
}

async function verifyCandidateWithCommittedVerifier({
  candidateRoot,
  resourceRoot,
}) {
  const attestationPath = join(candidateRoot, "source-build-attestation.json");
  const { stdout } = await runOwnedProcess(
    process.execPath,
    [
      VERIFY_SOURCE_BUILD_SCRIPT,
      "--resource-root",
      resourceRoot,
      "--attestation",
      attestationPath,
      "--output-root",
      candidateRoot,
    ],
    {
      encoding: "utf8",
      maxBuffer: VERIFIER_MAX_BYTES,
      timeout: VERIFIER_TIMEOUT_MS,
    },
  );
  try {
    return JSON.parse(stdout);
  } catch {
    fail("candidate_verifier_output_invalid", "source-build verifier did not return JSON");
  }
}

async function readVerifiedCandidate({
  candidateRoot,
  committedLock,
  committedSourceInputs,
  expectedPlatform,
  verifierResult,
}) {
  assertExactKeys(
    verifierResult,
    [
      "attestation",
      "attestationSha256",
      "files",
      "manifestSha256",
      "ok",
      "platform",
      "promotionInputsSha256",
    ],
    "candidate_verifier_result_invalid",
  );
  if (verifierResult.ok !== true || verifierResult.platform !== expectedPlatform) {
    fail("candidate_platform_mismatch", "verified candidate platform does not match --platform");
  }
  if (resolve(verifierResult.attestation)
    !== resolve(candidateRoot, "source-build-attestation.json")) {
    fail("candidate_verifier_path_mismatch", "verifier result names a different attestation path");
  }
  const binaryPaths = expectedPlatform === "darwin"
    ? ["darwin/ling-cua-driver"]
    : [
        "win32-x64/payload/ling-cua-driver.exe",
        "audit/win32-x64/cua-driver-uia.exe",
      ];
  const stablePaths = [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "cua-driver.spdx.json",
    "provider-lock.json",
    "source-build-inputs.json",
    "source-build-promotion-inputs.json",
    ...binaryPaths,
  ].sort();
  assertDigestMap(verifierResult.files, stablePaths);
  const expectedFiles = [
    ...stablePaths,
    "source-build-attestation.json",
    "source-build-manifest.json",
  ].sort();
  const expectedDirectories = expectedPlatform === "darwin"
    ? ["darwin"]
    : ["audit", "audit/win32-x64", "win32-x64", "win32-x64/payload"];
  const inventory = await listTreeInventory(candidateRoot);
  assertDeepEqual(
    inventory.files,
    expectedFiles,
    "candidate_inventory_mismatch",
    "candidate contains missing or extra files",
  );
  assertDeepEqual(
    inventory.directories,
    expectedDirectories,
    "candidate_inventory_mismatch",
    "candidate contains missing or extra directories",
  );

  const artifactDigests = {};
  for (const relativePath of stablePaths) {
    const snapshot = await readBoundedFileSnapshot(
      join(candidateRoot, ...relativePath.split("/")),
      binaryPaths.includes(relativePath) ? BINARY_MAX_BYTES : JSON_MAX_BYTES,
      "promotion_candidate_artifact",
    );
    artifactDigests[relativePath] = snapshot.sha256;
  }
  assertDeepEqual(
    artifactDigests,
    verifierResult.files,
    "candidate_changed_after_verification",
    "candidate stable artifact map changed after verifier completion",
  );

  const attestation = await readBoundedJsonSnapshot(
    join(candidateRoot, "source-build-attestation.json"),
    JSON_MAX_BYTES,
    "promotion_candidate_attestation",
  );
  const manifest = await readBoundedJsonSnapshot(
    join(candidateRoot, "source-build-manifest.json"),
    JSON_MAX_BYTES,
    "promotion_candidate_manifest",
  );
  const promotion = await readBoundedJsonSnapshot(
    join(candidateRoot, "source-build-promotion-inputs.json"),
    JSON_MAX_BYTES,
    "promotion_candidate_inputs",
  );
  const providerLock = await readBoundedJsonSnapshot(
    join(candidateRoot, "provider-lock.json"),
    JSON_MAX_BYTES,
    "promotion_candidate_provider_lock",
  );
  const sourceInputs = await readBoundedJsonSnapshot(
    join(candidateRoot, "source-build-inputs.json"),
    JSON_MAX_BYTES,
    "promotion_candidate_source_inputs",
  );
  if (attestation.sha256 !== verifierResult.attestationSha256
    || manifest.sha256 !== verifierResult.manifestSha256
    || promotion.sha256 !== verifierResult.promotionInputsSha256) {
    fail("candidate_changed_after_verification", "candidate metadata changed after verifier completion");
  }
  if (providerLock.sha256 !== committedLock.sha256
    || sourceInputs.sha256 !== committedSourceInputs.sha256) {
    fail("candidate_input_digest_mismatch", "candidate uses a different provider lock or source-build input");
  }
  if (promotion.sha256 !== artifactDigests["source-build-promotion-inputs.json"]
    || attestation.value.promotionInputsSha256 !== promotion.sha256
    || attestation.value.manifestSha256 !== manifest.sha256
    || canonicalJson(manifest.value.files) !== canonicalJson(artifactDigests)) {
    fail("candidate_metadata_digest_mismatch", "candidate metadata is not bound to the stable artifact map");
  }
  bindCandidateMetadata({
    artifactDigests,
    attestation: attestation.value,
    committedLock,
    committedSourceInputs,
    expectedPlatform,
    promotion: promotion.value,
  });
  return Object.freeze({
    artifactDigests: Object.freeze(artifactDigests),
    attestation: attestation.value,
    attestationSha256: attestation.sha256,
    manifestSha256: manifest.sha256,
    promotion: promotion.value,
    promotionInputsSha256: promotion.sha256,
  });
}

function bindCandidateMetadata({
  artifactDigests,
  attestation,
  committedLock,
  committedSourceInputs,
  expectedPlatform,
  promotion,
}) {
  if (attestation.platform !== expectedPlatform
    || promotion.platform !== expectedPlatform
    || attestation.packagingEligible !== false
    || attestation.signingState !== "pre-sign-only"
    || promotion.promotionEligible !== false) {
    fail("candidate_promotion_gate_invalid", "candidate is not non-promoting pre-sign evidence");
  }
  for (const value of [
    attestation.providerLockSha256,
    promotion.providerLockSha256,
    promotion.providerSealInputs?.lockSha256,
  ]) {
    if (value !== committedLock.sha256) {
      fail("candidate_provider_lock_binding_mismatch", "candidate provider-lock binding is mixed or stale");
    }
  }
  for (const value of [
    attestation.sourceBuildInputsSha256,
    promotion.sourceBuildInputsSha256,
  ]) {
    if (value !== committedSourceInputs.sha256) {
      fail("candidate_source_inputs_binding_mismatch", "candidate source-build input binding is mixed or stale");
    }
  }
  const expectedMissingFinalIdentity = expectedPlatform === "darwin"
    ? ["cdhashes", "codeIdentifier", "teamId", "designatedRequirement", "entitlementsCanonicalSha256"]
    : ["authenticodeStatus", "providerSealSha256"];
  assertDeepEqual(
    promotion.missingFinalIdentity,
    expectedMissingFinalIdentity,
    "candidate_final_identity_invalid",
    "candidate fabricated or omitted final signing identity boundaries",
  );
  if (!Array.isArray(attestation.binaries)) {
    fail("candidate_binary_inventory_invalid", "candidate attestation binaries are missing");
  }
  for (const binary of attestation.binaries) {
    if (!binary || artifactDigests[binary.relativePath] !== binary.sha256BeforeSigning) {
      fail("candidate_binary_digest_mismatch", "candidate binary is not bound to its attestation");
    }
    if (binary.role === "uia-audit" && binary.packaged !== false) {
      fail("candidate_uia_packaged", "UIAccess audit helper cannot enter the standard payload");
    }
  }
  if (canonicalJson(promotion.providerSealInputs?.binaries)
    !== canonicalJson(attestation.binaries)) {
    fail("candidate_binary_inventory_mismatch", "promotion and attestation binary inventories differ");
  }
}

function bindCommittedInputs({
  committedLock,
  committedSourceInputs,
  expectedProviderLockSha256,
  expectedSourceBuildInputsSha256,
  verifiedInputs,
}) {
  if (committedLock.sha256 !== expectedProviderLockSha256) {
    fail("provider_lock_anchor_mismatch", "provider lock does not match the independent committed digest");
  }
  if (committedSourceInputs.sha256 !== expectedSourceBuildInputsSha256) {
    fail("source_build_inputs_anchor_mismatch", "source-build inputs do not match the independent committed digest");
  }
  if (canonicalJson(committedLock.value) !== canonicalJson(verifiedInputs.providerLock)
    || canonicalJson(committedSourceInputs.value) !== canonicalJson(verifiedInputs.sourceInputs)) {
    fail("committed_inputs_changed_during_verification", "committed promotion inputs changed during verification");
  }
}

function validateEnabledPlatformRecords(lock) {
  verifyDistributionLockV2(lock);
  for (const platform of lock.enabledPlatforms) {
    validateCuaDriverProviderLockContract(lock, {
      platform: platform === "darwin" ? "darwin" : "win32",
      architecture: platform === "darwin" ? "arm64" : "x86_64",
      requireReleaseEvidence: true,
    });
  }
}

function assertExistingPlatformRecordsPreserved(baseLock, proposedLock) {
  for (const platform of baseLock.enabledPlatforms) {
    const key = platform === "darwin" ? "darwin" : "win32X64";
    if (canonicalJson(baseLock.platforms[key]) !== canonicalJson(proposedLock.platforms[key])) {
      fail("existing_platform_record_changed", `promotion changed existing ${platform} record`);
    }
  }
}

function receiptCandidateEvidence(evidence) {
  return {
    attestationSha256: evidence.attestationSha256,
    manifestSha256: evidence.manifestSha256,
    promotionInputsSha256: evidence.promotionInputsSha256,
  };
}

function assertDigestMap(value, expectedPaths) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("candidate_digest_map_invalid", "verifier artifact digest map is missing");
  }
  assertDeepEqual(
    Object.keys(value).sort(),
    expectedPaths,
    "candidate_digest_map_invalid",
    "verifier artifact digest map inventory changed",
  );
  for (const [path, digest] of Object.entries(value)) {
    requireSha256(digest, `candidate_digest_invalid:${path}`);
  }
}

async function assertPromotionRoots({ candidateARoot, candidateBRoot, outputRoot, resources }) {
  for (const [left, right] of [
    [candidateARoot, candidateBRoot],
    [candidateARoot, outputRoot],
    [candidateBRoot, outputRoot],
    [resources, candidateARoot],
    [resources, candidateBRoot],
    [resources, outputRoot],
  ]) {
    await assertCanonicalDisjointRoots(
      left,
      right,
      "promotion_roots_overlap",
      "promotion resource, candidate and output roots must be disjoint",
    );
  }
}

function resolveRequired(value, code) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(code, "required promotion path is missing");
  }
  return resolve(value);
}

function assertExactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(code, "object keys changed");
  }
}

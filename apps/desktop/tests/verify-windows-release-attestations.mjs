import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  verify as verifySignature,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import {
  WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS,
  canonicalJson,
} from "./windows-acceptance-report.mjs";
import { windowsAcceptanceMatrixEvidenceSha256 } from "./finalize-windows-signed-acceptance.mjs";
import { validateWindowsSignedAcceptanceMatrixDocument } from "./windows-handoff-contracts.mjs";
import {
  validateWindowsCandidateManifestDocument,
  validateWindowsReleasePolicyDocument,
} from "./windows-release-evidence-contracts.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SIGNATURE_ALGORITHM = "RSA-SHA256";
const FUTURE_SKEW_MS = 300_000;

export function windowsReviewerAttestationPayload(value) {
  return {
    schemaVersion: value?.schemaVersion,
    kind: value?.kind,
    scope: value?.scope,
    evidenceSha256: value?.evidenceSha256,
    candidateManifestSha256: value?.candidateManifestSha256,
    releasePolicySha256: value?.releasePolicySha256,
    signingTier: value?.signingTier,
    distributionChannel: value?.distributionChannel,
    productionEligible: value?.productionEligible,
    reviewerId: value?.reviewerId,
    keyId: value?.keyId,
    reviewedAt: value?.reviewedAt,
    verdict: value?.verdict,
  };
}

export function windowsCandidateBuildAttestationPayload(value) {
  return {
    schemaVersion: value?.schemaVersion,
    kind: value?.kind,
    scope: value?.scope,
    candidateManifestSha256: value?.candidateManifestSha256,
    candidateCommit: value?.candidateCommit,
    releasePolicySha256: value?.releasePolicySha256,
    signingTier: value?.signingTier,
    distributionChannel: value?.distributionChannel,
    productionEligible: value?.productionEligible,
    verdict: value?.verdict,
    daemonPayload: value?.daemonPayload,
    attestorId: value?.attestorId,
    keyId: value?.keyId,
    attestedAt: value?.attestedAt,
  };
}

/**
 * Promote an already finalized matrix only after two independent, detached
 * signatures are checked against public-key fingerprints pinned by the externally anchored
 * release policy. The report builder itself has no code path that returns releaseReady=true.
 */
export async function verifyWindowsReleaseAttestations(input, options = {}) {
  const verified = await verifyWindowsSignedAttestationPair(input, {
    ...options,
    expectedProfile: "production",
  });
  return {
    schemaVersion: 2,
    kind: "ling.windows.release-verification",
    verifiedAt: verified.verifiedAt,
    matrixEvidenceSha256: verified.matrixEvidenceSha256,
    candidateManifestSha256: verified.candidateManifestSha256,
    releasePolicySha256: verified.releasePolicySha256,
    signingTier: "production_signed",
    distributionChannel: "production",
    productionEligible: true,
    verifier: {
      name: "ling.windows.release-attestation-verifier",
      harnessCommit: verified.harnessCommit,
    },
    reviewer: verified.reviewer,
    candidateBuild: verified.candidateBuild,
    verdict: {
      status: "RELEASE_PASS",
      fullAcceptanceStatus: "PASS",
      promotionStatus: "RELEASE_PASS",
      releaseReady: true,
      releaseBlockers: [],
    },
  };
}

/** Verify detached signatures without emitting an internal or production verdict. */
export async function verifyWindowsSignedAttestationPair(input, options = {}) {
  const matrix = input?.matrix;
  validateWindowsSignedAcceptanceMatrixDocument(matrix);
  if (
    matrix.verdict.fullAcceptanceStatus !== "PASS" ||
    matrix.verdict.status !== "MANUAL_REVIEW_REQUIRED" ||
    matrix.verdict.promotionStatus !== "ATTESTATION_REQUIRED" ||
    matrix.verdict.releaseReady !== false ||
    !isDeepStrictEqual(
      matrix.verdict.releaseBlockers,
      WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS,
    )
  ) {
    throw new TypeError("windows_release_attestation_matrix_not_promotable");
  }
  const evidenceSha256 = windowsAcceptanceMatrixEvidenceSha256(matrix);
  if (matrix.evidenceSha256 !== evidenceSha256) {
    throw new TypeError("windows_release_attestation_evidence_digest_mismatch");
  }

  const context = input?.context;
  const releasePolicy = context?.releasePolicy;
  const candidateManifest = context?.candidateManifest;
  const manualReviewerIds = matrix?.manualReviewerIds;
  if (!releasePolicy || !candidateManifest || !Array.isArray(manualReviewerIds)) {
    throw new TypeError("windows_release_attestation_verified_context_required");
  }
  validateWindowsReleasePolicyDocument(releasePolicy);
  validateWindowsCandidateManifestDocument(candidateManifest, {
    policy: releasePolicy,
    expectedCommit: matrix.candidateCommit,
    expectedReleasePolicySha256: matrix.releasePolicySha256,
  });
  const expectedProfile = options.expectedProfile ?? "production";
  const internal = candidateManifest.signingTier === "test_signed_internal";
  const production = candidateManifest.signingTier === "production_signed";
  if (
    (expectedProfile === "internal" && !internal)
    || (expectedProfile === "production" && !production)
    || !["internal", "production"].includes(expectedProfile)
  ) {
    throw new TypeError("windows_release_attestation_profile_mismatch");
  }
  const expectedVerdict = internal ? "INTERNAL_TEST_PASS" : "RELEASE_PASS";
  const expectedArtifacts = {
    lingApp: candidateManifest.tierGovernedArtifacts.lingApp.sha256,
    lingInstaller:
      candidateManifest.tierGovernedArtifacts.lingInstaller.sha256,
    lingUninstaller:
      candidateManifest.tierGovernedArtifacts.lingUninstaller.sha256,
    provider: candidateManifest.tierGovernedArtifacts.provider.sha256,
    providerSeal: candidateManifest.packagedProvider.providerSealSha256,
    providerCatalog:
      candidateManifest.tierGovernedArtifacts.providerCatalog.sha256,
  };
  if (
    !isDeepStrictEqual(
      matrix.cells.map((cell) => cell.cellId),
      releasePolicy.requiredAcceptanceCells.map((cell) => cell.id),
    ) ||
    candidateManifest.commit !== matrix.candidateCommit ||
    candidateManifest.releasePolicySha256 !== matrix.releasePolicySha256 ||
    matrix.candidateManifestSha256 !== input?.candidateManifestSha256 ||
    matrix.releasePolicySha256 !== input?.releasePolicySha256 ||
    matrix.signingTier !== candidateManifest.signingTier ||
    matrix.distributionChannel !== candidateManifest.distributionChannel ||
    matrix.productionEligible !== candidateManifest.productionEligible ||
    matrix.testAuthorityKind !== candidateManifest.testAuthorityKind ||
    !isDeepStrictEqual(matrix.artifacts, expectedArtifacts) ||
    matrix.harness.commit !== candidateManifest.commit
  ) {
    throw new TypeError("windows_release_attestation_context_binding_invalid");
  }

  const reviewAttestation = input?.reviewAttestation;
  assertExactKeys(reviewAttestation, [
    "schemaVersion",
    "kind",
    "scope",
    "evidenceSha256",
    "candidateManifestSha256",
    "releasePolicySha256",
    "signingTier",
    "distributionChannel",
    "productionEligible",
    "reviewerId",
    "keyId",
    "reviewedAt",
    "verdict",
    "signature",
  ], "windows_reviewer_attestation_shape_invalid");
  assertExactKeys(
    reviewAttestation.signature,
    ["algorithm", "valueBase64"],
    "windows_reviewer_attestation_signature_shape_invalid",
  );
  const reviewedAt = parseIsoTimestamp(
    reviewAttestation.reviewedAt,
    "windows_reviewer_attestation_reviewed_at_invalid",
  );
  const verifiedAt = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(verifiedAt.getTime())) {
    throw new TypeError("windows_release_attestation_verifier_time_invalid");
  }
  if (
    reviewAttestation.schemaVersion !== 2 ||
    reviewAttestation.kind !== "ling.windows.review-attestation" ||
    reviewAttestation.scope !== "windows-signed-acceptance" ||
    reviewAttestation.evidenceSha256 !== evidenceSha256 ||
    reviewAttestation.candidateManifestSha256 !==
      matrix.candidateManifestSha256 ||
    reviewAttestation.releasePolicySha256 !== matrix.releasePolicySha256 ||
    reviewAttestation.signingTier !== candidateManifest.signingTier ||
    reviewAttestation.distributionChannel !== candidateManifest.distributionChannel ||
    reviewAttestation.productionEligible !== candidateManifest.productionEligible ||
    reviewAttestation.verdict !== expectedVerdict ||
    reviewAttestation.signature.algorithm !== SIGNATURE_ALGORITHM ||
    reviewedAt.getTime() < Date.parse(matrix.finalizedAt) ||
    reviewedAt.getTime() > verifiedAt.getTime() + FUTURE_SKEW_MS ||
    !isDeepStrictEqual(manualReviewerIds, [reviewAttestation.reviewerId])
  ) {
    throw new TypeError("windows_reviewer_attestation_binding_invalid");
  }
  const reviewerKeyPolicy = findPolicyKey(
    releasePolicy.reviewerKeys,
    reviewAttestation.reviewerId,
    reviewAttestation.keyId,
    "windows_reviewer_attestation_policy_key_missing",
  );
  const reviewerPublicKeySpkiSha256 = verifyDetachedSignature({
    payload: windowsReviewerAttestationPayload(reviewAttestation),
    signature: reviewAttestation.signature,
    publicKey: input?.reviewerPublicKey,
    policyKey: reviewerKeyPolicy,
    invalidCode: "windows_reviewer_attestation_signature_invalid",
  });

  const buildAttestation = input?.candidateBuildAttestation;
  assertExactKeys(buildAttestation, [
    "schemaVersion",
    "kind",
    "scope",
    "candidateManifestSha256",
    "candidateCommit",
    "releasePolicySha256",
    "signingTier",
    "distributionChannel",
    "productionEligible",
    "verdict",
    "daemonPayload",
    "attestorId",
    "keyId",
    "attestedAt",
    "signature",
  ], "windows_candidate_build_attestation_shape_invalid");
  assertExactKeys(
    buildAttestation.signature,
    ["algorithm", "valueBase64"],
    "windows_candidate_build_attestation_signature_shape_invalid",
  );
  const attestedAt = parseIsoTimestamp(
    buildAttestation.attestedAt,
    "windows_candidate_build_attestation_time_invalid",
  );
  if (
    buildAttestation.schemaVersion !== 2 ||
    buildAttestation.kind !== "ling.windows.candidate-build-attestation" ||
    buildAttestation.scope !== "windows-signed-candidate-build" ||
    buildAttestation.candidateManifestSha256 !==
      matrix.candidateManifestSha256 ||
    buildAttestation.candidateCommit !== matrix.candidateCommit ||
    buildAttestation.releasePolicySha256 !== matrix.releasePolicySha256 ||
    buildAttestation.signingTier !== candidateManifest.signingTier ||
    buildAttestation.distributionChannel !== candidateManifest.distributionChannel ||
    buildAttestation.productionEligible !== candidateManifest.productionEligible ||
    buildAttestation.verdict !== expectedVerdict ||
    !isDeepStrictEqual(
      buildAttestation.daemonPayload,
      candidateManifest.daemonPayload,
    ) ||
    buildAttestation.daemonPayload?.sourceCommit !== matrix.candidateCommit ||
    ![
      "deterministic-rebuild",
      "signed-candidate-embedded-daemon",
    ].includes(buildAttestation.daemonPayload?.strategy) ||
    !SHA256_PATTERN.test(buildAttestation.daemonPayload?.treeSha256 ?? "") ||
    buildAttestation.signature.algorithm !== SIGNATURE_ALGORITHM ||
    attestedAt.getTime() < Date.parse(releasePolicy.approvedAt) ||
    attestedAt.getTime() > Date.parse(matrix.finalizedAt) + FUTURE_SKEW_MS ||
    attestedAt.getTime() > verifiedAt.getTime() + FUTURE_SKEW_MS
  ) {
    throw new TypeError("windows_candidate_build_attestation_binding_invalid");
  }
  const buildKeyPolicy = findPolicyKey(
    releasePolicy.candidateBuildAttestors,
    buildAttestation.attestorId,
    buildAttestation.keyId,
    "windows_candidate_build_attestation_policy_key_missing",
  );
  assertIndependentAttestorRoles(reviewerKeyPolicy, buildKeyPolicy);
  const candidateBuildPublicKeySpkiSha256 = verifyDetachedSignature({
    payload: windowsCandidateBuildAttestationPayload(buildAttestation),
    signature: buildAttestation.signature,
    publicKey: input?.candidateBuildPublicKey,
    policyKey: buildKeyPolicy,
    invalidCode: "windows_candidate_build_attestation_signature_invalid",
  });
  if (reviewerPublicKeySpkiSha256 === candidateBuildPublicKeySpkiSha256) {
    throw new TypeError("windows_release_attestation_roles_not_independent");
  }

  return {
    verifiedAt: verifiedAt.toISOString(),
    matrixEvidenceSha256: evidenceSha256,
    candidateManifestSha256: matrix.candidateManifestSha256,
    releasePolicySha256: matrix.releasePolicySha256,
    harnessCommit: matrix.harness.commit,
    signingTier: candidateManifest.signingTier,
    distributionChannel: candidateManifest.distributionChannel,
    productionEligible: candidateManifest.productionEligible,
    testAuthorityKind: candidateManifest.testAuthorityKind,
    reviewer: {
      id: reviewAttestation.reviewerId,
      keyId: reviewAttestation.keyId,
      reviewedAt: reviewedAt.toISOString(),
      verification: "trusted_external_signature",
    },
    candidateBuild: {
      attestorId: buildAttestation.attestorId,
      keyId: buildAttestation.keyId,
      attestedAt: attestedAt.toISOString(),
      strategy: buildAttestation.daemonPayload.strategy,
      daemonTreeSha256: buildAttestation.daemonPayload.treeSha256,
      verification: "trusted_external_signature",
    },
  };
}

function findPolicyKey(entries, id, keyId, errorCode) {
  const matches = Array.isArray(entries)
    ? entries.filter((entry) => entry?.id === id && entry?.keyId === keyId)
    : [];
  if (matches.length !== 1 || matches[0].algorithm !== SIGNATURE_ALGORITHM) {
    throw new TypeError(errorCode);
  }
  return matches[0];
}

function assertIndependentAttestorRoles(reviewerKey, candidateBuildKey) {
  if (
    reviewerKey.id === candidateBuildKey.id ||
    reviewerKey.keyId === candidateBuildKey.keyId ||
    reviewerKey.publicKeySpkiSha256 === candidateBuildKey.publicKeySpkiSha256
  ) {
    throw new TypeError("windows_release_attestation_roles_not_independent");
  }
}

function verifyDetachedSignature({
  payload,
  signature,
  publicKey,
  policyKey,
  invalidCode,
}) {
  let key;
  try {
    key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  } catch {
    throw new TypeError(`${invalidCode}:public_key_invalid`);
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new TypeError(`${invalidCode}:public_key_type_invalid`);
  }
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new TypeError(`${invalidCode}:public_key_strength_invalid`);
  }
  const spki = key.export({ format: "der", type: "spki" });
  const spkiSha256 = createHash("sha256").update(spki).digest("hex");
  if (spkiSha256 !== policyKey.publicKeySpkiSha256) {
    throw new TypeError(`${invalidCode}:public_key_policy_mismatch`);
  }
  const signatureBytes = strictBase64(signature.valueBase64, invalidCode);
  const valid = verifySignature(
    "sha256",
    Buffer.from(canonicalJson(payload), "utf8"),
    { key, padding: cryptoConstants.RSA_PKCS1_PADDING },
    signatureBytes,
  );
  if (!valid) {
    throw new TypeError(invalidCode);
  }
  return spkiSha256;
}

function strictBase64(value, errorCode) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new TypeError(`${errorCode}:signature_encoding_invalid`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new TypeError(`${errorCode}:signature_encoding_invalid`);
  }
  return bytes;
}

function parseIsoTimestamp(value, errorCode) {
  if (typeof value !== "string") {
    throw new TypeError(errorCode);
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new TypeError(errorCode);
  }
  return parsed;
}

function assertExactKeys(value, expectedKeys, errorCode) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())
  ) {
    throw new TypeError(errorCode);
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse((await readFile(resolve(path), "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new TypeError(`${label}_invalid:${error?.message ?? error}`);
  }
}

async function readJsonWithDigest(path, label) {
  const bytes = await readFile(resolve(path));
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new TypeError(`${label}_invalid:${error?.message ?? error}`);
  }
  return {
    document,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function loadWindowsAttestationVerificationInput(values) {
  const matrix = await readJson(values.matrix, "windows_acceptance_matrix");
  validateWindowsSignedAcceptanceMatrixDocument(matrix);
  const candidateManifestFile = await readJsonWithDigest(
    values["candidate-manifest"],
    "windows_candidate_manifest",
  );
  const releasePolicyFile = await readJsonWithDigest(
    values["release-policy"],
    "windows_release_policy",
  );
  const expectedHandoffIndexSha256 = values[
    "expected-handoff-index-sha256"
  ].toLowerCase();
  const expectedCandidateManifestSha256 = values[
    "expected-candidate-manifest-sha256"
  ].toLowerCase();
  const expectedReleasePolicySha256 = values[
    "expected-release-policy-sha256"
  ].toLowerCase();
  if (
    matrix.handoffIndexSha256 !== expectedHandoffIndexSha256 ||
    matrix.candidateManifestSha256 !== expectedCandidateManifestSha256 ||
    candidateManifestFile.sha256 !== expectedCandidateManifestSha256 ||
    matrix.releasePolicySha256 !== expectedReleasePolicySha256 ||
    releasePolicyFile.sha256 !== expectedReleasePolicySha256 ||
    matrix.candidateCommit !== values["expected-candidate-commit"].toLowerCase()
  ) {
    throw new TypeError("windows_release_attestation_external_anchor_mismatch");
  }
  return {
    matrix,
    context: {
      candidateManifest: candidateManifestFile.document,
      releasePolicy: releasePolicyFile.document,
    },
    candidateManifestSha256: candidateManifestFile.sha256,
    releasePolicySha256: releasePolicyFile.sha256,
    reviewAttestation: await readJson(
      values["review-attestation"],
      "windows_reviewer_attestation",
    ),
    reviewerPublicKey: await readFile(resolve(values["reviewer-public-key"])),
    candidateBuildAttestation: await readJson(
      values["candidate-build-attestation"],
      "windows_candidate_build_attestation",
    ),
    candidateBuildPublicKey: await readFile(
      resolve(values["candidate-build-public-key"]),
    ),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      matrix: { type: "string" },
      "candidate-manifest": { type: "string" },
      "release-policy": { type: "string" },
      "review-attestation": { type: "string" },
      "reviewer-public-key": { type: "string" },
      "candidate-build-attestation": { type: "string" },
      "candidate-build-public-key": { type: "string" },
      "expected-handoff-index-sha256": { type: "string" },
      "expected-candidate-manifest-sha256": { type: "string" },
      "expected-candidate-commit": { type: "string" },
      "expected-release-policy-sha256": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const required = [
    "matrix",
    "candidate-manifest",
    "release-policy",
    "review-attestation",
    "reviewer-public-key",
    "candidate-build-attestation",
    "candidate-build-public-key",
    "expected-handoff-index-sha256",
    "expected-candidate-manifest-sha256",
    "expected-candidate-commit",
    "expected-release-policy-sha256",
  ];
  if (values.help || required.some((name) => !values[name])) {
    process.stdout.write(
      "Usage: node verify-windows-release-attestations.mjs --matrix <matrix.json> --candidate-manifest <candidate.json> --release-policy <policy.json> --review-attestation <review.json> --reviewer-public-key <reviewer.pem> --candidate-build-attestation <build.json> --candidate-build-public-key <builder.pem> --expected-handoff-index-sha256 <sha256> --expected-candidate-manifest-sha256 <sha256> --expected-candidate-commit <commit> --expected-release-policy-sha256 <sha256> [--output <verification.json>]\n",
    );
    if (!values.help) {
      process.exitCode = 2;
    }
    return;
  }
  const outputPath = values.output ? resolve(values.output) : null;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
  }
  const verification = await verifyWindowsReleaseAttestations(
    await loadWindowsAttestationVerificationInput(values),
  );
  const serialized = `${JSON.stringify(verification, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
  } else {
    process.stdout.write(serialized);
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Windows release attestation verification failed: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}

import {
  createHash,
  createPublicKey,
  constants as cryptoConstants,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import {
  WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS,
  canonicalJson,
  validateWindowsAcceptanceReportShape,
  verifyWindowsAcceptanceEvidenceFiles,
  windowsAcceptanceEvidenceSha256,
} from "./windows-acceptance-report.mjs";

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
    daemonPayload: value?.daemonPayload,
    attestorId: value?.attestorId,
    keyId: value?.keyId,
    attestedAt: value?.attestedAt,
  };
}

/**
 * Promote an already file-validated Full report only after two independent, detached
 * signatures are checked against public-key fingerprints pinned by the externally anchored
 * release policy. The report builder itself has no code path that returns releaseReady=true.
 */
export async function verifyWindowsReleaseAttestations(input, options = {}) {
  const report = input?.report;
  validateWindowsAcceptanceReportShape(report);
  if (
    report.mode !== "Full" ||
    report.summary.fullAcceptanceStatus !== "PASS" ||
    report.summary.releaseStatus !== "MANUAL_REVIEW_REQUIRED" ||
    report.summary.releaseReady !== false ||
    report.summary.reviewerAttestation !== "not_verified" ||
    report.summary.candidateBuildProvenance !== "not_verified" ||
    !isDeepStrictEqual(
      report.summary.releaseBlockers,
      WINDOWS_ACCEPTANCE_RELEASE_BLOCKERS,
    )
  ) {
    throw new TypeError("windows_release_attestation_report_not_promotable");
  }
  const evidenceSha256 = windowsAcceptanceEvidenceSha256(report);
  if (report.summary.evidenceSha256 !== evidenceSha256) {
    throw new TypeError("windows_release_attestation_evidence_digest_mismatch");
  }

  const context = input?.context;
  const releasePolicy = context?.releasePolicy;
  const candidateManifest = context?.candidateManifest;
  const manualReviewerIds = context?.manualEvidence?.reviewerIds;
  if (!releasePolicy || !candidateManifest || !Array.isArray(manualReviewerIds)) {
    throw new TypeError("windows_release_attestation_verified_context_required");
  }
  if (
    releasePolicy.schemaVersion !== 2 ||
    releasePolicy.kind !== "ling.windows.release-policy" ||
    releasePolicy.policyVersion !== 2 ||
    releasePolicy.status !== "approved" ||
    candidateManifest.schemaVersion !== 3 ||
    candidateManifest.kind !== "ling.windows.candidate-manifest" ||
    !isDeepStrictEqual(
      releasePolicy.reviewerKeys,
      report.bindings.releasePolicy.reviewerKeys,
    ) ||
    !isDeepStrictEqual(
      releasePolicy.candidateBuildAttestors,
      report.bindings.releasePolicy.candidateBuildAttestors,
    ) ||
    candidateManifest.commit !== report.bindings.commit ||
    candidateManifest.releasePolicySha256 !== report.bindings.releasePolicy.sha256
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
    reviewAttestation.schemaVersion !== 1 ||
    reviewAttestation.kind !== "ling.windows.review-attestation" ||
    reviewAttestation.scope !== "windows-full-acceptance" ||
    reviewAttestation.evidenceSha256 !== evidenceSha256 ||
    reviewAttestation.candidateManifestSha256 !==
      report.bindings.candidateManifest.sha256 ||
    reviewAttestation.releasePolicySha256 !== report.bindings.releasePolicy.sha256 ||
    reviewAttestation.verdict !== "PASS" ||
    reviewAttestation.signature.algorithm !== SIGNATURE_ALGORITHM ||
    reviewedAt.getTime() < Date.parse(report.generatedAt) ||
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
    buildAttestation.schemaVersion !== 1 ||
    buildAttestation.kind !== "ling.windows.candidate-build-attestation" ||
    buildAttestation.scope !== "windows-candidate-build" ||
    buildAttestation.candidateManifestSha256 !==
      report.bindings.candidateManifest.sha256 ||
    buildAttestation.candidateCommit !== report.bindings.commit ||
    buildAttestation.releasePolicySha256 !== report.bindings.releasePolicy.sha256 ||
    !isDeepStrictEqual(
      buildAttestation.daemonPayload,
      candidateManifest.daemonPayload,
    ) ||
    buildAttestation.daemonPayload?.sourceCommit !== report.bindings.commit ||
    ![
      "deterministic-rebuild",
      "signed-candidate-embedded-daemon",
    ].includes(buildAttestation.daemonPayload?.strategy) ||
    !SHA256_PATTERN.test(buildAttestation.daemonPayload?.treeSha256 ?? "") ||
    buildAttestation.signature.algorithm !== SIGNATURE_ALGORITHM ||
    attestedAt.getTime() < Date.parse(releasePolicy.approvedAt) ||
    attestedAt.getTime() > Date.parse(report.generatedAt) + FUTURE_SKEW_MS ||
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
    schemaVersion: 1,
    kind: "ling.windows.release-verification",
    verifiedAt: verifiedAt.toISOString(),
    reportEvidenceSha256: evidenceSha256,
    candidateManifestSha256: report.bindings.candidateManifest.sha256,
    releasePolicySha256: report.bindings.releasePolicy.sha256,
    verifier: {
      name: "ling.windows.release-attestation-verifier",
      harnessCommit: report.bindings.harness.commit,
    },
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
    verdict: {
      status: "PASS",
      fullAcceptanceStatus: "PASS",
      releaseReady: true,
      releaseBlockers: [],
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

async function main() {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      "review-attestation": { type: "string" },
      "reviewer-public-key": { type: "string" },
      "candidate-build-attestation": { type: "string" },
      "candidate-build-public-key": { type: "string" },
      "git-executable": { type: "string" },
      "expected-candidate-commit": { type: "string" },
      "expected-repository-root": { type: "string" },
      "expected-release-policy-sha256": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const required = [
    "report",
    "review-attestation",
    "reviewer-public-key",
    "candidate-build-attestation",
    "candidate-build-public-key",
    "git-executable",
    "expected-candidate-commit",
    "expected-repository-root",
    "expected-release-policy-sha256",
  ];
  if (values.help || required.some((name) => !values[name])) {
    process.stdout.write(
      "Usage: node verify-windows-release-attestations.mjs --report <acceptance.json> --review-attestation <review.json> --reviewer-public-key <reviewer.pem> --candidate-build-attestation <build.json> --candidate-build-public-key <builder.pem> --git-executable <trusted-git.exe> --expected-candidate-commit <commit> --expected-repository-root <clean-root> --expected-release-policy-sha256 <sha256> [--output <verification.json>]\n",
    );
    if (!values.help) {
      process.exitCode = 2;
    }
    return;
  }
  const outputPath = values.output ? resolve(values.output) : null;
  const temporaryOutputPath = outputPath
    ? `${outputPath}.tmp-${process.pid}-${randomUUID()}`
    : null;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await rm(outputPath, { force: true });
  }
  try {
    const report = await readJson(values.report, "windows_acceptance_report");
    validateWindowsAcceptanceReportShape(report);
    const context = await verifyWindowsAcceptanceEvidenceFiles(report, {
      gitExecutable: values["git-executable"],
      expectedCandidateCommit: values["expected-candidate-commit"],
      expectedRepositoryRoot: values["expected-repository-root"],
      expectedReleasePolicySha256: values["expected-release-policy-sha256"],
    });
    const verification = await verifyWindowsReleaseAttestations({
      report,
      context,
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
    });
    const serialized = `${JSON.stringify(verification, null, 2)}\n`;
    if (outputPath && temporaryOutputPath) {
      await writeFile(temporaryOutputPath, serialized, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryOutputPath, outputPath);
    } else {
      process.stdout.write(serialized);
    }
  } finally {
    if (temporaryOutputPath) {
      await rm(temporaryOutputPath, { force: true });
    }
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

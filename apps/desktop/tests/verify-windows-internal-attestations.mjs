import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  loadWindowsAttestationVerificationInput,
  verifyWindowsSignedAttestationPair,
} from "./verify-windows-release-attestations.mjs";

export async function verifyWindowsInternalAttestations(input, options = {}) {
  const verified = await verifyWindowsSignedAttestationPair(input, {
    ...options,
    expectedProfile: "internal",
  });
  return {
    schemaVersion: 1,
    kind: "ling.windows.internal-verification",
    verifiedAt: verified.verifiedAt,
    matrixEvidenceSha256: verified.matrixEvidenceSha256,
    candidateManifestSha256: verified.candidateManifestSha256,
    releasePolicySha256: verified.releasePolicySha256,
    signingTier: "test_signed_internal",
    distributionChannel: "internal",
    productionEligible: false,
    testAuthorityKind: verified.testAuthorityKind,
    verifier: {
      name: "ling.windows.internal-attestation-verifier",
      harnessCommit: verified.harnessCommit,
    },
    reviewer: verified.reviewer,
    candidateBuild: verified.candidateBuild,
    verdict: {
      status: "INTERNAL_TEST_PASS",
      fullAcceptanceStatus: "PASS",
      promotionStatus: "INTERNAL_TEST_PASS",
      releaseReady: false,
      releaseBlockers: ["production_signing_required"],
    },
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
      "Usage: node verify-windows-internal-attestations.mjs --matrix <matrix.json> --candidate-manifest <candidate.json> --release-policy <policy.json> --review-attestation <review.json> --reviewer-public-key <reviewer.pem> --candidate-build-attestation <build.json> --candidate-build-public-key <builder.pem> --expected-handoff-index-sha256 <sha256> --expected-candidate-manifest-sha256 <sha256> --expected-candidate-commit <commit> --expected-release-policy-sha256 <sha256> [--output <verification.json>]\n",
    );
    if (!values.help) {
      process.exitCode = 2;
    }
    return;
  }
  const verification = await verifyWindowsInternalAttestations(
    await loadWindowsAttestationVerificationInput(values),
  );
  const serialized = `${JSON.stringify(verification, null, 2)}\n`;
  if (!values.output) {
    process.stdout.write(serialized);
    return;
  }
  const outputPath = resolve(values.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Windows internal attestation verification failed: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}

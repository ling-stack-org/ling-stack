import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  buildWindowsAcceptanceReport,
  canonicalJson,
  WINDOWS_RELEASE_HARNESS_FILES,
  validateWindowsAcceptanceReport,
  validateWindowsAcceptanceReportShape,
  verifyWindowsCandidateManifestReference,
  verifyWindowsFullManualEvidenceFiles,
  verifyWindowsAcceptanceEvidenceFiles,
  verifyWindowsReleaseHarnessFiles,
  verifyWindowsReleasePolicyReference,
} from "./windows-acceptance-report.mjs";
import {
  verifyWindowsReleaseAttestations,
  windowsCandidateBuildAttestationPayload,
  windowsReviewerAttestationPayload,
} from "./verify-windows-release-attestations.mjs";
import { verifyWindowsInternalAttestations } from "./verify-windows-internal-attestations.mjs";
import { windowsAcceptanceMatrixEvidenceSha256 } from "./finalize-windows-signed-acceptance.mjs";
import { WINDOWS_CUA_DRIVER_RELEASE } from "./verify-windows-cua-driver-provider.mjs";
import { createInstalledProviderFixture } from "./windows-installed-provider-fixture.mjs";
import {
  WINDOWS_TEST_BUILD,
  WINDOWS_TEST_CATALOG_CERTIFICATE_SHA256,
  WINDOWS_TEST_PROVIDER_CATALOG_SHA256,
  WINDOWS_TEST_PROVIDER_CERTIFICATE_SHA256,
  WINDOWS_TEST_PROVIDER_SEAL_SHA256,
  WINDOWS_TEST_PROVIDER_SHA256,
  windowsAcceptanceCellFixture,
  windowsCandidateManifestFixture,
  windowsCandidateManifestReferenceFixture,
  windowsProviderVerificationReportFixture,
  windowsReleasePolicyFixture,
  windowsReleasePolicyReferenceFixture,
} from "./windows-release-evidence-fixtures.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = WINDOWS_TEST_PROVIDER_SHA256;
const SHA_D = WINDOWS_TEST_PROVIDER_SEAL_SHA256;
const CERT_LING = "c".repeat(64);
const CERT_PROVIDER = WINDOWS_TEST_PROVIDER_CERTIFICATE_SHA256;
const CERT_CATALOG = WINDOWS_TEST_CATALOG_CERTIFICATE_SHA256;
const REVIEW_KEY_SHA = "e".repeat(64);
const BUILD_KEY_SHA = "9".repeat(64);
const COMMIT = "d".repeat(40);
const MANUAL_EVIDENCE_LABELS = [
  "windowsVersion",
  "display",
  "narrator",
  "nvda",
  "smartScreen",
  "installLifecycle",
];
const MANUAL_EVIDENCE_KINDS = {
  windowsVersion: "ling.windows.full-evidence.windows-version",
  display: "ling.windows.full-evidence.display",
  narrator: "ling.windows.full-evidence.narrator",
  nvda: "ling.windows.full-evidence.nvda",
  smartScreen: "ling.windows.full-evidence.smartscreen",
  installLifecycle: "ling.windows.full-evidence.install-lifecycle",
};

test("complete Full evidence passes every Windows acceptance gate", () => {
  const report = buildWindowsAcceptanceReport(completeEvidence());

  assert.equal(report.summary.status, "PASS", JSON.stringify(report.gates));
  assert.equal(report.summary.fullAcceptanceStatus, "PASS");
  assert.equal(report.summary.releaseStatus, "MANUAL_REVIEW_REQUIRED");
  assert.equal(report.summary.releaseReady, false);
  assert.deepEqual(report.summary.releaseBlockers, [
    "external_reviewer_attestation_unverified",
    "candidate_build_provenance_unverified",
  ]);
  assert.match(report.summary.evidenceSha256, /^[0-9a-f]{64}$/u);
  assert.ok(report.gates.every((gate) => gate.status === "PASS"));
  assert.equal(validateWindowsAcceptanceReportShape(report), report);
});

test("only policy-pinned detached reviewer and candidate-build signatures promote Full release readiness", async () => {
  const fixture = signedReleaseAttestationFixture();
  const verification = await verifyWindowsReleaseAttestations(
    fixture.input,
    { now: "2026-07-17T12:10:00.000Z" },
  );

  assert.equal(verification.verdict.status, "RELEASE_PASS");
  assert.equal(verification.verdict.releaseReady, true);
  assert.equal(verification.verifier.harnessCommit, COMMIT);
  assert.deepEqual(verification.verdict.releaseBlockers, []);
  assert.equal(
    verification.reviewer.verification,
    "trusted_external_signature",
  );
  assert.equal(
    verification.candidateBuild.verification,
    "trusted_external_signature",
  );
});

test("test-signed internal attestations stop at INTERNAL_TEST_PASS", async () => {
  const fixture = signedReleaseAttestationFixture({ production: false });
  const verification = await verifyWindowsInternalAttestations(fixture.input, {
    now: "2026-07-17T12:10:00.000Z",
  });

  assert.equal(verification.kind, "ling.windows.internal-verification");
  assert.equal(verification.signingTier, "test_signed_internal");
  assert.equal(verification.distributionChannel, "internal");
  assert.equal(verification.productionEligible, false);
  assert.equal(verification.verdict.status, "INTERNAL_TEST_PASS");
  assert.equal(verification.verdict.releaseReady, false);
  assert.deepEqual(verification.verdict.releaseBlockers, [
    "production_signing_required",
  ]);
  await assert.rejects(
    verifyWindowsReleaseAttestations(fixture.input, {
      now: "2026-07-17T12:10:00.000Z",
    }),
    /windows_release_attestation_profile_mismatch/u,
  );

  const productionFixture = signedReleaseAttestationFixture();
  await assert.rejects(
    verifyWindowsInternalAttestations(productionFixture.input, {
      now: "2026-07-17T12:10:00.000Z",
    }),
    /windows_release_attestation_profile_mismatch/u,
  );
});

test("cell and verification JSON Schemas accept actual outputs and reject self-promotion", async () => {
  const report = buildWindowsAcceptanceReport(completeEvidence());
  const productionFixture = signedReleaseAttestationFixture();
  const productionVerification = await verifyWindowsReleaseAttestations(
    productionFixture.input,
    { now: "2026-07-17T12:10:00.000Z" },
  );
  const internalFixture = signedReleaseAttestationFixture({ production: false });
  const internalVerification = await verifyWindowsInternalAttestations(
    internalFixture.input,
    { now: "2026-07-17T12:10:00.000Z" },
  );
  for (const [name, value] of [
    ["windows-cell-acceptance-report.schema.json", report],
    ["windows-release-verification.schema.json", productionVerification],
    ["windows-internal-verification.schema.json", internalVerification],
  ]) {
    const validate = await releaseEvidenceSchemaValidator(name);
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }

  const validateInternal = await releaseEvidenceSchemaValidator(
    "windows-internal-verification.schema.json",
  );
  const selfPromoted = structuredClone(internalVerification);
  selfPromoted.verdict.releaseReady = true;
  assert.equal(validateInternal(selfPromoted), false);
});

test("different release roles cannot reuse the same RSA key even with two valid signatures", async () => {
  const fixture = signedReleaseAttestationFixture({
    reuseReviewerKeyForBuild: true,
  });

  await assert.rejects(
    verifyWindowsReleaseAttestations(fixture.input, {
      now: "2026-07-17T12:10:00.000Z",
    }),
    /windows_release_(?:policy_attestor_roles_invalid|attestation_roles_not_independent)/u,
  );
  assert.equal(fixture.input.report.summary.releaseReady, false);
});

test("an allowlisted reviewer string with no matching detached signature cannot promote Full", async () => {
  const fixture = signedReleaseAttestationFixture();
  fixture.input.reviewAttestation.signature.valueBase64 = Buffer.alloc(
    256,
    7,
  ).toString("base64");

  await assert.rejects(
    verifyWindowsReleaseAttestations(fixture.input, {
      now: "2026-07-17T12:10:00.000Z",
    }),
    /windows_reviewer_attestation_signature_invalid/u,
  );
  assert.equal(fixture.input.report.summary.releaseReady, false);
});

test("an operator-generated key cannot impersonate the policy-pinned reviewer", async () => {
  const fixture = signedReleaseAttestationFixture();
  const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fixture.input.reviewAttestation.signature.valueBase64 = signDetached(
    windowsReviewerAttestationPayload(fixture.input.reviewAttestation),
    attacker.privateKey,
  );
  fixture.input.reviewerPublicKey = attacker.publicKey;

  await assert.rejects(
    verifyWindowsReleaseAttestations(fixture.input, {
      now: "2026-07-17T12:10:00.000Z",
    }),
    /windows_reviewer_attestation_signature_invalid:public_key_policy_mismatch/u,
  );
});

test("review approval cannot substitute for candidate daemon build provenance", async () => {
  const fixture = signedReleaseAttestationFixture();
  fixture.input.candidateBuildAttestation.daemonPayload.treeSha256 =
    "0".repeat(64);
  fixture.input.candidateBuildAttestation.signature.valueBase64 = signDetached(
    windowsCandidateBuildAttestationPayload(
      fixture.input.candidateBuildAttestation,
    ),
    fixture.buildPrivateKey,
  );

  await assert.rejects(
    verifyWindowsReleaseAttestations(fixture.input, {
      now: "2026-07-17T12:10:00.000Z",
    }),
    /windows_candidate_build_attestation_binding_invalid/u,
  );
});

test("missing provider evidence is BLOCKED and can never be reported as PASS", () => {
  const evidence = completeEvidence();
  evidence.bindings.provider = missingArtifact({ version: null });
  evidence.probes.providerVerification = notAttemptedProbe("provider_missing");
  evidence.probes.providerSmoke = notAttemptedProbe("provider_missing");

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "candidate-binding"), "BLOCKED");
  assert.equal(gateStatus(report, "signature"), "BLOCKED");
  assert.equal(gateStatus(report, "provider-verification"), "BLOCKED");
  assert.equal(gateStatus(report, "provider-smoke"), "BLOCKED");
  assert.equal(report.summary.status, "BLOCKED");
  assert.equal(report.summary.releaseReady, false);
});

test("Session 0 or a non-interactive session is BLOCKED", () => {
  const evidence = completeEvidence();
  evidence.host.session = {
    id: 0,
    name: "Services",
    interactive: false,
    locked: false,
  };

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "interactive-session"), "BLOCKED");
  assert.equal(report.summary.status, "BLOCKED");
});

test("a single display cannot close the topology or Full DPI gates", () => {
  const evidence = completeEvidence();
  evidence.host.displays = [evidence.host.displays[0]];

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "display-topology"), "BLOCKED");
  assert.equal(gateStatus(report, "dpi-profile"), "BLOCKED");
  assert.equal(report.summary.status, "BLOCKED");
});

test("unsigned Ling or provider artifacts remain BLOCKED", () => {
  const evidence = completeEvidence();
  evidence.bindings.lingInstaller.signature = signature("NotSigned");

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "signature"), "BLOCKED");
  assert.match(gateReason(report, "signature"), /unsigned/u);
  assert.equal(report.summary.status, "BLOCKED");
});

test("Full evidence rejects installed vendor native inventory drift", () => {
  const evidence = completeEvidence();
  evidence.probes.installerPayload.report.installedVendorNativeInventory[0]
    .sha256 = "1".repeat(64);

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "installer-payload"), "FAIL");
  assert.equal(report.summary.status, "FAIL");
});

test("missing NVDA leaves accessibility readiness BLOCKED", () => {
  const evidence = completeEvidence();
  evidence.host.accessibility.nvda = {
    available: false,
    running: false,
    path: null,
  };

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "accessibility-readiness"), "BLOCKED");
  assert.match(gateReason(report, "accessibility-readiness"), /nvda/u);
  assert.equal(report.summary.status, "BLOCKED");
});

test("Full evidence cannot pass from installed-but-unexercised accessibility tools", () => {
  const evidence = completeEvidence();
  evidence.acceptance.narrator = notAttemptedAcceptance(
    "narrator_not_exercised",
  );

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "accessibility-readiness"), "BLOCKED");
  assert.equal(report.summary.releaseReady, false);
});

test("inconsistent successful probe evidence is a FAIL", () => {
  const evidence = completeEvidence();
  evidence.probes.providerVerification.exitCode = 99;
  evidence.probes.providerVerification.error = "forged";

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "provider-verification"), "FAIL");
  assert.equal(report.summary.releaseReady, false);
});

test("provider verification gate rejects shallow or cross-tuple Windows reports", () => {
  const cases = [
    ["missing provider lock", (evidence) => {
      delete evidence.probes.providerVerification.report.providerLock;
    }],
    ["pre-sign digest detached from source lock", (evidence) => {
      evidence.probes.providerVerification.report.providerLock.sourceBuild
        .binariesSha256BeforeSigning.main = "0".repeat(64);
    }],
    ["seal tier drift", (evidence) => {
      evidence.probes.providerVerification.report.providerSeal.signingTier =
        "test_signed_internal";
    }],
    ["seal lock drift", (evidence) => {
      evidence.probes.providerVerification.report.providerSeal.lockSha256 =
        "2".repeat(64);
    }],
    ["seal main digest drift", (evidence) => {
      evidence.probes.providerVerification.report.providerSeal.main.sha256 =
        "2".repeat(64);
    }],
    ["provider Authenticode drift", (evidence) => {
      evidence.probes.providerVerification.report.authenticode.files[0]
        .certificateSha256 = "2".repeat(64);
    }],
    ["catalog membership drift", (evidence) => {
      evidence.probes.providerVerification.report.providerCatalog.membership
        .members.push({ relativePath: "payload/extra.dll", sha256: "2".repeat(64) });
    }],
    ["legacy shallow payload inventory", (evidence) => {
      evidence.probes.providerVerification.report.packageLayout = {
        unexpectedExecutablePaths: [],
      };
    }],
  ];

  for (const [label, mutate] of cases) {
    const evidence = completeEvidence();
    mutate(evidence);
    const report = buildWindowsAcceptanceReport(evidence);
    assert.equal(
      gateStatus(report, "provider-verification"),
      "FAIL",
      label,
    );
    assert.equal(report.summary.releaseReady, false, label);
  }
});

test("real installed-provider verifier output passes the report gate and every identity layer fails closed on drift", async () => {
  const fixture = await createInstalledProviderFixture();
  try {
    const evidence = completeEvidence({ production: false });
    const policy = evidence.bindings.releasePolicy;
    fixture.seal.main.signerSubject = policy.providerSignerSubject;
    fixture.seal.main.certificateSha256 =
      policy.providerSignerCertificateSha256;
    fixture.identity.authenticode.files[0].signerSubject =
      policy.providerSignerSubject;
    fixture.identity.authenticode.files[0].certificateSha256 =
      policy.providerSignerCertificateSha256;
    fixture.identity.authenticode.files[1].signerSubject =
      policy.catalogSignerSubject;
    fixture.identity.authenticode.files[1].certificateSha256 =
      policy.catalogSignerCertificateSha256;
    await fixture.writeSeal();

    const verifierReport = await fixture.verify();
    const providerSignature = verifierReport.authenticode.files[0];
    const catalogSignature = verifierReport.authenticode.files[1];
    evidence.bindings.provider = verifierArtifact(
      verifierReport.provider,
      providerSignature,
      { version: "0.8.3" },
    );
    evidence.bindings.providerSeal = {
      path: verifierReport.providerSeal.path,
      exists: true,
      sha256: verifierReport.providerSeal.sha256,
    };
    evidence.bindings.providerCatalog = verifierArtifact(
      verifierReport.providerCatalog,
      catalogSignature,
    );
    const candidate = windowsCandidateManifestFixture({
      policy,
      bindings: evidence.bindings,
      commit: COMMIT,
      releasePolicySha256: evidence.bindings.releasePolicy.sha256,
      production: false,
    });
    candidate.preSignPayloadSha256 =
      verifierReport.providerLock.sourceBuild.binariesSha256BeforeSigning.main;
    evidence.bindings.candidateManifest =
      windowsCandidateManifestReferenceFixture(candidate);
    evidence.probes.providerVerification = passedProbe(
      verifierReport,
      "real installed provider verifier passed",
    );

    const accepted = buildWindowsAcceptanceReport(evidence);
    assert.equal(
      gateStatus(accepted, "provider-verification"),
      "PASS",
      JSON.stringify(accepted.gates),
    );

    const cases = [
      ["version output", (report) => { report.versionProbe.output = "cua-driver 0.8.2"; }],
      ["empty version output", (report) => { report.versionProbe.output = ""; }],
      ["source lock", (report) => {
        report.providerLock.sourceBuild.binariesSha256BeforeSigning.main =
          "0".repeat(64);
      }],
      ["provider seal", (report) => { report.providerSeal.lockSha256 = "0".repeat(64); }],
      ["catalog membership", (report) => { report.providerCatalog.membership.members.pop(); }],
      ["Authenticode identity", (report) => {
        report.authenticode.files[0].certificateSha256 = "0".repeat(64);
      }],
    ];
    for (const [label, mutate] of cases) {
      const drifted = structuredClone(evidence);
      mutate(drifted.probes.providerVerification.report);
      assert.equal(
        gateStatus(buildWindowsAcceptanceReport(drifted), "provider-verification"),
        "FAIL",
        label,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("manual acceptance cannot PASS while carrying an error", () => {
  const evidence = completeEvidence();
  evidence.acceptance.display.error = "forged_manual_error";

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "display-topology"), "FAIL");
  assert.equal(report.summary.releaseReady, false);
});

test("candidate binding rejects a provider hash outside the signed candidate tuple", () => {
  const evidence = completeEvidence();
  evidence.bindings.provider.sha256 = "7".repeat(64);

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "candidate-binding"), "BLOCKED");
  assert.match(
    gateReason(report, "candidate-binding"),
    /candidate_artifact_tuple/u,
  );
  assert.equal(report.summary.releaseReady, false);
});

test("release harness binding cannot self-assert a different commit", async () => {
  const evidence = completeEvidence();
  evidence.bindings.harness.commit = "e".repeat(40);
  const report = buildWindowsAcceptanceReport(evidence);
  assert.equal(gateStatus(report, "candidate-binding"), "BLOCKED");
  assert.match(gateReason(report, "candidate-binding"), /release_harness/u);
  await assert.rejects(
    verifyWindowsReleaseHarnessFiles(
      evidence.bindings.harness,
      evidence.bindings.commit,
    ),
    /release_harness_invalid:commit/u,
  );
});

test("release harness verifier rehashes working scripts and their bound commit blobs", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "ling-windows-harness-test-")),
  );
  const locator =
    process.platform === "win32"
      ? join(process.env.WINDIR, "System32", "where.exe")
      : "/usr/bin/which";
  const located = spawnSync(locator, ["git"], { encoding: "utf8" });
  assert.equal(located.status, 0, located.stderr);
  const gitExecutable = await realpath(
    located.stdout.trim().split(/\r?\n/u)[0],
  );
  try {
    for (const [index, name] of WINDOWS_RELEASE_HARNESS_FILES.entries()) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `release harness ${index}\n`, "utf8");
    }
    for (const args of [
      ["init"],
      ["config", "user.name", "Ling Test"],
      ["config", "user.email", "ling-test@example.invalid"],
      ["add", "."],
      ["commit", "-m", "test harness provenance"],
    ]) {
      const result = spawnSync(gitExecutable, args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const revision = spawnSync(gitExecutable, ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(revision.status, 0, revision.stderr);
    const commit = revision.stdout.trim();
    const harness = {
      schemaVersion: 1,
      commit,
      repositoryRoot: root,
      gitExecutable,
      files: await Promise.all(
        WINDOWS_RELEASE_HARNESS_FILES.map(async (name) => {
          const path = await realpath(join(root, name));
          return {
            name,
            path,
            sha256: createHash("sha256")
              .update(await readFile(path))
              .digest("hex"),
          };
        }),
      ),
    };
    assert.equal(
      (
        await verifyWindowsReleaseHarnessFiles(harness, commit, true, {
          gitExecutable,
        })
      ).commit,
      commit,
    );

    const changed = Buffer.from("locally replaced harness\n", "utf8");
    await writeFile(harness.files[0].path, changed);
    harness.files[0].sha256 = createHash("sha256").update(changed).digest("hex");
    await assert.rejects(
      verifyWindowsReleaseHarnessFiles(harness, commit, true, {
        gitExecutable,
      }),
      /release_harness_commit_blob_mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Full signature acceptance requires a verified approved release policy", () => {
  const evidence = completeEvidence();
  evidence.bindings.releasePolicy.verified = false;
  evidence.bindings.releasePolicy.error = "approval_missing";

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "candidate-binding"), "BLOCKED");
  assert.equal(gateStatus(report, "signature"), "BLOCKED");
  assert.equal(report.summary.releaseReady, false);
});

test("publisher mismatch, missing SmartScreen, visual evidence, or install lifecycle blocks Full", () => {
  const signerMismatch = completeEvidence();
  signerMismatch.bindings.lingInstaller.signature.signerSubject =
    "CN=Different Publisher";
  assert.equal(
    gateStatus(buildWindowsAcceptanceReport(signerMismatch), "signature"),
    "FAIL",
  );

  const missingSmartScreen = completeEvidence();
  missingSmartScreen.acceptance.smartScreen = notAttemptedAcceptance(
    "smartscreen_not_observed",
  );
  assert.equal(
    gateStatus(buildWindowsAcceptanceReport(missingSmartScreen), "signature"),
    "BLOCKED",
  );

  const missingVisual = completeEvidence();
  missingVisual.acceptance.display = notAttemptedAcceptance(
    "cross_display_not_exercised",
  );
  assert.equal(
    gateStatus(buildWindowsAcceptanceReport(missingVisual), "display-topology"),
    "BLOCKED",
  );

  const missingInstall = completeEvidence();
  missingInstall.acceptance.installLifecycle = {
    ...notAttemptedAcceptance("install_lifecycle_not_run"),
    cleanBaselinePassed: null,
    installPassed: null,
    installedSmokePassed: null,
    updatePassed: null,
    uninstallPassed: null,
  };
  assert.equal(
    gateStatus(
      buildWindowsAcceptanceReport(missingInstall),
      "install-cleanliness",
    ),
    "BLOCKED",
  );
});

test("process, install, registry, shortcut, or user-data residue is a FAIL", () => {
  const evidence = completeEvidence();
  evidence.installation.residualPaths = [
    "C:\\Users\\test\\AppData\\Local\\Ling Stack",
  ];

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "install-cleanliness"), "FAIL");
  assert.equal(report.summary.status, "FAIL");
  assert.equal(report.summary.fullAcceptanceStatus, "FAIL");
});

test("Preflight explicitly SKIPs real provider smoke and cannot claim full acceptance", () => {
  const evidence = completeEvidence();
  evidence.mode = "Preflight";
  evidence.probes.providerSmoke = notAttemptedProbe("preflight");

  const report = buildWindowsAcceptanceReport(evidence);

  assert.equal(gateStatus(report, "provider-smoke"), "SKIP");
  assert.equal(gateStatus(report, "installer-payload"), "SKIP");
  assert.equal(report.summary.status, "PASS", JSON.stringify(report.gates));
  assert.equal(report.summary.fullAcceptanceStatus, "BLOCKED");
  assert.equal(report.summary.releaseReady, false);
});

test("Full rejects an installer whose installed app differs or whose uninstaller is unsigned", () => {
  const mismatchedApp = completeEvidence();
  mismatchedApp.probes.installerPayload.report.installedApp.sha256 = "7".repeat(64);
  assert.equal(
    gateStatus(buildWindowsAcceptanceReport(mismatchedApp), "installer-payload"),
    "FAIL",
  );

  const unsignedUninstaller = completeEvidence();
  unsignedUninstaller.probes.installerPayload.report.uninstaller.signature =
    signature("NotSigned");
  assert.equal(
    gateStatus(
      buildWindowsAcceptanceReport(unsignedUninstaller),
      "installer-payload",
    ),
    "FAIL",
  );
});

test("validator rejects a forged PASS that disagrees with captured evidence", () => {
  const evidence = completeEvidence();
  evidence.bindings.provider = missingArtifact({ version: null });
  evidence.probes.providerVerification = notAttemptedProbe("provider_missing");
  evidence.probes.providerSmoke = notAttemptedProbe("provider_missing");
  const report = buildWindowsAcceptanceReport(evidence);
  const forged = structuredClone(report);
  forged.gates.find((gate) => gate.id === "provider-verification").status =
    "PASS";
  forged.summary.status = "PASS";

  assert.throws(
    () => validateWindowsAcceptanceReportShape(forged),
    /windows_acceptance_report_inconsistent/u,
  );
});

test("shape validation rejects self-promoted releaseReady on otherwise complete Full evidence", () => {
  const forged = buildWindowsAcceptanceReport(completeEvidence());
  forged.summary.releaseStatus = "PASS";
  forged.summary.releaseReady = true;
  forged.summary.releaseBlockers = [];
  forged.summary.reviewerAttestation = "trusted_external_signature";
  forged.summary.candidateBuildProvenance = "trusted_external_signature";

  assert.throws(
    () => validateWindowsAcceptanceReportShape(forged),
    /windows_acceptance_report_inconsistent/u,
  );
});

test("CLI evidence verification recomputes referenced file hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-evidence-test-"));
  const path = join(root, "Ling Stack.exe");
  const bytes = Buffer.from("signed candidate bytes", "utf8");
  await writeFile(path, bytes);
  try {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await verifyWindowsAcceptanceEvidenceFiles({
      bindings: { lingApp: { exists: true, path, sha256 } },
    });
    await assert.rejects(
      verifyWindowsAcceptanceEvidenceFiles({
        bindings: { lingApp: { exists: true, path, sha256: "f".repeat(64) } },
      }),
      /file_hash_mismatch:bindings\.lingApp/u,
    );
    const report = buildWindowsAcceptanceReport({
      mode: "Preflight",
      generatedAt: "2026-07-17T12:00:00.000Z",
      bindings: {
        lingApp: { exists: true, path, sha256: "f".repeat(64) },
      },
    });
    await assert.rejects(
      validateWindowsAcceptanceReport(report),
      /file_hash_mismatch:bindings\.lingApp/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Full public file validation requires caller-fixed external trust anchors", async () => {
  const repositoryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "ling-windows-external-root-")),
  );
  const otherRepositoryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "ling-windows-other-root-")),
  );
  try {
    const evidence = completeEvidence();
    evidence.bindings.harness.repositoryRoot = repositoryRoot;
    evidence.bindings.harness.files = evidence.bindings.harness.files.map(
      (file) => ({ ...file, path: join(repositoryRoot, file.name) }),
    );
    const report = buildWindowsAcceptanceReport(evidence);
    const policySha256 = evidence.bindings.releasePolicy.sha256;

    await assert.rejects(
      validateWindowsAcceptanceReport(report),
      /expected_candidate_commit_required/u,
    );
    await assert.rejects(
      validateWindowsAcceptanceReport(report, {
        expectedCandidateCommit: COMMIT,
      }),
      /expected_repository_root_required/u,
    );
    await assert.rejects(
      validateWindowsAcceptanceReport(report, {
        expectedCandidateCommit: COMMIT,
        expectedRepositoryRoot: repositoryRoot,
      }),
      /expected_release_policy_sha256_required/u,
    );
    await assert.rejects(
      validateWindowsAcceptanceReport(report, {
        expectedCandidateCommit: "e".repeat(40),
        expectedRepositoryRoot: repositoryRoot,
        expectedReleasePolicySha256: policySha256,
      }),
      /external_candidate_commit_mismatch/u,
    );
    await assert.rejects(
      validateWindowsAcceptanceReport(report, {
        expectedCandidateCommit: COMMIT,
        expectedRepositoryRoot: repositoryRoot,
        expectedReleasePolicySha256: "7".repeat(64),
      }),
      /external_release_policy_sha256_mismatch/u,
    );
    await assert.rejects(
      validateWindowsAcceptanceReport(report, {
        expectedCandidateCommit: COMMIT,
        expectedRepositoryRoot: otherRepositoryRoot,
        expectedReleasePolicySha256: policySha256,
      }),
      /external_repository_root_mismatch/u,
    );
    await assert.rejects(
      validateWindowsAcceptanceReport(report, {
        expectedCandidateCommit: COMMIT.toUpperCase(),
        expectedRepositoryRoot: repositoryRoot,
        expectedReleasePolicySha256: policySha256.toUpperCase(),
      }),
      /release_harness_git_verifier_required/u,
    );
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
    await rm(otherRepositoryRoot, { recursive: true, force: true });
  }
});

test("Windows acceptance CLI keeps Preflight anchor-free and rejects unanchored Full", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-cli-anchor-test-"));
  const cliPath = fileURLToPath(
    new URL("./windows-acceptance-report.mjs", import.meta.url),
  );
  try {
    const preflightInput = join(root, "preflight-input.json");
    const preflightOutput = join(root, "preflight-report.json");
    await writeFile(
      preflightInput,
      JSON.stringify({
        mode: "Preflight",
        generatedAt: "2026-07-17T12:00:00.000Z",
      }),
      "utf8",
    );
    const preflight = spawnSync(
      process.execPath,
      [cliPath, "--input", preflightInput, "--output", preflightOutput],
      { encoding: "utf8" },
    );
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal(
      JSON.parse(await readFile(preflightOutput, "utf8")).mode,
      "Preflight",
    );

    const fullInput = join(root, "full-input.json");
    await writeFile(fullInput, JSON.stringify(completeEvidence()), "utf8");
    const full = spawnSync(process.execPath, [cliPath, "--input", fullInput], {
      encoding: "utf8",
    });
    assert.equal(full.status, 1);
    assert.match(full.stderr, /expected_candidate_commit_required/u);

    const externallyAnchoredMismatch = spawnSync(
      process.execPath,
      [
        cliPath,
        "--input",
        fullInput,
        "--expected-candidate-commit",
        "e".repeat(40),
        "--expected-repository-root",
        root,
        "--expected-release-policy-sha256",
        "8".repeat(64),
      ],
      { encoding: "utf8" },
    );
    assert.equal(externallyAnchoredMismatch.status, 1);
    assert.match(
      externallyAnchoredMismatch.stderr,
      /external_candidate_commit_mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Full manual evidence is kind-specific, host-bound, attachment-bound, and non-reusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-manual-evidence-test-"));
  const candidateManifestSha256 = "f".repeat(64);
  const host = {
    machineName: "WIN-ACCEPTANCE-01",
    platform: "win32",
    architecture: "x64",
    windowsBuild: "Windows 11 24H2 build 26100.4652",
    session: { id: 2, name: "Console", interactive: true, locked: false },
    displays: [
      { id: "DISPLAY1", scalePercent: 100 },
      { id: "DISPLAY2", scalePercent: 150 },
    ],
  };
  const generatedAt = "2026-07-17T12:10:00.000Z";
  const cell = windowsAcceptanceCellFixture();
  const releasePolicy = {
    approvedAt: "2026-07-17T11:00:00.000Z",
    manualEvidenceReviewers: ["manual-reviewer"],
  };
  try {
    const acceptance = {};
    for (const label of MANUAL_EVIDENCE_LABELS) {
      const attachmentPath = join(root, `${label}-attachment.txt`);
      const attachmentBytes = Buffer.from(`${label} retained evidence`, "utf8");
      await writeFile(attachmentPath, attachmentBytes);
      const document = {
        schemaVersion: 3,
        kind: MANUAL_EVIDENCE_KINDS[label],
        candidateManifestSha256,
        host: {
          machineName: host.machineName,
          platform: host.platform,
          architecture: host.architecture,
          windowsBuild: host.windowsBuild,
          session: host.session,
        },
        operator: { id: "release-owner" },
        reviewer: {
          id: "manual-reviewer",
          reviewedAt: "2026-07-17T12:05:00.000Z",
          status: "review_claimed_unverified",
        },
        case: {
          outcome: "PASS",
          summary: `${label} passed`,
          completedAt: "2026-07-17T12:00:00.000Z",
          error: null,
        },
        details: manualEvidenceDetails(label),
        attachments: [
          {
            path: `${label}-attachment.txt`,
            sha256: createHash("sha256").update(attachmentBytes).digest("hex"),
          },
        ],
      };
      const evidencePath = join(root, `${label}.json`);
      const evidenceBytes = Buffer.from(JSON.stringify(document), "utf8");
      await writeFile(evidencePath, evidenceBytes);
      acceptance[label] = {
        attempted: true,
        passed: true,
        operator: "release-owner",
        evidence: {
          path: evidencePath,
          sha256: createHash("sha256").update(evidenceBytes).digest("hex"),
        },
        error: null,
        ...(label === "installLifecycle"
          ? {
              cleanBaselinePassed: true,
              installPassed: true,
              installedSmokePassed: true,
              updatePassed: true,
              uninstallPassed: true,
            }
          : {}),
      };
    }

    await verifyWindowsFullManualEvidenceFiles({
      acceptance,
      candidateManifestSha256,
      host,
      releasePolicy,
      cell,
      generatedAt,
    });

    const smartScreenBypass = structuredClone(acceptance);
    const smartScreenDocument = JSON.parse(
      await readFile(acceptance.smartScreen.evidence.path, "utf8"),
    );
    smartScreenDocument.details = {
      reputationEstablished: false,
      warningDisplayed: true,
      runAnywayUsed: true,
      installerLaunchAllowed: true,
    };
    const smartScreenBypassPath = join(root, "smartScreen-bypass.json");
    const smartScreenBypassBytes = Buffer.from(
      JSON.stringify(smartScreenDocument),
      "utf8",
    );
    await writeFile(smartScreenBypassPath, smartScreenBypassBytes);
    smartScreenBypass.smartScreen.evidence = {
      path: smartScreenBypassPath,
      sha256: createHash("sha256")
        .update(smartScreenBypassBytes)
        .digest("hex"),
    };
    await assert.rejects(
      verifyWindowsFullManualEvidenceFiles({
        acceptance: smartScreenBypass,
        candidateManifestSha256,
        host,
        releasePolicy,
        cell,
        generatedAt,
      }),
      /manual_pass_details_invalid:smartScreen/u,
    );

    await assert.rejects(
      verifyWindowsFullManualEvidenceFiles({
        acceptance,
        candidateManifestSha256,
        host,
        releasePolicy: { ...releasePolicy, manualEvidenceReviewers: ["someone-else"] },
        cell,
        generatedAt,
      }),
      /manual_evidence_invalid:windowsVersion/u,
    );

    await assert.rejects(
      verifyWindowsFullManualEvidenceFiles({
        acceptance,
        candidateManifestSha256,
        host: {
          ...host,
          displays: [
            { id: "OTHER1", scalePercent: 125 },
            { id: "OTHER2", scalePercent: 175 },
          ],
        },
        releasePolicy,
        cell,
        generatedAt,
      }),
      /manual_pass_details_invalid:display/u,
    );

    const reused = structuredClone(acceptance);
    reused.nvda.evidence = reused.narrator.evidence;
    await assert.rejects(
      verifyWindowsFullManualEvidenceFiles({
        acceptance: reused,
        candidateManifestSha256,
        host,
        releasePolicy,
        cell,
        generatedAt,
      }),
      /manual_evidence_reused:nvda/u,
    );

    const traversal = structuredClone(acceptance);
    traversal.narrator.evidence = structuredClone(acceptance.narrator.evidence);
    const narratorDocument = JSON.parse(
      await readFile(traversal.narrator.evidence.path, "utf8"),
    );
    narratorDocument.attachments[0].path = "../outside.txt";
    const traversalBytes = Buffer.from(JSON.stringify(narratorDocument), "utf8");
    await writeFile(traversal.narrator.evidence.path, traversalBytes);
    traversal.narrator.evidence.sha256 = createHash("sha256")
      .update(traversalBytes)
      .digest("hex");
    await assert.rejects(
      verifyWindowsFullManualEvidenceFiles({
        acceptance: traversal,
        candidateManifestSha256,
        host,
        releasePolicy,
        cell,
        generatedAt,
      }),
      /manual_attachment_path_invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Full host acceptance rejects a build that is not in the approved policy", () => {
  const evidence = completeEvidence();
  evidence.bindings.releasePolicy.supportedWindowsBuilds = [
    "Windows 11 23H2 build 22631.1",
  ];
  const report = buildWindowsAcceptanceReport(evidence);
  assert.equal(gateStatus(report, "host"), "FAIL");
  assert.match(gateReason(report, "host"), /not_approved/u);
  assert.equal(report.summary.releaseReady, false);
});

test("release policy rejects reviewer and candidate-build roles that reuse an SPKI", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-release-policy-role-test-"));
  try {
    const sharedSpki = "6".repeat(64);
    const policy = {
      schemaVersion: 2,
      kind: "ling.windows.release-policy",
      policyVersion: 2,
      status: "approved",
      approvedBy: "release-owner",
      approvedAt: "2026-07-17T11:00:00.000Z",
      lingSignerSubject: "CN=Ling Stack Test Publisher",
      providerSignerSubject: "CN=TryCua Test Publisher",
      lingSignerCertificateSha256: CERT_LING,
      providerSignerCertificateSha256: CERT_PROVIDER,
      supportedWindowsBuilds: ["Windows 11 24H2 build 26100.4652"],
      manualEvidenceReviewers: ["manual-reviewer"],
      reviewerKeys: [policyKey("manual-reviewer", "review-key", sharedSpki)],
      candidateBuildAttestors: [
        policyKey("build-service", "build-key", sharedSpki),
      ],
    };
    const policyReference = await writeJsonReference(
      root,
      "release-policy.json",
      policy,
    );
    Object.assign(policyReference, {
      verified: true,
      kind: policy.kind,
      policyVersion: policy.policyVersion,
      approvedBy: policy.approvedBy,
      approvedAt: policy.approvedAt,
      lingSignerSubject: policy.lingSignerSubject,
      providerSignerSubject: policy.providerSignerSubject,
      lingSignerCertificateSha256: policy.lingSignerCertificateSha256,
      providerSignerCertificateSha256: policy.providerSignerCertificateSha256,
      supportedWindowsBuilds: policy.supportedWindowsBuilds,
      manualEvidenceReviewers: policy.manualEvidenceReviewers,
      reviewerKeys: policy.reviewerKeys,
      candidateBuildAttestors: policy.candidateBuildAttestors,
      error: null,
    });

    await assert.rejects(
      verifyWindowsReleasePolicyReference(policyReference),
      /windows_acceptance_release_policy_invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("candidate manifest binds the approved policy and exact reviewed provider release tuple", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-candidate-manifest-test-"));
  try {
    const policy = windowsReleasePolicyFixture({
      reviewerKeys: [policyKey("manual-reviewer", "review-key", REVIEW_KEY_SHA)],
      candidateBuildAttestors: [
        policyKey("build-service", "build-key", BUILD_KEY_SHA),
      ],
    });
    const policyReference = await writeJsonReference(root, "release-policy.json", policy);
    Object.assign(
      policyReference,
      windowsReleasePolicyReferenceFixture(policy, policyReference),
    );
    const parsedPolicy = await verifyWindowsReleasePolicyReference(policyReference);
    const bindings = {
      commit: COMMIT,
      lingApp: { sha256: SHA_A },
      lingInstaller: { sha256: SHA_B },
      provider: {
        path: "C:\\candidate\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\cua-driver.exe",
        sha256: SHA_C,
      },
      providerSeal: {
        path: "C:\\candidate\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\provider-seal.json",
        sha256: SHA_D,
      },
      providerCatalog: {
        path: "C:\\candidate\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\provider-integrity.cat",
        sha256: WINDOWS_TEST_PROVIDER_CATALOG_SHA256,
      },
      releasePolicy: policyReference,
    };
    const manifest = candidateManifestDocument(bindings);
    const manifestReference = await writeJsonReference(root, "candidate-manifest.json", manifest);
    Object.assign(
      manifestReference,
      windowsCandidateManifestReferenceFixture(manifest, manifestReference),
    );

    await verifyWindowsCandidateManifestReference(
      manifestReference,
      bindings,
      parsedPolicy,
    );

    const unreviewed = structuredClone(manifest);
    unreviewed.providerRelease.archiveSha256 = "0".repeat(64);
    const unreviewedReference = await writeJsonReference(
      root,
      "candidate-manifest-unreviewed.json",
      unreviewed,
    );
    Object.assign(
      unreviewedReference,
      windowsCandidateManifestReferenceFixture(
        unreviewed,
        unreviewedReference,
      ),
    );
    await assert.rejects(
      verifyWindowsCandidateManifestReference(
        unreviewedReference,
        bindings,
        parsedPolicy,
      ),
      /candidate_manifest_tuple_invalid/u,
    );

    const missingDaemonProvenance = structuredClone(manifest);
    delete missingDaemonProvenance.daemonPayload;
    const missingDaemonReference = await writeJsonReference(
      root,
      "candidate-manifest-without-daemon-provenance.json",
      missingDaemonProvenance,
    );
    Object.assign(
      missingDaemonReference,
      windowsCandidateManifestReferenceFixture(
        missingDaemonProvenance,
        missingDaemonReference,
      ),
    );
    await assert.rejects(
      verifyWindowsCandidateManifestReference(
        missingDaemonReference,
        bindings,
        parsedPolicy,
      ),
      /candidate_manifest_tuple_invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows release evidence schemas pin policy, provider tuple, and six manual kinds", async () => {
  const candidateSchema = JSON.parse(
    await readFile(
      new URL("../../../docs/release/evidence/windows-candidate-manifest.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const policySchema = JSON.parse(
    await readFile(
      new URL("../../../docs/release/evidence/windows-release-policy.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const manualSchema = JSON.parse(
    await readFile(
      new URL("../../../docs/release/evidence/windows-full-manual-evidence.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const reviewAttestationSchema = JSON.parse(
    await readFile(
      new URL(
        "../../../docs/release/evidence/windows-review-attestation.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const buildAttestationSchema = JSON.parse(
    await readFile(
      new URL(
        "../../../docs/release/evidence/windows-candidate-build-attestation.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const releaseVerificationSchema = JSON.parse(
    await readFile(
      new URL(
        "../../../docs/release/evidence/windows-release-verification.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  assert.equal(candidateSchema.properties.schemaVersion.const, 4);
  assert.equal(
    candidateSchema.$defs.providerRelease.properties.archiveSha256.const,
    WINDOWS_CUA_DRIVER_RELEASE.sha256,
  );
  assert.equal(
    candidateSchema.$defs.packagedProvider.properties.providerRelativePath
      .const,
    "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/cua-driver.exe",
  );
  assert.ok(candidateSchema.required.includes("tierGovernedArtifacts"));
  assert.ok(candidateSchema.required.includes("vendorNativeInventory"));
  assert.equal(policySchema.properties.kind.const, "ling.windows.release-policy");
  assert.equal(policySchema.properties.schemaVersion.const, 3);
  assert.equal(
    policySchema.properties.supportedWindowsBuilds.minItems,
    1,
  );
  assert.ok(policySchema.required.includes("manualEvidenceReviewers"));
  assert.ok(policySchema.required.includes("reviewerKeys"));
  assert.ok(policySchema.required.includes("candidateBuildAttestors"));
  assert.ok(policySchema.required.includes("requiredAcceptanceCells"));
  assert.equal(manualSchema.properties.schemaVersion.const, 3);
  assert.equal(
    manualSchema.$defs.reviewer.properties.status.const,
    "review_claimed_unverified",
  );
  assert.ok(
    manualSchema.$defs.fileReference.properties.path.pattern.includes("\\.\\."),
  );
  assert.deepEqual(
    manualSchema.properties.kind.enum.slice().sort(),
    Object.values(MANUAL_EVIDENCE_KINDS).sort(),
  );
  assert.ok(manualSchema.$defs.screenReaderDetails);
  assert.ok(manualSchema.$defs.smartScreenDetails);
  assert.ok(manualSchema.$defs.installLifecycleDetails);
  assert.equal(
    reviewAttestationSchema.properties.signature.$ref,
    "#/$defs/signature",
  );
  assert.equal(reviewAttestationSchema.properties.schemaVersion.const, 2);
  assert.ok(buildAttestationSchema.required.includes("daemonPayload"));
  assert.equal(buildAttestationSchema.properties.schemaVersion.const, 2);
  assert.equal(
    releaseVerificationSchema.properties.verdict.properties.releaseReady.const,
    true,
  );
});

function completeEvidence({ production = true } = {}) {
  const cell = windowsAcceptanceCellFixture();
  const policy = windowsReleasePolicyFixture({
    production,
    reviewerKeys: [
      policyKey("manual-reviewer", "review-key", REVIEW_KEY_SHA),
    ],
    candidateBuildAttestors: [
      policyKey("build-service", "build-key", BUILD_KEY_SHA),
    ],
  });
  const evidence = {
    mode: "Full",
    generatedAt: "2026-07-17T12:00:00.000Z",
    handoff: {
      runId: "4a43ddcb-df07-4bf0-8749-88c0b7bf76f3",
      handoffIndexSha256: "6".repeat(64),
      cellManifestSha256: "7".repeat(64),
    },
    cell,
    bindings: {
      commit: COMMIT,
      harness: releaseHarnessFixture(),
      lingApp: artifact(
        "C:\\candidate\\Ling Stack.exe",
        SHA_A,
        "CN=Ling Stack Test Publisher",
      ),
      lingInstaller: artifact(
        "C:\\candidate\\Ling Stack Setup.exe",
        SHA_B,
        "CN=Ling Stack Test Publisher",
      ),
      provider: {
        ...artifact(
          "C:\\candidate\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\cua-driver.exe",
          SHA_C,
          policy.providerSignerSubject,
        ),
        version: "0.8.3",
      },
      providerSeal: {
        path: "C:\\candidate\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\payload\\provider-seal.json",
        exists: true,
        sha256: SHA_D,
      },
      providerCatalog: artifact(
        "C:\\candidate\\resources\\providers\\cua-driver\\0.8.3-ling.1\\win32-x64\\provider-integrity.cat",
        WINDOWS_TEST_PROVIDER_CATALOG_SHA256,
        policy.catalogSignerSubject,
      ),
      releasePolicy: windowsReleasePolicyReferenceFixture(policy),
      candidateManifest: null,
    },
    host: {
      platform: "win32",
      architecture: "x64",
      machineName: "WIN-ACCEPTANCE-01",
      windowsBuild: WINDOWS_TEST_BUILD,
      session: {
        id: 2,
        name: "Console",
        interactive: true,
        locked: false,
      },
      displays: [
        display("DISPLAY1", true, 1920, 1080, 96, 100),
        display("DISPLAY2", false, 2560, 1440, 144, 150),
      ],
      accessibility: {
        narrator: {
          available: true,
          running: false,
          path: "C:\\Windows\\System32\\Narrator.exe",
        },
        nvda: {
          available: true,
          running: false,
          path: "C:\\Program Files\\NVDA\\nvda.exe",
        },
      },
      errors: [],
    },
    installation: {
      observed: true,
      lingProcesses: [],
      providerProcesses: [],
      installRoots: [],
      residualPaths: [],
      registryEntries: [],
      shortcuts: [],
      errors: [],
    },
    probes: {
      providerVerification: passedProbe(null, "provider verifier passed"),
      providerSmoke: passedProbe(null, "capture lifecycle passed"),
      installerPayload: passedProbe(
        {
          schemaVersion: 1,
          mode: "signed_installer_payload_roundtrip",
          cleanBaselinePassed: true,
          cleanupPassed: true,
          installedApp: artifact(
            "C:\\Users\\test\\AppData\\Local\\Programs\\Ling Stack\\Ling Stack.exe",
            SHA_A,
            "CN=Ling Stack Test Publisher",
          ),
          uninstaller: artifact(
            "C:\\Users\\test\\AppData\\Local\\Programs\\Ling Stack\\Uninstall Ling Stack.exe",
            "9".repeat(64),
            "CN=Ling Stack Test Publisher",
          ),
        },
        "signed installer payload roundtrip passed",
      ),
    },
    acceptance: {
      windowsVersion: passedAcceptance("windows-version-review.json", "1"),
      display: passedAcceptance("display-review.json", "2"),
      narrator: passedAcceptance("narrator-review.json", "3"),
      nvda: passedAcceptance("nvda-review.json", "4"),
      smartScreen: passedAcceptance("smartscreen-review.json", "5"),
      installLifecycle: {
        ...passedAcceptance("install-lifecycle.json", "6"),
        cleanBaselinePassed: true,
        installPassed: true,
        installedSmokePassed: true,
        updatePassed: true,
        uninstallPassed: true,
      },
    },
  };
  const candidate = windowsCandidateManifestFixture({
    policy,
    bindings: evidence.bindings,
    commit: COMMIT,
    releasePolicySha256: evidence.bindings.releasePolicy.sha256,
    production,
  });
  evidence.probes.installerPayload.report.installedVendorNativeInventory =
    candidate.vendorNativeInventory.map((entry) => ({
      relativePath: entry.relativePath,
      path: `C:\\Users\\test\\AppData\\Local\\Programs\\Ling Stack\\${entry.relativePath.replaceAll("/", "\\")}`,
      exists: true,
      sha256: entry.sha256,
      signature: {
        checked: true,
        status: entry.authenticodeStatus,
        signerSubject: entry.signerSubject,
        certificateSha256: entry.certificateSha256,
        error: null,
      },
    }));
  evidence.bindings.candidateManifest =
    windowsCandidateManifestReferenceFixture(candidate);
  evidence.probes.providerVerification.report =
    windowsProviderVerificationReportFixture({
      candidate,
      provider: evidence.bindings.provider,
      providerSeal: evidence.bindings.providerSeal,
      providerCatalog: evidence.bindings.providerCatalog,
    });
  return evidence;
}

function releaseHarnessFixture() {
  const repositoryRoot = "C:\\ling-stack";
  return {
    schemaVersion: 1,
    commit: COMMIT,
    repositoryRoot,
    gitExecutable: "C:\\Program Files\\Git\\cmd\\git.exe",
    files: WINDOWS_RELEASE_HARNESS_FILES.map((name, index) => ({
      name,
      path: `${repositoryRoot}\\${name.replaceAll("/", "\\")}`,
      sha256: ((index + 1) % 16).toString(16).repeat(64),
    })),
  };
}

function artifact(path, sha256, signerSubject) {
  return {
    path,
    exists: true,
    sha256,
    signature: signature("Valid", signerSubject),
  };
}

function verifierArtifact(reportArtifact, verifierSignature, extra = {}) {
  return {
    path: reportArtifact.path,
    exists: true,
    sha256: reportArtifact.sha256,
    signature: {
      checked: true,
      status: verifierSignature.status,
      signerSubject: verifierSignature.signerSubject,
      certificateSha256: verifierSignature.certificateSha256,
      timestampStatus: verifierSignature.timestampStatus,
      error: null,
    },
    ...extra,
  };
}

function missingArtifact(extra = {}) {
  return {
    path: null,
    exists: false,
    sha256: null,
    signature: {
      checked: false,
      status: null,
      signerSubject: null,
      certificateSha256: null,
      error: "missing",
    },
    ...extra,
  };
}

function signature(status, signerSubject = "CN=Ling Stack Test Publisher") {
  return {
    checked: true,
    status,
    signerSubject: status === "Valid" ? signerSubject : null,
    certificateSha256:
      status === "Valid"
        ? signerSubject.includes("Catalog")
          ? CERT_CATALOG
          : signerSubject.includes("Cua Driver") ||
              signerSubject.includes("TryCua")
            ? CERT_PROVIDER
            : CERT_LING
        : null,
    error: null,
  };
}

function display(id, primary, width, height, dpi, scalePercent) {
  return {
    id,
    primary,
    width,
    height,
    dpiX: dpi,
    dpiY: dpi,
    scalePercent,
  };
}

function passedProbe(report = null, output = null) {
  return {
    attempted: true,
    passed: true,
    exitCode: 0,
    error: null,
    output,
    report,
  };
}

function notAttemptedProbe(error) {
  return {
    attempted: false,
    passed: null,
    exitCode: null,
    error,
    output: null,
    report: null,
  };
}

function passedAcceptance(path, hashPrefix = "9") {
  return {
    attempted: true,
    passed: true,
    operator: "release-owner",
    evidence: { path: `C:\\evidence\\${path}`, sha256: hashPrefix.repeat(64) },
    error: null,
  };
}

function notAttemptedAcceptance(error) {
  return {
    attempted: false,
    passed: null,
    operator: null,
    evidence: { path: null, sha256: null },
    error,
  };
}

function manualEvidenceDetails(label) {
  if (label === "windowsVersion") {
    return { supportedBuild: true };
  }
  if (label === "display") {
    return {
      displayTopology: "dual",
      displayIds: ["DISPLAY1", "DISPLAY2"],
      dpiProfiles: [100, 150],
      crossDisplayCapturePassed: true,
      visualReviewPassed: true,
    };
  }
  if (label === "narrator" || label === "nvda") {
    return {
      focusPassed: true,
      namesPassed: true,
      orderPassed: true,
      announcementsPassed: true,
      failureRecoveryPassed: true,
    };
  }
  if (label === "smartScreen") {
    return {
      reputationEstablished: true,
      warningDisplayed: false,
      runAnywayUsed: false,
      installerLaunchAllowed: true,
    };
  }
  return {
    cleanBaselinePassed: true,
    installPassed: true,
    installedSmokePassed: true,
    updatePassed: true,
    uninstallPassed: true,
    finalResidueCount: 0,
  };
}

async function writeJsonReference(root, name, value) {
  const path = join(root, name);
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  await writeFile(path, bytes);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function candidateManifestDocument(bindings) {
  const policy = bindings.releasePolicy;
  return windowsCandidateManifestFixture({
    policy,
    bindings,
    commit: bindings.commit,
    releasePolicySha256: bindings.releasePolicy.sha256,
    production:
      bindings.releasePolicy.requiredSigningTier === "production_signed",
  });
}

function policyKey(id, keyId, publicKeySpkiSha256) {
  return { id, keyId, algorithm: "RSA-SHA256", publicKeySpkiSha256 };
}

function signedReleaseAttestationFixture(options = {}) {
  const production = options.production !== false;
  const reviewer = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const build = options.reuseReviewerKeyForBuild
    ? reviewer
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const evidence = completeEvidence({ production });
  evidence.bindings.releasePolicy.reviewerKeys = [
    policyKey(
      "manual-reviewer",
      "review-key",
      publicKeySpkiSha256(reviewer.publicKey),
    ),
  ];
  evidence.bindings.releasePolicy.candidateBuildAttestors = [
    policyKey(
      "build-service",
      "build-key",
      publicKeySpkiSha256(build.publicKey),
    ),
  ];
  const report = buildWindowsAcceptanceReport(evidence);
  const candidateManifest = candidateManifestDocument(evidence.bindings);
  const matrix = signedAcceptanceMatrixFixture(report, candidateManifest);
  const reviewAttestation = {
    schemaVersion: 2,
    kind: "ling.windows.review-attestation",
    scope: "windows-signed-acceptance",
    evidenceSha256: matrix.evidenceSha256,
    candidateManifestSha256: report.bindings.candidateManifest.sha256,
    releasePolicySha256: report.bindings.releasePolicy.sha256,
    signingTier: candidateManifest.signingTier,
    distributionChannel: candidateManifest.distributionChannel,
    productionEligible: candidateManifest.productionEligible,
    reviewerId: "manual-reviewer",
    keyId: "review-key",
    reviewedAt: "2026-07-17T12:05:00.000Z",
    verdict: production ? "RELEASE_PASS" : "INTERNAL_TEST_PASS",
    signature: { algorithm: "RSA-SHA256", valueBase64: "pending" },
  };
  reviewAttestation.signature.valueBase64 = signDetached(
    windowsReviewerAttestationPayload(reviewAttestation),
    reviewer.privateKey,
  );
  const candidateBuildAttestation = {
    schemaVersion: 2,
    kind: "ling.windows.candidate-build-attestation",
    scope: "windows-signed-candidate-build",
    candidateManifestSha256: report.bindings.candidateManifest.sha256,
    candidateCommit: report.bindings.commit,
    releasePolicySha256: report.bindings.releasePolicy.sha256,
    signingTier: candidateManifest.signingTier,
    distributionChannel: candidateManifest.distributionChannel,
    productionEligible: candidateManifest.productionEligible,
    verdict: production ? "RELEASE_PASS" : "INTERNAL_TEST_PASS",
    daemonPayload: structuredClone(candidateManifest.daemonPayload),
    attestorId: "build-service",
    keyId: "build-key",
    attestedAt: "2026-07-17T11:30:00.000Z",
    signature: { algorithm: "RSA-SHA256", valueBase64: "pending" },
  };
  candidateBuildAttestation.signature.valueBase64 = signDetached(
    windowsCandidateBuildAttestationPayload(candidateBuildAttestation),
    build.privateKey,
  );
  return {
    input: {
      report,
      matrix,
      context: {
        releasePolicy: stripReferenceFields(report.bindings.releasePolicy),
        candidateManifest,
        manualEvidence: { reviewerIds: ["manual-reviewer"] },
      },
      candidateManifestSha256: report.bindings.candidateManifest.sha256,
      releasePolicySha256: report.bindings.releasePolicy.sha256,
      reviewAttestation,
      reviewerPublicKey: reviewer.publicKey,
      candidateBuildAttestation,
      candidateBuildPublicKey: build.publicKey,
    },
    reviewerPrivateKey: reviewer.privateKey,
    buildPrivateKey: build.privateKey,
  };
}

function signedAcceptanceMatrixFixture(report, candidateManifest) {
  const artifacts = {
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
  const matrix = {
    schemaVersion: 1,
    kind: "ling.windows.signed-acceptance-matrix",
    finalizedAt: "2026-07-17T12:00:00.000Z",
    handoffIndexSha256: report.handoff.handoffIndexSha256,
    candidateManifestSha256: report.bindings.candidateManifest.sha256,
    releasePolicySha256: report.bindings.releasePolicy.sha256,
    candidateCommit: report.bindings.commit,
    signingTier: candidateManifest.signingTier,
    distributionChannel: candidateManifest.distributionChannel,
    productionEligible: candidateManifest.productionEligible,
    testAuthorityKind: candidateManifest.testAuthorityKind,
    artifacts,
    harness: {
      commit: report.bindings.harness.commit,
      files: report.bindings.harness.files.map(({ name, sha256 }) => ({
        name,
        sha256,
      })),
    },
    cells: report.bindings.releasePolicy.requiredAcceptanceCells.map(
      (cell, index) => ({
        cellId: cell.id,
        runId:
          index === 0
            ? "4a43ddcb-df07-4bf0-8749-88c0b7bf76f3"
            : "5a43ddcb-df07-4bf0-8749-88c0b7bf76f4",
        cellManifestSha256: String(index + 1).repeat(64),
        reportPath: `reports/${cell.id}.json`,
        reportSha256: String(index + 3).repeat(64),
        reportEvidenceSha256: String(index + 5).repeat(64),
        fullAcceptanceStatus: "PASS",
      }),
    ),
    manualReviewerIds: ["manual-reviewer"],
    evidenceSha256: null,
    verdict: {
      status: "MANUAL_REVIEW_REQUIRED",
      fullAcceptanceStatus: "PASS",
      promotionStatus: "ATTESTATION_REQUIRED",
      releaseReady: false,
      releaseBlockers: [
        "external_reviewer_attestation_unverified",
        "candidate_build_provenance_unverified",
      ],
    },
  };
  matrix.evidenceSha256 = windowsAcceptanceMatrixEvidenceSha256(matrix);
  return matrix;
}

function publicKeySpkiSha256(publicKey) {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function signDetached(payload, privateKey) {
  return signPayload(
    "sha256",
    Buffer.from(canonicalJson(payload), "utf8"),
    privateKey,
  ).toString("base64");
}

function stripReferenceFields(value) {
  const cloned = structuredClone(value);
  delete cloned.path;
  delete cloned.sha256;
  delete cloned.verified;
  delete cloned.error;
  return cloned;
}

function gateStatus(report, id) {
  return report.gates.find((gate) => gate.id === id)?.status;
}

function gateReason(report, id) {
  return report.gates.find((gate) => gate.id === id)?.reason ?? "";
}

async function releaseEvidenceSchemaValidator(name) {
  const schema = JSON.parse(
    await readFile(
      new URL(`../../../docs/release/evidence/${name}`, import.meta.url),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

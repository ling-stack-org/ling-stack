import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  WINDOWS_RELEASE_HARNESS_FILES,
  buildWindowsAcceptanceReport,
  validateWindowsAcceptanceReportShape,
  windowsAcceptanceEvidenceSha256,
} from "./windows-acceptance-report.mjs";
import {
  finalizeWindowsSignedAcceptance,
  windowsAcceptanceMatrixEvidenceSha256,
} from "./finalize-windows-signed-acceptance.mjs";
import { WINDOWS_HANDOFF_ARTIFACT_ROLES } from "./windows-handoff-contracts.mjs";
import { loadWindowsCellHandoff } from "./load-windows-cell-handoff.mjs";
import {
  windowsAcceptanceCellFixture,
  windowsCandidateManifestFixture,
  windowsCandidateManifestReferenceFixture,
  windowsProviderVerificationReportFixture,
  windowsReleasePolicyFixture,
  windowsReleasePolicyReferenceFixture,
} from "./windows-release-evidence-fixtures.mjs";

const execFileAsync = promisify(execFile);
const GIT = await findGitExecutable();
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("finalizer closes every required cell without self-promoting", async () => {
  const fixture = await createFinalizerFixture();
  try {
    const { matrix } = await runFinalizer(fixture);
    assert.equal(matrix.cells.length, 2);
    assert.deepEqual(
      matrix.cells.map((cell) => cell.cellId),
      ["win11-24h2-dual-100-150", "win11-24h2-single-100"],
    );
    assert.equal(matrix.signingTier, "test_signed_internal");
    assert.equal(matrix.distributionChannel, "internal");
    assert.equal(matrix.productionEligible, false);
    assert.equal(matrix.verdict.status, "MANUAL_REVIEW_REQUIRED");
    assert.equal(matrix.verdict.releaseReady, false);
    assert.equal(
      matrix.evidenceSha256,
      windowsAcceptanceMatrixEvidenceSha256(matrix),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("cell loader resolves the one-input handoff beneath its anchored root", async () => {
  const fixture = await createFinalizerFixture();
  try {
    await rm(
      join(fixture.root, "reports", "win11-24h2-dual-100-150.json"),
      { force: true },
    );
    const resolved = await loadWindowsCellHandoff(fixture.cellManifestPaths[0]);
    assert.equal(resolved.kind, "ling.windows.resolved-cell-handoff");
    assert.equal(resolved.indexSha256, fixture.indexSha256);
    assert.equal(
      resolved.manifestPath,
      await realpath(fixture.cellManifestPaths[0]),
    );
    assert.equal(resolved.cell.id, "win11-24h2-dual-100-150");
    assert.equal(resolved.releasePolicy.verified, true);
    assert.equal(resolved.candidateManifest.verified, true);
    assert.equal(
      resolved.outputReport,
      join(
        await realpath(fixture.root),
        "reports",
        "win11-24h2-dual-100-150.json",
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects missing, duplicate, and extra cell manifests", async () => {
  const fixture = await createFinalizerFixture();
  try {
    await assert.rejects(
      runFinalizer(fixture, { cellManifestPaths: [fixture.cellManifestPaths[0]] }),
      /cell_manifest_count_invalid/u,
    );
    await assert.rejects(
      runFinalizer(fixture, {
        cellManifestPaths: [
          fixture.cellManifestPaths[0],
          fixture.cellManifestPaths[0],
        ],
      }),
      /cell_manifest_file_set_invalid/u,
    );
    await writeFile(
      join(fixture.root, "cells", "extra.json"),
      "{}\n",
      "utf8",
    );
    await assert.rejects(
      runFinalizer(fixture),
      /cell_manifest_file_set_invalid/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects a cell manifest relabeled as another policy cell", async () => {
  const fixture = await createFinalizerFixture();
  try {
    const path = fixture.cellManifestPaths[0];
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.cell.id = "win11-24h2-single-100";
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(runFinalizer(fixture), /cross_cell_manifest/u);
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects a handoff artifact symlink that escapes the root", async () => {
  const fixture = await createFinalizerFixture();
  const outside = await mkdtemp(join(tmpdir(), "ling-windows-finalizer-outside-"));
  try {
    const outsideProvider = join(outside, "cua-driver.exe");
    await writeFile(outsideProvider, "outside provider", "utf8");
    const escapedLink = join(fixture.root, "candidate", "escaped-provider.exe");
    await symlink(outsideProvider, escapedLink);
    const index = JSON.parse(await readFile(fixture.indexPath, "utf8"));
    index.artifacts.provider = {
      path: "candidate/escaped-provider.exe",
      sha256: await sha256File(outsideProvider),
    };
    await writeFile(
      fixture.indexPath,
      `${JSON.stringify(index, null, 2)}\n`,
      "utf8",
    );
    fixture.indexSha256 = await sha256File(fixture.indexPath);
    await assert.rejects(runFinalizer(fixture), /path_escape:artifact_provider/u);
  } finally {
    await fixture.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("finalizer requires caller-fixed index, candidate, policy, and commit anchors", async () => {
  const fixture = await createFinalizerFixture();
  try {
    for (const overrides of [
      { expectedHandoffIndexSha256: "0".repeat(64) },
      { expectedCandidateManifestSha256: "0".repeat(64) },
      { expectedReleasePolicySha256: "0".repeat(64) },
      { expectedCandidateCommit: "0".repeat(40) },
    ]) {
      await assert.rejects(
        runFinalizer(fixture, overrides),
        /windows_finalizer_(?:handoff_index_digest|candidate_manifest_digest|release_policy_digest|candidate_commit)_mismatch/u,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects a report relabeled with another immutable run", async () => {
  const fixture = await createFinalizerFixture();
  try {
    const manifestPath = fixture.cellManifestPaths[0];
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const reportPath = resolve(dirname(manifestPath), manifest.outputReport.path);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.handoff.runId = "6a43ddcb-df07-4bf0-8749-88c0b7bf76f5";
    report.summary.evidenceSha256 = windowsAcceptanceEvidenceSha256(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await assert.rejects(
      runFinalizer(fixture),
      /windows_finalizer_cell_report_binding_invalid/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("finalizer rejects manual evidence outside the cell manifest and internal SmartScreen injection", async () => {
  const unlistedEvidence = await createFinalizerFixture();
  try {
    const manifestPath = unlistedEvidence.cellManifestPaths[0];
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const reportPath = resolve(dirname(manifestPath), manifest.outputReport.path);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const originalEvidence = report.acceptance.windowsVersion.evidence;
    const unlistedPath = join(dirname(originalEvidence.path), "windowsVersion-unlisted.json");
    await copyFile(originalEvidence.path, unlistedPath);
    report.acceptance.windowsVersion.evidence = {
      path: unlistedPath,
      sha256: await sha256File(unlistedPath),
    };
    report.summary.evidenceSha256 = windowsAcceptanceEvidenceSha256(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    await assert.rejects(
      runFinalizer(unlistedEvidence),
      /windows_finalizer_manual_evidence_binding_mismatch:windowsVersion/u,
    );
  } finally {
    await unlistedEvidence.cleanup();
  }

  const internalSmartScreen = await createFinalizerFixture();
  try {
    const manifestPath = internalSmartScreen.cellManifestPaths[0];
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const reportPath = resolve(dirname(manifestPath), manifest.outputReport.path);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.acceptance.smartScreen = structuredClone(
      report.acceptance.windowsVersion,
    );
    report.summary.evidenceSha256 = windowsAcceptanceEvidenceSha256(report);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    await assert.rejects(
      runFinalizer(internalSmartScreen),
      /windows_finalizer_manual_evidence_binding_mismatch:smartScreen/u,
    );
  } finally {
    await internalSmartScreen.cleanup();
  }
});

test("finalizer rejects vendor-native drift and standard-payload executable injection", async () => {
  const drifted = await createFinalizerFixture();
  try {
    await writeFile(drifted.vendorNativePath, "mutated vendor native\n", "utf8");
    await assert.rejects(
      runFinalizer(drifted),
      /windows_finalizer_file_hash_mismatch:vendor_native_0/u,
    );
  } finally {
    await drifted.cleanup();
  }

  for (const executableName of ["cua-driver-uia.exe", "unexpected.exe"]) {
    const injected = await createFinalizerFixture();
    try {
      await writeFile(
        join(injected.providerDirectory, executableName),
        "injected executable\n",
        "utf8",
      );
      await assert.rejects(
        runFinalizer(injected),
        executableName === "cua-driver-uia.exe"
          ? /windows_finalizer_standard_payload_contains_uiaccess/u
          : /windows_finalizer_standard_payload_executable_extra/u,
      );
    } finally {
      await injected.cleanup();
    }
  }
});

async function createFinalizerFixture() {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-finalizer-"));
  const repositoryRoot = join(root, "repository");
  await mkdir(repositoryRoot, { recursive: true });
  const repositoryCanonicalRoot = await realpath(repositoryRoot);
  for (const relativePath of WINDOWS_RELEASE_HARNESS_FILES) {
    const source = resolve(REPOSITORY_ROOT, relativePath);
    const destination = join(repositoryRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await execFileAsync(GIT, ["init", "-q", repositoryRoot]);
  await execFileAsync(GIT, ["-C", repositoryRoot, "add", "."]);
  await execFileAsync(
    GIT,
    [
      "-C",
      repositoryRoot,
      "-c",
      "user.name=Ling Test",
      "-c",
      "user.email=ling@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
  );
  const { stdout } = await execFileAsync(GIT, [
    "-C",
    repositoryRoot,
    "rev-parse",
    "HEAD",
  ]);
  const commit = stdout.trim();
  const harnessFiles = [];
  for (const name of WINDOWS_RELEASE_HARNESS_FILES) {
    harnessFiles.push({
      name,
      sha256: await sha256File(join(repositoryRoot, name)),
    });
  }

  const cells = [
    windowsAcceptanceCellFixture(),
    windowsAcceptanceCellFixture({
      id: "win11-24h2-single-100",
      displayTopology: "single",
      displayScalePercents: [100],
    }),
  ];
  const policy = windowsReleasePolicyFixture({
    production: false,
    requiredAcceptanceCells: cells,
  });
  await mkdir(join(root, "candidate"), { recursive: true });
  const policyPath = join(root, "candidate", "windows-release-policy.json");
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  const policySha256 = await sha256File(policyPath);

  const appRoot = join(root, "candidate", "win-unpacked");
  const providerRoot = join(
    appRoot,
    "resources",
    "providers",
    "cua-driver",
    "0.8.3-ling.1",
    "win32-x64",
  );
  const providerDirectory = join(providerRoot, "payload");
  await mkdir(providerDirectory, { recursive: true });
  const artifactPaths = {
    lingApp: join(appRoot, "Ling Stack.exe"),
    lingInstaller: join(root, "candidate", "Ling Stack Setup.exe"),
    lingUninstaller: join(root, "candidate", "Uninstall Ling Stack.exe"),
    provider: join(providerDirectory, "ling-cua-driver.exe"),
    providerSeal: join(providerDirectory, "provider-seal.json"),
    providerCatalog: join(providerRoot, "provider-integrity.cat"),
  };
  for (const [role, path] of Object.entries(artifactPaths)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `fixture ${role}\n`, "utf8");
  }
  const vendorPath = join(appRoot, "resources", "vendor", "native.dll");
  await mkdir(dirname(vendorPath), { recursive: true });
  await writeFile(vendorPath, "fixture vendor native\n", "utf8");
  const artifactDigests = Object.fromEntries(
    await Promise.all(
      WINDOWS_HANDOFF_ARTIFACT_ROLES.map(async (role) => [
        role,
        await sha256File(artifactPaths[role]),
      ]),
    ),
  );
  const candidateBindings = Object.fromEntries(
    WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
      role,
      { sha256: artifactDigests[role] },
    ]),
  );
  const candidate = windowsCandidateManifestFixture({
    policy,
    bindings: candidateBindings,
    commit,
    releasePolicySha256: policySha256,
  });
  candidate.vendorNativeInventory[0].sha256 = await sha256File(vendorPath);
  const candidatePath = join(root, "candidate", "candidate-manifest.json");
  await writeFile(
    candidatePath,
    `${JSON.stringify(candidate, null, 2)}\n`,
    "utf8",
  );
  const candidateSha256 = await sha256File(candidatePath);

  const index = {
    schemaVersion: 1,
    kind: "ling.windows.handoff-index",
    createdAt: "2026-07-17T11:30:00.000Z",
    candidateCommit: commit,
    signingTier: candidate.signingTier,
    distributionChannel: candidate.distributionChannel,
    productionEligible: candidate.productionEligible,
    testAuthorityKind: candidate.testAuthorityKind,
    candidateManifest: {
      path: portableRelative(root, candidatePath),
      sha256: candidateSha256,
    },
    releasePolicy: {
      path: portableRelative(root, policyPath),
      sha256: policySha256,
    },
    artifacts: Object.fromEntries(
      WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
        role,
        {
          path: portableRelative(root, artifactPaths[role]),
          sha256: artifactDigests[role],
        },
      ]),
    ),
    harness: { commit, files: harnessFiles },
    cellManifestDirectory: "cells",
    reportDirectory: "reports",
    requiredAcceptanceCells: cells,
  };
  const indexPath = join(root, "handoff-index.json");
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const indexSha256 = await sha256File(indexPath);
  await mkdir(join(root, "cells"));
  await mkdir(join(root, "reports"));
  await mkdir(join(root, "evidence"));

  const cellManifestPaths = [];
  for (const [position, cell] of cells.entries()) {
    const manualEvidence = await createManualEvidence({
      root,
      cell,
      candidateSha256,
      reviewerId: "manual-reviewer",
      suffix: String(position),
    });
    const cellManifestPath = join(root, "cells", `${cell.id}.json`);
    const reportPath = join(root, "reports", `${cell.id}.json`);
    const manifest = {
      schemaVersion: 1,
      kind: "ling.windows.cell-handoff",
      runId:
        position === 0
          ? "4a43ddcb-df07-4bf0-8749-88c0b7bf76f3"
          : "5a43ddcb-df07-4bf0-8749-88c0b7bf76f4",
      handoffIndex: { path: "../handoff-index.json", sha256: indexSha256 },
      cell,
      expected: {
        candidateCommit: commit,
        candidateManifestSha256: candidateSha256,
        releasePolicySha256: policySha256,
        handoffIndexSha256: indexSha256,
        signingTier: candidate.signingTier,
        distributionChannel: candidate.distributionChannel,
        productionEligible: candidate.productionEligible,
        testAuthorityKind: candidate.testAuthorityKind,
        artifacts: artifactDigests,
        harnessCommit: commit,
      },
      inputs: {
        repositoryRoot: "../repository",
        candidateManifest: manifestReference(cellManifestPath, candidatePath, candidateSha256),
        releasePolicy: manifestReference(cellManifestPath, policyPath, policySha256),
        ...Object.fromEntries(
          WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
            role,
            manifestReference(
              cellManifestPath,
              artifactPaths[role],
              artifactDigests[role],
            ),
          ]),
        ),
        manualEvidence: Object.fromEntries(
          Object.entries(manualEvidence.references).map(([role, reference]) => [
            role,
            reference
              ? manifestReference(
                  cellManifestPath,
                  reference.path,
                  reference.sha256,
                )
              : null,
          ]),
        ),
      },
      outputReport: {
        path: portableRelative(dirname(cellManifestPath), reportPath),
      },
      requiredToolVersions: {
        node: ">=22.0.0",
        powershell: ">=7.4.0",
        git: ">=2.45.0",
      },
    };
    await writeFile(
      cellManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const manifestSha256 = await sha256File(cellManifestPath);
    const rawEvidence = buildRawAcceptanceEvidence({
      root,
      repositoryRoot: repositoryCanonicalRoot,
      gitExecutable: GIT,
      harnessFiles,
      commit,
      indexSha256,
      manifestSha256,
      manifest,
      cell,
      policy,
      policyPath,
      policySha256,
      candidate,
      candidatePath,
      candidateSha256,
      artifactPaths,
      artifactDigests,
      manualEvidence,
    });
    const report = buildWindowsAcceptanceReport(rawEvidence);
    validateWindowsAcceptanceReportShape(report);
    assert.equal(report.summary.fullAcceptanceStatus, "PASS");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    cellManifestPaths.push(cellManifestPath);
  }

  return {
    root,
    indexPath,
    indexSha256,
    candidateSha256,
    policySha256,
    commit,
    cellManifestPaths,
    providerDirectory,
    vendorNativePath: vendorPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function buildRawAcceptanceEvidence({
  repositoryRoot,
  gitExecutable,
  harnessFiles,
  commit,
  indexSha256,
  manifestSha256,
  manifest,
  cell,
  policy,
  policyPath,
  policySha256,
  candidate,
  candidatePath,
  candidateSha256,
  artifactPaths,
  artifactDigests,
  manualEvidence,
}) {
  const signature = (signerSubject, certificateSha256) => ({
    checked: true,
    status: "Valid",
    signerSubject,
    certificateSha256,
    error: null,
  });
  const artifact = (path, sha256, signerSubject, certificateSha256) => ({
    path,
    exists: true,
    sha256,
    signature: signature(signerSubject, certificateSha256),
  });
  const lingApp = artifact(
    artifactPaths.lingApp,
    artifactDigests.lingApp,
    policy.lingSignerSubject,
    policy.lingSignerCertificateSha256,
  );
  const lingInstaller = artifact(
    artifactPaths.lingInstaller,
    artifactDigests.lingInstaller,
    policy.lingSignerSubject,
    policy.lingSignerCertificateSha256,
  );
  const provider = {
    ...artifact(
      artifactPaths.provider,
      artifactDigests.provider,
      policy.providerSignerSubject,
      policy.providerSignerCertificateSha256,
    ),
    version: "0.8.3",
  };
  const providerCatalog = artifact(
    artifactPaths.providerCatalog,
    artifactDigests.providerCatalog,
    policy.catalogSignerSubject,
    policy.catalogSignerCertificateSha256,
  );
  const displays =
    cell.displayTopology === "single"
      ? [display("DISPLAY1", true, 100)]
      : [display("DISPLAY1", true, 100), display("DISPLAY2", false, 150)];
  return {
    mode: "Full",
    generatedAt: "2026-07-17T12:10:00.000Z",
    handoff: {
      runId: manifest.runId,
      handoffIndexSha256: indexSha256,
      cellManifestSha256: manifestSha256,
    },
    cell,
    bindings: {
      commit,
      harness: {
        schemaVersion: 1,
        commit,
        repositoryRoot,
        gitExecutable,
        files: harnessFiles.map((file) => ({
          ...file,
          path: join(repositoryRoot, file.name),
        })),
      },
      lingApp,
      lingInstaller,
      provider,
      providerSeal: {
        path: artifactPaths.providerSeal,
        exists: true,
        sha256: artifactDigests.providerSeal,
      },
      providerCatalog,
      releasePolicy: windowsReleasePolicyReferenceFixture(policy, {
        path: policyPath,
        sha256: policySha256,
      }),
      candidateManifest: windowsCandidateManifestReferenceFixture(candidate, {
        path: candidatePath,
        sha256: candidateSha256,
      }),
    },
    host: {
      platform: "win32",
      architecture: "x64",
      machineName: `WIN-${cell.id}`,
      windowsBuild: cell.windowsBuild,
      session: {
        id: 2,
        name: "Console",
        interactive: true,
        locked: false,
      },
      displays,
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
      providerVerification: passedProbe(
        windowsProviderVerificationReportFixture({
          candidate,
          provider,
          providerSeal: {
            path: artifactPaths.providerSeal,
            sha256: artifactDigests.providerSeal,
          },
          providerCatalog,
        }),
      ),
      providerSmoke: passedProbe(null),
      installerPayload: passedProbe({
        schemaVersion: 1,
        mode: "signed_installer_payload_roundtrip",
        cleanBaselinePassed: true,
        cleanupPassed: true,
        installedApp: lingApp,
        uninstaller: artifact(
          artifactPaths.lingUninstaller,
          artifactDigests.lingUninstaller,
          policy.lingSignerSubject,
          policy.lingSignerCertificateSha256,
        ),
        installedVendorNativeInventory: candidate.vendorNativeInventory.map(
          (entry) => ({
            relativePath: entry.relativePath,
            path: join(
              dirname(artifactPaths.lingApp),
              ...entry.relativePath.split("/"),
            ),
            exists: true,
            sha256: entry.sha256,
            signature: {
              checked: true,
              status: entry.authenticodeStatus,
              signerSubject: entry.signerSubject,
              certificateSha256: entry.certificateSha256,
              error: null,
            },
          }),
        ),
      }),
    },
    acceptance: manualEvidence.acceptance,
  };
}

async function createManualEvidence({
  root,
  cell,
  candidateSha256,
  reviewerId,
  suffix,
}) {
  const directory = join(root, "evidence", cell.id);
  await mkdir(directory, { recursive: true });
  const hostDisplays =
    cell.displayTopology === "single"
      ? [{ id: "DISPLAY1", scalePercent: 100 }]
      : [
          { id: "DISPLAY1", scalePercent: 100 },
          { id: "DISPLAY2", scalePercent: 150 },
        ];
  const references = {
    windowsVersion: null,
    display: null,
    narrator: null,
    nvda: null,
    smartScreen: null,
    installLifecycle: null,
  };
  const acceptance = {};
  for (const role of [
    "windowsVersion",
    "display",
    "narrator",
    "nvda",
    "installLifecycle",
  ]) {
    const attachmentPath = join(directory, `${role}-${suffix}.txt`);
    await writeFile(attachmentPath, `${role} ${cell.id}\n`, "utf8");
    const document = {
      schemaVersion: 3,
      kind: `ling.windows.full-evidence.${manualKind(role)}`,
      candidateManifestSha256: candidateSha256,
      host: {
        machineName: `WIN-${cell.id}`,
        platform: "win32",
        architecture: "x64",
        windowsBuild: cell.windowsBuild,
        session: { id: 2, name: "Console", interactive: true, locked: false },
      },
      operator: { id: "windows-operator" },
      reviewer: {
        id: reviewerId,
        reviewedAt: "2026-07-17T12:05:00.000Z",
        status: "review_claimed_unverified",
      },
      case: {
        outcome: "PASS",
        summary: `${role} passed`,
        completedAt: "2026-07-17T12:00:00.000Z",
        error: null,
      },
      details: manualDetails(role, cell, hostDisplays),
      attachments: [
        {
          path: `./${role}-${suffix}.txt`,
          sha256: await sha256File(attachmentPath),
        },
      ],
    };
    const path = join(directory, `${role}.json`);
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    const reference = { path, sha256: await sha256File(path) };
    references[role] = reference;
    acceptance[role] = {
      attempted: true,
      passed: true,
      operator: "windows-operator",
      evidence: reference,
      error: null,
      ...(role === "installLifecycle"
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
  acceptance.smartScreen = {
    attempted: false,
    passed: null,
    operator: null,
    evidence: { path: null, sha256: null },
    error: "production_only",
  };
  return { references, acceptance };
}

function manualDetails(role, cell, hostDisplays) {
  if (role === "windowsVersion") return { supportedBuild: true };
  if (role === "display") {
    return {
      displayTopology: cell.displayTopology,
      displayIds: hostDisplays.map((display) => display.id),
      dpiProfiles: cell.displayScalePercents,
      crossDisplayCapturePassed:
        cell.displayTopology === "single" ? null : true,
      visualReviewPassed: true,
    };
  }
  if (role === "narrator" || role === "nvda") {
    return {
      focusPassed: true,
      namesPassed: true,
      orderPassed: true,
      announcementsPassed: true,
      failureRecoveryPassed: true,
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

function manualKind(role) {
  return role === "windowsVersion"
    ? "windows-version"
    : role === "installLifecycle"
      ? "install-lifecycle"
      : role;
}

function display(id, primary, scalePercent) {
  return {
    id,
    primary,
    width: 1920,
    height: 1080,
    dpiX: (96 * scalePercent) / 100,
    dpiY: (96 * scalePercent) / 100,
    scalePercent,
  };
}

function passedProbe(report) {
  return {
    attempted: true,
    passed: true,
    exitCode: 0,
    error: null,
    output: "passed",
    report,
  };
}

async function runFinalizer(fixture, overrides = {}) {
  return finalizeWindowsSignedAcceptance(
    {
      handoffIndexPath: fixture.indexPath,
      cellManifestPaths:
        overrides.cellManifestPaths ?? fixture.cellManifestPaths,
    },
    {
      expectedHandoffIndexSha256:
        overrides.expectedHandoffIndexSha256 ?? fixture.indexSha256,
      expectedCandidateManifestSha256:
        overrides.expectedCandidateManifestSha256 ?? fixture.candidateSha256,
      expectedReleasePolicySha256:
        overrides.expectedReleasePolicySha256 ?? fixture.policySha256,
      expectedCandidateCommit:
        overrides.expectedCandidateCommit ?? fixture.commit,
      gitExecutable: GIT,
      now: "2026-07-17T12:20:00.000Z",
    },
  );
}

function manifestReference(manifestPath, targetPath, sha256) {
  return {
    path: portableRelative(dirname(manifestPath), targetPath),
    sha256,
  };
}

function portableRelative(from, to) {
  return relative(from, to).replaceAll("\\", "/");
}

async function findGitExecutable() {
  let executable;
  if (process.platform === "win32") {
    const result = await execFileAsync("where.exe", ["git.exe"]);
    executable = result.stdout.split(/\r?\n/u).find(Boolean);
  } else {
    const result = await execFileAsync("/usr/bin/which", ["git"]);
    executable = result.stdout.trim();
  }
  if (!executable || !isAbsolute(executable)) {
    throw new TypeError("windows_finalizer_test_git_executable_invalid");
  }
  return executable;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

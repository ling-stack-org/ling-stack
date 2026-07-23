import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  WINDOWS_RELEASE_HARNESS_FILES,
} from "./windows-acceptance-report.mjs";
import { loadWindowsCellHandoff } from "./load-windows-cell-handoff.mjs";
import {
  publishWindowsAcceptanceHandoffRoot,
  produceWindowsAcceptanceHandoff,
  writeWindowsCandidateManifest,
} from "./produce-windows-acceptance-handoff.mjs";
import {
  windowsAcceptanceCellFixture,
  windowsReleasePolicyFixture,
} from "./windows-release-evidence-fixtures.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

test("producer freezes candidate v4 and emits one immutable handoff per policy cell", async () => {
  const fixture = await createProducerFixture();
  try {
    const candidateResult = await writeWindowsCandidateManifest({
      ...fixture.common,
      outputPath: fixture.candidatePath,
    });
    await createEvidence(fixture, candidateResult.sha256);
    const result = await produceWindowsAcceptanceHandoff({
      ...fixture.common,
      candidateManifestPath: fixture.candidatePath,
      evidenceMapPath: fixture.evidenceMapPath,
      outputRoot: fixture.outputRoot,
      now: "2026-07-21T10:00:00.000Z",
      randomUUID: uuidSequence([
        "4a43ddcb-df07-4bf0-8749-88c0b7bf76f3",
        "5a43ddcb-df07-4bf0-8749-88c0b7bf76f4",
      ]),
    });

    assert.equal(result.cellManifestPaths.length, 2);
    const candidate = JSON.parse(await readFile(result.candidateManifestPath, "utf8"));
    assert.equal(candidate.schemaVersion, 4);
    assert.equal(candidate.signingTier, "test_signed_internal");
    assert.equal(candidate.distributionChannel, "internal");
    assert.equal(candidate.productionEligible, false);
    assert.equal(candidate.tierGovernedArtifacts.provider.sha256, fixture.finalProviderSha256);
    assert.notEqual(candidate.preSignPayloadSha256, fixture.finalProviderSha256);
    const vendorNative = candidate.vendorNativeInventory[0];
    const copiedVendorNativePath = join(
      result.root,
      "candidate",
      "artifacts",
      ...vendorNative.relativePath.split("/"),
    );
    assert.equal(await sha256File(copiedVendorNativePath), vendorNative.sha256);

    for (const manifestPath of result.cellManifestPaths) {
      const loaded = await loadWindowsCellHandoff(manifestPath);
      assert.equal(loaded.indexSha256, result.indexSha256);
      assert.equal(
        loaded.candidateManifest.sha256,
        candidateResult.sha256,
      );
      assert.equal(loaded.expected.signingTier, "test_signed_internal");
      assert.equal(loaded.requiredToolVersions.node, ">=22.0.0");
    }

    await assert.rejects(
      produceWindowsAcceptanceHandoff({
        ...fixture.common,
        candidateManifestPath: fixture.candidatePath,
        evidenceMapPath: fixture.evidenceMapPath,
        outputRoot: fixture.outputRoot,
      }),
      /windows_handoff_output_exists/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("producer rejects artifact drift after the candidate manifest was frozen", async () => {
  const fixture = await createProducerFixture();
  try {
    const candidate = await writeWindowsCandidateManifest({
      ...fixture.common,
      outputPath: fixture.candidatePath,
    });
    await createEvidence(fixture, candidate.sha256);
    await writeFile(fixture.finalProviderPath, "mutated signed provider\n", "utf8");
    await assert.rejects(
      produceWindowsAcceptanceHandoff({
        ...fixture.common,
        candidateManifestPath: fixture.candidatePath,
        evidenceMapPath: fixture.evidenceMapPath,
        outputRoot: fixture.outputRoot,
      }),
      /windows_handoff_candidate_source_drift/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("producer rejects candidate source paths that escape through a parent symlink", async () => {
  const fixture = await createProducerFixture();
  try {
    const outsideRoot = join(fixture.root, "outside-artifacts");
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "Ling Stack.exe"), "escaped app\n", "utf8");
    await symlink(
      outsideRoot,
      join(fixture.inputRoot, "escaped-artifacts"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const source = JSON.parse(
      await readFile(fixture.common.candidateSourcePath, "utf8"),
    );
    source.artifacts.lingApp.path = "escaped-artifacts/Ling Stack.exe";
    await writeFile(
      fixture.common.candidateSourcePath,
      `${JSON.stringify(source, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      writeWindowsCandidateManifest({
        ...fixture.common,
        outputPath: fixture.candidatePath,
      }),
      /windows_handoff_path_escape:artifact_lingApp/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("producer clones the exact commit from a sibling Git worktree", async () => {
  const fixture = await createProducerFixture();
  try {
    const siblingWorktree = join(fixture.root, "repository-worktree");
    await execFileAsync(fixture.common.gitExecutable, [
      "-C",
      fixture.common.repositoryRoot,
      "worktree",
      "add",
      "--detach",
      siblingWorktree,
      "HEAD",
    ]);
    const common = { ...fixture.common, repositoryRoot: siblingWorktree };
    const candidate = await writeWindowsCandidateManifest({
      ...common,
      outputPath: fixture.candidatePath,
    });
    await createEvidence(fixture, candidate.sha256);
    const result = await produceWindowsAcceptanceHandoff({
      ...common,
      candidateManifestPath: fixture.candidatePath,
      evidenceMapPath: fixture.evidenceMapPath,
      outputRoot: fixture.outputRoot,
    });
    const loaded = await loadWindowsCellHandoff(result.cellManifestPaths[0]);
    assert.equal(loaded.expected.candidateCommit, candidate.candidate.commit);
  } finally {
    await fixture.cleanup();
  }
});

test("production handoff requires and copies SmartScreen evidence for every cell", async () => {
  const fixture = await createProducerFixture({ production: true });
  try {
    const candidate = await writeWindowsCandidateManifest({
      ...fixture.common,
      outputPath: fixture.candidatePath,
    });
    await createEvidence(fixture, candidate.sha256);
    const evidenceMap = JSON.parse(
      await readFile(fixture.evidenceMapPath, "utf8"),
    );
    evidenceMap.cells[0].manualEvidence.smartScreen = null;
    await writeFile(
      fixture.evidenceMapPath,
      `${JSON.stringify(evidenceMap, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      produceWindowsAcceptanceHandoff({
        ...fixture.common,
        candidateManifestPath: fixture.candidatePath,
        evidenceMapPath: fixture.evidenceMapPath,
        outputRoot: fixture.outputRoot,
      }),
      /windows_evidence_map_reference_invalid:smartScreen/u,
    );

    await createEvidence(fixture, candidate.sha256);
    const result = await produceWindowsAcceptanceHandoff({
      ...fixture.common,
      candidateManifestPath: fixture.candidatePath,
      evidenceMapPath: fixture.evidenceMapPath,
      outputRoot: fixture.outputRoot,
    });
    for (const manifestPath of result.cellManifestPaths) {
      const loaded = await loadWindowsCellHandoff(manifestPath);
      assert.equal(loaded.expected.signingTier, "production_signed");
      assert.equal(loaded.expected.distributionChannel, "production");
      assert.equal(loaded.expected.productionEligible, true);
      assert.match(loaded.manualEvidence.smartScreen, /smartScreen/u);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("producer rejects reused manual evidence and attachment bytes across cells", async () => {
  const fixture = await createProducerFixture();
  try {
    const candidate = await writeWindowsCandidateManifest({
      ...fixture.common,
      outputPath: fixture.candidatePath,
    });
    await createEvidence(fixture, candidate.sha256);
    const evidenceMap = JSON.parse(
      await readFile(fixture.evidenceMapPath, "utf8"),
    );
    evidenceMap.cells[1].manualEvidence.narrator =
      evidenceMap.cells[0].manualEvidence.narrator;
    await writeFile(
      fixture.evidenceMapPath,
      `${JSON.stringify(evidenceMap, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      produceWindowsAcceptanceHandoff({
        ...fixture.common,
        candidateManifestPath: fixture.candidatePath,
        evidenceMapPath: fixture.evidenceMapPath,
        outputRoot: fixture.outputRoot,
      }),
      /windows_handoff_manual_evidence_reused:narrator/u,
    );

    await createEvidence(fixture, candidate.sha256);
    const firstAttachment = join(
      fixture.inputRoot,
      "evidence",
      fixture.cells[0].id,
      "narrator",
      "attachment.txt",
    );
    const secondAttachment = join(
      fixture.inputRoot,
      "evidence",
      fixture.cells[1].id,
      "narrator",
      "attachment.txt",
    );
    await copyFile(firstAttachment, secondAttachment);
    const secondEvidencePath = join(
      fixture.inputRoot,
      "evidence",
      fixture.cells[1].id,
      "narrator",
      "evidence.json",
    );
    const secondEvidence = JSON.parse(await readFile(secondEvidencePath, "utf8"));
    secondEvidence.attachments[0].sha256 = await sha256File(secondAttachment);
    await writeFile(
      secondEvidencePath,
      `${JSON.stringify(secondEvidence, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      produceWindowsAcceptanceHandoff({
        ...fixture.common,
        candidateManifestPath: fixture.candidatePath,
        evidenceMapPath: fixture.evidenceMapPath,
        outputRoot: fixture.outputRoot,
      }),
      /windows_handoff_manual_attachment_reused:narrator/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("producer rejects a repository dirtied after candidate freeze", async () => {
  const fixture = await createProducerFixture();
  try {
    const candidate = await writeWindowsCandidateManifest({
      ...fixture.common,
      outputPath: fixture.candidatePath,
    });
    await createEvidence(fixture, candidate.sha256);
    await writeFile(
      join(fixture.common.repositoryRoot, "untracked-after-freeze.txt"),
      "dirty\n",
      "utf8",
    );
    await assert.rejects(
      produceWindowsAcceptanceHandoff({
        ...fixture.common,
        candidateManifestPath: fixture.candidatePath,
        evidenceMapPath: fixture.evidenceMapPath,
        outputRoot: fixture.outputRoot,
      }),
      /windows_handoff_repository_dirty/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("handoff publication never replaces a concurrently claimed output root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-publish-"));
  const stagingRoot = join(root, "staging");
  const outputRoot = join(root, "handoff");
  try {
    await mkdir(stagingRoot);
    for (const directory of [
      "repository",
      "candidate",
      "evidence",
      "cells",
      "reports",
    ]) {
      await mkdir(join(stagingRoot, directory));
    }
    await writeFile(join(stagingRoot, "handoff-index.json"), "{}\n", "utf8");

    // This is the exact state created by a competing publisher after the
    // producer's early absence check but before its final publication step.
    await mkdir(outputRoot);
    await writeFile(join(outputRoot, "owner.txt"), "other publisher\n", "utf8");

    await assert.rejects(
      publishWindowsAcceptanceHandoffRoot(stagingRoot, outputRoot),
      /windows_handoff_output_exists/u,
    );
    assert.equal(
      await readFile(join(outputRoot, "owner.txt"), "utf8"),
      "other publisher\n",
    );
    assert.equal(
      await readFile(join(stagingRoot, "handoff-index.json"), "utf8"),
      "{}\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createProducerFixture({ production = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ling-windows-producer-"));
  const gitExecutable = await findGitExecutable();
  const repositoryRoot = join(root, "repository-source");
  await mkdir(repositoryRoot, { recursive: true });
  for (const relativePath of WINDOWS_RELEASE_HARNESS_FILES) {
    const destination = join(repositoryRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(REPOSITORY_ROOT, relativePath), destination);
  }
  await execFileAsync(gitExecutable, ["init", "-q", repositoryRoot]);
  await execFileAsync(gitExecutable, ["-C", repositoryRoot, "add", "."]);
  await execFileAsync(gitExecutable, [
    "-C",
    repositoryRoot,
    "-c",
    "user.name=Ling Test",
    "-c",
    "user.email=ling@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);

  const cells = [
    windowsAcceptanceCellFixture(),
    windowsAcceptanceCellFixture({
      id: "win11-24h2-single-100",
      displayTopology: "single",
      displayScalePercents: [100],
    }),
  ];
  const policy = windowsReleasePolicyFixture({
    production,
    requiredAcceptanceCells: cells,
  });
  const inputRoot = join(root, "inputs");
  const artifactRoot = join(inputRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const paths = {
    lingApp: join(artifactRoot, "Ling Stack.exe"),
    lingInstaller: join(artifactRoot, "Ling Stack Setup.exe"),
    lingUninstaller: join(artifactRoot, "Uninstall Ling Stack.exe"),
    provider: join(artifactRoot, "cua-driver.exe"),
    providerSeal: join(artifactRoot, "provider-seal.json"),
    providerCatalog: join(artifactRoot, "provider-integrity.cat"),
    preSignProvider: join(artifactRoot, "cua-driver.pre-sign.exe"),
    auditOnlyUiAccess: join(artifactRoot, "cua-driver-uia.audit.exe"),
    vendorNative: join(artifactRoot, "vendor-native.dll"),
  };
  for (const [role, path] of Object.entries(paths)) {
    await writeFile(path, `fixture ${role}\n`, "utf8");
  }
  const policyPath = join(inputRoot, "windows-release-policy.json");
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

  const lingSignature = signature(
    policy.lingSignerSubject,
    policy.lingSignerCertificateSha256,
    production ? "Valid" : "NotRequired",
  );
  const providerSignature = signature(
    policy.providerSignerSubject,
    policy.providerSignerCertificateSha256,
    production ? "Valid" : "NotRequired",
  );
  const catalogSignature = signature(
    policy.catalogSignerSubject,
    policy.catalogSignerCertificateSha256,
    production ? "Valid" : "NotRequired",
  );
  const source = {
    schemaVersion: 1,
    kind: "ling.windows.candidate-production-input",
    preSignProvider: { path: "artifacts/cua-driver.pre-sign.exe" },
    auditOnlyUiAccess: { path: "artifacts/cua-driver-uia.audit.exe" },
    daemonPayload: {
      strategy: "signed-candidate-embedded-daemon",
      treeSha256: "7".repeat(64),
    },
    artifacts: {
      lingApp: artifact(
        "artifacts/Ling Stack.exe",
        "Ling Stack.exe",
        lingSignature,
      ),
      lingInstaller: artifact(
        "artifacts/Ling Stack Setup.exe",
        "Ling Stack Setup.exe",
        lingSignature,
      ),
      lingUninstaller: artifact(
        "artifacts/Uninstall Ling Stack.exe",
        "Uninstall Ling Stack.exe",
        lingSignature,
      ),
      provider: artifact(
        "artifacts/cua-driver.exe",
        "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/payload/cua-driver.exe",
        providerSignature,
      ),
      providerSeal: { path: "artifacts/provider-seal.json" },
      providerCatalog: artifact(
        "artifacts/provider-integrity.cat",
        "resources/providers/cua-driver/0.8.3-ling.1/win32-x64/provider-integrity.cat",
        catalogSignature,
      ),
    },
    vendorNativeInventory: [
      {
        path: "artifacts/vendor-native.dll",
        relativePath: "resources/vendor/vendor-native.dll",
        signature: {
          authenticodeStatus: "Valid",
          signerSubject: "CN=Electron Vendor",
          certificateSha256: "0".repeat(64),
        },
      },
    ],
  };
  const candidateSourcePath = join(inputRoot, "candidate-source.json");
  await writeFile(
    candidateSourcePath,
    `${JSON.stringify(source, null, 2)}\n`,
    "utf8",
  );
  return {
    root,
    common: {
      repositoryRoot,
      gitExecutable,
      releasePolicyPath: policyPath,
      candidateSourcePath,
    },
    cells,
    policy,
    inputRoot,
    candidatePath: join(root, "candidate-manifest.json"),
    evidenceMapPath: join(inputRoot, "evidence-map.json"),
    outputRoot: join(root, "handoff"),
    finalProviderPath: paths.provider,
    finalProviderSha256: await sha256File(paths.provider),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function createEvidence(fixture, candidateManifestSha256) {
  const cellEntries = [];
  for (const cell of fixture.cells) {
    const manualEvidence = {};
    const roles = [
      "windowsVersion",
      "display",
      "narrator",
      "nvda",
      "installLifecycle",
      ...(fixture.policy.requiredDistributionChannel === "production"
        ? ["smartScreen"]
        : []),
    ];
    for (const role of roles) {
      const directory = join(fixture.inputRoot, "evidence", cell.id, role);
      await mkdir(directory, { recursive: true });
      const attachmentPath = join(directory, "attachment.txt");
      await writeFile(
        attachmentPath,
        `attachment ${cell.id} ${role}\n`,
        "utf8",
      );
      const evidencePath = join(directory, "evidence.json");
      const document = manualEvidenceDocument({
        role,
        cell,
        candidateManifestSha256,
        reviewerId: fixture.policy.manualEvidenceReviewers[0],
        attachmentSha256: await sha256File(attachmentPath),
      });
      await writeFile(
        evidencePath,
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      );
      manualEvidence[role] = relativeFrom(fixture.inputRoot, evidencePath);
    }
    if (fixture.policy.requiredDistributionChannel === "internal") {
      manualEvidence.smartScreen = null;
    }
    cellEntries.push({ cellId: cell.id, manualEvidence });
  }
  await writeFile(
    fixture.evidenceMapPath,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "ling.windows.acceptance-evidence-map",
      cells: cellEntries,
    }, null, 2)}\n`,
    "utf8",
  );
}

function manualEvidenceDocument({
  role,
  cell,
  candidateManifestSha256,
  reviewerId,
  attachmentSha256,
}) {
  return {
    schemaVersion: 3,
    kind: {
      windowsVersion: "ling.windows.full-evidence.windows-version",
      display: "ling.windows.full-evidence.display",
      narrator: "ling.windows.full-evidence.narrator",
      nvda: "ling.windows.full-evidence.nvda",
      smartScreen: "ling.windows.full-evidence.smartscreen",
      installLifecycle: "ling.windows.full-evidence.install-lifecycle",
    }[role],
    candidateManifestSha256,
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
      reviewedAt: "2026-07-21T09:00:00.000Z",
      status: "review_claimed_unverified",
    },
    case: {
      outcome: "PASS",
      summary: `${role} passed`,
      completedAt: "2026-07-21T08:59:00.000Z",
      error: null,
    },
    details: manualDetails(role, cell),
    attachments: [{ path: "attachment.txt", sha256: attachmentSha256 }],
  };
}

function manualDetails(role, cell) {
  if (role === "windowsVersion") return { supportedBuild: true };
  if (role === "display") {
    return {
      displayTopology: cell.displayTopology,
      displayIds: cell.displayTopology === "single" ? ["DISPLAY1"] : ["DISPLAY1", "DISPLAY2"],
      dpiProfiles: cell.displayScalePercents,
      crossDisplayCapturePassed: cell.displayTopology === "single" ? null : true,
      visualReviewPassed: true,
    };
  }
  if (role === "installLifecycle") {
    return {
      cleanBaselinePassed: true,
      installPassed: true,
      installedSmokePassed: true,
      updatePassed: true,
      uninstallPassed: true,
      finalResidueCount: 0,
    };
  }
  if (role === "smartScreen") {
    return {
      reputationEstablished: true,
      warningDisplayed: false,
      runAnywayUsed: false,
      installerLaunchAllowed: true,
    };
  }
  return {
    focusPassed: true,
    namesPassed: true,
    orderPassed: true,
    announcementsPassed: true,
    failureRecoveryPassed: true,
  };
}

function artifact(path, relativePath, observedSignature) {
  return { path, relativePath, signature: observedSignature };
}

function signature(
  signerSubject,
  certificateSha256,
  timestampStatus = "NotRequired",
) {
  return {
    authenticodeStatus: "Valid",
    signerSubject,
    certificateSha256,
    timestampStatus,
  };
}

function uuidSequence(values) {
  let index = 0;
  return () => values[index++];
}

function relativeFrom(root, path) {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}

async function findGitExecutable() {
  if (process.platform === "win32") {
    const result = await execFileAsync("where.exe", ["git.exe"]);
    return result.stdout.split(/\r?\n/u).find(Boolean);
  }
  const result = await execFileAsync("/usr/bin/which", ["git"]);
  return result.stdout.trim();
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

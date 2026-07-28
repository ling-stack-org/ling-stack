import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import {
  WINDOWS_HANDOFF_ARTIFACT_ROLES,
  validateWindowsCellHandoffDocument,
  validateWindowsHandoffIndexDocument,
} from "./windows-handoff-contracts.mjs";
import {
  validateWindowsCandidateManifestDocument,
  validateWindowsReleasePolicyDocument,
} from "./windows-release-evidence-contracts.mjs";

export async function loadWindowsCellHandoff(manifestPath) {
  const manifestRealPath = await realpath(resolve(manifestPath));
  const manifestDirectory = dirname(manifestRealPath);
  const manifestFile = await readJsonWithDigest(manifestRealPath, "cell_manifest");
  const manifest = validateWindowsCellHandoffDocument(manifestFile.document);
  const indexPath = await resolveExistingPath(
    manifestDirectory,
    manifest.handoffIndex.path,
    "handoff_index",
  );
  const handoffRoot = dirname(indexPath);
  assertInside(handoffRoot, manifestRealPath, "cell_manifest");
  const indexFile = await readJsonWithDigest(indexPath, "handoff_index");
  const index = validateWindowsHandoffIndexDocument(indexFile.document);
  if (
    indexFile.sha256 !== manifest.handoffIndex.sha256 ||
    indexFile.sha256 !== manifest.expected.handoffIndexSha256
  ) {
    throw new TypeError("windows_handoff_loader_index_digest_mismatch");
  }
  const cellManifestDirectory = await resolveExistingPath(
    dirname(indexPath),
    index.cellManifestDirectory,
    "cell_manifest_directory",
  );
  if (dirname(manifestRealPath) !== cellManifestDirectory) {
    throw new TypeError("windows_handoff_loader_manifest_directory_mismatch");
  }
  const policyCell = index.requiredAcceptanceCells.find(
    (cell) => cell.id === manifest.cell.id,
  );
  if (!policyCell || !isDeepStrictEqual(policyCell, manifest.cell)) {
    throw new TypeError("windows_handoff_loader_cell_mismatch");
  }
  assertExpectedTuple(manifest.expected, index);

  const resolvedInputs = {};
  for (const role of [
    "candidateManifest",
    "releasePolicy",
    ...WINDOWS_HANDOFF_ARTIFACT_ROLES,
  ]) {
    const manifestReference = manifest.inputs[role];
    const indexReference =
      role === "candidateManifest" || role === "releasePolicy"
        ? index[role]
        : index.artifacts[role];
    const resolved = await resolveAndVerifyReference(
      handoffRoot,
      manifestDirectory,
      manifestReference,
      `input_${role}`,
    );
    const indexed = await resolveAndVerifyReference(
      handoffRoot,
      dirname(indexPath),
      indexReference,
      `index_${role}`,
    );
    if (resolved.path !== indexed.path || resolved.sha256 !== indexed.sha256) {
      throw new TypeError(`windows_handoff_loader_input_mismatch:${role}`);
    }
    resolvedInputs[role] = resolved.path;
  }
  const repositoryRoot = await resolveExistingPath(
    manifestDirectory,
    manifest.inputs.repositoryRoot,
    "repository_root",
  );
  assertInside(handoffRoot, repositoryRoot, "repository_root");
  const manualEvidence = {};
  for (const [role, reference] of Object.entries(
    manifest.inputs.manualEvidence,
  )) {
    if (reference === null) {
      manualEvidence[role] = null;
      continue;
    }
    manualEvidence[role] = (
      await resolveAndVerifyReference(
        handoffRoot,
        manifestDirectory,
        reference,
        `manual_${role}`,
      )
    ).path;
  }
  const reportDirectory = await resolveExistingPath(
    dirname(indexPath),
    index.reportDirectory,
    "report_directory",
  );
  const outputReport = await resolveFuturePath(
    handoffRoot,
    manifestDirectory,
    manifest.outputReport.path,
    "output_report",
  );
  if (dirname(outputReport) !== reportDirectory) {
    throw new TypeError("windows_handoff_loader_output_directory_mismatch");
  }

  const policyFile = await readJsonWithDigest(
    resolvedInputs.releasePolicy,
    "release_policy",
  );
  const policy = validateWindowsReleasePolicyDocument(policyFile.document);
  const candidateFile = await readJsonWithDigest(
    resolvedInputs.candidateManifest,
    "candidate_manifest",
  );
  const candidate = validateWindowsCandidateManifestDocument(
    candidateFile.document,
    {
      policy,
      expectedCommit: index.candidateCommit,
      expectedReleasePolicySha256: index.releasePolicy.sha256,
    },
  );
  if (
    candidateFile.sha256 !== index.candidateManifest.sha256 ||
    policyFile.sha256 !== index.releasePolicy.sha256 ||
    candidate.signingTier !== index.signingTier ||
    candidate.distributionChannel !== index.distributionChannel ||
    candidate.productionEligible !== index.productionEligible ||
    candidate.testAuthorityKind !== index.testAuthorityKind
  ) {
    throw new TypeError("windows_handoff_loader_document_tuple_mismatch");
  }

  return {
    schemaVersion: 1,
    kind: "ling.windows.resolved-cell-handoff",
    handoffRoot,
    manifestPath: manifestRealPath,
    manifestSha256: manifestFile.sha256,
    indexPath,
    indexSha256: indexFile.sha256,
    runId: manifest.runId,
    cell: manifest.cell,
    expected: manifest.expected,
    repositoryRoot,
    outputReport,
    inputs: resolvedInputs,
    manualEvidence,
    requiredToolVersions: manifest.requiredToolVersions,
    releasePolicy: {
      path: resolvedInputs.releasePolicy,
      sha256: policyFile.sha256,
      verified: true,
      ...policy,
      error: null,
    },
    candidateManifest: {
      path: resolvedInputs.candidateManifest,
      sha256: candidateFile.sha256,
      verified: true,
      ...candidate,
      error: null,
    },
  };
}

function assertExpectedTuple(expected, index) {
  const artifactDigests = Object.fromEntries(
    WINDOWS_HANDOFF_ARTIFACT_ROLES.map((role) => [
      role,
      index.artifacts[role].sha256,
    ]),
  );
  if (
    expected.candidateCommit !== index.candidateCommit ||
    expected.candidateManifestSha256 !== index.candidateManifest.sha256 ||
    expected.releasePolicySha256 !== index.releasePolicy.sha256 ||
    expected.signingTier !== index.signingTier ||
    expected.distributionChannel !== index.distributionChannel ||
    expected.productionEligible !== index.productionEligible ||
    expected.testAuthorityKind !== index.testAuthorityKind ||
    expected.harnessCommit !== index.harness.commit ||
    !isDeepStrictEqual(expected.artifacts, artifactDigests)
  ) {
    throw new TypeError("windows_handoff_loader_expected_tuple_mismatch");
  }
}

async function resolveAndVerifyReference(root, owner, reference, label) {
  const path = await resolveExistingPath(owner, reference.path, label);
  assertInside(root, path, label);
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== reference.sha256) {
    throw new TypeError(`windows_handoff_loader_hash_mismatch:${label}`);
  }
  return { path, sha256 };
}

async function resolveExistingPath(owner, path, label) {
  if (!isSafeManifestPath(path)) {
    throw new TypeError(`windows_handoff_loader_path_invalid:${label}`);
  }
  try {
    return await realpath(resolve(owner, path));
  } catch {
    throw new TypeError(`windows_handoff_loader_path_unresolvable:${label}`);
  }
}

async function resolveFuturePath(root, owner, path, label) {
  if (!isSafeManifestPath(path)) {
    throw new TypeError(`windows_handoff_loader_path_invalid:${label}`);
  }
  const candidate = resolve(owner, path);
  const parent = await realpath(dirname(candidate));
  assertInside(root, parent, `${label}_parent`);
  const resolved = resolve(parent, candidate.slice(dirname(candidate).length + 1));
  assertInside(root, resolved, label);
  try {
    await access(resolved);
    throw new TypeError(`windows_handoff_loader_output_exists:${label}`);
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === `windows_handoff_loader_output_exists:${label}`
    ) {
      throw error;
    }
  }
  return resolved;
}

function assertInside(root, path, label) {
  const fromRoot = relative(root, path);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new TypeError(`windows_handoff_loader_path_escape:${label}`);
  }
}

function isSafeManifestPath(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:[\\/]/u.test(value)
  );
}

async function readJsonWithDigest(path, label) {
  const bytes = await readFile(path);
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new TypeError(`windows_handoff_loader_json_invalid:${label}`);
  }
  return {
    document,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help || !values.manifest) {
    process.stdout.write(
      "Usage: node load-windows-cell-handoff.mjs --manifest <windows-cell-handoff.json>\n",
    );
    if (!values.help) process.exitCode = 2;
    return;
  }
  process.stdout.write(
    `${JSON.stringify(await loadWindowsCellHandoff(values.manifest), null, 2)}\n`,
  );
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Windows cell handoff load failed: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}

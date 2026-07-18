import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  SigningContractError,
  canonicalJson,
  sha256Bytes,
} from "./signing-contract.mjs";

const FIXTURE_ARCHIVE_MAGIC = "LING-CUA-SIGNING-FIXTURE-ARCHIVE-V1";
const ALLOWED_KINDS = new Set(["zip", "dmg", "nsis"]);

/**
 * Build a small, deterministic archive fixture.  It deliberately is not a
 * ZIP/DMG/NSIS implementation and is never shipped; the extension only lets
 * the feasibility harness exercise Electron Builder's artifact callback on
 * every target family without a certificate, notarization service, or hosted
 * signing VM.  The extractor reopens the file, verifies each member digest,
 * and materialises a clean root before the normal provider verifier runs.
 */
export async function writeFixtureArtifact({ sourceRoot, artifactPath, kind }) {
  assertKind(kind);
  const root = resolve(sourceRoot);
  const entries = [];
  await collectFiles(root, root, entries);
  const document = {
    magic: FIXTURE_ARCHIVE_MAGIC,
    schemaVersion: 1,
    kind,
    entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
  };
  await mkdir(dirname(resolve(artifactPath)), { recursive: true });
  await writeFile(resolve(artifactPath), `${canonicalJson(document)}\n`, { flag: "wx" });
  return Object.freeze({
    artifactPath: resolve(artifactPath),
    kind,
    sha256: sha256Bytes(Buffer.from(canonicalJson(document), "utf8")),
    entryCount: entries.length,
  });
}

export async function extractFixtureArtifact({ artifactPath, destinationRoot, expectedKind }) {
  const path = resolve(artifactPath);
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new SigningContractError("fixture_artifact_invalid", `Cannot reopen ${path}`, { cause: error });
  }
  if (
    document?.magic !== FIXTURE_ARCHIVE_MAGIC ||
    document?.schemaVersion !== 1 ||
    !Array.isArray(document.entries)
  ) {
    throw new SigningContractError("fixture_artifact_invalid", `Invalid fixture artifact: ${path}`);
  }
  assertKind(document.kind);
  if (expectedKind !== undefined && document.kind !== expectedKind) {
    throw new SigningContractError(
      "fixture_artifact_kind_mismatch",
      `Expected ${expectedKind}, got ${document.kind}`,
    );
  }
  const root = resolve(destinationRoot);
  await mkdir(root, { recursive: true });
  for (const entry of document.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !isSafeRelativePath(entry.path) ||
      typeof entry.contentBase64 !== "string" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new SigningContractError("fixture_artifact_member_invalid", "Invalid fixture artifact member");
    }
    const bytes = Buffer.from(entry.contentBase64, "base64");
    if (sha256Bytes(bytes) !== entry.sha256) {
      throw new SigningContractError(
        "fixture_artifact_member_digest_mismatch",
        `Fixture artifact member changed: ${entry.path}`,
      );
    }
    const target = resolve(root, entry.path);
    if (!isWithin(target, root)) {
      throw new SigningContractError("fixture_artifact_path_escape", `Member escapes root: ${entry.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
  }
  return root;
}

async function collectFiles(root, current, result) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SigningContractError("fixture_artifact_symlink", `Symlinks are not archive inputs: ${path}`);
    }
    if (entry.isDirectory()) {
      await collectFiles(root, path, result);
      continue;
    }
    if (!entry.isFile()) {
      throw new SigningContractError("fixture_artifact_member_invalid", `Not a regular file: ${path}`);
    }
    const bytes = await readFile(path);
    result.push({
      path: relative(root, path).replaceAll("\\", "/"),
      sha256: sha256Bytes(bytes),
      contentBase64: bytes.toString("base64"),
    });
  }
}

function assertKind(kind) {
  if (!ALLOWED_KINDS.has(kind)) {
    throw new SigningContractError("fixture_artifact_kind_invalid", `Unsupported fixture artifact kind: ${String(kind)}`);
  }
}

function isSafeRelativePath(path) {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    path !== "." &&
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !path.includes("\0")
  );
}

function isWithin(candidate, root) {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
}

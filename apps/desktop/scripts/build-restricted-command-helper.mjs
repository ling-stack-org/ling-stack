import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildNativeEvidence } from "../../../native/sandbox/scripts/build.mjs";
import { readReviewedCodesignSource, assertReviewedCodesignBuildManifest } from "./packaged-codesign-review-publication.mjs";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const publications = new WeakMap();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function requireBuild(value) {
  if (!value) throw new Error("restricted_command_package_build_invalid");
}
function fileIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  requireBuild(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path
    && stat.size > 0n && stat.size <= 64n * 1024n * 1024n);
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid),
    sizeBytes: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
}
/**
 * Fixed trusted build origin. No caller chooses target, inputs, executable,
 * manifest, review row, receipt constructor, or existing staged artifact.
 * The only receipt maker is this module-private original fresh pipeline.
 */
export function buildFreshRestrictedCommandHelperPublication() {
  requireBuild(process.platform === "darwin" && process.arch === "arm64");
  const { review, sourceReviewSha256 } = readReviewedCodesignSource();
  const parent = mkdtempSync(join(tmpdir(), "ling-restricted-package-"));
  const build = join(parent, "build"), staged = join(desktopRoot, "dist", ".restricted-command-next");
  const destination = join(desktopRoot, "dist", "restricted-command");
  try {
    ensureGeneratedDistDirectory();
    const manifest = buildNativeEvidence({ target: "aarch64-apple-darwin", output: build });
    assertReviewedCodesignBuildManifest(manifest);
    requireBuild(manifest.target === "aarch64-apple-darwin" && manifest.verification.releaseBuild === "passed"
      && manifest.verification.inputCapture === "passed" && manifest.fixedCodesignLeaf?.parserProtocol === "passed");
    const freshBinary = join(build, "ling-sandbox-runner"), freshBinaryBytes = readFileSync(freshBinary);
    requireBuild(hash(freshBinaryBytes) === manifest.binary.sha256 && freshBinaryBytes.length === manifest.binary.sizeBytes);
    rmGenerated(staged); mkdirSync(staged, { recursive: false, mode: 0o700 });
    cpSync(freshBinary, join(staged, "ling-sandbox-runner"), { errorOnExist: true });
    chmodSync(join(staged, "ling-sandbox-runner"), 0o755);
    cpSync(join(build, "licenses"), join(staged, "licenses"), { recursive: true, errorOnExist: true });
    const packagedBinary = join(staged, "ling-sandbox-runner");
    normalizeDarwinCodeSignature(packagedBinary);
    const normalizedBytes = readFileSync(packagedBinary);
    const packagedManifest = { ...manifest, binary: { ...manifest.binary, sha256: hash(normalizedBytes), sizeBytes: normalizedBytes.length } };
    requireBuild(packagedManifest.binary.sizeBytes > 0 && packagedManifest.binary.sizeBytes <= manifest.binary.sizeBytes
      && packagedManifest.binary.sha256 !== manifest.binary.sha256);
    const manifestBytes = Buffer.from(JSON.stringify(packagedManifest, null, 2) + "\n");
    writeFileSync(join(staged, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    // Bind source-approved ORIGINAL fresh result before any generated artifact
    // can become a read-back source. A copied/self-created JSON grants nothing.
    assertReviewedCodesignBuildManifest(manifest);
    requireBuild(readReviewedCodesignSource().sourceReviewSha256 === sourceReviewSha256
      && readFileSync(freshBinary).equals(freshBinaryBytes));
    rmGenerated(destination); renameSync(staged, destination);
    const helperPath = join(destination, "ling-sandbox-runner"), manifestPath = join(destination, "manifest.json");
    const descriptor = Object.freeze({ schemaVersion: 1, reviewId: review.reviewId, sourceReviewSha256,
      manifestSha256: hash(manifestBytes), helperVersion: manifest.helperVersion,
      unsignedBinarySha256: packagedManifest.binary.sha256, unsignedBinarySizeBytes: packagedManifest.binary.sizeBytes,
      sourceSha256: Object.freeze({ ...review.sourceSha256 }), runtime: Object.freeze({ ...review.runtime }),
      os: Object.freeze({ ...review.os }), trust: review.trust });
    const token = Object.freeze({});
    publications.set(token, { descriptor, helperPath, manifestPath, helperIdentity: fileIdentity(helperPath),
      manifestIdentity: fileIdentity(manifestPath), normalizedBytes: Buffer.from(normalizedBytes), manifestBytes: Buffer.from(manifestBytes) });
    readOriginalRestrictedCommandBuildPublication(token);
    return token;
  } finally { rmSync(parent, { recursive: true, force: true }); }
}
/** Exact private provenance plus read-back; fake/stale staged JSON or caller token cannot mint a literal. */
export function readOriginalRestrictedCommandBuildPublication(token) {
  const owned = publications.get(token);
  requireBuild(owned && Object.isFrozen(token) && Reflect.ownKeys(token).length === 0);
  requireBuild(JSON.stringify(fileIdentity(owned.helperPath)) === JSON.stringify(owned.helperIdentity)
    && JSON.stringify(fileIdentity(owned.manifestPath)) === JSON.stringify(owned.manifestIdentity)
    && readFileSync(owned.helperPath).equals(owned.normalizedBytes) && readFileSync(owned.manifestPath).equals(owned.manifestBytes));
  requireBuild(readReviewedCodesignSource().sourceReviewSha256 === owned.descriptor.sourceReviewSha256);
  return owned.descriptor;
}
function ensureGeneratedDistDirectory() {
  const dist = join(desktopRoot, "dist");
  try {
    const stat = lstatSync(dist); requireBuild(stat.isDirectory() && !stat.isSymbolicLink());
  } catch (error) { if (error?.code !== "ENOENT") throw error; mkdirSync(dist, { mode: 0o700 }); }
}
function normalizeDarwinCodeSignature(path) {
  const result = spawnSync("/usr/bin/codesign", ["--remove-signature", path], { encoding: "utf8", windowsHide: true });
  requireBuild(!result.error && !result.signal && result.status === 0);
}
function rmGenerated(path) {
  if (!path.startsWith(resolve(desktopRoot, "dist") + "/")) throw new Error("restricted_command_package_path_invalid");
  try {
    const stat = lstatSync(path); requireBuild(stat.isDirectory() && !stat.isSymbolicLink());
    rmSync(path, { recursive: true });
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--platform" || args[1] !== "darwin") throw new Error("restricted_command_package_platform_invalid");
  const token = buildFreshRestrictedCommandHelperPublication(), publication = readOriginalRestrictedCommandBuildPublication(token);
  process.stdout.write(JSON.stringify({ target: "aarch64-apple-darwin", helperVersion: publication.helperVersion,
    binarySha256: publication.unsignedBinarySha256, destination: join(desktopRoot, "dist", "restricted-command") }) + "\n");
}

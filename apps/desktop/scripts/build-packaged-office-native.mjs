import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNativeEvidence } from "../../../native/office-local/scripts/build.mjs";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "../../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts";
import { readLocalPackagedOfficeSource, assertReviewedOfficeNativeBuild } from "./packaged-office-native-review.mjs";
import { resolveSigningProfile } from "./cua-driver-signing/signing-contract.mjs";

const desktopRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const nativeRoot = join(desktopRoot, "../../native/office-local");
const publications = new WeakMap();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
let building = false;
let activeToken;
function requireBuild(value) { if (!value) throw new Error("packaged_office_native_publication_invalid"); }
function identity(path, maximum) {
  const stat = lstatSync(path, { bigint: true });
  requireBuild(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path
    && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o022n) === 0n && stat.size > 0n && stat.size <= BigInt(maximum));
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid),
    sizeBytes: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
}
function directory(path) {
  const stat = lstatSync(path);
  requireBuild(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path
    && stat.uid === process.getuid() && (stat.mode & 0o022) === 0);
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid) });
}
function ensureDist() {
  const path = join(desktopRoot, "dist");
  try { directory(path); }
  catch (cause) { if (cause?.code !== "ENOENT") throw cause; mkdirSync(path, { mode: 0o700 }); directory(path); }
}
function stageLeaves(root, expected, prefix = "") {
  const leaves = [];
  directory(root);
  const stream = opendirSync(root);
  const names = [];
  try {
    for (;;) {
      const entry = stream.readSync();
      if (!entry) break;
      requireBuild(names.length < expected.length);
      names.push(entry.name);
    }
  } finally { stream.closeSync(); }
  for (const name of names) {
    const path = join(root, name), relativePath = prefix + name, stat = lstatSync(path);
    requireBuild(!stat.isSymbolicLink());
    if (stat.isDirectory()) {
      requireBuild(expected.some(path => path.startsWith(relativePath + "/")));
      leaves.push(...stageLeaves(path, expected, relativePath + "/"));
    } else { requireBuild(stat.isFile() && expected.includes(relativePath)); leaves.push(relativePath); }
  }
  return leaves;
}
function signAndVerify(path) {
  const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const argv of [
    ["--force", "--sign", "-", "--identifier", "com.ling-stack.office-local.native", "--timestamp=none", path],
    ["--verify", "--strict", path],
  ]) {
    const result = spawnSync("/usr/bin/codesign", argv, { env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    requireBuild(!result.error && !result.signal && result.status === 0);
  }
}

/**
 * Original same-process fresh build. No caller artifact, path, signer, receipt,
 * or review argument. Failed/interrupted outputs remain available for diagnosis.
 * The opaque token selects build data, never Core authority or runtime permission.
 */
export function buildFreshPackagedOfficeNativePublication() {
  requireBuild(!building && activeToken === undefined && process.platform === "darwin" && process.arch === "arm64"
    && resolveSigningProfile().signingTier === "unsigned_dev");
  building = true;
  try {
    const { review, sourceReviewSha256 } = readLocalPackagedOfficeSource();
    ensureDist();
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-package-")));
    const buildRoot = join(parent, "build");
    const evidence = buildNativeEvidence({ output: buildRoot, headers: review.headers.root, compiler: review.compiler.path });
    assertReviewedOfficeNativeBuild(evidence, { review, sourceReviewSha256 });
    const unsignedPath = join(buildRoot, "office-local.node"), unsignedIdentity = identity(unsignedPath, 64 * 1024 * 1024);
    const unsignedBytes = readFileSync(unsignedPath);
    requireBuild(hash(unsignedBytes) === evidence.binary.sha256 && unsignedBytes.length === evidence.binary.bytes
      && JSON.stringify(identity(unsignedPath, 64 * 1024 * 1024)) === JSON.stringify(unsignedIdentity));
    const stage = mkdtempSync(join(desktopRoot, "dist", ".office-local-next-"));
    const binary = join(stage, "office-local.node");
    cpSync(unsignedPath, binary, { errorOnExist: true, force: false }); chmodSync(binary, 0o600);
    const copyIdentity = identity(binary, 64 * 1024 * 1024);
    requireBuild(readFileSync(binary).equals(unsignedBytes)
      && JSON.stringify(identity(binary, 64 * 1024 * 1024)) === JSON.stringify(copyIdentity));
    signAndVerify(binary);
    const finalIdentity = identity(binary, 64 * 1024 * 1024);
    const finalBytes = readFileSync(binary);
    requireBuild(finalBytes.length > 0 && finalBytes.length <= 64 * 1024 * 1024
      && finalBytes.length <= unsignedBytes.length + 1024 * 1024
      && JSON.stringify(identity(binary, 64 * 1024 * 1024)) === JSON.stringify(finalIdentity));
    const pins = new Map([["office-local.node", { maximum: 64 * 1024 * 1024, identity: finalIdentity,
      bytes: Buffer.from(finalBytes), digest: hash(finalBytes) }]]);
    for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
      const destination = join(stage, "source", name);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      cpSync(join(nativeRoot, name), destination, { errorOnExist: true, force: false }); chmodSync(destination, 0o600);
      const sourceIdentity = identity(destination, 4 * 1024 * 1024), sourceBytes = readFileSync(destination);
      requireBuild(hash(sourceBytes) === review.sourceSha256[name]
        && JSON.stringify(identity(destination, 4 * 1024 * 1024)) === JSON.stringify(sourceIdentity));
      pins.set("source/" + name, { maximum: 4 * 1024 * 1024, identity: sourceIdentity,
        bytes: sourceBytes, digest: review.sourceSha256[name] });
    }
    const manifestBytes = Buffer.from(JSON.stringify(evidence, null, 2) + "\n");
    writeFileSync(join(stage, "build-manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
    pins.set("build-manifest.json", { maximum: 1024 * 1024, identity: identity(join(stage, "build-manifest.json"), 1024 * 1024),
      bytes: manifestBytes, digest: hash(manifestBytes) });
    assertReviewedOfficeNativeBuild(evidence, { review, sourceReviewSha256 });
    requireBuild(readLocalPackagedOfficeSource().sourceReviewSha256 === sourceReviewSha256
      && readFileSync(unsignedPath).equals(unsignedBytes)
      && JSON.stringify(identity(unsignedPath, 64 * 1024 * 1024)) === JSON.stringify(unsignedIdentity));
    const directories = new Map([["", directory(stage)]]);
    for (const name of pins.keys()) {
      const parts = name.split("/");
      for (let end = 1; end < parts.length; end++) {
        const relativePath = parts.slice(0, end).join("/");
        if (!directories.has(relativePath)) directories.set(relativePath, directory(join(stage, relativePath)));
      }
    }
    const destination = join(desktopRoot, "dist", "office-local");
    try {
      directory(destination);
      // Keep the previous generated package instead of silently destroying it.
      // The repository and OS temp directory may live on different volumes.
      renameSync(destination, mkdtempSync(join(desktopRoot, ".office-local-previous-")) + "/stage");
    } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
    renameSync(stage, destination);
    const descriptor = Object.freeze({ schemaVersion: 1, reviewId: review.reviewId, protocolVersion: 2, napiVersion: 8,
      deploymentTarget: "13.0", sourceReviewSha256, buildManifestSha256: hash(manifestBytes),
      unsignedBinarySha256: hash(unsignedBytes), unsignedBinarySizeBytes: unsignedBytes.length,
      finalBinarySha256: hash(finalBytes), finalBinarySizeBytes: finalBytes.length,
      sourceSha256: Object.freeze({ ...review.sourceSha256 }), runtime: Object.freeze({ ...review.runtime }),
      signing: Object.freeze({ ...review.signing }), trust: review.trust });
    const token = Object.freeze({});
    publications.set(token, { descriptor, destination, pins, directories });
    readOriginalPackagedOfficeNativePublication(token);
    return token;
  } finally { building = false; }
}

/** Original in-memory provenance and current staged bytes; JSON/clones/old stdout grant nothing. */
export function readOriginalPackagedOfficeNativePublication(token) {
  const owned = publications.get(token);
  requireBuild(owned && Object.isFrozen(token) && Reflect.ownKeys(token).length === 0);
  for (const [name, original] of owned.directories)
    requireBuild(JSON.stringify(directory(join(owned.destination, name))) === JSON.stringify(original));
  const expected = [...owned.pins.keys()];
  requireBuild(JSON.stringify(stageLeaves(owned.destination, expected).sort()) === JSON.stringify(expected.sort()));
  for (const [name, pin] of owned.pins) {
    const path = join(owned.destination, name);
    requireBuild(JSON.stringify(identity(path, pin.maximum)) === JSON.stringify(pin.identity));
    const bytes = readFileSync(path);
    requireBuild(bytes.equals(pin.bytes) && hash(bytes) === pin.digest
      && JSON.stringify(identity(path, pin.maximum)) === JSON.stringify(pin.identity));
  }
  requireBuild((process.env.LING_PACKAGED_RELEASE_REVIEW_REQUIRED === "1"
    ? readLocalPackagedOfficeSource().sourceReviewSha256 : owned.descriptor.sourceReviewSha256)
    === owned.descriptor.sourceReviewSha256);
  return owned.descriptor;
}

/** Hold one genuine original publication across Builder and all awaited hooks. */
export async function withOriginalPackagedOfficeNativePublication(token, operation) {
  requireBuild(activeToken === undefined);
  readOriginalPackagedOfficeNativePublication(token);
  activeToken = token;
  try { return await operation(); }
  finally { activeToken = undefined; }
}

/** Hook discovery is same-process only, never an environment or staged JSON reader. */
export function readActiveOriginalPackagedOfficeNativePublication() {
  requireBuild(activeToken !== undefined);
  return readOriginalPackagedOfficeNativePublication(activeToken);
}

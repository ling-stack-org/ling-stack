import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "../../../packages/daemon/dist/runtime/sandbox/packaged-office-native-published-review.js";
import { readActiveOriginalPackagedOfficeNativePublication } from "./build-packaged-office-native.mjs";
import { extractCuaDriverFinalArtifact } from "./cua-driver-signing/final-artifact-extractor.mjs";
import { verifyOriginalOfficeDaemonInApp } from "./packaged-office-native-asar-checks.mjs";

const maximumBinaryBytes = 64n * 1024n * 1024n;
const maximumSourceBytes = 4n * 1024n * 1024n;
const maximumTotalSourceBytes = 16n * 1024n * 1024n;
const maximumManifestBytes = 1024n * 1024n;
const maximumArtifactEntries = 100_000;

function requireCopy(value) {
  if (!value) throw new Error("packaged_office_native_copy_invalid");
}

function activePublication() {
  const publication = readActiveOriginalPackagedOfficeNativePublication();
  if (!publication) throw new Error("packaged_office_native_active_publication_missing");
  return publication;
}

function sameNode(actual, original) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"]
    .every(key => actual[key] === original[key]);
}

function inspectNode(path, uid, directory) {
  requireCopy(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
  const stat = lstatSync(path, { bigint: true });
  requireCopy(!stat.isSymbolicLink() && realpathSync(path) === path
    && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n)
    && stat.uid === uid && (stat.mode & 0o022n) === 0n);
  return stat;
}

function assertEntries(path, expected) {
  const directory = opendirSync(path), actual = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      requireCopy(actual.length < expected.length);
      actual.push(entry.name);
    }
  } finally { directory.closeSync(); }
  actual.sort();
  const sorted = [...expected].sort();
  requireCopy(actual.length === sorted.length && actual.every((name, index) => name === sorted[index]));
}

function assertPinnedBytes(path, original, maximum, digest) {
  requireCopy(original.size > 0n && original.size <= maximum
    && typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireCopy(sameNode(fstatSync(fd, { bigint: true }), original));
    const bytes = Buffer.alloc(Number(original.size));
    const maximumAttempts = Math.ceil(bytes.length / 65536) + 32;
    let offset = 0, attempts = 0;
    while (offset < bytes.length) {
      requireCopy(attempts++ < maximumAttempts);
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      requireCopy(count > 0);
      offset += count;
    }
    requireCopy(readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) === 0
      && sameNode(fstatSync(fd, { bigint: true }), original)
      && createHash("sha256").update(bytes).digest("hex") === digest);
  } finally { closeSync(fd); }
}

function sourceDirectories() {
  const directories = new Map([["", new Set()]]);
  for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
    const parts = name.split("/");
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (!directories.has(parent)) directories.set(parent, new Set());
      directories.get(parent).add(parts[index]);
    }
  }
  return directories;
}

/**
 * Check this actual App's fixed copy against the active original publication.
 * Hashes are comparisons with original pins, never fresh review approval. This
 * returns build byte-selection data only, not signature, Core or runtime authority.
 * No caller descriptor, token, environment, JSON or verification callback is read.
 */
export function verifyOriginalOfficeCopyInApp(appPath) {
  const publication = activePublication();
  try {
    const uid = process.getuid?.();
    requireCopy(Number.isSafeInteger(uid) && uid >= 0 && typeof appPath === "string"
      && basename(appPath).endsWith(".app") && basename(appPath).length > 4);
    const owner = BigInt(uid), observations = [];
    const capture = (path, directory) => {
      const original = inspectNode(path, owner, directory);
      observations.push({ path, directory, original });
      return original;
    };
    const contentsRoot = join(appPath, "Contents"), resourcesRoot = join(contentsRoot, "Resources");
    const officeRoot = join(resourcesRoot, "office-local"), sourceRoot = join(officeRoot, "source");
    const binaryPath = join(officeRoot, "office-local.node");
    for (const path of [appPath, contentsRoot, resourcesRoot, officeRoot]) capture(path, true);
    const stageEntries = ["office-local.node", "build-manifest.json", "source"];
    assertEntries(officeRoot, stageEntries);
    const binary = capture(binaryPath, false);
    requireCopy(Number.isSafeInteger(publication.finalBinarySizeBytes)
      && binary.size === BigInt(publication.finalBinarySizeBytes));
    assertPinnedBytes(binaryPath, binary, maximumBinaryBytes, publication.finalBinarySha256);
    const manifestPath = join(officeRoot, "build-manifest.json");
    assertPinnedBytes(manifestPath, capture(manifestPath, false), maximumManifestBytes, publication.buildManifestSha256);
    const directories = sourceDirectories();
    for (const [relativePath, entries] of directories) {
      const path = join(sourceRoot, relativePath);
      capture(path, true);
      assertEntries(path, [...entries]);
    }
    let totalSourceBytes = 0n;
    for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
      const path = join(sourceRoot, name), original = capture(path, false);
      totalSourceBytes += original.size;
      requireCopy(totalSourceBytes <= maximumTotalSourceBytes);
      assertPinnedBytes(path, original, maximumSourceBytes, publication.sourceSha256[name]);
    }
    verifyOriginalOfficeDaemonInApp(appPath);
    for (const { path, directory, original } of observations)
      requireCopy(sameNode(inspectNode(path, owner, directory), original));
    assertEntries(officeRoot, stageEntries);
    for (const [relativePath, entries] of directories) assertEntries(join(sourceRoot, relativePath), [...entries]);
    requireCopy(activePublication() === publication);
    return Object.freeze({ evidenceKind: "build_byte_pins_only", appPath, officeRoot, binaryPath,
      finalBinarySha256: publication.finalBinarySha256, finalBinarySizeBytes: publication.finalBinarySizeBytes,
      buildManifestSha256: publication.buildManifestSha256 });
  } catch (cause) { throw new Error("packaged_office_native_copy_invalid", { cause }); }
}

function productFilename(context) {
  const value = context?.packager?.appInfo?.productFilename;
  requireCopy(typeof value === "string" && value.length > 0 && value.length <= 255
    && value !== "." && value !== ".." && !/[\/\\\0]/u.test(value));
  return value;
}

function isMacContext(context, artifact = false) {
  const platform = artifact ? context?.packager?.platform?.nodeName : context?.electronPlatformName;
  requireCopy(typeof platform === "string");
  return platform === "darwin";
}

function appFromPackContext(context) {
  const directory = context.appOutDir;
  requireCopy(typeof directory === "string" && isAbsolute(directory)
    && resolve(directory) === directory && realpathSync(directory) === directory);
  return join(directory, productFilename(context) + ".app");
}

function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }

/** Before signing: preserve unrelated Builder ignores and skip only this exact file. */
export async function verifyOfficeAfterPack(context) {
  if (!isMacContext(context)) return undefined;
  activePublication();
  const copy = verifyOriginalOfficeCopyInApp(appFromPackContext(context));
  const options = context.packager.platformSpecificBuildOptions;
  requireCopy(options && typeof options === "object");
  const previous = options.signIgnore;
  const ignores = previous == null ? [] : typeof previous === "string" ? [previous] : previous;
  requireCopy(Array.isArray(ignores) && ignores.every(value => typeof value === "string"));
  const exact = "^" + escapeRegExp(copy.binaryPath) + "$";
  const officePaths = [copy.binaryPath, copy.officeRoot, join(copy.officeRoot, "source"),
    join(copy.officeRoot, "build-manifest.json"),
    ...OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.map(name => join(copy.officeRoot, "source", name))];
  for (const pattern of ignores) {
    const regex = new RegExp(pattern);
    if (pattern !== exact && officePaths.some(path => regex.test(path))) {
      throw new Error("packaged_office_native_broad_sign_ignore_forbidden");
    }
  }
  if (!ignores.includes(exact)) options.signIgnore = [...ignores, exact];
  return copy;
}

function verifyAppSignature(appPath) {
  return new Promise((settle, reject) => {
    execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8",
      timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    }, error => {
      if (error) reject(new Error("packaged_office_native_signature_verification_failed", { cause: error }));
      else settle();
    });
  });
}

/** Build-time verification only; an afterSign callback is not itself proof of signing. */
export async function verifyOfficeAfterSign(context) {
  if (!isMacContext(context)) return undefined;
  activePublication();
  const appPath = appFromPackContext(context);
  verifyOriginalOfficeCopyInApp(appPath);
  await verifyAppSignature(appPath);
  return verifyOriginalOfficeCopyInApp(appPath);
}

function uniqueProductApp(rootValue, expectedName) {
  requireCopy(typeof rootValue === "string" && isAbsolute(rootValue));
  const rootStat = lstatSync(rootValue);
  requireCopy(rootStat.isDirectory() && !rootStat.isSymbolicLink());
  const root = realpathSync(rootValue), candidates = [];
  let entries = 0;
  function visit(directory) {
    const handle = opendirSync(directory);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        requireCopy(++entries <= maximumArtifactEntries);
        const path = join(directory, entry.name), metadata = lstatSync(path);
        if (entry.name.toLowerCase().endsWith(".app")) {
          requireCopy(metadata.isDirectory() && !metadata.isSymbolicLink());
          candidates.push(path);
        } else if (metadata.isDirectory() && !metadata.isSymbolicLink()) visit(path);
        // Do not follow DMG's Applications link or recurse inside product/helper Apps.
      }
    } finally { handle.closeSync(); }
  }
  visit(root);
  const appPath = join(root, expectedName + ".app");
  requireCopy(candidates.length === 1 && candidates[0] === appPath);
  return appPath;
}

/** Verify each actual ZIP/DMG independently, even when the Cua provider has no state. */
export async function verifyOfficeFinalArtifact(context) {
  if (!isMacContext(context, true)) return undefined;
  activePublication();
  const kind = context.target?.name, artifactPath = context.file;
  requireCopy(["zip", "dmg"].includes(kind) && typeof artifactPath === "string"
    && extname(artifactPath).toLowerCase() === "." + kind);
  const uid = process.getuid?.();
  requireCopy(Number.isSafeInteger(uid) && uid >= 0);
  const artifactIdentity = inspectNode(artifactPath, BigInt(uid), false);
  const expectedName = productFilename(context);
  const extracted = await extractCuaDriverFinalArtifact(artifactPath, {
    platform: "darwin", artifactRole: "outer-" + kind,
  });
  let verificationFailed = false, verificationError, result;
  try {
    requireCopy(typeof extracted?.cleanup === "function");
    const appPath = uniqueProductApp(extracted.artifactRoot, expectedName);
    verifyOriginalOfficeCopyInApp(appPath);
    await verifyAppSignature(appPath);
    result = verifyOriginalOfficeCopyInApp(appPath);
    requireCopy(uniqueProductApp(extracted.artifactRoot, expectedName) === appPath);
    requireCopy(sameNode(inspectNode(artifactPath, BigInt(uid), false), artifactIdentity));
  } catch (error) { verificationFailed = true; verificationError = error; }
  let cleanupFailed = false, cleanupError;
  try { await extracted.cleanup(); }
  catch (error) { cleanupFailed = true; cleanupError = error; }
  if (!verificationFailed && !cleanupFailed) {
    // The final artifact remains pinned through awaited detach/input cleanup.
    // This is verification, not a second cleanup failure for the same mutation.
    try { requireCopy(sameNode(inspectNode(artifactPath, BigInt(uid), false), artifactIdentity)); }
    catch (error) { verificationFailed = true; verificationError = error; }
  }
  if (verificationFailed && cleanupFailed) {
    throw new AggregateError([verificationError, cleanupError], "packaged_office_native_artifact_and_cleanup_failed");
  }
  if (verificationFailed) throw verificationError;
  if (cleanupFailed) throw cleanupError;
  return result;
}

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS, readOriginalPublishedOfficeNativeReview,
  type PublishedOriginalOfficeNativeReview } from "./packaged-office-native-published-review.js";

export interface OriginalPackagedOfficeResources {
  readonly appRoot: string;
  readonly executablePath: string;
  readonly officeRoot: string;
  readonly binaryPath: string;
  readonly sourceRoot: string;
  readonly review: PublishedOriginalOfficeNativeReview;
}

const maximumSourceBytes = 4n * 1024n * 1024n;
const maximumTotalSourceBytes = 16n * 1024n * 1024n;
const maximumManifestBytes = 1024n * 1024n;
const maximumBinaryBytes = 64n * 1024n * 1024n;
const invalidResource = "packaged_office_native_resources_invalid";

function requireResource(value: unknown): asserts value {
  if (!value) throw new Error(invalidResource);
}

function sameNode(actual: BigIntStats, original: BigIntStats): boolean {
  return actual.dev === original.dev && actual.ino === original.ino && actual.mode === original.mode
    && actual.uid === original.uid && actual.gid === original.gid && actual.size === original.size
    && actual.mtimeNs === original.mtimeNs && actual.ctimeNs === original.ctimeNs;
}

/** Check an app-internal canonical node; never follow an accepted symlink. */
function inspectNode(path: string, uid: bigint, directory: boolean): BigIntStats {
  requireResource(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path);
  const stat = lstatSync(path, { bigint: true });
  requireResource(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && stat.uid === uid && (stat.mode & 0o022n) === 0n);
  return stat;
}

/** Bound directory enumeration by the fixed closure, including extra empty directories. */
function assertEntries(path: string, expected: readonly string[]): void {
  const directory = opendirSync(path);
  const actual: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      requireResource(actual.length < expected.length);
      actual.push(entry.name);
    }
  } finally { directory.closeSync(); }
  const sorted = [...expected].sort();
  actual.sort();
  requireResource(actual.length === sorted.length && actual.every((name, index) => name === sorted[index]));
}

/** Hash only an original bounded readonly FD, with actual EOF and before/after identity. */
function assertFileBytes(path: string, original: BigIntStats, maximum: bigint, digest: string): void {
  requireResource(original.size >= 0n && original.size <= maximum);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireResource(sameNode(fstatSync(fd, { bigint: true }), original));
    const bytes = Buffer.alloc(Number(original.size));
    const maximumAttempts = Math.ceil(bytes.length / 65536) + 32;
    let offset = 0, attempts = 0;
    while (offset < bytes.length) {
      requireResource(attempts++ < maximumAttempts);
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      requireResource(count > 0);
      offset += count;
    }
    const probe = Buffer.alloc(1);
    requireResource(readSync(fd, probe, 0, 1, bytes.length) === 0
      && sameNode(fstatSync(fd, { bigint: true }), original)
      && createHash("sha256").update(bytes).digest("hex") === digest);
  } finally { closeSync(fd); }
}

/** Derive the exact bounded source tree only from the fixed original 15-input list. */
function sourceDirectories(): ReadonlyMap<string, readonly string[]> {
  const directories = new Map<string, Set<string>>([["", new Set()]]);
  for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
    const parts = name.split("/");
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (!directories.has(parent)) directories.set(parent, new Set());
      directories.get(parent)!.add(parts[index]);
    }
  }
  return new Map([...directories].map(([path, entries]) => [path, [...entries]]));
}

/**
 * Resolve point-in-time build-selection data from this actual packaged executable.
 * No caller path, environment, config, receipt, workspace fallback or provider is read.
 * This neither authenticates a signature nor grants Core/native execution authority;
 * the bootstrap must verify the same final app with its fixed signing actor, and the
 * original loader must still retain/recheck its own binary FD and source closure.
 */
export function resolveOriginalPackagedOfficeResources(): OriginalPackagedOfficeResources | undefined {
  const review = readOriginalPublishedOfficeNativeReview();
  if (!review) return undefined;
  try {
    const versions = process.versions;
    requireResource(process.platform === "darwin" && process.arch === "arm64"
      && versions.electron === review.runtime.electron && versions.node === review.runtime.node
      && versions.uv === review.runtime.uv && /^\d+$/u.test(versions.napi ?? "")
      && Number.isSafeInteger(Number(versions.napi)) && Number(versions.napi) >= review.napiVersion);
    const uid = process.getuid?.();
    requireResource(uid !== undefined && Number.isSafeInteger(uid) && uid >= 0);
    const owner = BigInt(uid);
    const executablePath = process.execPath;
    requireResource(isAbsolute(executablePath) && resolve(executablePath) === executablePath
      && realpathSync(executablePath) === executablePath);
    const macosRoot = dirname(executablePath), contentsRoot = dirname(macosRoot), appRoot = dirname(contentsRoot);
    requireResource(basename(macosRoot) === "MacOS" && basename(contentsRoot) === "Contents"
      && basename(appRoot).endsWith(".app") && basename(appRoot).length > 4);
    const resourcesRoot = join(contentsRoot, "Resources"), officeRoot = join(resourcesRoot, "office-local");
    const binaryPath = join(officeRoot, "office-local.node"), sourceRoot = join(officeRoot, "source");
    const observations: { path: string; original: BigIntStats; directory: boolean }[] = [];
    const capture = (path: string, directory: boolean): BigIntStats => {
      const original = inspectNode(path, owner, directory);
      observations.push({ path, original, directory });
      return original;
    };
    for (const path of [appRoot, contentsRoot, macosRoot, resourcesRoot, officeRoot]) capture(path, true);
    const executable = capture(executablePath, false);
    requireResource((executable.mode & 0o100n) !== 0n);
    assertEntries(officeRoot, ["office-local.node", "source", "build-manifest.json"]);
    const binary = capture(binaryPath, false);
    requireResource(binary.size === BigInt(review.finalBinarySizeBytes));
    assertFileBytes(binaryPath, binary, maximumBinaryBytes, review.finalBinarySha256);
    const manifestPath = join(officeRoot, "build-manifest.json"), manifest = capture(manifestPath, false);
    // A byte pin only: no manifest fields become runtime authentication evidence.
    assertFileBytes(manifestPath, manifest, maximumManifestBytes, review.buildManifestSha256);
    const directories = sourceDirectories();
    for (const [relative, entries] of directories) {
      const path = join(sourceRoot, relative);
      capture(path, true);
      assertEntries(path, entries);
    }
    let sourceBytes = 0n;
    for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
      const path = join(sourceRoot, name), original = capture(path, false);
      sourceBytes += original.size;
      requireResource(sourceBytes <= maximumTotalSourceBytes);
      assertFileBytes(path, original, maximumSourceBytes, review.sourceSha256[name]);
    }
    // Fence the same canonical app nodes after every byte/closure observation.
    for (const { path, original, directory } of observations)
      requireResource(sameNode(inspectNode(path, owner, directory), original));
    assertEntries(officeRoot, ["office-local.node", "source", "build-manifest.json"]);
    for (const [relative, entries] of directories) assertEntries(join(sourceRoot, relative), entries);
    return Object.freeze({ appRoot, executablePath, officeRoot, binaryPath, sourceRoot, review });
  } catch (cause) { throw new Error(invalidResource, { cause }); }
}

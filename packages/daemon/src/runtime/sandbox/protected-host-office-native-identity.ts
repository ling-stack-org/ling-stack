import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { Module } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "./packaged-office-native-published-review.js";
import { resolveOriginalPackagedOfficeResources } from "./packaged-office-native-resources.js";

const localSourceRoot = fileURLToPath(new URL("../../../../../native/office-local/", import.meta.url));
const sourceInputs = OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS;
export const OFFICE_LOCAL_NATIVE_METHODS = Object.freeze(["openSession", "createDirectory", "createFile", "writeFile",
  "readFile", "fsyncResource", "observeResource", "closeResource", "installTree", "observePublication",
  "inspectSession", "cancelSession", "closeSession"] as const);
export type OfficeLocalNativeMethod = typeof OFFICE_LOCAL_NATIVE_METHODS[number];
export interface OfficeLocalReviewedNativeArtifact {
  readonly binaryPath: string;
  readonly reviewedBinarySha256: string;
  readonly reviewedSourceSha256: Readonly<Record<string, string>>;
}
export interface OfficeLocalNativeIdentityFacts {
  readonly classification: "local_verified";
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly sourceSha256: Readonly<Record<string, string>>;
  readonly protocolVersion: 2;
  readonly napiVersion: 8;
  readonly packaged: false;
  readonly distributionSignature: "not_verified";
  readonly coreSafe: false;
}
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
function requireIdentity(value: unknown): asserts value { if (!value) throw new Error("office_local_native_identity_invalid"); }
function sameFile(stat: BigIntStats, original: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.dev === original.dev && stat.ino === original.ino
    && stat.size === original.size && stat.mtimeNs === original.mtimeNs && stat.ctimeNs === original.ctimeNs;
}
function originalBytes(fd: number, size: bigint): Buffer {
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
    requireIdentity(read > 0); offset += read;
  }
  return bytes;
}
function reviewedSources(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireIdentity(Reflect.ownKeys(descriptors).length === sourceInputs.length);
  const owned: Record<string, string> = Object.create(null);
  for (const name of sourceInputs) {
    const descriptor = descriptors[name];
    requireIdentity(descriptor && Object.hasOwn(descriptor, "value") && /^[a-f0-9]{64}$/u.test(descriptor.value));
    owned[name] = descriptor.value as string;
  }
  return Object.freeze(owned);
}
function assertSources(path: string, digest: string, sources: Readonly<Record<string, string>>): void {
  const packaged = resolveOriginalPackagedOfficeResources();
  if (packaged) requireIdentity(path === packaged.binaryPath && digest === packaged.review.finalBinarySha256
    && sourceInputs.every(name => sources[name] === packaged.review.sourceSha256[name]));
  const sourceRoot = packaged ? packaged.sourceRoot : localSourceRoot;
  for (const name of sourceInputs) {
    const path = join(sourceRoot, name), stat = lstatSync(path);
    requireIdentity(realpathSync(path) === path && stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024
      && hash(readFileSync(path)) === sources[name]);
  }
}

/** Exact original binary FD and original N-API methods. No runtime compiler or workspace configuration. */
export function loadReviewedOfficeLocalNativeArtifact(input: OfficeLocalReviewedNativeArtifact): Readonly<{
  facts: OfficeLocalNativeIdentityFacts;
  assertCurrent(): void;
  invoke(method: OfficeLocalNativeMethod, args: readonly unknown[]): unknown;
  invokeCleanup(method: "closeResource" | "cancelSession" | "closeSession", args: readonly unknown[]): unknown;
  closeIdentity(): void;
}> {
  const path = input.binaryPath, sources = reviewedSources(input.reviewedSourceSha256), digest = input.reviewedBinarySha256;
  requireIdentity(process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)
    && Number(process.versions.napi) >= 8 && isAbsolute(path) && resolve(path) === path && realpathSync(path) === path
    && /^[a-f0-9]{64}$/u.test(digest));
  const original = lstatSync(path, { bigint: true });
  requireIdentity(original.isFile() && !original.isSymbolicLink() && original.size > 0n && original.size <= 64n * 1024n * 1024n
    && original.uid === BigInt(process.getuid!()) && (original.mode & 0o022n) === 0n);
  let fd: number | undefined, lifetime: "retained" | "closed" | "unknown" = "retained";
  const closeIdentity = (): void => {
    if (lifetime === "closed") return;
    requireIdentity(lifetime === "retained" && fd !== undefined);
    const originalFd = fd; fd = undefined; lifetime = "unknown";
    closeSync(originalFd); lifetime = "closed";
  };
  const assertBinary = (): void => {
    requireIdentity(lifetime === "retained" && fd !== undefined);
    let actual: BigIntStats;
    try { actual = fstatSync(fd, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EBADF") { fd = undefined; lifetime = "unknown"; } throw error; }
    if (!actual.isFile() || actual.dev !== original.dev || actual.ino !== original.ino) {
      fd = undefined; lifetime = "unknown"; throw new Error("office_local_native_original_fd_changed");
    }
    requireIdentity(sameFile(actual, original));
    requireIdentity(realpathSync(path) === path && sameFile(lstatSync(path, { bigint: true }), original)
      && hash(originalBytes(fd, original.size)) === digest && sameFile(fstatSync(fd, { bigint: true }), original));
  };
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    requireIdentity(sameFile(fstatSync(fd, { bigint: true }), original));
    assertBinary(); assertSources(path, digest, sources);
    // The dynamic loader opens the retained original, not a pathname that can
    // be replaced between hash and load or an unrelated require-cache entry.
    const nativeModule = new Module(path);
    nativeModule.filename = path;
    process.dlopen(nativeModule, `/dev/fd/${fd}`);
    const addon: unknown = nativeModule.exports;
    requireIdentity(addon !== null && typeof addon === "object");
    const descriptors = Object.getOwnPropertyDescriptors(addon);
    requireIdentity(descriptors.protocolVersion?.value === 2 && descriptors.scopeBinding?.value === "unbound"
      && descriptors.protectedStageVerified?.value === false && descriptors.coreSafe?.value === false && descriptors.packaged?.value === false);
    const methods = new Map<OfficeLocalNativeMethod, (...args: unknown[]) => unknown>();
    for (const name of OFFICE_LOCAL_NATIVE_METHODS) {
      const descriptor = descriptors[name];
      requireIdentity(descriptor && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function");
      methods.set(name, descriptor.value as (...args: unknown[]) => unknown);
    }
    Object.freeze(addon);
    const assertMethods = (): void => {
      for (const [name, method] of methods) requireIdentity(Object.getOwnPropertyDescriptor(addon, name)?.value === method);
    };
    const assertCurrent = (): void => { assertBinary(); assertSources(path, digest, sources); assertMethods(); };
    assertCurrent();
    const facts: OfficeLocalNativeIdentityFacts = Object.freeze({ classification: "local_verified", binaryPath: path,
      binarySha256: digest, sourceSha256: sources, protocolVersion: 2, napiVersion: 8, packaged: false,
      distributionSignature: "not_verified", coreSafe: false });
    return Object.freeze({ facts, assertCurrent,
      invoke(method: OfficeLocalNativeMethod, args: readonly unknown[]): unknown {
        assertCurrent(); const originalMethod = methods.get(method); requireIdentity(originalMethod); return originalMethod(...args);
      },
      invokeCleanup(method: "closeResource" | "cancelSession" | "closeSession", args: readonly unknown[]): unknown {
        assertMethods(); const originalMethod = methods.get(method); requireIdentity(originalMethod); return originalMethod(...args);
      }, closeIdentity });
  } catch (error) {
    if (fd !== undefined && lifetime === "retained") {
      try { closeIdentity(); } catch (closeError) { throw new AggregateError([error, closeError], "office_local_native_loader_close_unknown"); }
    }
    throw error;
  }
}

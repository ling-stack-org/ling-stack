import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import type { ExecutionSandboxBackendIdentity } from "@ling-stack/core";
import { MACOS_DYLD_PROFILE } from "./macos-seatbelt-profile.js";

// Reviewed OS-owned source: Cryptex subpaths/ancestors, literal /, no file writes.
// Non-FS bootstrap privileges remain: open/openat/fstatat/dup, dyld getfsstat/map,
// fcntl signing/LV/F_GETPATH and Sandbox check. Apple-internal conditions also allow
// mach_vm_map_external, JETSAM and VM-footprint sysctl writes. This is not a blanket
// no-Mach/no-sysctl claim, nor a new Host IPC/task-port/ptrace/Host-FD inheritance allow.
// The original profile metadata rule remains visible; only data/map and mutation are isolated.
// This reviewed manifest is static support evidence, not a substitute for a kernel probe.
// Unknown OS revisions close only Office protection until their source is reviewed.
const reviewedBootstrapSha256 = "bdfc2354c683c8fb95a39e63fbc8610e9739b0256c89ab880564edefbe73a5ce";
const reservedReadRoots = Object.freeze(["/dev", "/System"]);
const maxBootstrapBytes = 8 * 1024 * 1024;
const sameFile = (first: BigIntStats, second: BigIntStats): boolean => second.isFile() && !second.isSymbolicLink()
  && first.dev === second.dev && first.ino === second.ino;
function requireBootstrap(value: unknown): asserts value {
  if (!value) throw new Error("protected_host_bootstrap_domain_unverified");
}

const originalUnsupportedReviews = new WeakSet<object>();
/** Single-use provenance for only this original reader's unsupported review result. */
export function consumeProtectedHostBootstrapReviewUnsupported(error: unknown): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function")
    && originalUnsupportedReviews.delete(error);
}
/** All identity and original FD closes complete before an unsupported review can be tagged. */
function readOriginalBootstrapReviewStatus(backend: ExecutionSandboxBackendIdentity): boolean {
  const initial = lstatSync(MACOS_DYLD_PROFILE, { bigint: true });
  requireBootstrap(initial.isFile() && !initial.isSymbolicLink() && initial.uid === 0n && (initial.mode & 0o022n) === 0n
    && initial.size > 0n && initial.size <= BigInt(maxBootstrapBytes) && realpathSync(MACOS_DYLD_PROFILE) === MACOS_DYLD_PROFILE);
  let fd: number | undefined = openSync(MACOS_DYLD_PROFILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  let acquired: BigIntStats | undefined;
  const originalStat = (): BigIntStats => {
    let stat: BigIntStats;
    try { stat = fstatSync(fd!, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EBADF") fd = undefined;
      throw error;
    }
    if (acquired && !sameFile(acquired, stat)) {
      fd = undefined; // The original FD cannot change inode; never close a foreign reused integer.
      throw new Error("protected_host_bootstrap_domain_unverified");
    }
    return stat;
  };
  try {
    acquired = originalStat();
    requireBootstrap(sameFile(initial, acquired) && acquired.uid === 0n && (acquired.mode & 0o022n) === 0n
      && acquired.size === initial.size);
    const bytes = Buffer.alloc(maxBootstrapBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      let count: number;
      try { count = readSync(fd, bytes, length, bytes.length - length, null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EBADF") fd = undefined; throw error; }
      if (count === 0) break;
      length += count;
    }
    requireBootstrap(length <= maxBootstrapBytes && length === Number(initial.size));
    const final = originalStat(), pathname = lstatSync(MACOS_DYLD_PROFILE, { bigint: true });
    requireBootstrap(sameFile(acquired, final) && sameFile(acquired, pathname) && final.uid === 0n
      && (final.mode & 0o022n) === 0n && final.size === acquired.size && realpathSync(MACOS_DYLD_PROFILE) === MACOS_DYLD_PROFILE);
    const sha = createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
    requireBootstrap(backend.kind === "macos_seatbelt"
      && backend.helperVersion.endsWith(":" + sha));
    return sha === reviewedBootstrapSha256;
  } finally {
    if (fd !== undefined) { const original = fd; fd = undefined; closeSync(original); }
  }
}

/** Actual bounded OS bytes; unreviewed imports never acquire a complete read-domain claim. */
export function readProtectedHostBootstrapReadRoots(backend: ExecutionSandboxBackendIdentity): readonly string[] {
  let originalUnsupported: Error | undefined;
  try {
    if (readOriginalBootstrapReviewStatus(backend)) return reservedReadRoots;
    originalUnsupported = new Error("protected_host_bootstrap_domain_unverified");
    originalUnsupportedReviews.add(originalUnsupported);
    throw originalUnsupported;
  } catch (error) {
    // A reused old Error from lstat/read/fstat/close is not this invocation's review result.
    if (error !== originalUnsupported && error !== null
      && (typeof error === "object" || typeof error === "function")) originalUnsupportedReviews.delete(error);
    throw error;
  }
}

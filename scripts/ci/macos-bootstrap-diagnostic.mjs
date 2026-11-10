import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { release } from "node:os";
import { pathToFileURL } from "node:url";

export const PROFILE_PATH = "/System/Library/Sandbox/Profiles/dyld-support.sb";
const MAX_BYTES = 8 * 1024 * 1024;
const invalid = () => { throw new Error("bootstrap_diagnostic_identity_invalid"); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && b.isFile() && !b.isSymbolicLink() && b.uid === 0n && (b.mode & 0o022n) === 0n;

/** Fixed-path, bounded observation only. No report from this script grants authority. */
export function collectBootstrapDiagnostic({ io = fs, exec = execFileSync,
  platform = process.platform, arch = process.arch, kernel = release() } = {}) {
  const base = { schemaVersion: 1, observationOnly: true, platform, arch, kernel,
    nodeVersion: process.version, path: PROFILE_PATH };
  let fd;
  try {
    if (platform !== "darwin") throw new Error("bootstrap_diagnostic_requires_macos");
    const osVersion = exec("/usr/bin/sw_vers", ["-productVersion"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 8192 }).trim();
    const osBuild = exec("/usr/bin/sw_vers", ["-buildVersion"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 8192 }).trim();
    Object.assign(base, { osVersion, osBuild });
    const initial = io.lstatSync(PROFILE_PATH, { bigint: true });
    if (!same(initial, initial) || initial.size <= 0n || initial.size > BigInt(MAX_BYTES)
      || io.realpathSync(PROFILE_PATH) !== PROFILE_PATH) invalid();
    fd = io.openSync(PROFILE_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const acquired = io.fstatSync(fd, { bigint: true });
    if (!same(initial, acquired)) invalid();
    const bytes = Buffer.alloc(Number(initial.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = io.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== Number(initial.size) || !same(acquired, io.fstatSync(fd, { bigint: true }))
      || !same(acquired, io.lstatSync(PROFILE_PATH, { bigint: true }))
      || io.realpathSync(PROFILE_PATH) !== PROFILE_PATH) invalid();
    const content = bytes.subarray(0, length);
    const completedFd = fd; fd = undefined;
    io.closeSync(completedFd);
    return { ...base, collected: true, size: length,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytesBase64: content.toString("base64"),
      identity: { dev: acquired.dev.toString(), ino: acquired.ino.toString(),
        uid: acquired.uid.toString(), mode: acquired.mode.toString(8) } };
  } catch (error) {
    // Diagnostics must not mask the independent mandatory native/shard gates.
    let closeError = false;
    if (fd !== undefined) {
      const failedFd = fd; fd = undefined;
      try { io.closeSync(failedFd); } catch { closeError = true; }
    }
    return { ...base, collected: false, diagnosticError:
      error?.message?.startsWith("bootstrap_diagnostic_") ? error.message : "bootstrap_diagnostic_read_failed",
    ...(closeError ? { closeError: true } : {}) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error("bootstrap_diagnostic_no_arguments_allowed");
  console.log(JSON.stringify(collectBootstrapDiagnostic()));
}

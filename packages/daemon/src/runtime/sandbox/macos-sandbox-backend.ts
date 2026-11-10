import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { release } from "node:os";
import type { ExecutionSandboxBackendIdentity } from "@ling-stack/core";
import { MACOS_DYLD_PROFILE, MACOS_SANDBOX_EXECUTABLE } from "./macos-seatbelt-profile.js";

/** The original Error class is shared with the public native command API. */
export class MacosSandboxCommandError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MacosSandboxCommandError"; }
}
function requireNative(condition: unknown, code: string): asserts condition {
  if (!condition) throw new MacosSandboxCommandError(code);
}
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
/** Fixed system identity; no inventory, source issuer or staging dependency. */
export function readMacosSandboxBackendIdentity(): ExecutionSandboxBackendIdentity {
  requireNative(process.platform === "darwin", "macos_backend_unavailable");
  for (const path of [MACOS_SANDBOX_EXECUTABLE, MACOS_DYLD_PROFILE]) {
    const stat = lstatSync(path);
    requireNative(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0 && realpathSync(path) === path, "macos_system_identity_invalid");
    requireNative(stat.size <= 8 * 1024 * 1024, "macos_system_identity_invalid");
  }
  return Object.freeze({ kind: "macos_seatbelt", protocolVersion: 1,
    helperVersion: "ling-seatbelt-v1:" + release() + ":" + hash(readFileSync(MACOS_DYLD_PROFILE)),
    executableSha256: hash(readFileSync(MACOS_SANDBOX_EXECUTABLE)) });
}

import type { ExecutionSandboxPolicyV1 } from "@ling-stack/core";

export const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
export const MACOS_DYLD_PROFILE = "/System/Library/Sandbox/Profiles/dyld-support.sb";
export const MACOS_SYSTEM_READ_ROOTS = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/share", "/System/Library"] as const;

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function anyPath(roots: readonly string[]): string {
  return `(require-any ${roots.map(root => `(subpath ${quote(root)})`).join(" ")})`;
}

/** Only profile generation. The launcher must validate current authority, identity and paths. */
export function buildMacosSeatbeltProfile(policy: ExecutionSandboxPolicyV1): string {
  const filesystem = policy.filesystem;
  if (policy.platform !== "darwin" || policy.executionMode !== "native_required" || !filesystem || policy.backend?.kind !== "macos_seatbelt") {
    throw new Error("macos_restricted_policy_required");
  }
  const reads = [...filesystem.readRoots, filesystem.temporaryRoot];
  const writes = [...filesystem.writeRoots, filesystem.temporaryRoot];
  // deny filters are also subtracted from the allow clauses, not dependent on rule ordering.
  const allow = (operation: string, roots: readonly string[], denied: readonly string[]): string =>
    `(allow ${operation} (require-all ${anyPath(roots)} (require-not ${anyPath(denied)})))`;
  return [
    "(version 1)", "(deny default)",
    // This OS-owned bootstrap profile is referenced, not copied; its digest binds backend identity.
    `(import ${quote(MACOS_DYLD_PROFILE)})`,
    "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)",
    "(allow signal (target same-sandbox))",
    "(allow file-read-metadata)",
    allow("file-read* file-map-executable", reads, filesystem.deniedReadRoots),
    allow("file-write*", writes, filesystem.deniedWriteRoots),
    `(deny file-read* file-map-executable ${anyPath(filesystem.deniedReadRoots)})`,
    `(deny file-write* ${anyPath(filesystem.deniedWriteRoots)})`,
    "(allow file-read* (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\"))",
    "(allow file-write-data (literal \"/dev/null\") (literal \"/dev/zero\"))",
    policy.networkMode === "disabled" ? "(deny network*)" : "(allow network*)",
  ].join("\n");
}

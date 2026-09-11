import { posix, win32 } from "node:path";
import { ExecutionSandboxPolicyError } from "./execution-policy-types.js";

/** Lexical checks only. They do not establish realpath, reparse-point or inode authority. */
export function executionSandboxPaths(platform: "darwin" | "win32") {
  if (platform !== "darwin" && platform !== "win32") throw new ExecutionSandboxPolicyError("unsupported_sandbox_platform");
  const paths = platform === "win32" ? win32 : posix;
  const key = (value: string): string => platform === "win32" ? value.toLowerCase() : value;
  function absolute(value: string): string {
    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f*?]/u.test(value)) {
      throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
    }
    if (platform === "win32") {
      if (!/^[a-z]:[\\/]/i.test(value) || value.slice(2).includes(":")) throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
      const parts = value.slice(3).split(/[\\/]/u);
      if (parts.some(part => /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
        throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
      }
    } else if (!paths.isAbsolute(value) || value.startsWith("//")) {
      throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
    }
    const normalized = paths.normalize(value).replace(platform === "win32" ? /[\\/]+$/u : /\/+$/u, "");
    if (!normalized || normalized === paths.parse(normalized).root.replace(/[\\/]+$/u, "")) throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
    return platform === "win32" ? normalized[0].toUpperCase() + normalized.slice(1) : normalized;
  }
  const inside = (candidate: string, root: string): boolean => key(candidate) === key(root) || key(candidate).startsWith(key(root) + paths.sep);
  const overlap = (first: string, second: string): boolean => inside(first, second) || inside(second, first);
  function roots(values: readonly string[]): string[] {
    if (!Array.isArray(values) || values.length > 128) throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
    const seen = new Set<string>();
    return values.map(absolute).sort().filter(value => {
      if (seen.has(key(value))) return false;
      seen.add(key(value));
      return true;
    });
  }
  function workspaceWriteRoot(value: string, workspace: string): string {
    if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f*?]/u.test(value)) throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
    if (platform === "win32" && !paths.isAbsolute(value) && (/^[a-z]:/iu.test(value) || /^[\\/]/u.test(value))) {
      throw new ExecutionSandboxPolicyError("invalid_sandbox_path");
    }
    const candidate = absolute(paths.isAbsolute(value) ? value : paths.resolve(workspace, value));
    if (!inside(candidate, workspace)) throw new ExecutionSandboxPolicyError("write_scope_outside_workspace");
    return candidate;
  }
  return { absolute, inside, overlap, roots, workspaceWriteRoot, join: paths.join };
}

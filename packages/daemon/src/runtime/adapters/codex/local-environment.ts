import { isAbsolute } from "node:path";

export interface CodexLocalEnvironment {
  readonly environmentId: "local";
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
}

/** Undefined retains legacy local requests; null rejects an unproven environment selection. */
export function readCodexLocalEnvironment(value: unknown, cwd: string): CodexLocalEnvironment | undefined | null {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return undefined;
  if (!Array.isArray(value) || value.length !== 1) return null;
  const environment: unknown = value[0];
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return null;
  const selected = environment as Record<string, unknown>;
  if (selected.environmentId !== "local" || !samePath(selected.cwd, cwd)
    || !Array.isArray(selected.runtimeWorkspaceRoots) || selected.runtimeWorkspaceRoots.length !== 1
    || !samePath(selected.runtimeWorkspaceRoots[0], cwd)) return null;
  return { environmentId: "local", cwd: selected.cwd as string, runtimeWorkspaceRoots: [...selected.runtimeWorkspaceRoots] as string[] };
}

function samePath(value: unknown, cwd: string): boolean {
  return typeof value === "string" && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value) && value === cwd;
}

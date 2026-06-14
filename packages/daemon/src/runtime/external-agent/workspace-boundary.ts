import { isAbsolute, relative, resolve } from "node:path";

export interface WorkspaceBoundary {
  readonly cwd: string;
  readonly allowedRoots?: readonly string[];
}

export function resolveExternalWorkspacePath(boundary: WorkspaceBoundary, candidatePath: string): string {
  const roots = (boundary.allowedRoots && boundary.allowedRoots.length > 0 ? boundary.allowedRoots : [boundary.cwd]).map((root) => resolve(root));
  const resolved = resolve(boundary.cwd, candidatePath);
  if (!roots.some((root) => isWithinRoot(root, resolved))) {
    throw new Error("External agent path is outside the allowed workspace boundary.");
  }
  return resolved;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

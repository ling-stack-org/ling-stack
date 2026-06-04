import { isAbsolute, relative, resolve as resolvePath } from "node:path";

export function isPathInsideRoot(root: string, path: string): boolean {
  const relativePath = relative(resolvePath(root), resolvePath(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/");
}

import type { WorkspaceChangeFile, WorkspaceChangesResponse } from "@ling-stack/contracts";

/** Resolve only lexical absolute paths; a path outside the reported Git root is not a match. */
function absolutePath(path: string, base?: string): string | undefined {
  const windows = /^[a-z]:[\\/]/iu.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path)
    || Boolean(base && (/^[a-z]:\//iu.test(base) || base.startsWith("//")));
  if (!windows && path.includes("\\")) return undefined;
  const normalized = windows ? path.replace(/\\/gu, "/") : path;
  const absolute = /^(?:[a-z]:\/|\/)/iu.test(normalized);
  if (!absolute && !base) return undefined;
  const joined = absolute ? normalized : `${base}/${normalized}`;
  const root = joined.match(/^(?:\/\/[^/]+\/[^/]+|[a-z]:|\/)/iu)?.[0];
  if (!root) return undefined;
  const segments: string[] = [];
  for (const segment of joined.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (!segments.length) return undefined; segments.pop(); }
    else segments.push(segment);
  }
  return `${root === "/" ? "" : root}/${segments.join("/")}`;
}

export function workspaceRelativePath(response: WorkspaceChangesResponse, cwd: string, path: string): string | undefined {
  const root = response.repoRoot && absolutePath(response.repoRoot);
  const base = absolutePath(cwd);
  const target = base && absolutePath(path, base);
  if (!root || !target) return undefined;
  const windows = /^[a-z]:\//iu.test(root) || root.startsWith("//");
  const key = (value: string) => windows ? value.toLowerCase() : value;
  const rootPrefix = `${root.replace(/\/$/u, "")}/`;
  if (!key(target).startsWith(key(rootPrefix))) return undefined;
  return target.slice(rootPrefix.length);
}

export function workspaceFileChange(response: WorkspaceChangesResponse, cwd: string, path: string): WorkspaceChangeFile | undefined {
  const relative = workspaceRelativePath(response, cwd, path);
  if (!relative) return undefined;
  const windows = /^[a-z]:[\\/]/iu.test(response.repoRoot ?? "") || /^(?:\\\\|\/\/)/u.test(response.repoRoot ?? "");
  const key = (value: string) => windows ? value.toLowerCase() : value;
  const normalized = (value: string) => windows ? value.replace(/\\/gu, "/") : value;
  return response.files.find(file => key(normalized(file.path)) === key(relative)
    || file.originalPath !== undefined && key(normalized(file.originalPath)) === key(relative));
}

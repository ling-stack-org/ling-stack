import type { ConversationOperationSourceRef } from "@ling-stack/conversation-ui-core";

type DisplayFallback = Pick<ConversationOperationSourceRef, "kind" | "id" | "path" | "label">;

/**
 * Prefer evidence refs over redundant section-path fallbacks after privacy filtering.
 * Full paths are display joins only: original ref identity and authority are preserved.
 * Distinct evidence refs are not collapsed merely because they target the same file.
 */
export function terminalReportDisplaySourceRefs(
  sourceRefs: readonly ConversationOperationSourceRef[],
  fallbacks: readonly DisplayFallback[] = [],
  resources: readonly DisplayFallback[] = [],
): readonly ConversationOperationSourceRef[] {
  const refs = [...new Map(sourceRefs.map((ref) => [JSON.stringify([ref.kind, ref.id, ref.path ?? ""]), ref])).values()]
    .map((ref) => {
      if (ref.path) return ref;
      const resource = resources.find((candidate) => candidate.path && sameResourceIdentity(ref, candidate));
      return resource?.path ? { ...ref, path: resource.path } : ref;
    });
  for (const fallback of fallbacks) {
    const path = normalizedPath(fallback.path);
    const match = refs.findIndex((ref) =>
      sameResourceIdentity(ref, fallback) || (path !== "" && path === referencePath(ref)),
    );
    if (match === -1) {
      refs.push(fallback);
    } else if (!refs[match]!.path && fallback.path) {
      // The tooltip gains the report's full path, never a capability or a new id.
      refs[match] = { ...refs[match]!, path: fallback.path };
    }
  }
  return refs;
}

function sameResourceIdentity(ref: ConversationOperationSourceRef, fallback: DisplayFallback): boolean {
  if (ref.id !== fallback.id) return false;
  if (ref.kind === fallback.kind) return true;
  // Reports may describe a stored artifact as a diff. Keep the original evidence
  // ref's kind rather than minting a second, differently typed navigation target.
  return (ref.kind === "artifact" || ref.kind === "diff") &&
    (fallback.kind === "artifact" || fallback.kind === "diff");
}

function referencePath(ref: ConversationOperationSourceRef): string {
  if (ref.kind !== "file" && ref.kind !== "path" && ref.kind !== "diff" && ref.kind !== "artifact") return "";
  return normalizedPath(ref.path ?? (ref.kind === "file" || ref.kind === "path" ? ref.id : undefined));
}

function normalizedPath(path: string | undefined): string {
  return path?.trim().replace(/\\/gu, "/").replace(/^\.\//u, "") ?? "";
}

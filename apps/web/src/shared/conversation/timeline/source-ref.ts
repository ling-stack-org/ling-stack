import type {
  ConversationOperationSourceRef,
  ConversationTrustedSourceRef,
} from "@ling-stack/conversation-ui-core";

/**
 * Host capabilities are intentionally opt-in.  A path or id from model text
 * is display-only until the canonical adapter attaches a supported target.
 */
export function isTrustedSourceRef(
  ref: ConversationOperationSourceRef | undefined,
): ref is ConversationTrustedSourceRef {
  return Boolean(
    ref &&
    typeof ref.id === "string" &&
    ref.id.trim().length > 0 &&
    (ref.hostTarget === "open_file" ||
      ref.hostTarget === "open_diff" ||
      ref.hostTarget === "open_artifact" ||
      ref.hostTarget === "open_run"),
  );
}

export function isTrustedFileSourceRef(
  ref: ConversationOperationSourceRef | undefined,
): ref is ConversationTrustedSourceRef {
  return isTrustedSourceRef(ref) &&
    ref.hostTarget === "open_file" &&
    (ref.kind === "file" || ref.kind === "path") &&
    typeof ref.path === "string" &&
    ref.path.trim().length > 0;
}

/**
 * Resolve a trusted file capability for a displayed path without turning the
 * path itself into authority. Separators and a leading `./` are normalized only
 * for matching; the returned value is the original Host-issued capability.
 */
export function trustedFileSourceRefForPath(
  refs: readonly ConversationOperationSourceRef[],
  path: string,
): ConversationTrustedSourceRef | undefined {
  const normalizedPath = normalizeDisplayPath(path);
  if (!normalizedPath) return undefined;
  return refs.find((ref): ref is ConversationTrustedSourceRef =>
    isTrustedFileSourceRef(ref) && normalizeDisplayPath(ref.path) === normalizedPath,
  );
}

export function normalizeDisplayPath(path: string | undefined): string {
  return path?.trim().replace(/\\/gu, "/").replace(/^\.\//u, "") ?? "";
}

import type {
  ConversationOperationSourceRef,
  ConversationTrustedSourceRef,
} from "@ling-stack/conversation-ui-core";

export interface ConversationSourceRefScope {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly actionId?: string;
  readonly participantId?: string;
  /** Current daemon epoch; a restart invalidates previously minted refs. */
  readonly daemonEpoch?: string;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  readonly now?: string | number | Date;
}

/** A capability minted by the trusted Host/daemon after path validation. */
export interface ConversationHostSourceCapability {
  readonly kind: "file" | "diff" | "artifact";
  readonly id: string;
  readonly path?: string;
  readonly hostTarget: "open_file" | "open_diff" | "open_artifact";
  readonly capabilityId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly actionId?: string;
  readonly participantId?: string;
  readonly attemptId?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
  readonly daemonEpoch?: string;
}

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
      ref.hostTarget === "open_run") &&
    typeof ref.capabilityId === "string" &&
    ref.capabilityId.trim().length > 0,
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

/**
 * Upgrade a display-only ref only when the Host capability matches the current
 * transcript scope. The frontend cannot mint a capability from a path string.
 */
export function upgradeConversationSourceRef(
  ref: ConversationOperationSourceRef | undefined,
  capability: ConversationHostSourceCapability | undefined,
  scope: ConversationSourceRefScope,
): ConversationTrustedSourceRef | undefined {
  if (!ref || !capability || !isTrustedSourceRef(capability)) return undefined;
  if (!isCapabilityActive(capability, scope)) return undefined;
  if (capability.workspaceId !== scope.workspaceId || capability.threadId !== scope.threadId) return undefined;
  if (scope.runId && capability.runId !== scope.runId) return undefined;
  if (scope.actionId && capability.actionId !== scope.actionId) return undefined;
  if (scope.participantId && capability.participantId !== scope.participantId) return undefined;
  if (ref.id !== capability.id && normalizeDisplayPath(ref.path) !== normalizeDisplayPath(capability.path)) return undefined;
  return {
    ...ref,
    kind: capability.kind,
    id: capability.id,
    ...(capability.path ? { path: capability.path } : {}),
    hostTarget: capability.hostTarget,
    capabilityId: capability.capabilityId,
    workspaceId: capability.workspaceId,
  };
}

/**
 * Host capability freshness check shared by all surfaces. The renderer must
 * not open a stale ref after a daemon restart or a TTL expiry.
 */
export function isCapabilityActive(
  capability: ConversationHostSourceCapability,
  scope: Pick<ConversationSourceRefScope, "daemonEpoch" | "now"> = {},
): boolean {
  if (!capability.capabilityId.trim()) return false;
  if (capability.expiresAt) {
    const expiresAt = Date.parse(capability.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= nowEpochMs(scope.now)) return false;
  }
  if (scope.daemonEpoch && capability.daemonEpoch !== scope.daemonEpoch) return false;
  return true;
}

function nowEpochMs(value: string | number | Date | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Date.now();
}

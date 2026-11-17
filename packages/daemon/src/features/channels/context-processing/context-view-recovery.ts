import type { ConversationContextProjectionMetadata } from "@ling-stack/contracts";
import type { ConversationContextViewLineage, RunStore } from "@ling-stack/core";
import {
  buildConversationContextProjection,
  type ConversationContextProjection,
  type ConversationContextProjectionView,
} from "./conversation-context-projector.js";

export type ContextViewLineageRecoveryStatus =
  | "current"
  | "reconstructed"
  | "stale"
  | "blocked"
  | "unsupported";

export interface ContextViewLineageRecoveryEntry {
  readonly lineageKey: string;
  readonly kind: string;
  readonly status: ContextViewLineageRecoveryStatus;
  readonly contextViewId: string;
  readonly projection?: ConversationContextProjection;
  readonly reason?: string;
}

export interface ContextViewLineageRecoveryReport {
  readonly scanned: number;
  readonly current: number;
  readonly reconstructed: number;
  readonly stale: number;
  readonly blocked: number;
  readonly unsupported: number;
  readonly entries: readonly ContextViewLineageRecoveryEntry[];
}

/**
 * Rebuilds the canonical conversation projection from durable messages,
 * assignments, summaries and visibility policy after a daemon restart. The
 * worker never rewrites lineage here: a changed projection must be reviewed by
 * the next Host-owned materialization, so an active Run cannot silently adopt a
 * different context under the same contextViewId.
 */
export function reconcileContextViewLineagesAtStartup(input: {
  readonly store: RunStore;
  readonly workspaceId?: string;
  readonly limit?: number;
}): ContextViewLineageRecoveryReport {
  const lineages = input.store.listConversationContextViewLineages({
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const entries: ContextViewLineageRecoveryEntry[] = [];
  for (const lineage of lineages) {
    entries.push(reconcileLineage(input.store, lineage));
  }
  return {
    scanned: entries.length,
    current: entries.filter((entry) => entry.status === "current").length,
    reconstructed: entries.filter((entry) => entry.status === "reconstructed").length,
    stale: entries.filter((entry) => entry.status === "stale").length,
    blocked: entries.filter((entry) => entry.status === "blocked").length,
    unsupported: entries.filter((entry) => entry.status === "unsupported").length,
    entries,
  };
}

function reconcileLineage(
  store: Parameters<typeof buildConversationContextProjection>[0]["store"],
  lineage: ConversationContextViewLineage,
): ContextViewLineageRecoveryEntry {
  const base = {
    lineageKey: lineage.lineageKey,
    kind: lineage.kind,
    contextViewId: lineage.contextViewId,
  } as const;

  if (lineage.kind === "private_chat_view") {
    return reconcilePrivateChatLineage(store, lineage, base);
  }

  const view = projectionViewForLineageKind(lineage.kind);
  if (!view) {
    return { ...base, status: "unsupported", reason: "view_kind_has_no_rebuild_contract" };
  }
  if (!lineage.sourceItemId || !lineage.projection) {
    return { ...base, status: "blocked", reason: "projection_lineage_missing_source" };
  }

  try {
    const projection = buildConversationContextProjection({
      store,
      sourceItemId: lineage.sourceItemId,
      view,
      ...(lineage.consumerTeammateId ? { consumerTeammateId: lineage.consumerTeammateId } : {}),
    });
    const status = sameProjectionMetadata(projection.metadata, lineage.projection)
      ? "current"
      : projection.metadata.throughItemSequence < lineage.projection.throughItemSequence
        ? "stale"
        : "reconstructed";
    return { ...base, status, projection, ...(status === "stale" ? { reason: "durable_projection_changed" } : {}) };
  } catch (error) {
    return { ...base, status: "blocked", reason: safeRecoveryReason(error) };
  }
}

function reconcilePrivateChatLineage(
  store: Parameters<typeof buildConversationContextProjection>[0]["store"],
  lineage: ConversationContextViewLineage,
  base: Pick<ContextViewLineageRecoveryEntry, "lineageKey" | "kind" | "contextViewId">,
): ContextViewLineageRecoveryEntry {
  if (!lineage.threadId || !lineage.sourceItemId || !lineage.consumerTeammateId) {
    return { ...base, status: "blocked", reason: "private_lineage_missing_scope" };
  }
  const thread = store.listTeammateDirectThreads({ teammateId: lineage.consumerTeammateId, limit: 500 })
    .find((candidate) => candidate.id === lineage.threadId);
  if (!thread) return { ...base, status: "blocked", reason: "private_thread_missing" };
  const source = store.listTeammateDirectMessages({
    teammateId: lineage.consumerTeammateId,
    threadId: lineage.threadId,
    limit: 500,
  }).find((message) => message.id === lineage.sourceItemId);
  if (!source) return { ...base, status: "blocked", reason: "private_source_message_missing" };
  return { ...base, status: "current" };
}

function projectionViewForLineageKind(kind: string): ConversationContextProjectionView | undefined {
  switch (kind) {
    case "ling_agent_channel_view": return "reply";
    case "specialist_task_view": return "specialist";
    case "selector_view": return "selector";
    case "workflow_proposal_view": return "proposal";
    case "workflow_step_view": return "workflow_step";
    case "evidence_inspect_view": return "inspect";
    default: return undefined;
  }
}

function sameProjectionMetadata(
  left: ConversationContextProjectionMetadata,
  right: ConversationContextProjectionMetadata,
): boolean {
  return left.projectionVersion === right.projectionVersion
    && left.sourceStateFingerprint === right.sourceStateFingerprint
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.segmentId === right.segmentId
    && left.throughItemSequence === right.throughItemSequence
    && left.visibilityFingerprint === right.visibilityFingerprint
    && left.policyVersion === right.policyVersion;
}

function safeRecoveryReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.replace(/[\r\n\t]/g, " ").slice(0, 240);
  }
  return "durable_projection_rebuild_failed";
}

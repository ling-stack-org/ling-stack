import { createHash } from "node:crypto";
import type {
  ConversationContextViewLineage,
  RunStore,
  UpsertConversationContextViewLineageInput,
} from "@ling-stack/core";
import type { ChannelContextView, ChannelContextViewKind } from "./types.js";

export interface ContextViewLineageIdentityInput {
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly sourceItemId?: string;
  readonly kind: ChannelContextViewKind;
  readonly consumerTeammateId?: string;
}

export function contextViewLineageKey(input: ContextViewLineageIdentityInput): string {
  return `context_lineage_${sha256([
    input.workspaceId,
    input.channelId ?? "",
    input.threadId ?? "",
    input.sourceItemId ?? "",
    input.kind,
    input.consumerTeammateId ?? "",
  ])}`;
}

export function recordContextViewLineage(input: {
  readonly store: Pick<RunStore, "upsertConversationContextViewLineage">;
  readonly view: ChannelContextView;
  readonly lineageKey: string;
  readonly threadId?: string;
  readonly sourceItemId?: string;
  readonly expectedCurrentViewId?: string;
  readonly now?: string;
}): ConversationContextViewLineage {
  const now = input.now ?? input.view.metadata.createdAt;
  const projection = input.view.contextProjection;
  const request: UpsertConversationContextViewLineageInput = {
    lineageKey: input.lineageKey,
    workspaceId: input.view.workspaceId,
    ...(input.view.channelId ? { channelId: input.view.channelId } : {}),
    ...((input.threadId ?? projection?.threadId) ? { threadId: input.threadId ?? projection?.threadId } : {}),
    ...(input.sourceItemId ? { sourceItemId: input.sourceItemId } : {}),
    kind: input.view.kind,
    ...(input.view.consumerTeammateId ? { consumerTeammateId: input.view.consumerTeammateId } : {}),
    contextViewId: input.view.id,
    contextViewCreatedAt: input.view.metadata.createdAt,
    ...(projection ? { projection } : {}),
    viewFingerprint: fingerprintContextViewShape(input.view),
    ...(input.expectedCurrentViewId ? { expectedCurrentViewId: input.expectedCurrentViewId } : {}),
  };
  const result = input.store.upsertConversationContextViewLineage(request, now);
  if (result.status === "rejected_stale") {
    throw new Error(`Conversation context view lineage is stale: ${result.reason}`);
  }
  return result.lineage;
}

/** Rebuild metadata is safe only when the durable source fingerprint matches. */
export function reconcileContextViewLineage(input: {
  readonly store: Pick<RunStore, "getConversationContextViewLineage">;
  readonly lineageKey: string;
  readonly contextViewId?: string;
  readonly sourceStateFingerprint?: string;
  readonly projectionVersion?: string;
}): {
  readonly status: "missing" | "current" | "stale";
  readonly lineage?: ConversationContextViewLineage;
} {
  const lineage = input.store.getConversationContextViewLineage(input.lineageKey);
  if (!lineage) return { status: "missing" };
  if (input.contextViewId && lineage.contextViewId !== input.contextViewId) {
    return { status: "stale", lineage };
  }
  if (input.sourceStateFingerprint !== undefined
    && lineage.projection?.sourceStateFingerprint !== input.sourceStateFingerprint) {
    return { status: "stale", lineage };
  }
  if (input.projectionVersion !== undefined
    && lineage.projection?.projectionVersion !== input.projectionVersion) {
    return { status: "stale", lineage };
  }
  return { status: "current", lineage };
}

export function fingerprintContextViewShape(view: ChannelContextView): string {
  return sha256({
    kind: view.kind,
    workspaceId: view.workspaceId,
    channelId: view.channelId ?? null,
    consumerTeammateId: view.consumerTeammateId ?? null,
    sections: view.sections.map((section) => ({
      id: section.id,
      sourceRefIds: section.sourceRefIds,
      visibility: section.visibility,
      quotePolicy: section.quotePolicy,
    })),
    sources: view.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      sourceRefs: source.sourceRefs,
      sensitivity: source.sensitivity,
      freshness: source.freshness,
    })),
    dropped: view.dropped,
    projection: view.contextProjection
      ? {
          projectionVersion: view.contextProjection.projectionVersion,
          sourceStateFingerprint: view.contextProjection.sourceStateFingerprint,
          visibilityFingerprint: view.contextProjection.visibilityFingerprint,
        }
      : null,
  });
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

import type { ConversationItemV1 } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import { memoryEligibilityForView, type MemoryContextConsumerScope } from "./memory.js";
import { sourceDropReasonForView } from "./policies.js";
import type { ChannelContextSource, ChannelContextView, ChannelContextViewKind } from "./types.js";
import type { ConversationContextProjectionView } from "./conversation-context-projector.js";
import { isConversationContextItemVisible } from "./visibility.js";

export type ContextQuoteRejectionReason =
  | "missing"
  | "stale"
  | "private"
  | "scope"
  | "policy_blocked";

export interface ContextQuoteEligibility {
  readonly status: "eligible" | "rejected";
  readonly reason?: ContextQuoteRejectionReason;
}

export interface ContextQuoteDiagnostic {
  readonly sourceId: string;
  readonly status: "accepted" | "rejected";
  readonly reason?: ContextQuoteRejectionReason;
}

/**
 * Source references are public evidence only when both the source policy and
 * every section that presents the source permit quotation. A source may still
 * remain in the prompt as influence-only or inspect-only context.
 */
export function assessChannelContextViewSourceQuoteEligibility(input: {
  readonly view: ChannelContextView;
  readonly sourceRef: { readonly type: string; readonly id: string };
}): ContextQuoteEligibility {
  const sources = input.view.sources.filter((source) => source.sourceRefs.some((ref) =>
    ref.type === input.sourceRef.type && ref.id === input.sourceRef.id));
  const matchingSections = input.view.sections.filter((section) => section.sourceRefIds.includes(input.sourceRef.id));

  // Structural refs such as a channel or workflow may be carried by the view
  // without a body source. They are still checked by the channel reference
  // validator before persistence. Conversation items are body evidence and
  // fail closed when no visible source can attest to them.
  if (sources.length === 0) {
    const dropped = input.view.dropped.find((entry) => droppedSourceMatchesRef(entry.sourceId, input.sourceRef));
    if (dropped) {
      if (matchingSections.length > 0 && !matchingSections.some((section) => section.quotePolicy === "public_ok")) {
        return { status: "rejected", reason: "policy_blocked" };
      }
      return { status: "rejected", reason: reasonForDrop(dropped.reason) };
    }
    if (matchingSections.length > 0 && !matchingSections.some((section) => section.quotePolicy === "public_ok")) {
      return { status: "rejected", reason: "policy_blocked" };
    }
    return input.sourceRef.type === "conversation_item"
      ? { status: "rejected", reason: "missing" }
      : { status: "eligible" };
  }

  const sourceEligibility = sources.map((source) => assessChannelContextSourceQuoteEligibility({
    source,
    view: input.view.kind,
    consumerTeammateId: input.view.consumerTeammateId,
    consumerScope: {
      workspaceId: input.view.workspaceId,
      channelId: input.view.channelId,
    },
  }));
  const rejected = sourceEligibility.find((eligibility) => eligibility.status === "rejected");
  if (rejected) return rejected;

  // A source included in an inspect-only section must not be promoted just
  // because the source object itself is otherwise public. If it is also
  // presented by a public section, the public presentation is authoritative.
  if (matchingSections.length > 0 && !matchingSections.some((section) => section.quotePolicy === "public_ok")) {
    return { status: "rejected", reason: "policy_blocked" };
  }
  return { status: "eligible" };
}

/**
 * A quoted conversation item must be the exact current item. Following a
 * supersession chain would turn a stale user quote into a different source.
 */
export function assessConversationItemQuoteEligibility(input: {
  readonly store: Pick<RunStore, "getConversationItem" | "getEffectiveConversationItem">;
  readonly sourceItem: ConversationItemV1;
  readonly itemId: string;
  readonly view: ConversationContextProjectionView;
  readonly consumerTeammateId?: string;
}): ContextQuoteEligibility {
  const item = input.store.getConversationItem(input.itemId);
  if (!item) return { status: "rejected", reason: "missing" };
  if (item.status !== "committed") return { status: "rejected", reason: "stale" };
  const effective = input.store.getEffectiveConversationItem(input.itemId);
  if (!effective || effective.id !== item.id) return { status: "rejected", reason: "stale" };
  if (item.workspaceId !== input.sourceItem.workspaceId) return { status: "rejected", reason: "scope" };
  if (item.channelId !== input.sourceItem.channelId) return { status: "rejected", reason: "scope" };
  if (!isConversationContextItemVisible(item, input.view, input.consumerTeammateId)) {
    return { status: "rejected", reason: privateVisibility(item) ? "private" : "policy_blocked" };
  }
  return { status: "eligible" };
}

/**
 * Source-level policy used when a ChannelContextSource is explicitly quoted.
 * Prompt inclusion and quotation are intentionally separate: influence-only
 * sources may shape a response but cannot be presented as public evidence.
 */
export function assessChannelContextSourceQuoteEligibility(input: {
  readonly source: ChannelContextSource;
  readonly view: ChannelContextViewKind;
  readonly consumerTeammateId?: string;
  readonly consumerScope?: MemoryContextConsumerScope;
}): ContextQuoteEligibility {
  const metadata = input.source.metadata;
  if (
    metadata.deleted === true
    || metadata.stale === true
    || metadata.status === "deleted"
    || metadata.status === "stale"
    || metadata.status === "superseded"
  ) {
    return { status: "rejected", reason: "stale" };
  }
  if (metadata.policyBlocked === true || metadata.quoteBlocked === true) {
    return { status: "rejected", reason: "policy_blocked" };
  }

  const memoryEligibility = memoryEligibilityForView(
    input.source,
    input.view,
    input.consumerTeammateId,
    input.consumerScope,
  );
  if (memoryEligibility?.mode === "excluded") {
    return { status: "rejected", reason: reasonForDrop(memoryEligibility.droppedReason) };
  }

  const dropped = sourceDropReasonForView(
    input.source,
    input.view,
    input.consumerTeammateId,
    input.consumerScope,
  );
  if (dropped) return { status: "rejected", reason: reasonForDrop(dropped) };

  const quotePolicy = memoryEligibility?.quotePolicy
    ?? readQuotePolicy(metadata.quotePolicy)
    ?? (input.source.kind === "private_message" ? "influence_only" : "public_ok");
  if (quotePolicy !== "public_ok" && input.view !== "evidence_inspect_view") {
    return { status: "rejected", reason: "policy_blocked" };
  }
  return { status: "eligible" };
}

function privateVisibility(item: ConversationItemV1): boolean {
  return item.visibility === "agent_private";
}

function readQuotePolicy(value: unknown): "public_ok" | "influence_only" | "inspect_only" | undefined {
  return value === "public_ok" || value === "influence_only" || value === "inspect_only"
    ? value
    : undefined;
}

function droppedSourceMatchesRef(sourceId: string, sourceRef: { readonly type: string; readonly id: string }): boolean {
  return sourceId === sourceRef.id
    || sourceId === `${sourceRef.type}:${sourceRef.id}`
    || sourceId.endsWith(`:${sourceRef.id}`);
}

function reasonForDrop(reason: string | undefined): ContextQuoteRejectionReason {
  if (reason === "scope" || reason === "unrelated") return "scope";
  if (reason === "sensitivity") return "private";
  return "policy_blocked";
}

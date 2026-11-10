import type { MemorySensitivity, RecalledMemory } from "@ling-stack/core";
import type {
  ChannelContextDroppedReason,
  ChannelContextQuotePolicy,
  ChannelContextSource,
  ChannelContextSourceRef,
  ChannelContextViewKind,
} from "./types.js";

export type ChannelContextMemoryUseMode =
  | "public_quote"
  | "influence_only"
  | "inspect_only"
  | "excluded";

export interface ChannelContextMemoryEligibility {
  readonly mode: ChannelContextMemoryUseMode;
  readonly quotePolicy: ChannelContextQuotePolicy;
  readonly droppedReason?: ChannelContextDroppedReason;
  readonly policyVersion: "memory_use_isolation_v2";
}

export const MEMORY_USE_ISOLATION_POLICY_VERSION = "memory_use_isolation_v2" as const;

/** Selected by the Host, never inferred from memory text or supplied as an authority grant. */
export interface MemoryContextConsumerScope {
  readonly workspaceId: string;
  readonly channelId?: string;
}

export interface RecalledMemoryContextSourceInput {
  readonly item: RecalledMemory;
  readonly workspaceId?: string;
  readonly channelId?: string;
}

export function recalledMemoryToContextSource(input: RecalledMemoryContextSourceInput): ChannelContextSource {
  const memory = input.item.memory;
  const sourceRefs: ChannelContextSourceRef[] = [
    { type: "memory", id: memory.id, label: memory.title },
    ...memory.sourceRefs.map((ref) => ({
      type: `memory_source:${ref.type}`,
      id: ref.id,
      label: ref.label,
    })),
  ];
  return {
    id: `memory:${memory.id}`,
    kind: "memory",
    // Consumer scope cannot relabel source ownership.
    workspaceId: memory.workspaceId,
    channelId: memory.scopeType === "channel" ? memory.ownerId : input.channelId,
    teammateId: memory.scopeType === "teammate" ? memory.ownerId : undefined,
    sourceRefs,
    title: memory.title,
    text: input.item.excerpt,
    metadata: {
      memoryId: memory.id,
      scopeType: memory.scopeType,
      ownerId: memory.ownerId,
      reviewState: memory.reviewState,
      enabled: memory.enabled,
      memorySensitivity: memory.sensitivity,
      score: input.item.score,
      matchedTerms: input.item.matchedTerms,
      tags: memory.tags,
      verifyBeforeUse: memory.verifyBeforeUse,
      quotePolicy: memory.sensitivity === "private" ? "influence_only" : undefined,
    },
    sensitivity: memorySensitivityToContextSensitivity(memory.sensitivity),
    freshness: "durable",
  };
}

export function memoryEligibilityForView(
  source: ChannelContextSource,
  viewKind: ChannelContextViewKind,
  consumerTeammateId?: string,
  consumerScope?: MemoryContextConsumerScope,
): ChannelContextMemoryEligibility | undefined {
  if (source.kind !== "memory") {
    return undefined;
  }
  if (consumerScope && !memoryMatchesConsumerScope(source, consumerScope)) {
    return excludedMemory("scope");
  }

  if (viewKind === "evidence_inspect_view") {
    return memoryEligibility("inspect_only", "inspect_only");
  }

  if (source.sensitivity === "secret_adjacent") {
    return excludedMemory("sensitivity");
  }

  if (source.sensitivity === "private" && !isPrivateMemoryAllowed(source, viewKind, consumerTeammateId, consumerScope)) {
    return excludedMemory("sensitivity");
  }

  if (viewKind === "selector_view" || viewKind === "workflow_proposal_view") {
    return excludedMemory("scope");
  }

  const metadataQuotePolicy = memoryQuotePolicyFromMetadata(source.metadata);
  if (metadataQuotePolicy === "inspect_only") {
    return memoryEligibility("inspect_only", "inspect_only");
  }
  if (source.sensitivity === "private") {
    return memoryEligibility("influence_only", "influence_only");
  }
  if (source.metadata.verifyBeforeUse === true) {
    return memoryEligibility("influence_only", "influence_only");
  }
  if (metadataQuotePolicy === "influence_only") {
    return memoryEligibility("influence_only", "influence_only");
  }

  if (
    viewKind === "private_chat_view" ||
    viewKind === "workflow_step_view" ||
    viewKind === "specialist_task_view"
  ) {
    return memoryEligibility("influence_only", "influence_only");
  }

  return memoryEligibility("public_quote", "public_ok");
}

function isPrivateMemoryAllowed(
  source: ChannelContextSource,
  viewKind: ChannelContextViewKind,
  consumerTeammateId?: string,
  consumerScope?: MemoryContextConsumerScope,
): boolean {
  if (viewKind === "selector_view" || viewKind === "workflow_proposal_view") return false;
  if (consumerScope && memoryMatchesConsumerScope(source, consumerScope) &&
    (source.metadata.scopeType === "workspace" || source.metadata.scopeType === "channel")) {
    return true;
  }
  if (viewKind !== "private_chat_view" && viewKind !== "workflow_step_view" && viewKind !== "specialist_task_view") {
    return false;
  }
  return Boolean(consumerTeammateId && source.teammateId === consumerTeammateId);
}

function memoryMatchesConsumerScope(source: ChannelContextSource, scope: MemoryContextConsumerScope): boolean {
  if (source.workspaceId !== scope.workspaceId) return false;
  if (source.metadata.scopeType === "workspace") return source.metadata.ownerId === scope.workspaceId;
  if (source.metadata.scopeType === "channel") {
    return Boolean(scope.channelId && source.channelId === scope.channelId && source.metadata.ownerId === scope.channelId);
  }
  return true;
}

function memoryQuotePolicyFromMetadata(metadata: Readonly<Record<string, unknown>>): ChannelContextQuotePolicy | undefined {
  const quotePolicy = metadata.quotePolicy;
  if (quotePolicy === "public_ok" || quotePolicy === "influence_only" || quotePolicy === "inspect_only") {
    return quotePolicy;
  }
  if (metadata.publicQuoteEligible === false) {
    return "influence_only";
  }
  return undefined;
}

function excludedMemory(droppedReason: ChannelContextDroppedReason): ChannelContextMemoryEligibility {
  return {
    mode: "excluded",
    quotePolicy: "inspect_only",
    droppedReason,
    policyVersion: MEMORY_USE_ISOLATION_POLICY_VERSION,
  };
}

function memoryEligibility(
  mode: Exclude<ChannelContextMemoryUseMode, "excluded">,
  quotePolicy: ChannelContextQuotePolicy,
): ChannelContextMemoryEligibility {
  return {
    mode,
    quotePolicy,
    policyVersion: MEMORY_USE_ISOLATION_POLICY_VERSION,
  };
}

function memorySensitivityToContextSensitivity(sensitivity: MemorySensitivity): ChannelContextSource["sensitivity"] {
  if (sensitivity === "secret-adjacent") {
    return "secret_adjacent";
  }
  return sensitivity;
}

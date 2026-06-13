import type {
  ChannelContextDroppedReason,
  ChannelContextQuotePolicy,
  ChannelContextSource,
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
  readonly policyVersion: "memory_use_isolation_v1";
}

const MEMORY_POLICY_VERSION = "memory_use_isolation_v1" as const;

export function memoryEligibilityForView(
  source: ChannelContextSource,
  viewKind: ChannelContextViewKind,
  consumerTeammateId?: string,
): ChannelContextMemoryEligibility | undefined {
  if (source.kind !== "memory") {
    return undefined;
  }

  if (viewKind === "evidence_inspect_view") {
    return memoryEligibility("inspect_only", "inspect_only");
  }

  if (source.sensitivity === "secret_adjacent") {
    return excludedMemory("sensitivity");
  }

  if (source.sensitivity === "private" && !isPrivateMemoryAllowed(source, viewKind, consumerTeammateId)) {
    return excludedMemory("sensitivity");
  }

  if (viewKind === "selector_view" || viewKind === "workflow_proposal_view") {
    return excludedMemory("scope");
  }

  if (source.sensitivity === "private") {
    return memoryEligibility("influence_only", "influence_only");
  }

  const metadataQuotePolicy = memoryQuotePolicyFromMetadata(source.metadata);
  if (metadataQuotePolicy === "inspect_only") {
    return memoryEligibility("inspect_only", "inspect_only");
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
): boolean {
  if (viewKind !== "private_chat_view" && viewKind !== "workflow_step_view" && viewKind !== "specialist_task_view") {
    return false;
  }
  return Boolean(consumerTeammateId && source.teammateId === consumerTeammateId);
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
    policyVersion: MEMORY_POLICY_VERSION,
  };
}

function memoryEligibility(
  mode: Exclude<ChannelContextMemoryUseMode, "excluded">,
  quotePolicy: ChannelContextQuotePolicy,
): ChannelContextMemoryEligibility {
  return {
    mode,
    quotePolicy,
    policyVersion: MEMORY_POLICY_VERSION,
  };
}

export type ChannelContextSourceKind =
  | "turn"
  | "channel_state"
  | "recent_message"
  | "channel_summary"
  | "decision"
  | "handoff"
  | "active_work"
  | "materialized_input"
  | "memory"
  | "evidence"
  | "artifact"
  | "workflow"
  | "workflow_step"
  | "workflow_packet";

export type ChannelContextSensitivity = "normal" | "private" | "secret_adjacent";
export type ChannelContextFreshness = "current_turn" | "recent" | "durable" | "archival";
export type ChannelContextVisibility = "prompt" | "inspect_only";
export type ChannelContextQuotePolicy = "public_ok" | "influence_only" | "inspect_only";
export type ChannelContextDroppedReason = "budget" | "scope" | "sensitivity" | "raw_evidence" | "unrelated";
export type ChannelContextSectionRole = "system" | "instruction" | "user" | "memory" | "evidence";
export type ChannelContextSectionPriority = "must_keep" | "high" | "medium" | "low";

export type ChannelContextViewKind =
  | "ling_agent_channel_view"
  | "specialist_task_view"
  | "selector_view"
  | "workflow_proposal_view"
  | "workflow_step_view"
  | "private_chat_view"
  | "evidence_inspect_view";

export interface ChannelContextSourceRef {
  readonly type: string;
  readonly id: string;
  readonly label?: string;
}

export interface ChannelContextSource {
  readonly id: string;
  readonly kind: ChannelContextSourceKind;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly sourceRefs: readonly ChannelContextSourceRef[];
  readonly title: string;
  readonly text?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sensitivity: ChannelContextSensitivity;
  readonly freshness: ChannelContextFreshness;
}

export interface ChannelContextSection {
  readonly id: string;
  readonly role: ChannelContextSectionRole;
  readonly priority: ChannelContextSectionPriority;
  readonly title: string;
  readonly text: string;
  readonly sourceRefIds: readonly string[];
  readonly visibility: ChannelContextVisibility;
  readonly quotePolicy: ChannelContextQuotePolicy;
  readonly estimatedTokens?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface ChannelContextDroppedSource {
  readonly sourceId: string;
  readonly reason: ChannelContextDroppedReason;
}

export interface ChannelContextBudgetSnapshot {
  readonly mode?: string;
  readonly inputBudgetTokens?: number;
  readonly estimatedInputTokens?: number;
  readonly capabilitySource?: string;
  readonly capabilityConfidence?: string;
}

export interface ChannelContextCondenserMetadata {
  readonly enabled: boolean;
  readonly maxSourceTextChars?: number;
  readonly maxSources?: number;
  readonly condensedSourceCount: number;
  readonly droppedSourceCount: number;
}

export interface ChannelContextViewMetadata {
  readonly createdAt: string;
  readonly compactionIds: readonly string[];
  readonly sourceCount: number;
  readonly condenser?: ChannelContextCondenserMetadata;
}

export interface ChannelContextView {
  readonly id: string;
  readonly kind: ChannelContextViewKind;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly consumerTeammateId?: string;
  readonly sections: readonly ChannelContextSection[];
  readonly sourceRefs: readonly ChannelContextSourceRef[];
  readonly sources: readonly ChannelContextSource[];
  readonly dropped: readonly ChannelContextDroppedSource[];
  readonly budget?: ChannelContextBudgetSnapshot;
  readonly metadata: ChannelContextViewMetadata;
}

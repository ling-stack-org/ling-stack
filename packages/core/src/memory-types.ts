import { randomUUID } from "node:crypto";

export type MemoryScopeType = "workspace" | "channel" | "teammate" | "task" | "run";

export type MemorySourceType =
  | "manual"
  | "message"
  | "decision"
  | "doc"
  | "attachment"
  | "run-event"
  | "artifact"
  | "import";

export type MemoryReviewState = "candidate" | "active" | "disabled" | "archived" | "rejected";

export type MemorySensitivity = "normal" | "private" | "secret-adjacent";

export type MemoryReviewMode = "conservative" | "balanced" | "fast";

export type MemoryReviewOutcome = "auto-active" | "auto-candidate" | "manual-review" | "quarantine";

export type MemoryReviewConfidence = "low" | "medium" | "high";

export type MemoryCandidateSourceKind =
  | "manual_user"
  | "private_chat"
  | "channel_decision"
  | "task_run_summary"
  | "reflection_job"
  | "persona_source"
  | "import";

export type MemoryReviewAction = "approve" | "edit_and_approve" | "keep_candidate" | "reject" | "archive" | "quarantine";

export interface MemorySourceRef {
  readonly type: MemorySourceType;
  readonly id: string;
  readonly label?: string;
  readonly url?: string;
}

export interface MemoryReviewPolicy {
  readonly workspaceId: string;
  readonly mode: MemoryReviewMode;
  readonly autoActiveSameScope: boolean;
  readonly autoActiveUserExplicit: boolean;
  readonly requireManualForWorkspace: boolean;
  readonly requireManualForPersona: boolean;
  readonly requireManualForCrossScope: boolean;
  readonly quarantineSecretAdjacent: boolean;
  readonly updatedAt: string;
}

export interface MemoryReviewPolicyUpdateInput {
  readonly workspaceId?: string;
  readonly mode?: MemoryReviewMode;
  readonly autoActiveSameScope?: boolean;
  readonly autoActiveUserExplicit?: boolean;
  readonly requireManualForWorkspace?: boolean;
  readonly requireManualForPersona?: boolean;
  readonly requireManualForCrossScope?: boolean;
  readonly quarantineSecretAdjacent?: boolean;
}

export interface MemoryObject {
  readonly id: string;
  readonly workspaceId: string;
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly reviewState: MemoryReviewState;
  readonly enabled: boolean;
  readonly sensitivity: MemorySensitivity;
  readonly verifyBeforeUse: boolean;
  readonly retrievalProviderId?: string;
  readonly retrievalHandle?: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
}

export type MemorySelfImprovingKind =
  | "correction"
  | "reflection"
  | "workflow_lesson"
  | "tool_routing_lesson"
  | "runtime_recovery_lesson";

export type MemorySelfImprovingTrigger = "manual_review" | "promotion" | "run_review" | "health_review" | "import";

export interface MemorySelfImprovingMetadata {
  readonly memoryId: string;
  readonly kind: MemorySelfImprovingKind;
  readonly trigger: MemorySelfImprovingTrigger;
  readonly lesson: string;
  readonly useWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly validUntil?: string;
  readonly lastSeenAt?: string;
  readonly evidenceCount: number;
  readonly supersededBy?: string;
  readonly lastUsedAt?: string;
  readonly useCount: number;
}

export interface UpsertMemorySelfImprovingMetadataInput {
  readonly memoryId: string;
  readonly kind: MemorySelfImprovingKind;
  readonly trigger: MemorySelfImprovingTrigger;
  readonly lesson: string;
  readonly useWhen?: readonly string[];
  readonly doNotUseWhen?: readonly string[];
  readonly validUntil?: string | null;
  readonly lastSeenAt?: string | null;
  readonly evidenceCount?: number;
  readonly supersededBy?: string | null;
  readonly lastUsedAt?: string | null;
  readonly useCount?: number;
}

export interface ListMemorySelfImprovingMetadataOptions {
  readonly workspaceId?: string;
  readonly memoryId?: string;
  readonly kind?: MemorySelfImprovingKind;
  readonly limit?: number;
}

export interface MemoryReviewDecision {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly outcome: MemoryReviewOutcome;
  readonly mode: MemoryReviewMode;
  readonly reasonCode: string;
  readonly reason: string;
  readonly confidence: MemoryReviewConfidence;
  readonly requiresManualReview: boolean;
  readonly quarantineReason?: string;
  readonly targetReviewState: MemoryReviewState;
  readonly targetSensitivity: MemorySensitivity;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly decidedBy: "policy" | "local-user" | "system";
  readonly createdAt: string;
}

export interface CreateMemoryReviewDecisionInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly memoryId: string;
  readonly outcome: MemoryReviewOutcome;
  readonly mode: MemoryReviewMode;
  readonly reasonCode: string;
  readonly reason: string;
  readonly confidence: MemoryReviewConfidence;
  readonly requiresManualReview: boolean;
  readonly quarantineReason?: string;
  readonly targetReviewState: MemoryReviewState;
  readonly targetSensitivity: MemorySensitivity;
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly decidedBy: "policy" | "local-user" | "system";
}

export interface MemoryReviewActionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly action: MemoryReviewAction;
  readonly previousReviewState: MemoryReviewState;
  readonly nextReviewState: MemoryReviewState;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly editedMemory?: MemoryObjectUpdateInput;
  readonly reason?: string;
  readonly actor: "local-user" | "system";
  readonly createdAt: string;
}

export interface ApplyMemoryReviewActionInput {
  readonly workspaceId?: string;
  readonly memoryId: string;
  readonly action: MemoryReviewAction;
  readonly editedMemory?: MemoryObjectUpdateInput;
  readonly reason?: string;
  readonly actor: "local-user" | "system";
}

export interface ListMemoryPromotionInboxOptions {
  readonly workspaceId?: string;
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly sensitivity?: MemorySensitivity;
  readonly limit?: number;
}

export interface MemoryPromotionInboxItem {
  readonly memory: MemoryObject;
  readonly decision?: MemoryReviewDecision;
  readonly sourceSummary: string;
  readonly recommendedAction: MemoryReviewAction;
}

export interface CreateMemoryObjectInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly verifyBeforeUse?: boolean;
  readonly retrievalProviderId?: string;
  readonly retrievalHandle?: string;
  readonly createdBy?: string;
}

export interface MemoryObjectUpdateInput {
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly verifyBeforeUse?: boolean;
  readonly retrievalProviderId?: string | null;
  readonly retrievalHandle?: string | null;
  readonly createdBy?: string | null;
  readonly lastUsedAt?: string | null;
}

export interface ListMemoryObjectsOptions {
  readonly workspaceId?: string;
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly tag?: string;
  readonly limit?: number;
}

export type MemoryRecallIntent = "private-chat" | "channel-reply" | "task-run" | "review" | "search";

export interface MemoryRecallRequest {
  readonly workspaceId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly intent: MemoryRecallIntent;
  readonly query: string;
  readonly tags?: readonly string[];
  readonly maxResults?: number;
  readonly includePrivate?: boolean;
  readonly includeDisabled?: boolean;
  readonly includeSecretAdjacent?: boolean;
}

export interface RecalledMemory {
  readonly memory: MemoryObject;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly excerpt: string;
}

export interface MemoryRecallResult {
  readonly request: MemoryRecallRequest;
  readonly memories: readonly RecalledMemory[];
  readonly policyVersion: string;
  /** Selection evidence only; actual context supply is recorded separately in UsedMemoryEvent. */
  readonly audit?: {
    readonly strategy: "fts5" | "scan";
    readonly candidateCount: number;
    /** Counts only within allowed owners; excluded objects are never decoded or named. */
    readonly eligibleCount?: number;
    readonly excludedCount?: number;
    readonly traceId?: string;
    readonly selectedMemoryIds: readonly string[];
    readonly scopeRejected?: boolean;
  };
}

export interface UsedMemoryEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryIds: readonly string[];
  readonly intent: MemoryRecallIntent;
  readonly recallQuery: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly responseId?: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface CreateUsedMemoryEventInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly memoryIds: readonly string[];
  readonly intent: MemoryRecallIntent;
  readonly recallQuery: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly responseId?: string;
  readonly policyVersion: string;
}

export interface ListUsedMemoryEventsOptions {
  readonly workspaceId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly responseId?: string;
  readonly memoryId?: string;
  readonly limit?: number;
}

export interface MemoryIndexInput {
  readonly memory: MemoryObject;
}

export interface MemoryIndexResult {
  readonly retrievalHandle?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemorySearchInput {
  readonly request: MemoryRecallRequest;
  readonly lexicalCandidates: readonly MemoryObject[];
}

export interface MemorySearchResult {
  readonly memories: readonly RecalledMemory[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryRerankInput {
  readonly request: MemoryRecallRequest;
  readonly memories: readonly RecalledMemory[];
}

export interface MemoryRerankResult {
  readonly memories: readonly RecalledMemory[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryRetrievalProvider {
  readonly id: string;
  readonly capabilities: {
    readonly embedding: boolean;
    readonly vectorSearch: boolean;
    readonly rerank: boolean;
  };
  index?(input: MemoryIndexInput): Promise<MemoryIndexResult>;
  search(input: MemorySearchInput): Promise<MemorySearchResult>;
  rerank?(input: MemoryRerankInput): Promise<MemoryRerankResult>;
}

export function createMemoryObjectId(): string {
  return `memory_${randomUUID().replaceAll("-", "")}`;
}

export function createUsedMemoryEventId(): string {
  return `used_memory_${randomUUID().replaceAll("-", "")}`;
}

export function createMemoryReviewDecisionId(): string {
  return `memory_review_decision_${randomUUID().replaceAll("-", "")}`;
}

export function createMemoryReviewActionId(): string {
  return `memory_review_action_${randomUUID().replaceAll("-", "")}`;
}

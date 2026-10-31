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

export type MemoryConsolidationJobKind =
  | "private_chat_summary"
  | "channel_decision_summary"
  | "task_run_lesson"
  | "workspace_consolidation";

export type MemoryConsolidationJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

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

export interface MemoryReviewPolicyUpdateRequest {
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

export type MemoryHealthSeverity = "info" | "warning" | "critical";

export type MemoryHealthFindingKind =
  | "missing_source_refs"
  | "expired_candidate"
  | "volatile_without_verify_before_use"
  | "duplicate_candidate"
  | "superseded_active_memory"
  | "secret_adjacent_recallable"
  | "authority_changing_claim"
  | "stale_candidate"
  | "high_review_backlog";

export interface MemoryHealthFinding {
  readonly id: string;
  readonly kind: MemoryHealthFindingKind;
  readonly severity: MemoryHealthSeverity;
  readonly memoryId?: string;
  readonly title: string;
  readonly message: string;
  readonly recommendation: string;
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly reviewState?: MemoryReviewState;
  readonly sensitivity?: MemorySensitivity;
  readonly sourceRefCount?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface MemoryHealthSummary {
  readonly total: number;
  readonly active: number;
  readonly candidate: number;
  readonly disabled: number;
  readonly archived: number;
  readonly rejected: number;
  readonly enabled: number;
  readonly reviewBacklog: number;
  readonly staleCandidates: number;
  readonly verifyBeforeUse: number;
  readonly findings: {
    readonly critical: number;
    readonly warning: number;
    readonly info: number;
  };
}

export interface MemoryHealthReport {
  readonly generatedAt: string;
  readonly staleCandidateDays: number;
  readonly summary: MemoryHealthSummary;
  readonly findings: readonly MemoryHealthFinding[];
}

export interface CreateMemoryObjectRequest {
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

export interface UpdateMemoryObjectRequest {
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

export interface MemoryReviewActionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryId: string;
  readonly action: MemoryReviewAction;
  readonly previousReviewState: MemoryReviewState;
  readonly nextReviewState: MemoryReviewState;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly editedMemory?: UpdateMemoryObjectRequest;
  readonly reason?: string;
  readonly actor: "local-user" | "system";
  readonly createdAt: string;
}

export interface MemoryPromotionInboxItem {
  readonly memory: MemoryObject;
  readonly decision?: MemoryReviewDecision;
  readonly sourceSummary: string;
  readonly recommendedAction: MemoryReviewAction;
}

export interface ApplyMemoryReviewActionRequest {
  readonly action: MemoryReviewAction;
  readonly editedMemory?: UpdateMemoryObjectRequest;
  readonly reason?: string;
  readonly actor?: "local-user" | "system";
}

export interface MemoryConsolidationJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: MemoryConsolidationJobKind;
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly status: MemoryConsolidationJobStatus;
  readonly createdCandidateIds: readonly string[];
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryConsolidationJobRequest {
  readonly kind: MemoryConsolidationJobKind;
  readonly sourceKind?: MemoryCandidateSourceKind;
  readonly sourceScopeType?: MemoryScopeType;
  readonly crossesScopeBoundary?: boolean;
  readonly userExplicitRemember?: boolean;
  readonly confidence?: MemoryReviewConfidence;
  readonly candidate: {
    readonly scopeType: MemoryScopeType;
    readonly ownerId: string;
    readonly title: string;
    readonly body: string;
    readonly tags?: readonly string[];
    readonly sourceRefs?: readonly MemorySourceRef[];
    readonly sensitivity?: MemorySensitivity;
    readonly verifyBeforeUse?: boolean;
    readonly createdBy?: string;
  };
}

export interface MemoryListResponse {
  readonly cwd: string;
  readonly memories: readonly MemoryObject[];
  readonly vectorRetrieval: {
    readonly status: "not_installed" | "not_configured" | "rebuilding" | "ready" | "degraded" | "unavailable";
    readonly optional: true;
  };
}

export interface MemoryMarkdownExportItem {
  readonly id: string;
  readonly title: string;
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly reviewState: MemoryReviewState;
  readonly sensitivity: MemorySensitivity;
  readonly confidence: MemoryReviewConfidence | "unknown";
  readonly tagCount: number;
  readonly sourceRefCount: number;
  readonly redactionApplied: boolean;
}

export interface MemoryMarkdownExportResult {
  readonly schemaVersion: 1;
  readonly kind: "ling-memory-markdown-export";
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly suggestedFileName: string;
  readonly memoryCount: number;
  readonly skippedSecretAdjacentCount: number;
  readonly skippedSecretAdjacentIds: readonly string[];
  readonly redactionApplied: boolean;
  readonly items: readonly MemoryMarkdownExportItem[];
  readonly markdown: string;
}

export interface MemoryMarkdownExportRequest {
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly reviewState?: MemoryReviewState;
  readonly sensitivity?: MemorySensitivity;
  readonly tag?: string;
  readonly limit?: number;
  readonly includeSecretAdjacent?: boolean;
  readonly includeMarkdown?: boolean;
  readonly fileName?: string;
  readonly generatedAt?: string;
}

export interface MemoryMarkdownExportResponse {
  readonly cwd: string;
  readonly filePath?: string;
  readonly export: MemoryMarkdownExportResult | Omit<MemoryMarkdownExportResult, "markdown">;
}

export interface MemoryMarkdownImportSource {
  readonly id: string;
  readonly label: string;
  readonly importedAt: string;
  readonly originalKind?: string;
  readonly originalWorkspaceId?: string;
}

export interface MemoryMarkdownImportCandidate {
  readonly index: number;
  readonly originalId?: string;
  readonly title: string;
  readonly createInput: CreateMemoryObjectRequest;
  readonly warnings: readonly string[];
}

export interface MemoryMarkdownImportSkipped {
  readonly index: number;
  readonly title?: string;
  readonly reason: string;
}

export interface MemoryMarkdownImportPlan {
  readonly schemaVersion: 1;
  readonly kind: "ling-memory-markdown-import";
  readonly source: MemoryMarkdownImportSource;
  readonly candidateCount: number;
  readonly skippedCount: number;
  readonly candidates: readonly MemoryMarkdownImportCandidate[];
  readonly skipped: readonly MemoryMarkdownImportSkipped[];
}

export interface MemoryMarkdownImportRequest {
  readonly markdown: string;
  readonly dryRun?: boolean;
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly fileName?: string;
  readonly limit?: number;
}

export interface MemoryMarkdownImportResponse {
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly importedCount: number;
  readonly plan: MemoryMarkdownImportPlan;
  readonly memories: readonly MemoryObject[];
}

export interface MemoryHealthRequest {
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly staleCandidateDays?: number;
  readonly limit?: number;
}

export interface MemoryHealthResponse {
  readonly cwd: string;
  readonly report: MemoryHealthReport;
}

export interface MemoryMutationResponse {
  readonly memory: MemoryObject;
}

export interface MemoryReviewPolicyResponse {
  readonly cwd: string;
  readonly policy: MemoryReviewPolicy;
}

export interface MemoryPromotionInboxResponse {
  readonly cwd: string;
  readonly items: readonly MemoryPromotionInboxItem[];
}

export interface MemoryReviewMutationResponse {
  readonly memory: MemoryObject;
  readonly action: MemoryReviewActionRecord;
}

export interface MemoryConsolidationJobListResponse {
  readonly cwd: string;
  readonly jobs: readonly MemoryConsolidationJob[];
}

export interface MemoryConsolidationJobMutationResponse {
  readonly cwd: string;
  readonly job: MemoryConsolidationJob;
  readonly candidates: readonly MemoryObject[];
  readonly decisions: readonly MemoryReviewDecision[];
}

export type MemoryRecallIntent = "private-chat" | "channel-reply" | "task-run" | "review" | "search";

export interface MemoryRecallRequest {
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

export interface MemoryRecallResponse {
  readonly cwd: string;
  readonly memories: readonly RecalledMemory[];
  readonly policyVersion: string;
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

export interface UsedMemoryListResponse {
  readonly cwd: string;
  readonly events: readonly UsedMemoryEvent[];
}

export interface MemoryDomainSnapshot {
  readonly reviewPolicy: {
    readonly workspaceId: string;
    readonly mode: string;
    readonly autoActiveSameScope: boolean;
    readonly autoActiveUserExplicit: boolean;
    readonly requireManualForWorkspace: boolean;
    readonly requireManualForPersona: boolean;
    readonly requireManualForCrossScope: boolean;
    readonly quarantineSecretAdjacent: boolean;
    readonly updatedAt: string;
  };
  readonly promotionInbox: {
    readonly pending: number;
    readonly quarantined: number;
  };
  readonly recentCandidates: readonly MemoryCandidateSummary[];
}

export interface MemoryCandidateSummary {
  readonly id: string;
  readonly scopeType: string;
  readonly ownerId?: string;
  readonly title: string;
  readonly status: string;
  readonly confidence: string;
  readonly reasonCode?: string;
  readonly createdAt: string;
}

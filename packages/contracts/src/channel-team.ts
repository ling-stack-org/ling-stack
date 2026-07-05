export type ChannelTeamTurnMode = "quick_answer" | "deep_review" | "safe_action" | "background_work";

export type ChannelTeamEvidenceGrade = "inferred" | "observed" | "inspected" | "verified" | "reproduced";

export type ChannelParticipationMode =
  | "observer"
  | "specialist"
  | "reviewer"
  | "executor"
  | "speaker"
  | "disabled";

export type AgentQualityState =
  | "new"
  | "warming_up"
  | "active"
  | "trusted"
  | "watchlisted"
  | "degraded"
  | "quarantined"
  | "manual_only"
  | "retired";

export type AgentAvailabilityState =
  | "healthy"
  | "slow"
  | "rate_limited"
  | "overloaded"
  | "offline"
  | "unknown";

export type ChannelTeamEvidenceKind =
  | "agent_relevance_card"
  | "specialist_note"
  | "risk_signal"
  | "dissent_signal";

export type ChannelTeamEvidenceStatus =
  | "pending"
  | "completed"
  | "skipped"
  | "timeout"
  | "unavailable"
  | "rejected"
  | "adopted"
  | "expired";

export type ChannelTeamEvidenceVisibility = "internal" | "folded_evidence" | "promoted";

export type ChannelTeamEvidenceSourceRefType =
  | "message"
  | "turn"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step"
  | "context_summary"
  | "attachment"
  | "link_preview"
  | "approval"
  | "provider_observation"
  | "external";

export interface ChannelTeamEvidenceSourceRef {
  readonly type: ChannelTeamEvidenceSourceRefType;
  readonly id: string;
  readonly label?: string;
}

export interface ModelSignature {
  readonly providerPresetId?: string;
  readonly providerId?: string;
  readonly model: string;
  readonly api?: string;
  readonly promptHash?: string;
  readonly capabilityHash?: string;
}

export interface AgentCapabilityManifest {
  readonly agentId: string;
  readonly summary?: string;
  readonly capabilityScopes: readonly string[];
  readonly preferredTurnModes?: readonly ChannelTeamTurnMode[];
  readonly disallowedActions?: readonly string[];
  readonly maxLeaseLevel?: "L0" | "L1" | "L2" | "L3";
  readonly riskReviewEligible?: boolean;
  readonly source?: "teammate_profile" | "template" | "inferred" | "system";
}

export interface ChannelTeamFeatureFlags {
  readonly attentionPlanEnabled?: boolean;
  readonly agentRelevanceCardsEnabled?: boolean;
}

export interface ChannelTeamTurnSignal {
  readonly kind: "topic" | "risk" | "tool" | "file" | "workflow" | "user_mention" | "default";
  readonly scope: string;
  readonly weight?: number;
  readonly sourceRefs?: readonly ChannelTeamEvidenceSourceRef[];
}

export interface AgentObserverPlan {
  readonly agentId: string;
  readonly participationMode: ChannelParticipationMode;
  readonly reason: string;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly maxLevel: "L0" | "L1" | "L2" | "L3";
  readonly matchedScopes?: readonly string[];
  readonly availabilityState?: AgentAvailabilityState;
  readonly qualityState?: AgentQualityState;
}

export interface AttentionPlan {
  readonly id: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly turnMode: ChannelTeamTurnMode;
  readonly observers: readonly AgentObserverPlan[];
  readonly riskSignals: readonly string[];
  readonly createdAt: string;
}

export interface TeamRuntimePlan {
  readonly id: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly turnMode: ChannelTeamTurnMode;
  readonly attentionPlanId?: string;
  readonly maxObservers: number;
  readonly totalTimeoutMs: number;
  readonly perAgentTimeoutMs: number;
  readonly allowLateNotes: boolean;
  readonly allowFallbackProvider: boolean;
  readonly maxReadLeases: number;
  readonly budgetClass: "low" | "normal" | "high";
  readonly observers: readonly AgentObserverPlan[];
  readonly lateObserverIds: readonly string[];
  readonly skippedObserverIds: readonly string[];
  readonly constraints: readonly string[];
  readonly createdAt: string;
}

export interface AgentRelevanceCard {
  readonly id: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly status: ChannelTeamEvidenceStatus;
  readonly summary: string;
  readonly confidence: number;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpecialistNote {
  readonly id: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly visibility: ChannelTeamEvidenceVisibility;
  readonly evidenceGrade: ChannelTeamEvidenceGrade;
  readonly summary: string;
  readonly concerns: readonly string[];
  readonly recommendations: readonly string[];
  readonly confidence: number;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
}

export interface CreateSpecialistNoteEvidenceInput {
  readonly id?: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly evidenceGrade: ChannelTeamEvidenceGrade;
  readonly summary: string;
  readonly concerns?: readonly string[];
  readonly recommendations?: readonly string[];
  readonly confidence?: number;
  readonly sourceRefs?: readonly ChannelTeamEvidenceSourceRef[];
  readonly visibility?: ChannelTeamEvidenceVisibility;
  readonly status?: ChannelTeamEvidenceStatus;
  readonly now?: string;
  readonly retentionDays?: number;
  readonly expiresAt?: string | null;
  readonly payload?: Record<string, unknown>;
}

export interface FoldedExpertEvidenceEntry {
  readonly id: string;
  readonly agentId?: string;
  readonly kind: ChannelTeamEvidenceKind;
  readonly status: ChannelTeamEvidenceStatus;
  readonly visibility: ChannelTeamEvidenceVisibility;
  readonly evidenceGrade?: ChannelTeamEvidenceGrade;
  readonly summary: string;
  readonly concerns: readonly string[];
  readonly recommendations: readonly string[];
  readonly confidence?: number;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FoldedExpertChip {
  readonly agentId: string;
  readonly status: ChannelTeamEvidenceStatus;
  readonly evidenceCount: number;
  readonly evidenceGrade?: ChannelTeamEvidenceGrade;
  readonly latestSummary: string;
  readonly updatedAt: string;
}

export interface FoldedExpertsReadModel {
  readonly channelId: string;
  readonly turnId: string;
  readonly totalCount: number;
  readonly activeCount: number;
  readonly completedCount: number;
  readonly delayedCount: number;
  readonly unavailableCount: number;
  readonly adoptedCount: number;
  readonly rejectedCount: number;
  readonly statusCounts: Partial<Record<ChannelTeamEvidenceStatus, number>>;
  readonly chips: readonly FoldedExpertChip[];
  readonly entries: readonly FoldedExpertEvidenceEntry[];
  readonly latestUpdatedAt?: string;
}

export interface ChannelTeamExpertsProjectionResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly experts: FoldedExpertsReadModel;
}

export type ChannelTeamHealthState = "healthy" | "attention_needed" | "degraded";

export type ChannelEvidenceSummaryKind = "runs" | "approvals" | "browser" | "files" | "team_evidence";

export interface ChannelEvidenceSummaryProjection {
  readonly channelId: string;
  readonly generatedAt: string;
  readonly totalCount: number;
  readonly countsByKind: Partial<Record<ChannelEvidenceSummaryKind, number>>;
  readonly pendingCount: number;
  readonly failedCount: number;
  readonly latestUpdatedAt?: string;
}

export interface ChannelTeamMetricsSummary {
  readonly healthState: ChannelTeamHealthState;
  readonly totalEvidenceCount: number;
  readonly activeEvidenceCount: number;
  readonly delayedEvidenceCount: number;
  readonly unavailableEvidenceCount: number;
  readonly reliabilityIncidentCount: number;
  readonly availabilityIncidentCount: number;
  readonly latestUpdatedAt?: string;
}

export interface ChannelTeamAgentMetric {
  readonly agentId: string;
  readonly evidenceCount: number;
  readonly completedCount: number;
  readonly delayedCount: number;
  readonly unavailableCount: number;
  readonly adoptedCount: number;
  readonly rejectedCount: number;
  readonly reliabilityIncidentCount: number;
  readonly latestSummary?: string;
  readonly latestUpdatedAt?: string;
}

export interface ChannelTeamAttentionMetric {
  readonly activeAgentCount: number;
  readonly evidenceKindCounts: Partial<Record<ChannelTeamEvidenceKind, number>>;
  readonly evidenceStatusCounts: Partial<Record<ChannelTeamEvidenceStatus, number>>;
}

export interface ChannelTeamRiskReviewMetric {
  readonly riskSignalCount: number;
  readonly dissentSignalCount: number;
  readonly openReliabilityIncidentCount: number;
  readonly openCriticalReliabilityIncidentCount: number;
}

export interface ChannelTeamLearningQueueMetric {
  readonly recommendationEvidenceCount: number;
  readonly adoptedEvidenceCount: number;
  readonly rejectedEvidenceCount: number;
  readonly provisionalRuleCount: number;
  readonly note: string;
}

export interface ChannelTeamMetricsProjection {
  readonly channelId: string;
  readonly generatedAt: string;
  readonly visibleEvidence?: ChannelEvidenceSummaryProjection;
  readonly summary: ChannelTeamMetricsSummary;
  readonly agents: readonly ChannelTeamAgentMetric[];
  readonly attention: ChannelTeamAttentionMetric;
  readonly riskReview: ChannelTeamRiskReviewMetric;
  readonly learningQueue: ChannelTeamLearningQueueMetric;
}

export interface ChannelTeamMetricsProjectionResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly metrics: ChannelTeamMetricsProjection;
}

export interface ChannelTeamShadowArtifactGuardrails {
  readonly authority: "shadow";
  readonly canMutateProtocol: false;
  readonly canMutateMemory: false;
  readonly canMutateSkills: false;
  readonly canChangeRuntimeAuthority: false;
  readonly requiresExplicitApply: true;
}

export type ChannelTeamPatternStatus = "candidate" | "provisional" | "approved" | "expired" | "rejected";

export type ChannelTeamPatternCreatedBy = "system" | "ai-draft" | "local-user";

export type ChannelTeamProvisionalRuleEffect =
  | "attention_ordering"
  | "default_observer_suggestion"
  | "folded_experts_sort"
  | "low_risk_recommendation";

export interface ChannelTeamPattern {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly pattern: string;
  readonly summary: string;
  readonly evidenceCount: number;
  readonly adoptedCount: number;
  readonly failureCount: number;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly status: ChannelTeamPatternStatus;
  readonly createdBy: ChannelTeamPatternCreatedBy;
  readonly guardrails: ChannelTeamShadowArtifactGuardrails;
  readonly provisionalEffect?: ChannelTeamProvisionalRuleEffect;
  readonly provisionalRationale?: string;
  readonly verifyBeforeUse: boolean;
  readonly supersededByPatternId?: string;
  readonly lastSeenAt: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateChannelTeamPatternRequest {
  readonly pattern: string;
  readonly summary: string;
  readonly evidenceCount?: number;
  readonly adoptedCount?: number;
  readonly failureCount?: number;
  readonly sourceRefs?: readonly ChannelTeamEvidenceSourceRef[];
  readonly status?: Extract<ChannelTeamPatternStatus, "candidate" | "provisional">;
  readonly createdBy?: ChannelTeamPatternCreatedBy;
  readonly provisionalEffect?: ChannelTeamProvisionalRuleEffect;
  readonly provisionalRationale?: string;
  readonly verifyBeforeUse?: boolean;
  readonly supersededByPatternId?: string;
  readonly lastSeenAt?: string;
  readonly expiresAt?: string;
}

export interface ChannelTeamPatternsResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly patterns: readonly ChannelTeamPattern[];
}

export interface ChannelTeamPatternResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly pattern: ChannelTeamPattern;
}

export type ChannelTeamSnapshotCreatedBy = "system" | "local-user" | "ai-draft";

export interface ChannelTeamSnapshotProtocolState {
  readonly version?: number;
  readonly defaultWorkflowPreference?: string;
  readonly visibleMultiReplyMaxParticipants?: number;
  readonly privacyRules: readonly string[];
  readonly reviewRules: readonly string[];
  readonly updatedAt?: string;
}

export interface ChannelTeamSnapshotState {
  readonly protocol?: ChannelTeamSnapshotProtocolState;
  readonly activeProvisionalRules: readonly ChannelTeamPattern[];
  readonly patterns: readonly ChannelTeamPattern[];
  readonly reliabilityIncidentIds: readonly string[];
  readonly availabilityIncidentIds: readonly string[];
  readonly metrics?: ChannelTeamMetricsProjection;
  readonly messageCount: number;
  readonly latestMessageAt?: string;
}

export interface ChannelTeamSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly reason: string;
  readonly createdBy: ChannelTeamSnapshotCreatedBy;
  readonly guardrails: ChannelTeamShadowArtifactGuardrails;
  readonly state: ChannelTeamSnapshotState;
  readonly createdAt: string;
}

export interface CreateChannelTeamSnapshotRequest {
  readonly reason: string;
  readonly createdBy?: ChannelTeamSnapshotCreatedBy;
}

export interface ChannelTeamSnapshotsResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly snapshots: readonly ChannelTeamSnapshot[];
}

export interface ChannelTeamSnapshotResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly snapshot: ChannelTeamSnapshot;
}

export interface ChannelTeamSnapshotDiffEntry {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly kind: "added" | "removed" | "changed";
}

export interface ChannelTeamSnapshotDiff {
  readonly baseSnapshotId: string;
  readonly targetSnapshotId: string;
  readonly entries: readonly ChannelTeamSnapshotDiffEntry[];
  readonly guardrails: ChannelTeamShadowArtifactGuardrails;
  readonly restoreRequiresExplicitApply: true;
}

export interface ChannelTeamSnapshotDiffResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly diff: ChannelTeamSnapshotDiff;
}

export interface ChannelTeamEvaluationCase {
  readonly id: string;
  readonly input: string;
  readonly expectedRiskReviewStatus?: ChannelTeamRiskReviewDecision["status"];
  readonly maxObserverCount?: number;
}

export interface CreateChannelTeamEvaluationRunRequest {
  readonly snapshotId?: string;
  readonly cases: readonly ChannelTeamEvaluationCase[];
  readonly includeRecentMessages?: boolean;
  readonly recentMessageLimit?: number;
}

export interface ChannelTeamEvaluationCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly observedRiskReviewStatus: ChannelTeamRiskReviewDecision["status"];
  readonly observedObserverCount: number;
  readonly reasons: readonly string[];
}

export interface ChannelTeamEvaluationSummary {
  readonly passedCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
}

export interface ChannelTeamEvaluationRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly snapshotId?: string;
  readonly guardrails: ChannelTeamShadowArtifactGuardrails;
  readonly cases: readonly ChannelTeamEvaluationCase[];
  readonly results: readonly ChannelTeamEvaluationCaseResult[];
  readonly summary: ChannelTeamEvaluationSummary;
  readonly createdAt: string;
}

export interface ChannelTeamEvaluationRunsResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly evaluations: readonly ChannelTeamEvaluationRun[];
}

export interface ChannelTeamEvaluationRunResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly evaluation: ChannelTeamEvaluationRun;
}

export interface DissentSignal {
  readonly id: string;
  readonly turnId: string;
  readonly agentId: string;
  readonly summary: string;
  readonly conflictId?: string;
  readonly evidenceGrade: ChannelTeamEvidenceGrade;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
}

export interface AgentConflict {
  readonly id: string;
  readonly turnId: string;
  readonly agentIds: readonly string[];
  readonly summary: string;
  readonly status: "open" | "resolved" | "ignored";
  readonly resolution?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TeamFailureKind =
  | "quota"
  | "timeout"
  | "overload"
  | "network"
  | "tool_unavailable"
  | "unsafe_suggestion"
  | "low_quality"
  | "unknown";

export type ChannelTeamIncidentSeverity = "low" | "medium" | "high" | "critical";

export interface ReliabilityIncident {
  readonly id: string;
  readonly workspaceId?: string;
  readonly agentId: string;
  readonly capabilityScope: string;
  readonly kind: TeamFailureKind;
  readonly severity?: ChannelTeamIncidentSeverity;
  readonly summary: string;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly modelSignature?: ModelSignature;
  readonly recoveryRequired?: boolean;
  readonly recoveredAt?: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
}

export interface AvailabilityIncident {
  readonly id: string;
  readonly workspaceId?: string;
  readonly agentId?: string;
  readonly providerPresetId?: string;
  readonly modelSignature?: ModelSignature;
  readonly state: AgentAvailabilityState;
  readonly kind: Extract<TeamFailureKind, "quota" | "timeout" | "overload" | "network" | "unknown">;
  readonly severity?: ChannelTeamIncidentSeverity;
  readonly summary: string;
  readonly observedAt: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
}

export interface AgentLifecycleScopeState {
  readonly agentId: string;
  readonly capabilityScope: string;
  readonly qualityState: AgentQualityState;
  readonly availabilityState: AgentAvailabilityState;
  readonly reviewerEligible: boolean;
  readonly highRiskReviewerEligible: boolean;
  readonly recoveryRequired: boolean;
  readonly modelSignatureChanged: boolean;
  readonly activeReliabilityIncidentIds: readonly string[];
  readonly activeAvailabilityIncidentIds: readonly string[];
  readonly reasons: readonly string[];
  readonly updatedAt: string;
}

export interface RiskReviewGate {
  readonly id: string;
  readonly turnId: string;
  readonly riskLevel: "none" | "low" | "medium" | "high" | "critical";
  readonly reasons: readonly string[];
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
}

export type ChannelTeamRiskReviewStatus = "not_required" | "required" | "blocked";

export interface ChannelTeamRiskReviewDecision {
  readonly status: ChannelTeamRiskReviewStatus;
  readonly risk: "none" | "low" | "medium" | "high" | "critical";
  readonly reasons: readonly string[];
  readonly triggerCodes: readonly string[];
}

export interface AuthorityLedgerEntry {
  readonly id: string;
  readonly channelId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly authority: "read" | "reply" | "run" | "approval";
  readonly scope: string;
  readonly status: "requested" | "granted" | "denied" | "expired" | "revoked";
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface ChannelTeamAuthorityLedgerProjection {
  readonly channelId: string;
  readonly generatedAt: string;
  readonly entries: readonly AuthorityLedgerEntry[];
  readonly note: string;
}

export interface ChannelTeamAuthorityLedgerResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly ledger: ChannelTeamAuthorityLedgerProjection;
}

export interface ChannelTeamEvidenceItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly kind: ChannelTeamEvidenceKind;
  readonly status: ChannelTeamEvidenceStatus;
  readonly visibility: ChannelTeamEvidenceVisibility;
  readonly evidenceGrade?: ChannelTeamEvidenceGrade;
  readonly summary: string;
  readonly concerns: readonly string[];
  readonly recommendations: readonly string[];
  readonly confidence?: number;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly payload: Record<string, unknown>;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelTeamEvidenceListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly evidence: readonly ChannelTeamEvidenceItem[];
}

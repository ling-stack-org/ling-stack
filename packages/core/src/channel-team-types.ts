import { randomUUID } from "node:crypto";

export type ChannelTeamTurnMode = "quick_answer" | "deep_review" | "safe_action" | "background_work";

export type ChannelTeamEvidenceGrade = "inferred" | "observed" | "inspected" | "verified" | "reproduced";

export const channelTeamEvidenceGrades: readonly ChannelTeamEvidenceGrade[] = [
  "inferred",
  "observed",
  "inspected",
  "verified",
  "reproduced",
];

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

export const channelTeamEvidenceKinds: readonly ChannelTeamEvidenceKind[] = [
  "agent_relevance_card",
  "specialist_note",
  "risk_signal",
  "dissent_signal",
];

export type ChannelTeamEvidenceStatus =
  | "pending"
  | "completed"
  | "skipped"
  | "timeout"
  | "unavailable"
  | "rejected"
  | "adopted"
  | "expired";

export const channelTeamEvidenceStatuses: readonly ChannelTeamEvidenceStatus[] = [
  "pending",
  "completed",
  "skipped",
  "timeout",
  "unavailable",
  "rejected",
  "adopted",
  "expired",
];

export type ChannelTeamEvidenceVisibility = "internal" | "folded_evidence" | "promoted";

export const channelTeamEvidenceVisibilities: readonly ChannelTeamEvidenceVisibility[] = [
  "internal",
  "folded_evidence",
  "promoted",
];

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

export const channelTeamEvidenceSourceRefTypes: readonly ChannelTeamEvidenceSourceRefType[] = [
  "message",
  "turn",
  "task",
  "run",
  "workflow",
  "workflow_step",
  "context_summary",
  "attachment",
  "link_preview",
  "approval",
  "provider_observation",
  "external",
];

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
  readonly attentionPlanId?: string;
  readonly observers: readonly AgentObserverPlan[];
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

export interface ReliabilityIncident {
  readonly id: string;
  readonly agentId: string;
  readonly capabilityScope: string;
  readonly kind: TeamFailureKind;
  readonly summary: string;
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface AvailabilityIncident {
  readonly id: string;
  readonly agentId?: string;
  readonly providerPresetId?: string;
  readonly modelSignature?: ModelSignature;
  readonly state: AgentAvailabilityState;
  readonly kind: Extract<TeamFailureKind, "quota" | "timeout" | "overload" | "network" | "unknown">;
  readonly summary: string;
  readonly observedAt: string;
  readonly expiresAt?: string;
}

export interface RiskReviewGate {
  readonly id: string;
  readonly turnId: string;
  readonly riskLevel: "none" | "low" | "medium" | "high" | "critical";
  readonly reasons: readonly string[];
  readonly sourceRefs: readonly ChannelTeamEvidenceSourceRef[];
  readonly createdAt: string;
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

export interface CreateChannelTeamEvidenceItemInput {
  readonly id?: string;
  readonly channelId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly kind: ChannelTeamEvidenceKind;
  readonly status?: ChannelTeamEvidenceStatus;
  readonly visibility?: ChannelTeamEvidenceVisibility;
  readonly evidenceGrade?: ChannelTeamEvidenceGrade;
  readonly summary: string;
  readonly concerns?: readonly string[];
  readonly recommendations?: readonly string[];
  readonly confidence?: number;
  readonly sourceRefs?: readonly ChannelTeamEvidenceSourceRef[];
  readonly payload?: Record<string, unknown>;
  readonly expiresAt?: string | null;
}

export interface UpdateChannelTeamEvidenceItemInput {
  readonly status?: ChannelTeamEvidenceStatus;
  readonly visibility?: ChannelTeamEvidenceVisibility;
  readonly evidenceGrade?: ChannelTeamEvidenceGrade | null;
  readonly summary?: string;
  readonly concerns?: readonly string[];
  readonly recommendations?: readonly string[];
  readonly confidence?: number | null;
  readonly sourceRefs?: readonly ChannelTeamEvidenceSourceRef[];
  readonly payload?: Record<string, unknown>;
  readonly expiresAt?: string | null;
}

export interface ListChannelTeamEvidenceItemsOptions {
  readonly channelId: string;
  readonly turnId?: string;
  readonly agentId?: string;
  readonly kind?: ChannelTeamEvidenceKind;
  readonly status?: ChannelTeamEvidenceStatus;
  readonly visibility?: ChannelTeamEvidenceVisibility;
  readonly includeExpired?: boolean;
  readonly now?: string;
  readonly limit?: number;
}

export function createChannelTeamEvidenceItemId(): string {
  return `channel_team_evidence_${randomUUID()}`;
}

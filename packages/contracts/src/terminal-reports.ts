export type TerminalReportSourceKind = "workflow" | "run" | "turn";
export type TerminalReportOutcomeStatus = "succeeded" | "partially_succeeded" | "blocked" | "failed" | "cancelled";
export type TerminalReportCheckStatus = "passed" | "failed" | "blocked" | "cancelled" | "skipped" | "not_run" | "unknown";
export type TerminalReportApprovalDecision = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface TerminalReportSourceRefDto {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly href?: string;
  readonly visibility: "conversation" | "folded_evidence" | "developer_only";
  readonly sensitivity?: "normal" | "private" | "secret_adjacent";
}

export interface TerminalReportCorrectionDto {
  readonly id: string;
  readonly originalAssumption: string;
  readonly correctedFact: string;
  readonly confidence: "high" | "medium";
  readonly sourceRefs: readonly TerminalReportSourceRefDto[];
}

export interface TerminalReportChangeDto {
  readonly id: string;
  readonly kind: "behavior" | "code" | "configuration" | "documentation" | "data" | "other";
  readonly title: string;
  readonly summary: string;
  readonly paths: readonly string[];
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly sourceRefs: readonly TerminalReportSourceRefDto[];
}

export interface TerminalReportVerificationDto {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalReportCheckStatus;
  readonly summary?: string;
  readonly command?: string;
  readonly durationMs?: number;
  readonly sourceRefs: readonly TerminalReportSourceRefDto[];
}

export interface TerminalReportParticipantDto {
  readonly agentId: string;
  readonly displayName: string;
  readonly roleKey?: string;
  readonly status: "completed" | "failed" | "blocked" | "cancelled";
  readonly contribution: string;
  readonly sourceRefs: readonly TerminalReportSourceRefDto[];
}

export interface TerminalReportArtifactDto {
  readonly id: string;
  readonly kind: "file" | "diff" | "document" | "image" | "test_result" | "commit" | "pull_request" | "deployment" | "external" | "other";
  readonly title: string;
  readonly path?: string;
  readonly href?: string;
  readonly summary?: string;
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly sourceRefs: readonly TerminalReportSourceRefDto[];
}

export interface TerminalReportRiskDto {
  readonly id: string;
  readonly severity: "info" | "warning" | "critical";
  readonly status: "unresolved" | "mitigated" | "accepted" | "unverified";
  readonly summary: string;
  readonly nextAction?: string;
  readonly approvalDecision?: TerminalReportApprovalDecision;
  readonly sourceRefs: readonly TerminalReportSourceRefDto[];
}

export interface TerminalReportDto {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceMessageId?: string;
  readonly source: { readonly kind: TerminalReportSourceKind; readonly id: string };
  readonly status: "committed" | "fallback";
  readonly language: SupportedLocale;
  readonly outcome: {
    readonly status: TerminalReportOutcomeStatus;
    readonly title: string;
    readonly summary: string;
    readonly corrections: readonly TerminalReportCorrectionDto[];
    readonly sourceRefs: readonly TerminalReportSourceRefDto[];
  };
  readonly changes: readonly TerminalReportChangeDto[];
  readonly verification: readonly TerminalReportVerificationDto[];
  readonly participants: readonly TerminalReportParticipantDto[];
  readonly artifacts: readonly TerminalReportArtifactDto[];
  readonly risks: readonly TerminalReportRiskDto[];
  readonly references: readonly TerminalReportSourceRefDto[];
  readonly evidenceSnapshotId: string;
  readonly evidenceFingerprint: string;
  readonly synthesis: {
    readonly mode: "model" | "runner_reuse" | "deterministic_fallback";
    readonly model?: string;
    readonly providerPresetId?: string;
    readonly promptVersion: string;
    readonly attemptCount: number;
    readonly validationCodes: readonly string[];
  };
  readonly createdAt: string;
  readonly committedAt: string;
}

/** Conversation-detail join metadata for the Host-owned final-result Item. */
export interface ConversationTerminalReportProjectionDto extends TerminalReportDto {
  readonly generation: number;
  readonly resultItemId: string;
}

export interface TerminalReportResponse {
  readonly report: TerminalReportDto;
}

export interface TerminalReportListResponse {
  readonly reports: readonly TerminalReportDto[];
}
import type { SupportedLocale } from "@ling-stack/localization";

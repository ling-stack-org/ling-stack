import { randomUUID } from "node:crypto";
import type { SupportedLocale } from "@ling-stack/localization";

export const terminalReportSchemaVersion = 1 as const;

export type TerminalReportSurface = "normal_conversation" | "channel" | "teammate_private_chat";
export type TerminalReportSourceKind = "workflow" | "run" | "turn";
export type TerminalReportOutcomeStatus = "succeeded" | "partially_succeeded" | "blocked" | "failed" | "cancelled";
export type TerminalReportRecordStatus = "draft" | "validating" | "committed" | "fallback" | "failed";
export type TerminalReportLanguage = SupportedLocale;
export type TerminalReportCheckStatus = "passed" | "failed" | "blocked" | "cancelled" | "skipped" | "not_run" | "unknown";
export type TerminalReportParticipantStatus = "completed" | "failed" | "blocked" | "cancelled";
export type TerminalReportRiskSeverity = "info" | "warning" | "critical";
export type TerminalReportRiskStatus = "unresolved" | "mitigated" | "accepted" | "unverified";

export type TerminalReportSourceRefKind =
  | "message"
  | "conversation_item"
  | "turn"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step"
  | "operation"
  | "execution_action"
  | "approval"
  | "artifact"
  | "file"
  | "check"
  | "commit"
  | "pull_request"
  | "deployment"
  | "memory"
  | "context_source"
  | "external";

export interface TerminalReportSourceRef {
  readonly kind: TerminalReportSourceRefKind;
  readonly id: string;
  readonly label?: string;
  readonly href?: string;
  readonly visibility: "conversation" | "folded_evidence" | "developer_only";
  readonly sensitivity?: "normal" | "private" | "secret_adjacent";
}

export interface TerminalReportEvidenceStep {
  readonly id: string;
  readonly title: string;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled" | "skipped";
  readonly teammateId?: string;
  readonly runId?: string;
  readonly resultSummary?: string;
  readonly blocker?: string;
  readonly changedPaths: readonly string[];
  readonly artifactIds: readonly string[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportEvidenceOperation {
  readonly id: string;
  readonly kind: "read" | "search" | "edit" | "command" | "check" | "browser" | "approval" | "external" | "other";
  readonly title: string;
  readonly status: "succeeded" | "failed" | "blocked" | "cancelled" | "unknown";
  readonly runId?: string;
  readonly teammateId?: string;
  readonly changedPaths: readonly string[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportEvidenceCheck {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalReportCheckStatus;
  readonly command?: string;
  readonly summary?: string;
  readonly durationMs?: number;
  readonly runId?: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportEvidenceParticipant {
  readonly agentId: string;
  readonly displayName: string;
  readonly roleKey?: string;
  readonly status: TerminalReportParticipantStatus;
  readonly workflowStepIds: readonly string[];
  readonly runIds: readonly string[];
  readonly contributionSummaries: readonly string[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export type TerminalReportArtifactKind =
  | "file"
  | "diff"
  | "document"
  | "image"
  | "test_result"
  | "commit"
  | "pull_request"
  | "deployment"
  | "external"
  | "other";

export interface TerminalReportEvidenceArtifact {
  readonly id: string;
  readonly kind: TerminalReportArtifactKind;
  readonly title: string;
  readonly path?: string;
  readonly href?: string;
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly changedPaths: readonly string[];
  readonly status?: "created" | "updated" | "published" | "merged" | "failed";
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportEvidenceApproval {
  readonly id: string;
  readonly title: string;
  readonly actionType: string;
  readonly status: "pending" | "approved" | "denied" | "expired" | "cancelled";
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportEvidenceRisk {
  readonly id: string;
  readonly severity: TerminalReportRiskSeverity;
  readonly status: TerminalReportRiskStatus;
  readonly summary: string;
  readonly nextAction?: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportEvidenceSnapshot {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly surface: TerminalReportSurface;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceMessageId?: string;
  readonly source: { readonly kind: TerminalReportSourceKind; readonly id: string };
  readonly objective: string;
  readonly language: TerminalReportLanguage;
  readonly terminalState: TerminalReportOutcomeStatus;
  readonly terminalAt: string;
  readonly steps: readonly TerminalReportEvidenceStep[];
  readonly operations: readonly TerminalReportEvidenceOperation[];
  readonly checks: readonly TerminalReportEvidenceCheck[];
  readonly participants: readonly TerminalReportEvidenceParticipant[];
  readonly artifacts: readonly TerminalReportEvidenceArtifact[];
  readonly approvals: readonly TerminalReportEvidenceApproval[];
  readonly risks: readonly TerminalReportEvidenceRisk[];
  readonly references: readonly TerminalReportSourceRef[];
  readonly evidenceFingerprint: string;
  readonly generatedAt: string;
}

export interface TerminalReportCorrection {
  readonly id: string;
  readonly originalAssumption: string;
  readonly correctedFact: string;
  readonly confidence: "high" | "medium";
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportOutcome {
  readonly status: TerminalReportOutcomeStatus;
  readonly title: string;
  readonly summary: string;
  readonly corrections: readonly TerminalReportCorrection[];
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportChange {
  readonly id: string;
  readonly kind: "behavior" | "code" | "configuration" | "documentation" | "data" | "other";
  readonly title: string;
  readonly summary: string;
  readonly paths: readonly string[];
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportVerification {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalReportCheckStatus;
  readonly summary?: string;
  readonly command?: string;
  readonly durationMs?: number;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportParticipant {
  readonly agentId: string;
  readonly displayName: string;
  readonly roleKey?: string;
  readonly status: TerminalReportParticipantStatus;
  readonly contribution: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportArtifact {
  readonly id: string;
  readonly kind: TerminalReportArtifactKind;
  readonly title: string;
  readonly path?: string;
  readonly href?: string;
  readonly summary?: string;
  readonly addedLines?: number;
  readonly deletedLines?: number;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportRisk {
  readonly id: string;
  readonly severity: TerminalReportRiskSeverity;
  readonly status: TerminalReportRiskStatus;
  readonly summary: string;
  readonly nextAction?: string;
  readonly sourceRefs: readonly TerminalReportSourceRef[];
}

export interface TerminalReportContent {
  readonly outcome: TerminalReportOutcome;
  readonly changes: readonly TerminalReportChange[];
  readonly verification: readonly TerminalReportVerification[];
  readonly participants: readonly TerminalReportParticipant[];
  readonly artifacts: readonly TerminalReportArtifact[];
  readonly risks: readonly TerminalReportRisk[];
  readonly references: readonly TerminalReportSourceRef[];
}

export interface TerminalReportSynthesisMetadata {
  readonly mode: "model" | "runner_reuse" | "deterministic_fallback";
  readonly model?: string;
  readonly providerPresetId?: string;
  readonly promptVersion: string;
  readonly attemptCount: number;
  readonly validationCodes: readonly string[];
}

export interface TerminalReport extends TerminalReportContent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceMessageId?: string;
  readonly source: { readonly kind: TerminalReportSourceKind; readonly id: string };
  readonly status: "committed" | "fallback";
  readonly language: TerminalReportLanguage;
  readonly evidenceSnapshotId: string;
  readonly evidenceFingerprint: string;
  readonly synthesis: TerminalReportSynthesisMetadata;
  readonly createdAt: string;
  readonly committedAt: string;
}

export interface LingTerminalReportRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceMessageId?: string;
  readonly sourceKind: TerminalReportSourceKind;
  readonly sourceId: string;
  readonly generation: number;
  readonly status: TerminalReportRecordStatus;
  readonly outcomeStatus?: TerminalReportOutcomeStatus;
  readonly language: TerminalReportLanguage;
  readonly evidenceSnapshot: TerminalReportEvidenceSnapshot;
  readonly evidenceFingerprint: string;
  readonly report?: TerminalReport;
  readonly synthesisMode?: TerminalReportSynthesisMetadata["mode"];
  readonly promptVersion?: string;
  readonly attemptCount: number;
  readonly validationCodes: readonly string[];
  readonly publishedMessageId?: string;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}

export interface CreateLingTerminalReportInput {
  readonly id?: string;
  readonly generation?: number;
  readonly evidenceSnapshot: TerminalReportEvidenceSnapshot;
}

export interface ListLingTerminalReportsOptions {
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly threadId?: string;
  readonly sourceKind?: TerminalReportSourceKind;
  readonly sourceId?: string;
  readonly status?: TerminalReportRecordStatus;
  readonly limit?: number;
}

export interface UpdateLingTerminalReportDraftInput {
  readonly reportId: string;
  readonly expectedStatus: "draft" | "validating";
  readonly expectedEvidenceFingerprint: string;
  readonly status?: "draft" | "validating";
  readonly evidenceSnapshot?: TerminalReportEvidenceSnapshot;
  readonly promptVersion?: string;
  readonly attemptCount?: number;
  readonly validationCodes?: readonly string[];
  readonly now: string;
}

export interface CommitLingTerminalReportInput {
  readonly reportId: string;
  readonly expectedStatus: "draft" | "validating";
  readonly expectedEvidenceFingerprint: string;
  readonly report: TerminalReport;
  readonly synthesisMode: TerminalReportSynthesisMetadata["mode"];
  readonly promptVersion: string;
  readonly attemptCount: number;
  readonly validationCodes?: readonly string[];
  readonly now: string;
}

export interface FailLingTerminalReportInput {
  readonly reportId: string;
  readonly expectedStatus?: "draft" | "validating";
  readonly expectedEvidenceFingerprint?: string;
  readonly errorCode: string;
  readonly validationCodes?: readonly string[];
  readonly attemptCount?: number;
  readonly now: string;
}

export interface MarkLingTerminalReportPublishedInput {
  readonly reportId: string;
  readonly messageId: string;
  readonly now: string;
}

export function createTerminalReportId(): string {
  return `terminal_report_${randomUUID()}`;
}

export function createTerminalReportSnapshotId(): string {
  return `terminal_report_snapshot_${randomUUID()}`;
}

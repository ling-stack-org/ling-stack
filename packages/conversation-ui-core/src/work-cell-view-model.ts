export type ConversationOperationCellMode = "active" | "completed";
export type ConversationOperationCellStatus = string;
export type ConversationOperationCellSourceKind = "run_thread" | "workflow" | "collaboration_task";
export type ConversationOperationKind =
  | "plan"
  | "read"
  | "edit"
  | "run_command"
  | "search"
  | "approval"
  | "verify"
  | "handoff"
  | "watch";
export type ConversationWorkCellGroupKind = "changed" | "checked" | "context" | "evidence" | "attention";
export type ConversationWorkCellRowTone = "neutral" | "running" | "waiting" | "success" | "failed";

export interface ConversationWorkCellStat {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface ConversationWorkCellRow {
  readonly id: string;
  readonly kind?: ConversationOperationKind;
  readonly presentation?: "default" | "shell" | "note";
  readonly reportSection?: "outcome" | "correction" | "change" | "verification" | "participant" | "risk";
  readonly participantId?: string;
  readonly title: string;
  readonly description?: string;
  readonly meta?: string;
  readonly commandText?: string;
  readonly changePreview?: ConversationWorkCellChangePreview;
  readonly detailLines?: readonly ConversationWorkCellRowDetailLine[];
  readonly tone?: ConversationWorkCellRowTone;
}

export interface ConversationWorkCellChangePreview {
  readonly artifactId: string;
  readonly path?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
}

export interface ConversationWorkCellRowDetailLine {
  readonly kind?: "text" | "code";
  readonly text: string;
}

export type ConversationAgentActivitySpanKind = "agent" | "overflow";

export interface ConversationAgentActivitySpan {
  readonly id: string;
  readonly participantId?: string;
  readonly kind?: ConversationAgentActivitySpanKind;
  readonly label: string;
  readonly summary?: string;
  readonly meta?: string;
  readonly tone?: ConversationWorkCellRowTone;
  readonly stateLabel?: string;
  readonly latestRow?: ConversationWorkCellRow;
  readonly rows: readonly ConversationWorkCellRow[];
}

/** @deprecated Use ConversationAgentActivitySpan. */
export type ConversationWorkCellBranch = ConversationAgentActivitySpan;

export interface ConversationWorkCellEvidenceLink {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
  readonly href?: string;
  readonly artifactId?: string;
  readonly artifactType?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewKind?: "file" | "image";
  readonly previewable?: boolean;
}

export type ConversationArtifactStripItemKind = "artifact" | "changed" | "checked" | "attention" | "approval";

export interface ConversationArtifactStripChangeArtifact {
  readonly id: string;
  readonly label: string;
  readonly artifactId?: string;
  readonly path?: string;
  readonly href?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewable?: boolean;
}

export interface ConversationArtifactStripItem {
  readonly id: string;
  readonly kind: ConversationArtifactStripItemKind;
  readonly label: string;
  readonly tone?: ConversationWorkCellRowTone;
  readonly href?: string;
  readonly artifactId?: string;
  readonly artifactType?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewKind?: "file" | "image";
  readonly previewable?: boolean;
  readonly changeArtifacts?: readonly ConversationArtifactStripChangeArtifact[];
}

export interface ConversationWorkCellGroup {
  readonly id: ConversationWorkCellGroupKind;
  readonly label: string;
  readonly summary: string;
  readonly rows: readonly ConversationWorkCellRow[];
}

export interface ConversationOperationCellViewModel {
  readonly id: string;
  readonly sourceKind: ConversationOperationCellSourceKind;
  readonly threadId: string;
  readonly turnId?: string;
  readonly anchorRunId: string;
  readonly runIds: readonly string[];
  readonly mode: ConversationOperationCellMode;
  readonly status: ConversationOperationCellStatus;
  readonly presentation?: "default" | "collaboration_task";
  readonly kicker?: string;
  readonly showDiagnostics?: boolean;
  readonly title: string;
  readonly summary: string;
  readonly stats: readonly ConversationWorkCellStat[];
  readonly elapsedMs?: number;
  readonly operationRows: readonly ConversationWorkCellRow[];
  readonly agentSpans: readonly ConversationAgentActivitySpan[];
  /** @deprecated Use agentSpans. Kept while call sites migrate. */
  readonly agentBranches: readonly ConversationWorkCellBranch[];
  readonly terminalReportId?: string;
  readonly terminalReportRevisionKey?: string;
  readonly terminalReportRows: readonly ConversationWorkCellRow[];
  /** @deprecated Use operationRows. Kept while call sites migrate. */
  readonly activeRows: readonly ConversationWorkCellRow[];
  /** @deprecated Use agentSpans. Kept while call sites migrate. */
  readonly branchRows?: readonly ConversationWorkCellBranch[];
  /** @deprecated Use terminalReportRows. Kept while call sites migrate. */
  readonly finalReportRows?: readonly ConversationWorkCellRow[];
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
  readonly artifactStripItems: readonly ConversationArtifactStripItem[];
  readonly updatedAt: string;
}

export type ConversationWorkCellViewModel = ConversationOperationCellViewModel;

export type ConversationOperationCellDraft =
  Omit<ConversationOperationCellViewModel, "agentSpans" | "activeRows" | "branchRows" | "finalReportRows"> &
  Partial<Pick<ConversationOperationCellViewModel, "agentSpans" | "activeRows" | "branchRows" | "finalReportRows">>;

export function normalizeConversationOperationCell(
  draft: ConversationOperationCellDraft,
): ConversationOperationCellViewModel {
  const agentSpans = draft.agentSpans ?? draft.agentBranches;
  return {
    ...draft,
    agentSpans,
    activeRows: draft.activeRows ?? draft.operationRows,
    branchRows: draft.branchRows ?? agentSpans,
    finalReportRows: draft.finalReportRows ?? draft.terminalReportRows,
  };
}

export interface ConversationWorkCellDetailsModel {
  readonly groups: readonly ConversationWorkCellGroup[];
  readonly evidenceLinks: readonly ConversationWorkCellEvidenceLink[];
}

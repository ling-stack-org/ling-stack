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

export interface ConversationCommandExecutionView {
  readonly actionId: string;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly actionType: string;
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly status: string;
  readonly commandText: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly latestEventSeq: number;
  readonly outputTruncated: boolean;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
}

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
  readonly commandExecution?: ConversationCommandExecutionView;
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

export type ConversationWorkCellRowDetailLine =
  | {
      readonly kind?: "text";
      readonly text: string;
    }
  | {
      readonly kind: "code";
      readonly text: string;
    }
  | {
      readonly kind: "file_ref";
      readonly text: string;
      readonly path: string;
      readonly line?: number;
    };

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
  readonly items?: readonly ConversationWorkCellItem[];
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
  readonly path?: string;
  readonly tone?: ConversationWorkCellRowTone;
  readonly href?: string;
  readonly artifactId?: string;
  readonly artifactType?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewKind?: "file" | "image";
  readonly previewable?: boolean;
  readonly recoveryRunId?: string;
  readonly changeArtifacts?: readonly ConversationArtifactStripChangeArtifact[];
}

export interface ConversationWorkCellGroup {
  readonly id: ConversationWorkCellGroupKind;
  readonly label: string;
  readonly summary: string;
  readonly rows: readonly ConversationWorkCellRow[];
}

export interface ConversationCommandBatchItem {
  readonly id: string;
  readonly actionId: string;
  readonly row: ConversationWorkCellRow;
  readonly commandText: string;
  readonly status: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly outputTruncated: boolean;
  readonly stdoutArtifactId?: string;
  readonly stderrArtifactId?: string;
}

export interface ConversationCommandBatch {
  readonly id: string;
  readonly revisionKey: string;
  readonly commandCount: number;
  readonly durationMs?: number;
  readonly defaultExpanded: boolean;
  readonly commands: readonly ConversationCommandBatchItem[];
}

export type ConversationWorkCellItem =
  | {
      readonly kind: "operation";
      readonly row: ConversationWorkCellRow;
    }
  | {
      readonly kind: "command_batch";
      readonly batch: ConversationCommandBatch;
    };

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
  readonly operationItems?: readonly ConversationWorkCellItem[];
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

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
export type ConversationTurnRunRole = "primary" | "retry" | "resume" | "repair" | "validation";

export interface ConversationOperationSourceRef {
  readonly kind: string;
  readonly id: string;
  readonly label?: string;
  readonly path?: string;
  /** Granted only by the Host adapter; absent refs remain copyable text. */
  readonly hostTarget?: "open_file" | "open_diff" | "open_artifact" | "open_run";
  readonly capabilityId?: string;
  readonly workspaceId?: string;
  readonly visibility?: "conversation" | "private" | "audit";
}

/**
 * A source reference that the Host has explicitly authorised for an action.
 *
 * Renderers may display every source reference as copyable text. A typed
 * operation item may pass a display ref plus its full action lineage to the
 * Host so the Host can mint a fresh capability; model message text cannot.
 * This narrowed shape represents a capability that was already Host-issued.
 */
export type ConversationTrustedSourceRef = ConversationOperationSourceRef & {
  readonly hostTarget: "open_file" | "open_diff" | "open_artifact" | "open_run";
  /** Present when the Host minted a capability for this ref. */
  readonly capabilityId?: string;
  readonly workspaceId?: string;
};

export interface ConversationOperationExecutionView {
  readonly actionId: string;
  readonly revision?: number;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly approvalId?: string;
  readonly turnRunRole?: ConversationTurnRunRole;
  readonly participantId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly actionType: string;
  readonly status: string;
  readonly updatedAt?: string;
  readonly latestEventSeq?: number;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}

export interface ConversationActivitySummary {
  readonly editedFileCount: number;
  readonly editedItemCount: number;
  readonly readItemCount: number;
  readonly commandCount: number;
  readonly hasStructuredActions: boolean;
}

export interface ConversationCommandExecutionView {
  readonly actionId: string;
  readonly revision?: number;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly approvalId?: string;
  readonly turnRunRole?: ConversationTurnRunRole;
  readonly participantId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly actionType: string;
  readonly risk: "low" | "medium" | "high" | "critical";
  readonly status: string;
  readonly commandText: string;
  readonly cwd?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly latestEventSeq: number;
  readonly outputTail?: readonly {
    readonly eventSeq: number;
    readonly stream: "stdout" | "stderr";
    readonly text: string;
    readonly redacted: boolean;
  }[];
  readonly sourceRefs?: readonly ConversationOperationSourceRef[];
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
  readonly operationExecution?: ConversationOperationExecutionView;
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
  /** Parent run lineage for the nested participant span, when available. */
  readonly runId?: string;
  readonly attemptId?: string;
  readonly workflowStepId?: string;
  readonly sourceRefs?: readonly ConversationOperationSourceRef[];
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

export type ConversationWorkspaceRecoveryTarget =
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string }
  | { readonly kind: "turn"; readonly id: string };

export interface ConversationArtifactStripItem {
  readonly id: string;
  readonly kind: ConversationArtifactStripItemKind;
  readonly label: string;
  readonly path?: string;
  readonly workspaceFilePath?: string;
  readonly tone?: ConversationWorkCellRowTone;
  readonly href?: string;
  readonly artifactId?: string;
  readonly artifactType?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly previewKind?: "file" | "image";
  readonly previewable?: boolean;
  readonly recoveryTarget?: ConversationWorkspaceRecoveryTarget;
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
  readonly leadingRows?: readonly ConversationWorkCellRow[];
}

export interface ConversationCommandBatch {
  readonly id: string;
  /** Monotonic aggregate revision of the atomic command children. */
  readonly revision?: number;
  readonly revisionKey: string;
  readonly commandCount: number;
  readonly durationMs?: number;
  readonly defaultExpanded: boolean;
  readonly actionIds: readonly string[];
  /** Full atomic membership; actionIds remains as the legacy alias during cutover. */
  readonly childActionIds?: readonly string[];
  readonly childItemIds?: readonly string[];
  readonly runId?: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly turnRunRole?: ConversationTurnRunRole;
  readonly participantId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
  readonly commands: readonly ConversationCommandBatchItem[];
}

export interface ConversationExplorationBatch {
  readonly id: string;
  /** Monotonic aggregate revision of the atomic exploration children. */
  readonly revision?: number;
  readonly revisionKey: string;
  readonly actionIds: readonly string[];
  /** Full atomic membership; actionIds remains as the legacy alias during cutover. */
  readonly childActionIds?: readonly string[];
  readonly childItemIds?: readonly string[];
  readonly runId: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly turnRunRole?: ConversationTurnRunRole;
  readonly participantId?: string;
  readonly workUnitId?: string;
  readonly workflowStepId?: string;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
  readonly operationCount: number;
  readonly targetCount?: number;
  readonly defaultExpanded: boolean;
  readonly rows: readonly ConversationWorkCellRow[];
}

export type ConversationWorkCellItem =
  | {
      readonly kind: "operation";
      readonly row: ConversationWorkCellRow;
    }
  | {
      readonly kind: "command_batch";
      readonly batch: ConversationCommandBatch;
    }
  | {
      readonly kind: "exploration_batch";
      readonly batch: ConversationExplorationBatch;
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
  /** Canonical Codex-style typed facts. When present, this is the renderer source of truth. */
  readonly typedTimelineItems?: readonly import("./transcript-item.js").ConversationTimelineItem[];
  /** Immutable ContextSnapshot segment lookup used only by display batching. */
  readonly contextSegmentIdByItemId?: ReadonlyMap<string, string>;
  readonly activitySummary?: ConversationActivitySummary;
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

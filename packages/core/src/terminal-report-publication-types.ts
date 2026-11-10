import type { ConversationItemV1 } from "@ling-stack/contracts";
import type { AppendConversationItemInput } from "./conversation-item-store-types.js";
import type { ControlPlaneEvent, LingTurnStatus } from "./run-types.js";
import type { WorkflowCompletionEvaluationV1 } from "./workflow-completion-read-set.js";
import type { NormalTerminalReportBasis } from "./normal-terminal-report-basis.js";
import type { TerminalReport, TerminalReportEvidenceSnapshot } from "./terminal-report-types.js";
import type { DelegationCompletionEvidenceV1 } from "./delegation-completion-evidence.js";

export interface CommitWorkflowTerminalReportPublicationInput {
  readonly reportId: string;
  readonly expectedReportStatus: "committed" | "fallback";
  readonly expectedEvidenceFingerprint: string;
  readonly expectedWorkflowId: string;
  readonly expectedCompletion?: WorkflowCompletionEvaluationV1;
  /** Captured with the report input, never freshly substituted after synthesis. */
  readonly expectedDelegationCompletion?: DelegationCompletionEvidenceV1;
  readonly expectedSourceTurn: {
    readonly id: string;
    readonly status: LingTurnStatus;
    readonly updatedAt: string;
  };
  readonly publicationItem: AppendConversationItemInput<"terminal_report">;
  readonly publicationEventIdempotencyKey: string;
  readonly now: string;
}

export interface CommitNormalTerminalReportPublicationInput {
  readonly reportId: string;
  readonly expectedReportStatus: "validating" | "committed" | "fallback";
  readonly expectedEvidenceFingerprint: string;
  readonly expectedNormalBasis: NormalTerminalReportBasis;
  readonly report: TerminalReport;
  /** Host evidence collector; executed synchronously in a query-only transaction window. */
  readonly readEvidence: () => TerminalReportEvidenceSnapshot;
  readonly publicationItem: AppendConversationItemInput<"terminal_report">;
  readonly publicationEventIdempotencyKey: string;
  readonly now: string;
}

export type CommitTerminalReportPublicationInput =
  | CommitWorkflowTerminalReportPublicationInput
  | CommitNormalTerminalReportPublicationInput;

export type TerminalReportPublicationConflictCode =
  | "stale_completion_basis"
  | "report_conflict"
  | "outcome_conflict"
  | "item_conflict"
  | "source_turn_conflict"
  | "publication_event_conflict";

export type CommitTerminalReportPublicationResult =
  | {
      readonly ok: true;
      readonly reportId: string;
      readonly item: ConversationItemV1;
      readonly sourceTurnId: string;
      readonly sourceTurnStatus: LingTurnStatus;
      readonly controlPlaneEvent: ControlPlaneEvent;
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly code: TerminalReportPublicationConflictCode;
    };

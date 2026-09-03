import type { ConversationItemV1 } from "@ling-stack/contracts";
import type { AppendConversationItemInput } from "./conversation-item-store-types.js";
import type { ControlPlaneEvent, LingTurnStatus } from "./run-types.js";
import type { WorkflowCompletionEvaluationV1 } from "./workflow-completion-read-set.js";

export interface CommitTerminalReportPublicationInput {
  readonly reportId: string;
  readonly expectedReportStatus: "committed" | "fallback";
  readonly expectedEvidenceFingerprint: string;
  readonly expectedWorkflowId: string;
  readonly expectedCompletion?: WorkflowCompletionEvaluationV1;
  readonly expectedSourceTurn: {
    readonly id: string;
    readonly status: LingTurnStatus;
    readonly updatedAt: string;
  };
  readonly publicationItem: AppendConversationItemInput<"terminal_report">;
  readonly publicationEventIdempotencyKey: string;
  readonly now: string;
}

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

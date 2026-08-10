import type {
  ContextSegment,
  ContextSegmentState,
  ConversationContextSummary,
  ConversationDomainRef,
  TurnContextAssignment,
  TurnContextAssignmentStatus,
  TurnContextDecisionSource,
} from "@ling-stack/contracts";

export interface ListContextSegmentsOptions {
  readonly threadId: string;
  readonly states?: readonly ContextSegmentState[];
  readonly limit?: number;
}

export type TurnContextAssignmentTarget =
  | {
      readonly kind: "existing";
      readonly segmentId: string;
    }
  | {
      readonly kind: "new";
      readonly state: "provisional" | "active";
      readonly label?: string;
    };

export interface ApplyTurnContextAssignmentInput {
  readonly turnId: string;
  readonly target: TurnContextAssignmentTarget;
  readonly status: TurnContextAssignmentStatus;
  readonly decisionSource: TurnContextDecisionSource;
  readonly confidence?: number;
  readonly antecedentTurnId?: string;
  readonly evidenceRefs?: readonly ConversationDomainRef[];
  readonly policyVersion: string;
}

export interface ApplyTurnContextAssignmentResult {
  readonly segment: ContextSegment;
  readonly assignment: TurnContextAssignment;
  readonly previousAssignment?: TurnContextAssignment;
  readonly invalidatedSummaryIds: readonly string[];
  readonly idempotentReplay: boolean;
}

export interface ListConversationContextSummariesOptions {
  readonly threadId: string;
  readonly segmentId?: string;
  readonly statuses?: readonly ConversationContextSummary["status"][];
  readonly throughSequence?: number;
  readonly limit?: number;
}

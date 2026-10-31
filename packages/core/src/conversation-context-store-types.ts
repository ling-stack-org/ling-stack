import type {
  ContextSegment,
  ContextSegmentState,
  ConversationContextSnapshot,
  ConversationContextSummary,
  ConversationContextSummaryScope,
  ConversationDomainRef,
  ConversationItemVisibilityV1,
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
  /** Optional compare-and-swap fence for explicit user corrections. */
  readonly expectedPreviousRevision?: number;
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

export interface ConversationContextSummarySourceFence {
  readonly itemId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly updatedAt: string;
  readonly visibility: ConversationItemVisibilityV1;
  readonly visibilityOwnerId?: string;
  readonly turnId: string;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
}

export interface CommitConversationContextSummaryInput {
  readonly threadId: string;
  readonly segmentId?: string;
  readonly scope: ConversationContextSummaryScope;
  readonly coveredFromSequence: number;
  readonly coveredThroughSequence: number;
  readonly objective?: string;
  readonly decisions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly activeWorkRefs?: readonly ConversationDomainRef[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly policyVersion: string;
  readonly projectionVersion: string;
  readonly visibilityFingerprint: string;
  readonly expectedActiveSummaryId: string | null;
  readonly sourceFence: readonly ConversationContextSummarySourceFence[];
}

export type ConversationContextSummaryDiscardReason =
  | "active_summary_changed"
  | "segment_changed"
  | "source_items_changed"
  | "assignments_changed"
  | "visibility_changed";

export type CommitConversationContextSummaryResult =
  | {
      readonly status: "committed";
      readonly summary: ConversationContextSummary;
    }
  | {
      readonly status: "discarded_stale";
      readonly reason: ConversationContextSummaryDiscardReason;
    };

export interface CreateConversationContextSnapshotInput {
  readonly id?: string;
  readonly threadId: string;
  readonly segmentId?: string;
  readonly projectionVersion: string;
  readonly throughItemSequence: number;
  readonly summaryIds?: readonly string[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly policyVersion: string;
}

export interface ListConversationContextSnapshotsOptions {
  readonly threadId: string;
  readonly limit?: number;
}

export interface CreateConversationContextSnapshotResult {
  readonly snapshot: ConversationContextSnapshot;
}

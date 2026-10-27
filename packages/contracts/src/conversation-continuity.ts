import type { ChannelOperationBindingV1 } from "./channel-operation-bindings.js";
import type { UserInputRunEventPositionV1 } from "./user-input-event-position.js";
import type { CommittedRunNarrationV1 } from "./committed-run-narration.js";

export const conversationDomainRefTypes = [
  "conversation_item",
  "turn",
  "thread",
  "segment",
  "channel",
  "message",
  "run",
  "task",
  "workflow",
  "workflow_step",
  "terminal_report",
  "approval",
  "artifact",
  "handoff",
  "operation",
  "memory",
  "context_summary",
  "context_snapshot",
  "user_input_request",
  "user_input_answer",
  "external_work",
  "automation",
] as const;

export type ConversationDomainRefType = (typeof conversationDomainRefTypes)[number];

export interface ConversationDomainRef {
  readonly type: ConversationDomainRefType;
  readonly id: string;
  readonly label?: string;
}

export const lingThreadSurfaceKindsV2 = [
  "channel_root",
  "topic",
  "branch",
  "direct",
  "work",
] as const;

export type LingThreadSurfaceKindV2 = (typeof lingThreadSurfaceKindsV2)[number];

export const lingThreadRelationKindsV2 = ["root", "topic", "branch"] as const;
export type LingThreadRelationKindV2 = (typeof lingThreadRelationKindsV2)[number];

export interface LingThreadContinuityV2 {
  readonly surfaceKind: LingThreadSurfaceKindV2;
  readonly relationKind: LingThreadRelationKindV2;
  readonly parentThreadId?: string;
  readonly parentTurnId?: string;
  readonly anchorItemId?: string;
  readonly forkContextSnapshotId?: string;
}

export const conversationItemKindsV1 = [
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "approval_request",
  "approval_decision",
  "user_input_request",
  "user_input_answer",
  "handoff",
  "operation_state",
  "artifact_ref",
  "terminal_report",
  "system_event",
] as const;

export type ConversationItemKindV1 = (typeof conversationItemKindsV1)[number];

export const conversationItemStatusesV1 = ["pending", "committed", "failed"] as const;
export type ConversationItemStatusV1 = (typeof conversationItemStatusesV1)[number];

export const conversationItemVisibilitiesV1 = [
  "channel",
  "thread_participants",
  "agent_private",
  "operator",
] as const;

export type ConversationItemVisibilityV1 = (typeof conversationItemVisibilitiesV1)[number];

export const conversationItemActorTypesV1 = [
  "local_user",
  "ling_agent",
  "teammate",
  "system",
] as const;

export type ConversationItemActorTypeV1 = (typeof conversationItemActorTypesV1)[number];

export const conversationMessageMentionKindsV1 = [
  "ai_teammate",
  "local_user",
  "channel",
] as const;

export type ConversationMessageMentionKindV1 = (typeof conversationMessageMentionKindsV1)[number];

export interface ConversationMessageMentionV1 {
  readonly id: string;
  readonly label: string;
  readonly kind: ConversationMessageMentionKindV1;
}

export const conversationWorkspaceFileRefSourcesV1 = [
  "composer",
  "explicit_text",
  "api",
  "inferred_text",
] as const;

export type ConversationWorkspaceFileRefSourceV1 = (typeof conversationWorkspaceFileRefSourcesV1)[number];

export interface ConversationWorkspaceFileRefV1 {
  readonly path: string;
  readonly label?: string;
  readonly source?: ConversationWorkspaceFileRefSourceV1;
  readonly line?: number;
}

export interface ConversationUserMessagePayloadV1 {
  readonly body: string;
  readonly format: "plain_text" | "markdown";
  readonly mentions: readonly ConversationMessageMentionV1[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ConversationWorkspaceFileRefV1[];
  readonly replyToItemId?: string;
  readonly quotedItemIds?: readonly string[];
}

export const conversationAssistantDeliveryStatusesV1 = [
  "pending",
  "ready",
  "blocked",
  "failed",
] as const;

export type ConversationAssistantDeliveryStatusV1 = (typeof conversationAssistantDeliveryStatusesV1)[number];

export interface ConversationAssistantMessagePayloadV1 {
  readonly runNarration?: CommittedRunNarrationV1;
  readonly body: string;
  readonly format: "plain_text" | "markdown";
  readonly streaming: boolean;
  readonly deliveryStatus: ConversationAssistantDeliveryStatusV1;
  /** Host-assigned role; model text never self-classifies as a result. */
  readonly presentationRole: ConversationAssistantPresentationRoleV1;
  readonly errorMessage?: string;
}

export const conversationAssistantPresentationRolesV1 = [
  "narration",
  "reply_result",
  "execution_summary",
] as const;

export type ConversationAssistantPresentationRoleV1 =
  (typeof conversationAssistantPresentationRolesV1)[number];

export interface ConversationToolCallPayloadV1 {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly title?: string;
  readonly inputSummary?: string;
}

export interface ConversationToolResultPayloadV1 {
  readonly toolCallId: string;
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly outputSummary?: string;
  readonly errorCode?: string;
}

export interface ConversationApprovalRequestPayloadV1 {
  readonly approvalRequestId: string;
  readonly title: string;
  readonly summary?: string;
}

export interface ConversationApprovalDecisionPayloadV1 {
  readonly approvalRequestId: string;
  readonly decision: "approved" | "denied" | "cancelled";
  readonly reason?: string;
}

export interface ConversationHandoffPayloadV1 {
  readonly handoffId: string;
  readonly targetTeammateId: string;
  readonly summary: string;
}

export interface ConversationOperationStatePayloadV1 {
  readonly operationId: string;
  readonly state: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  readonly title: string;
  readonly summary?: string;
}

export interface ConversationArtifactRefPayloadV1 {
  readonly artifactId: string;
  readonly title?: string;
  readonly artifactKind?: string;
}

/** Host-committed final-result anchor. Report content remains in TerminalReport. */
export interface ConversationTerminalReportPayloadV1 {
  readonly reportId: string;
  readonly generation: number;
  readonly sourceKind: "workflow" | "run" | "turn";
  readonly sourceId: string;
  readonly evidenceFingerprint: string;
  readonly outcomeStatus:
    | "succeeded"
    | "partially_succeeded"
    | "blocked"
    | "failed"
    | "cancelled";
}

export interface ConversationSystemEventPayloadV1 {
  readonly eventType: string;
  readonly summary: string;
}

export interface ConversationItemPayloadByKindV1 {
  /** Immutable anchors; content and mutable status live in the user-input domain. */
  readonly user_input_request: { readonly requestId: string; readonly requestVersion: number; readonly runEventPosition?: UserInputRunEventPositionV1 };
  readonly user_input_answer: { readonly requestId: string; readonly requestVersion: number; readonly answerId: string; readonly runEventPosition?: UserInputRunEventPositionV1 };
  readonly user_message: ConversationUserMessagePayloadV1;
  readonly assistant_message: ConversationAssistantMessagePayloadV1;
  readonly tool_call: ConversationToolCallPayloadV1;
  readonly tool_result: ConversationToolResultPayloadV1;
  readonly approval_request: ConversationApprovalRequestPayloadV1;
  readonly approval_decision: ConversationApprovalDecisionPayloadV1;
  readonly handoff: ConversationHandoffPayloadV1;
  readonly operation_state: ConversationOperationStatePayloadV1;
  readonly artifact_ref: ConversationArtifactRefPayloadV1;
  readonly terminal_report: ConversationTerminalReportPayloadV1;
  readonly system_event: ConversationSystemEventPayloadV1;
}

export type ConversationItemPayloadV1 = ConversationItemPayloadByKindV1[ConversationItemKindV1];

export interface ConversationItemEnvelopeV1<K extends ConversationItemKindV1> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId?: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly kind: K;
  readonly status: ConversationItemStatusV1;
  readonly actorType: ConversationItemActorTypeV1;
  readonly actorId?: string;
  readonly visibility: ConversationItemVisibilityV1;
  readonly visibilityOwnerId?: string;
  readonly payload: ConversationItemPayloadByKindV1[K];
  readonly domainRefs: readonly ConversationDomainRef[];
  readonly idempotencyKey?: string;
  readonly revision: number;
  readonly supersedesItemId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt?: string;
}

export type ConversationItemV1 = {
  readonly [K in ConversationItemKindV1]: ConversationItemEnvelopeV1<K>;
}[ConversationItemKindV1];

export const contextSegmentStates = ["provisional", "active", "merged", "archived"] as const;
export type ContextSegmentState = (typeof contextSegmentStates)[number];

export interface ContextSegment {
  readonly id: string;
  readonly threadId: string;
  readonly state: ContextSegmentState;
  readonly label?: string;
  readonly createdFromTurnId: string;
  readonly lastActiveTurnId: string;
  readonly mergedIntoSegmentId?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const turnContextAssignmentStatuses = ["provisional", "committed"] as const;
export type TurnContextAssignmentStatus = (typeof turnContextAssignmentStatuses)[number];

export const turnContextDecisionSources = ["user", "structural", "model_policy"] as const;
export type TurnContextDecisionSource = (typeof turnContextDecisionSources)[number];

export interface TurnContextAssignment {
  readonly id: string;
  readonly turnId: string;
  readonly segmentId: string;
  readonly status: TurnContextAssignmentStatus;
  readonly revision: number;
  readonly decisionSource: TurnContextDecisionSource;
  readonly confidence?: number;
  readonly antecedentTurnId?: string;
  readonly evidenceRefs: readonly ConversationDomainRef[];
  readonly policyVersion: string;
  readonly supersedesAssignmentId?: string;
  readonly createdAt: string;
}

export type ContextSegmentProposal =
  | {
      readonly action: "continue";
      readonly segmentId: string;
      readonly antecedentTurnId?: string;
      readonly confidence: number;
      readonly evidenceItemIds: readonly string[];
    }
  | {
      readonly action: "switch_existing";
      readonly segmentId: string;
      readonly antecedentTurnId?: string;
      readonly confidence: number;
      readonly evidenceItemIds: readonly string[];
    }
  | {
      readonly action: "propose_new";
      readonly confidence: number;
      readonly relatedSegmentIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly action: "uncertain";
      readonly candidateSegmentIds: readonly string[];
    };

export const conversationContextSummaryScopes = ["segment", "thread_core", "work"] as const;
export type ConversationContextSummaryScope = (typeof conversationContextSummaryScopes)[number];

export const conversationContextSummaryStatuses = ["active", "superseded", "invalidated"] as const;
export type ConversationContextSummaryStatus = (typeof conversationContextSummaryStatuses)[number];

export interface ConversationContextSummary {
  readonly id: string;
  readonly threadId: string;
  readonly segmentId?: string;
  readonly scope: ConversationContextSummaryScope;
  readonly status: ConversationContextSummaryStatus;
  readonly version: number;
  readonly coveredFromSequence: number;
  readonly coveredThroughSequence: number;
  readonly objective?: string;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly openQuestions: readonly string[];
  readonly activeWorkRefs: readonly ConversationDomainRef[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly supersedesSummaryId?: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface ConversationContextSnapshot {
  readonly id: string;
  readonly threadId: string;
  /** Absent only for an explicitly empty fork boundary (sequence zero). */
  readonly segmentId?: string;
  readonly projectionVersion: string;
  readonly throughItemSequence: number;
  readonly summaryIds: readonly string[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface ConversationContextProjectionMetadata {
  readonly projectionVersion: string;
  /**
   * Fingerprint of the effective assignment, summaries, and item revisions that
   * contributed facts to this projection. Unlike projectionVersion, this does
   * not change for metadata-only segment activity.
   */
  readonly sourceStateFingerprint: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly segmentId: string;
  readonly throughItemSequence: number;
  readonly summaryIds: readonly string[];
  readonly sourceRefs: readonly ConversationDomainRef[];
  readonly policyVersion: string;
  readonly visibilityFingerprint: string;
  /** Immutable ChannelContextView identity used to materialize a run. */
  readonly contextViewId?: string;
  /** Creation timestamp for the immutable ChannelContextView projection. */
  readonly contextViewCreatedAt?: string;
}

export const channelIntentDecisionV2Actions = [
  "no_reply",
  "reply",
  "visible_multi_reply",
  "clarify",
  "workflow_proposal",
  "execute",
] as const;

export type ChannelIntentDecisionV2Action = (typeof channelIntentDecisionV2Actions)[number];

export const channelIntentDecisionV2Statuses = ["accepted", "suppressed", "failed"] as const;
export type ChannelIntentDecisionV2Status = (typeof channelIntentDecisionV2Statuses)[number];

export const channelIntentDecisionV2CreatedByValues = ["deterministic", "model_policy"] as const;
export type ChannelIntentDecisionV2CreatedBy = (typeof channelIntentDecisionV2CreatedByValues)[number];

export interface ChannelIntentClarificationV2 {
  readonly missingFields: readonly string[];
  readonly question: string;
  /** Host-bound draft only. Its existence grants no scheduling or tool authority. */
  readonly pendingOperation?: ChannelIntentPendingOperationV1;
}

export interface ChannelIntentPendingOperationV1 {
  readonly schemaVersion: 1;
  readonly sourceRevision: number;
  readonly sourceAssignmentId: string;
  readonly sourceAssignmentRevision: number;
  readonly authorityFingerprint: string;
  readonly execution: ChannelIntentExecutionPlanV1;
  readonly participantManifest: RequiredParticipantManifestV1;
  /** Only these typed fields may change when this question is answered. */
  readonly slots: readonly { readonly operationId: string; readonly field: "project_input_root" }[];
  readonly fingerprint: string;
}

export const commandMatchExecutableValuesV1 = [
  "bun",
  "cargo",
  "go",
  "make",
  "node",
  "npm",
  "npx",
  "pnpm",
  "pytest",
  "python",
  "python3",
  "swift",
  "xcodebuild",
  "yarn",
] as const;

export type CommandMatchExecutableV1 = (typeof commandMatchExecutableValuesV1)[number];

export type CommandMatchPolicyV1 =
  | {
      readonly kind: "exact_command";
      readonly command: string;
    }
  | {
      readonly kind: "executable";
      readonly executable: CommandMatchExecutableV1;
    };

export interface ChannelIntentExecutionOperationV1 {
  readonly id: string;
  readonly kind: "file_read" | "file_create" | "file_edit" | "open_local_target" | "run_command";
  readonly targetKind: "file" | "directory" | "command" | "workspace";
  readonly targetRef: ConversationDomainRef;
  readonly commandMatchPolicy?: CommandMatchPolicyV1;
  readonly required: boolean;
  readonly dependsOn: readonly string[];
  /** Absent only on persisted legacy plans; new typed candidates require binding. */
  readonly binding?: ChannelOperationBindingV1;
}

export interface ChannelIntentExecutionPlanV1 {
  readonly operations: readonly ChannelIntentExecutionOperationV1[];
  readonly bindingVersion?: 1;
  readonly fingerprint?: string;
}

export const requiredParticipantRequirementsV1 = ["required", "optional"] as const;
export type RequiredParticipantRequirementV1 = (typeof requiredParticipantRequirementsV1)[number];

export const requiredParticipantExpectedOutcomesV1 = [
  "discussion_reply",
  "execution",
  "verification",
  "synthesis",
] as const;
export type RequiredParticipantExpectedOutcomeV1 = (typeof requiredParticipantExpectedOutcomesV1)[number];

export const requiredParticipantRequestedByValuesV1 = [
  "structured_mention",
  "explicit_role",
  "selector_policy",
] as const;
export type RequiredParticipantRequestedByV1 = (typeof requiredParticipantRequestedByValuesV1)[number];

export interface RequiredParticipantV1 {
  readonly participantId: string;
  readonly role: string;
  readonly requirement: RequiredParticipantRequirementV1;
  readonly expectedOutcome: RequiredParticipantExpectedOutcomeV1;
  readonly requiredOperationIds: readonly string[];
  readonly requestedBy: RequiredParticipantRequestedByV1;
}

export interface RequiredParticipantManifestV1 {
  readonly schemaVersion: 1;
  readonly participants: readonly RequiredParticipantV1[];
  readonly fingerprint: string;
}

export function createRequiredParticipantManifestV1(
  participants: readonly RequiredParticipantV1[],
): RequiredParticipantManifestV1 {
  const copied = participants.map((participant) => ({
    ...participant,
    requiredOperationIds: [...participant.requiredOperationIds],
  }));
  return {
    schemaVersion: 1,
    participants: copied,
    fingerprint: requiredParticipantManifestFingerprintV1(copied),
  };
}

export function requiredParticipantManifestFingerprintV1(
  participants: readonly RequiredParticipantV1[],
): string {
  const canonical = [...participants]
    .map((participant) => ({
      participantId: participant.participantId,
      role: participant.role,
      requirement: participant.requirement,
      expectedOutcome: participant.expectedOutcome,
      requiredOperationIds: [...participant.requiredOperationIds].sort(),
      requestedBy: participant.requestedBy,
    }))
    .sort((left, right) => left.participantId.localeCompare(right.participantId));
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(canonical))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `rpmv1_${hash.toString(16).padStart(16, "0")}`;
}

export interface ChannelIntentDecisionV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceTurnId: string;
  readonly sourceItemId: string;
  readonly contextSegmentId: string;
  readonly contextProjectionVersion: string;
  readonly action: ChannelIntentDecisionV2Action;
  readonly selectedTeammateIds: readonly string[];
  readonly participantManifest: RequiredParticipantManifestV1;
  readonly proposalId?: string;
  readonly resultItemIds: readonly string[];
  readonly workflowId?: string;
  readonly reason: string;
  readonly clarification?: ChannelIntentClarificationV2;
  readonly execution?: ChannelIntentExecutionPlanV1;
  readonly status: ChannelIntentDecisionV2Status;
  readonly createdBy: ChannelIntentDecisionV2CreatedBy;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const goldenContextSegmentActionsV1 = [
  "continue",
  "switch_existing",
  "propose_new",
  "structural_inherit",
  "new_thread",
] as const;

export type GoldenContextSegmentActionV1 = (typeof goldenContextSegmentActionsV1)[number];

export type GoldenTargetResolverDispositionV1 = "skip" | "run";
export type GoldenStaleResultDispositionV1 = "accept" | "rebase" | "reject";

export interface ConversationContinuityGoldenInitialSegmentV1 {
  readonly id: string;
  readonly label: string;
  readonly state: "active" | "provisional";
}

export interface ConversationContinuityGoldenTurnRelationV1 {
  readonly kind: "reply" | "quote" | "approval" | "followup" | "fork";
  readonly targetTurnId: string;
}

export interface ConversationContinuityGoldenExpectedV1 {
  readonly segmentAction: GoldenContextSegmentActionV1;
  readonly segmentId?: string;
  readonly intentAction?: ChannelIntentDecisionV2Action;
  readonly targetResolver: GoldenTargetResolverDispositionV1;
  readonly missingFields?: readonly string[];
  readonly threadSurface?: LingThreadSurfaceKindV2;
  readonly forkCopiesParentItems?: boolean;
  readonly forbiddenSourceRefTypes?: readonly ConversationDomainRefType[];
  readonly staleResultDisposition?: GoldenStaleResultDispositionV1;
}

export interface ConversationContinuityGoldenTurnV1 {
  readonly id: string;
  readonly actor: "local_user" | "teammate" | "system";
  readonly body: string;
  readonly relation?: ConversationContinuityGoldenTurnRelationV1;
  readonly expected: ConversationContinuityGoldenExpectedV1;
}

export interface ConversationContinuityGoldenScenarioV1 {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly initialSegments?: readonly ConversationContinuityGoldenInitialSegmentV1[];
  readonly turns: readonly ConversationContinuityGoldenTurnV1[];
}

export interface ConversationContinuityGoldenFixtureV1 {
  readonly schemaVersion: 1;
  readonly contractSchemaVersion: 2;
  readonly scenarios: readonly ConversationContinuityGoldenScenarioV1[];
}

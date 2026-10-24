import { channelOperationPlanFingerprintV1, isChannelOperationBindingV1 } from "./channel-operation-bindings.js";
import { isUserInputRunEventPositionV1 } from "./user-input-event-position.js";
import { hasConsistentCommittedRunNarration, isCommittedRunNarrationV1 } from "./committed-run-narration.js";
import {
  channelIntentDecisionV2Actions,
  channelIntentDecisionV2CreatedByValues,
  channelIntentDecisionV2Statuses,
  commandMatchExecutableValuesV1,
  requiredParticipantExpectedOutcomesV1,
  requiredParticipantRequestedByValuesV1,
  requiredParticipantRequirementsV1,
  requiredParticipantManifestFingerprintV1,
  conversationAssistantDeliveryStatusesV1,
  conversationAssistantPresentationRolesV1,
  contextSegmentStates,
  conversationContextSummaryScopes,
  conversationContextSummaryStatuses,
  conversationDomainRefTypes,
  conversationItemActorTypesV1,
  conversationItemKindsV1,
  conversationItemStatusesV1,
  conversationItemVisibilitiesV1,
  conversationMessageMentionKindsV1,
  conversationWorkspaceFileRefSourcesV1,
  goldenContextSegmentActionsV1,
  lingThreadRelationKindsV2,
  lingThreadSurfaceKindsV2,
  turnContextAssignmentStatuses,
  turnContextDecisionSources,
  type ChannelIntentDecisionV2,
  type ChannelIntentDecisionV2Action,
  type ChannelIntentExecutionPlanV1,
  type ChannelIntentExecutionOperationV1,
  type CommandMatchPolicyV1,
  type RequiredParticipantManifestV1,
  type ContextSegment,
  type ContextSegmentProposal,
  type ConversationContextProjectionMetadata,
  type ConversationContextSnapshot,
  type ConversationContextSummary,
  type ConversationContinuityGoldenExpectedV1,
  type ConversationContinuityGoldenFixtureV1,
  type ConversationDomainRef,
  type ConversationItemKindV1,
  type ConversationItemV1,
  type LingThreadContinuityV2,
  type TurnContextAssignment,
} from "./conversation-continuity.js";

const ITEM_KEYS = new Set([
  "schemaVersion",
  "id",
  "workspaceId",
  "channelId",
  "threadId",
  "turnId",
  "sequence",
  "kind",
  "status",
  "actorType",
  "actorId",
  "visibility",
  "visibilityOwnerId",
  "payload",
  "domainRefs",
  "idempotencyKey",
  "revision",
  "supersedesItemId",
  "createdAt",
  "updatedAt",
  "committedAt",
]);

const PAYLOAD_KEYS: Readonly<Record<ConversationItemKindV1, ReadonlySet<string>>> = {
  user_message: new Set([
    "body",
    "format",
    "mentions",
    "attachmentIds",
    "linkPreviewIds",
    "fileRefs",
    "replyToItemId",
    "quotedItemIds",
  ]),
  assistant_message: new Set(["body", "format", "streaming", "deliveryStatus", "presentationRole", "errorMessage", "runNarration"]),
  tool_call: new Set(["toolCallId", "toolName", "title", "inputSummary"]),
  tool_result: new Set(["toolCallId", "status", "outputSummary", "errorCode"]),
  approval_request: new Set(["approvalRequestId", "title", "summary"]),
  approval_decision: new Set(["approvalRequestId", "decision", "reason"]),
  user_input_request: new Set(["requestId", "requestVersion", "runEventPosition"]),
  user_input_answer: new Set(["requestId", "requestVersion", "answerId", "runEventPosition"]),
  handoff: new Set(["handoffId", "targetTeammateId", "summary"]),
  operation_state: new Set(["operationId", "state", "title", "summary"]),
  artifact_ref: new Set(["artifactId", "title", "artifactKind"]),
  terminal_report: new Set(["reportId", "generation", "sourceKind", "sourceId", "evidenceFingerprint", "outcomeStatus"]),
  system_event: new Set(["eventType", "summary"]),
};

const THREAD_CONTINUITY_KEYS = new Set([
  "surfaceKind",
  "relationKind",
  "parentThreadId",
  "parentTurnId",
  "anchorItemId",
  "forkContextSnapshotId",
]);

const SEGMENT_KEYS = new Set([
  "id",
  "threadId",
  "state",
  "label",
  "createdFromTurnId",
  "lastActiveTurnId",
  "mergedIntoSegmentId",
  "revision",
  "createdAt",
  "updatedAt",
]);

const ASSIGNMENT_KEYS = new Set([
  "id",
  "turnId",
  "segmentId",
  "status",
  "revision",
  "decisionSource",
  "confidence",
  "antecedentTurnId",
  "evidenceRefs",
  "policyVersion",
  "supersedesAssignmentId",
  "createdAt",
]);

const SEGMENT_PROPOSAL_KEYS = {
  continue: new Set(["action", "segmentId", "antecedentTurnId", "confidence", "evidenceItemIds"]),
  switch_existing: new Set(["action", "segmentId", "antecedentTurnId", "confidence", "evidenceItemIds"]),
  propose_new: new Set(["action", "confidence", "relatedSegmentIds", "reason"]),
  uncertain: new Set(["action", "candidateSegmentIds"]),
} as const;

const SUMMARY_KEYS = new Set([
  "id",
  "threadId",
  "segmentId",
  "scope",
  "status",
  "version",
  "coveredFromSequence",
  "coveredThroughSequence",
  "objective",
  "decisions",
  "constraints",
  "openQuestions",
  "activeWorkRefs",
  "sourceRefs",
  "supersedesSummaryId",
  "policyVersion",
  "createdAt",
]);

const SNAPSHOT_KEYS = new Set([
  "id",
  "threadId",
  "segmentId",
  "projectionVersion",
  "throughItemSequence",
  "summaryIds",
  "sourceRefs",
  "policyVersion",
  "createdAt",
]);

const PROJECTION_KEYS = new Set([
  "projectionVersion",
  "sourceStateFingerprint",
  "threadId",
  "turnId",
  "segmentId",
  "throughItemSequence",
  "summaryIds",
  "sourceRefs",
  "policyVersion",
  "visibilityFingerprint",
  "contextViewId",
  "contextViewCreatedAt",
]);

const INTENT_KEYS = new Set([
  "schemaVersion",
  "id",
  "workspaceId",
  "channelId",
  "sourceTurnId",
  "sourceItemId",
  "contextSegmentId",
  "contextProjectionVersion",
  "action",
  "selectedTeammateIds",
  "participantManifest",
  "proposalId",
  "resultItemIds",
  "workflowId",
  "reason",
  "clarification",
  "execution",
  "status",
  "createdBy",
  "errorCode",
  "createdAt",
  "updatedAt",
]);

const GOLDEN_FIXTURE_KEYS = new Set(["schemaVersion", "contractSchemaVersion", "scenarios"]);
const GOLDEN_SCENARIO_KEYS = new Set(["id", "title", "description", "initialSegments", "turns"]);
const GOLDEN_SEGMENT_KEYS = new Set(["id", "label", "state"]);
const GOLDEN_TURN_KEYS = new Set(["id", "actor", "body", "relation", "expected"]);
const GOLDEN_RELATION_KEYS = new Set(["kind", "targetTurnId"]);
const GOLDEN_EXPECTED_KEYS = new Set([
  "segmentAction",
  "segmentId",
  "intentAction",
  "targetResolver",
  "missingFields",
  "threadSurface",
  "forkCopiesParentItems",
  "forbiddenSourceRefTypes",
  "staleResultDisposition",
]);

export function isConversationDomainRef(value: unknown): value is ConversationDomainRef {
  return isRecordWithOnlyKeys(value, new Set(["type", "id", "label"]))
    && includes(conversationDomainRefTypes, value.type)
    && isText(value.id)
    && isOptionalText(value.label);
}

export function isLingThreadContinuityV2(value: unknown): value is LingThreadContinuityV2 {
  if (!isRecordWithOnlyKeys(value, THREAD_CONTINUITY_KEYS)
    || !includes(lingThreadSurfaceKindsV2, value.surfaceKind)
    || !includes(lingThreadRelationKindsV2, value.relationKind)
    || !isOptionalText(value.parentThreadId)
    || !isOptionalText(value.parentTurnId)
    || !isOptionalText(value.anchorItemId)
    || !isOptionalText(value.forkContextSnapshotId)) {
    return false;
  }
  if (value.relationKind === "topic") {
    return value.surfaceKind === "topic"
      && isText(value.parentThreadId)
      && isText(value.parentTurnId)
      && isText(value.anchorItemId)
      && value.forkContextSnapshotId === undefined;
  }
  if (value.relationKind === "branch") {
    return value.surfaceKind === "branch"
      && isText(value.parentThreadId)
      && isText(value.parentTurnId)
      && value.anchorItemId === undefined
      && isText(value.forkContextSnapshotId);
  }
  return value.surfaceKind !== "topic"
    && value.surfaceKind !== "branch"
    && value.parentThreadId === undefined
    && value.parentTurnId === undefined
    && value.anchorItemId === undefined
    && value.forkContextSnapshotId === undefined;
}

export function isConversationItemV1(value: unknown): value is ConversationItemV1 {
  if (!isRecordWithOnlyKeys(value, ITEM_KEYS)
    || value.schemaVersion !== 1
    || !isText(value.id)
    || !isText(value.workspaceId)
    || !isOptionalText(value.channelId)
    || !isText(value.threadId)
    || !isOptionalText(value.turnId)
    || !isPositiveInteger(value.sequence)
    || !includes(conversationItemKindsV1, value.kind)
    || !includes(conversationItemStatusesV1, value.status)
    || !includes(conversationItemActorTypesV1, value.actorType)
    || !isOptionalText(value.actorId)
    || !includes(conversationItemVisibilitiesV1, value.visibility)
    || !isOptionalText(value.visibilityOwnerId)
    || !isConversationItemPayloadV1(value.kind, value.payload)
    || !isArrayOf(value.domainRefs, isConversationDomainRef)
    || !isOptionalText(value.idempotencyKey)
    || !isNonNegativeInteger(value.revision)
    || !isOptionalText(value.supersedesItemId)
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || !isOptionalCanonicalTimestamp(value.committedAt)) {
    return false;
  }
  if (value.visibility === "agent_private") {
    if (!isText(value.visibilityOwnerId)) return false;
  } else if (value.visibilityOwnerId !== undefined) {
    return false;
  }
  if (value.actorType === "teammate" && !isText(value.actorId)) return false;
  if (value.status === "committed") {
    if (!isCanonicalTimestamp(value.committedAt)) return false;
  } else if (value.committedAt !== undefined) {
    return false;
  }
  if (value.kind === "assistant_message" && (!isAssistantItemStateConsistent(value) || !hasConsistentCommittedRunNarration(value))) {
    return false;
  }
  return value.supersedesItemId !== value.id
    && Date.parse(value.updatedAt) >= Date.parse(value.createdAt);
}

export function isContextSegment(value: unknown): value is ContextSegment {
  if (!isRecordWithOnlyKeys(value, SEGMENT_KEYS)
    || !isText(value.id)
    || !isText(value.threadId)
    || !includes(contextSegmentStates, value.state)
    || !isOptionalText(value.label)
    || !isText(value.createdFromTurnId)
    || !isText(value.lastActiveTurnId)
    || !isOptionalText(value.mergedIntoSegmentId)
    || !isPositiveInteger(value.revision)
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)) {
    return false;
  }
  return value.state === "merged"
    ? isText(value.mergedIntoSegmentId) && value.mergedIntoSegmentId !== value.id
    : value.mergedIntoSegmentId === undefined;
}

export function isTurnContextAssignment(value: unknown): value is TurnContextAssignment {
  return isRecordWithOnlyKeys(value, ASSIGNMENT_KEYS)
    && isText(value.id)
    && isText(value.turnId)
    && isText(value.segmentId)
    && includes(turnContextAssignmentStatuses, value.status)
    && isPositiveInteger(value.revision)
    && includes(turnContextDecisionSources, value.decisionSource)
    && isOptionalConfidence(value.confidence)
    && isOptionalText(value.antecedentTurnId)
    && isArrayOf(value.evidenceRefs, isConversationDomainRef)
    && isText(value.policyVersion)
    && isOptionalText(value.supersedesAssignmentId)
    && value.supersedesAssignmentId !== value.id
    && isCanonicalTimestamp(value.createdAt);
}

export function isContextSegmentProposal(value: unknown): value is ContextSegmentProposal {
  if (!isRecord(value)) return false;
  if (value.action === "continue" || value.action === "switch_existing") {
    return isRecordWithOnlyKeys(value, SEGMENT_PROPOSAL_KEYS[value.action])
      && isText(value.segmentId)
      && isOptionalText(value.antecedentTurnId)
      && value.confidence !== undefined
      && isOptionalConfidence(value.confidence)
      && isUniqueTextArray(value.evidenceItemIds);
  }
  if (value.action === "propose_new") {
    return isRecordWithOnlyKeys(value, SEGMENT_PROPOSAL_KEYS.propose_new)
      && value.confidence !== undefined
      && isOptionalConfidence(value.confidence)
      && isUniqueTextArray(value.relatedSegmentIds)
      && isText(value.reason, 8_192);
  }
  return value.action === "uncertain"
    && isRecordWithOnlyKeys(value, SEGMENT_PROPOSAL_KEYS.uncertain)
    && isUniqueTextArray(value.candidateSegmentIds);
}

export function isConversationContextSummary(value: unknown): value is ConversationContextSummary {
  if (!isRecordWithOnlyKeys(value, SUMMARY_KEYS)
    || !isText(value.id)
    || !isText(value.threadId)
    || !isOptionalText(value.segmentId)
    || !includes(conversationContextSummaryScopes, value.scope)
    || !includes(conversationContextSummaryStatuses, value.status)
    || !isPositiveInteger(value.version)
    || !isPositiveInteger(value.coveredFromSequence)
    || !isPositiveInteger(value.coveredThroughSequence)
    || value.coveredThroughSequence < value.coveredFromSequence
    || !isOptionalText(value.objective, 8_192)
    || !isTextArray(value.decisions, 8_192)
    || !isTextArray(value.constraints, 8_192)
    || !isTextArray(value.openQuestions, 8_192)
    || !isArrayOf(value.activeWorkRefs, isConversationDomainRef)
    || !isArrayOf(value.sourceRefs, isConversationDomainRef)
    || !isOptionalText(value.supersedesSummaryId)
    || value.supersedesSummaryId === value.id
    || !isText(value.policyVersion)
    || !isCanonicalTimestamp(value.createdAt)) {
    return false;
  }
  return value.scope === "segment" ? isText(value.segmentId) : true;
}

export function isConversationContextSnapshot(value: unknown): value is ConversationContextSnapshot {
  return isRecordWithOnlyKeys(value, SNAPSHOT_KEYS)
    && isText(value.id)
    && isText(value.threadId)
    && isText(value.segmentId)
    && isText(value.projectionVersion)
    && isNonNegativeInteger(value.throughItemSequence)
    && isTextArray(value.summaryIds)
    && isArrayOf(value.sourceRefs, isConversationDomainRef)
    && isText(value.policyVersion)
    && isCanonicalTimestamp(value.createdAt);
}

export function isConversationContextProjectionMetadata(
  value: unknown,
): value is ConversationContextProjectionMetadata {
  return isRecordWithOnlyKeys(value, PROJECTION_KEYS)
    && isText(value.projectionVersion)
    && isText(value.sourceStateFingerprint)
    && isText(value.threadId)
    && isText(value.turnId)
    && isText(value.segmentId)
    && isNonNegativeInteger(value.throughItemSequence)
    && isTextArray(value.summaryIds)
    && isArrayOf(value.sourceRefs, isConversationDomainRef)
    && isText(value.policyVersion)
    && isText(value.visibilityFingerprint)
    && isOptionalText(value.contextViewId)
    && isOptionalCanonicalTimestamp(value.contextViewCreatedAt);
}

export function isChannelIntentDecisionV2(value: unknown): value is ChannelIntentDecisionV2 {
  if (!isRecordWithOnlyKeys(value, INTENT_KEYS)
    || value.schemaVersion !== 2
    || !isText(value.id)
    || !isText(value.workspaceId)
    || !isText(value.channelId)
    || !isText(value.sourceTurnId)
    || !isText(value.sourceItemId)
    || !isText(value.contextSegmentId)
    || !isText(value.contextProjectionVersion)
    || !includes(channelIntentDecisionV2Actions, value.action)
    || !isUniqueTextArray(value.selectedTeammateIds)
    || !isRequiredParticipantManifestV1(value.participantManifest)
    || !isOptionalText(value.proposalId)
    || !isUniqueTextArray(value.resultItemIds)
    || !isOptionalText(value.workflowId)
    || !isText(value.reason, 8_192)
    || !includes(channelIntentDecisionV2Statuses, value.status)
    || !includes(channelIntentDecisionV2CreatedByValues, value.createdBy)
    || !isOptionalText(value.errorCode)
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    return false;
  }
  const selectedParticipantIds = [...value.selectedTeammateIds].sort();
  const manifestParticipantIds = value.participantManifest.participants
    .map((participant) => participant.participantId)
    .sort();
  if (JSON.stringify(selectedParticipantIds) !== JSON.stringify(manifestParticipantIds)
    || ((value.action === "execute" || value.action === "workflow_proposal")
      && manifestParticipantIds.length === 0)) {
    return false;
  }
  if (value.action === "clarify") {
    return isClarification(value.clarification) && value.execution === undefined;
  }
  if (value.action === "execute") {
    return value.clarification === undefined && isChannelIntentExecutionPlanV1(value.execution);
  }
  return value.clarification === undefined && value.execution === undefined;
}

export function isRequiredParticipantManifestV1(value: unknown): value is RequiredParticipantManifestV1 {
  if (!isRecordWithOnlyKeys(value, new Set(["schemaVersion", "participants", "fingerprint"]))
    || value.schemaVersion !== 1
    || !Array.isArray(value.participants)
    || !isText(value.fingerprint)) {
    return false;
  }
  const participantIds = new Set<string>();
  for (const participant of value.participants) {
    if (!isRecordWithOnlyKeys(participant, new Set([
      "participantId",
      "role",
      "requirement",
      "expectedOutcome",
      "requiredOperationIds",
      "requestedBy",
    ]))
      || !isText(participant.participantId)
      || participantIds.has(participant.participantId)
      || !isText(participant.role)
      || !includes(requiredParticipantRequirementsV1, participant.requirement)
      || !includes(requiredParticipantExpectedOutcomesV1, participant.expectedOutcome)
      || !isUniqueTextArray(participant.requiredOperationIds)
      || !includes(requiredParticipantRequestedByValuesV1, participant.requestedBy)) {
      return false;
    }
    participantIds.add(participant.participantId);
  }
  return value.fingerprint === requiredParticipantManifestFingerprintV1(
    value.participants as RequiredParticipantManifestV1["participants"],
  );
}

export function isConversationContinuityGoldenFixtureV1(
  value: unknown,
): value is ConversationContinuityGoldenFixtureV1 {
  if (!isRecordWithOnlyKeys(value, GOLDEN_FIXTURE_KEYS)
    || value.schemaVersion !== 1
    || value.contractSchemaVersion !== 2
    || !Array.isArray(value.scenarios)
    || value.scenarios.length === 0) {
    return false;
  }
  const scenarioIds = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!isRecordWithOnlyKeys(scenario, GOLDEN_SCENARIO_KEYS)
      || !isText(scenario.id)
      || scenarioIds.has(scenario.id)
      || !isText(scenario.title)
      || !isText(scenario.description, 8_192)
      || !isGoldenInitialSegments(scenario.initialSegments)
      || !Array.isArray(scenario.turns)
      || scenario.turns.length === 0) {
      return false;
    }
    scenarioIds.add(scenario.id);
    const turnIds = new Set<string>();
    for (const turn of scenario.turns) {
      if (!isRecordWithOnlyKeys(turn, GOLDEN_TURN_KEYS)
        || !isText(turn.id)
        || turnIds.has(turn.id)
        || (turn.actor !== "local_user" && turn.actor !== "teammate" && turn.actor !== "system")
        || !isText(turn.body, 32_768)
        || !isGoldenRelation(turn.relation)
        || !isGoldenExpected(turn.expected)) {
        return false;
      }
      if (turn.relation !== undefined && !turnIds.has(turn.relation.targetTurnId)) {
        return false;
      }
      turnIds.add(turn.id);
    }
  }
  return true;
}

export function serializeConversationContinuityGoldenFixtureV1(
  value: ConversationContinuityGoldenFixtureV1,
): string {
  if (!isConversationContinuityGoldenFixtureV1(value)) {
    throw new TypeError("Invalid Channel Conversation Continuity v2 golden fixture.");
  }
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

function isConversationItemPayloadV1(kind: ConversationItemKindV1, value: unknown): boolean {
  if (!isRecordWithOnlyKeys(value, PAYLOAD_KEYS[kind])) return false;
  switch (kind) {
    case "user_input_request":
      return isText(value.requestId) && isPositiveInteger(value.requestVersion)
        && (value.runEventPosition === undefined || isUserInputRunEventPositionV1(value.runEventPosition));
    case "user_input_answer":
      return isText(value.requestId) && isPositiveInteger(value.requestVersion) && isText(value.answerId)
        && (value.runEventPosition === undefined || isUserInputRunEventPositionV1(value.runEventPosition));
    case "user_message":
      return typeof value.body === "string"
        && value.body.length <= 32_768
        && (value.format === "plain_text" || value.format === "markdown")
        && isUniqueArrayOf(value.mentions, isConversationMessageMention, (mention) => `${mention.kind}:${mention.id}`)
        && isUniqueTextArray(value.attachmentIds)
        && isUniqueTextArray(value.linkPreviewIds)
        && isUniqueArrayOf(value.fileRefs, isConversationWorkspaceFileRef, (fileRef) => `${fileRef.path}:${fileRef.line ?? ""}`)
        && (value.body.trim().length > 0
          || value.attachmentIds.length > 0
          || value.linkPreviewIds.length > 0
          || value.fileRefs.length > 0)
        && isOptionalText(value.replyToItemId)
        && (value.quotedItemIds === undefined || isUniqueTextArray(value.quotedItemIds));
    case "assistant_message":
      return typeof value.body === "string"
        && (value.runNarration === undefined || isCommittedRunNarrationV1(value.runNarration))
        && value.body.length <= 128_000
        && (value.format === "plain_text" || value.format === "markdown")
        && typeof value.streaming === "boolean"
        && includes(conversationAssistantDeliveryStatusesV1, value.deliveryStatus)
        && includes(conversationAssistantPresentationRolesV1, value.presentationRole)
        && isOptionalText(value.errorMessage, 8_192);
    case "tool_call":
      return isText(value.toolCallId)
        && isText(value.toolName)
        && isOptionalText(value.title)
        && isOptionalText(value.inputSummary, 8_192);
    case "tool_result":
      return isText(value.toolCallId)
        && (value.status === "succeeded" || value.status === "failed" || value.status === "cancelled")
        && isOptionalText(value.outputSummary, 32_768)
        && isOptionalText(value.errorCode);
    case "approval_request":
      return isText(value.approvalRequestId)
        && isText(value.title)
        && isOptionalText(value.summary, 8_192);
    case "approval_decision":
      return isText(value.approvalRequestId)
        && (value.decision === "approved" || value.decision === "denied" || value.decision === "cancelled")
        && isOptionalText(value.reason, 8_192);
    case "handoff":
      return isText(value.handoffId)
        && isText(value.targetTeammateId)
        && isText(value.summary, 8_192);
    case "operation_state":
      return isText(value.operationId)
        && (value.state === "pending" || value.state === "running" || value.state === "succeeded" || value.state === "failed" || value.state === "cancelled")
        && isText(value.title)
        && isOptionalText(value.summary, 8_192);
    case "artifact_ref":
      return isText(value.artifactId)
        && isOptionalText(value.title)
        && isOptionalText(value.artifactKind);
    case "terminal_report":
      return isText(value.reportId)
        && isPositiveInteger(value.generation)
        && (value.sourceKind === "workflow" || value.sourceKind === "run" || value.sourceKind === "turn")
        && isText(value.sourceId)
        && isText(value.evidenceFingerprint)
        && (value.outcomeStatus === "succeeded"
          || value.outcomeStatus === "partially_succeeded"
          || value.outcomeStatus === "blocked"
          || value.outcomeStatus === "failed"
          || value.outcomeStatus === "cancelled");
    case "system_event":
      return isText(value.eventType)
        && isText(value.summary, 8_192);
  }
}

function isAssistantItemStateConsistent(item: Record<string, unknown>): boolean {
  if (!isRecord(item.payload)) return false;
  const payload = item.payload;
  // A terminal Run may fail after producing text. Its immutable message was
  // still committed successfully; execution/delivery failure is a separate axis.
  if (payload.runNarration !== undefined && item.status === "committed" && payload.streaming === false
    && payload.deliveryStatus === "failed") return true;
  if (item.status === "pending") {
    return payload.streaming === true
      && payload.deliveryStatus === "pending"
      && payload.errorMessage === undefined;
  }
  if (item.status === "failed") {
    return payload.streaming === false && payload.deliveryStatus === "failed";
  }
  return payload.streaming === false
    && (payload.deliveryStatus === "ready" || payload.deliveryStatus === "blocked")
    && (payload.deliveryStatus === "blocked" || payload.errorMessage === undefined);
}

function isConversationMessageMention(value: unknown): value is {
  readonly id: string;
  readonly label: string;
  readonly kind: (typeof conversationMessageMentionKindsV1)[number];
} {
  return isRecordWithOnlyKeys(value, new Set(["id", "label", "kind"]))
    && isText(value.id)
    && isText(value.label)
    && includes(conversationMessageMentionKindsV1, value.kind);
}

function isConversationWorkspaceFileRef(value: unknown): value is {
  readonly path: string;
  readonly label?: string;
  readonly source?: (typeof conversationWorkspaceFileRefSourcesV1)[number];
  readonly line?: number;
} {
  return isRecordWithOnlyKeys(value, new Set(["path", "label", "source", "line"]))
    && isText(value.path, 4_096)
    && isOptionalText(value.label)
    && (value.source === undefined || includes(conversationWorkspaceFileRefSourcesV1, value.source))
    && (value.line === undefined || isPositiveInteger(value.line));
}

function isClarification(value: unknown): boolean {
  return isRecordWithOnlyKeys(value, new Set(["missingFields", "question"]))
    && isUniqueTextArray(value.missingFields)
    && value.missingFields.length > 0
    && isText(value.question, 8_192);
}

export function isChannelIntentExecutionPlanV1(value: unknown): value is ChannelIntentExecutionPlanV1 {
  if (!isRecordWithOnlyKeys(value, new Set(["operations", "bindingVersion", "fingerprint"]))
    || !Array.isArray(value.operations)
    || value.operations.length === 0
    || !value.operations.every(isExecutionOperation)) {
    return false;
  }
  if (value.bindingVersion === undefined
    ? value.fingerprint !== undefined || value.operations.some((operation) => operation.binding !== undefined || operation.kind === "file_read")
    : value.bindingVersion !== 1 || value.operations.some((operation) => !operation.binding)
      || value.fingerprint !== channelOperationPlanFingerprintV1(value.operations)) return false;
  const operationIds = new Set(value.operations.map((operation) => operation.id));
  if (operationIds.size !== value.operations.length
    || value.operations.some((operation) => operation.dependsOn.some((dependencyId) => !operationIds.has(dependencyId)))) {
    return false;
  }
  if (value.bindingVersion === 1) {
    const byId = new Map(value.operations.map((operation) => [operation.id, operation]));
    for (const operation of value.operations) {
      const binding = operation.binding!;
      const goal = binding.commandGoal;
      if (goal?.inputOperationId !== undefined) {
        const predecessor = byId.get(goal.inputOperationId);
        if (!predecessor || !operation.dependsOn.includes(predecessor.id)
          || !["file_read", "file_create", "file_edit"].includes(predecessor.kind)
          || !(predecessor.kind === "file_read" ? predecessor.binding?.inputRefs : predecessor.binding?.outputRefs)
            ?.some(ref => ref.path === goal.modulePath)) return false;
      }
      const content = binding.contentSource;
      if (content?.kind !== "generated_objective") continue;
      const inputPaths: string[] = operation.kind === "file_edit" ? [binding.outputRefs[0]!.path] : [];
      for (const inputId of content.inputOperationIds) {
        const predecessor = byId.get(inputId);
        if (!predecessor || predecessor.kind !== "file_read"
          || predecessor.binding?.ownerParticipantId !== binding.ownerParticipantId
          || !operation.dependsOn.includes(inputId)) return false;
        const path = predecessor.binding.inputRefs[0]!.path;
        if (!inputPaths.includes(path)) inputPaths.push(path);
      }
      if (JSON.stringify(binding.effectScope.readPaths) !== JSON.stringify(inputPaths)) return false;
    }
  }
  return !executionPlanHasCycle(value.operations);
}

function isExecutionOperation(value: unknown): value is ChannelIntentExecutionOperationV1 {
  if (!isRecordWithOnlyKeys(value, new Set([
    "id",
    "kind",
    "targetKind",
    "targetRef",
    "commandMatchPolicy",
    "required",
    "dependsOn",
    "binding",
  ]))) {
    return false;
  }
  if (!isText(value.id)
    || (value.kind !== "file_read" && value.kind !== "file_create" && value.kind !== "file_edit" && value.kind !== "open_local_target" && value.kind !== "run_command")
    || (value.targetKind !== "file" && value.targetKind !== "directory" && value.targetKind !== "command" && value.targetKind !== "workspace")
    || !isConversationDomainRef(value.targetRef)
    || typeof value.required !== "boolean"
    || !isUniqueTextArray(value.dependsOn)
    || value.dependsOn.includes(value.id)) {
    return false;
  }
  if (value.binding !== undefined) {
    if (!isChannelOperationBindingV1(value.binding)) return false;
    const binding = value.binding;
    if ((binding.commandGoal !== undefined || binding.commandInputScope !== undefined) && value.kind !== "run_command") return false;
    const writes = value.kind === "file_create" || value.kind === "file_edit";
    if (writes ? binding.outputRefs.length !== 1 || !binding.contentSource : binding.outputRefs.length > 0 || binding.contentSource !== undefined) return false;
    const targets = writes ? binding.outputRefs : binding.inputRefs;
    if (value.kind !== "run_command" && (targets.length !== 1 || value.targetRef.label !== targets[0]?.path)) return false;
    if (value.kind === "run_command"
      ? !isCommandMatchPolicyV1(value.commandMatchPolicy) || value.commandMatchPolicy.kind !== "exact_command"
        || binding.effectScope.exactCommands.length !== 1 || binding.effectScope.exactCommands[0] !== value.commandMatchPolicy.command
      : binding.effectScope.exactCommands.length !== 0) return false;
  }
  if (value.kind === "file_read" || value.kind === "file_create" || value.kind === "file_edit" || value.kind === "open_local_target") {
    return value.targetKind === "file" && value.commandMatchPolicy === undefined;
  }
  return value.targetKind === "command"
    ? isCommandMatchPolicyV1(value.commandMatchPolicy)
    : value.targetKind === "workspace" && value.commandMatchPolicy === undefined;
}

function isCommandMatchPolicyV1(value: unknown): value is CommandMatchPolicyV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "exact_command") {
    return isRecordWithOnlyKeys(value, new Set(["kind", "command"]))
      && isText(record.command)
      && record.command.length <= 512
      && !/[\r\n]/u.test(record.command);
  }
  return record.kind === "executable"
    && isRecordWithOnlyKeys(value, new Set(["kind", "executable"]))
    && typeof record.executable === "string"
    && commandMatchExecutableValuesV1.includes(record.executable as typeof commandMatchExecutableValuesV1[number]);
}

function executionPlanHasCycle(
  operations: readonly { readonly id: string; readonly dependsOn: readonly string[] }[],
): boolean {
  const dependencies = new Map(operations.map((operation) => [operation.id, operation.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operationId: string): boolean => {
    if (visiting.has(operationId)) return true;
    if (visited.has(operationId)) return false;
    visiting.add(operationId);
    for (const dependencyId of dependencies.get(operationId) ?? []) {
      if (visit(dependencyId)) return true;
    }
    visiting.delete(operationId);
    visited.add(operationId);
    return false;
  };
  return operations.some((operation) => visit(operation.id));
}

function isGoldenInitialSegments(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const segment of value) {
    if (!isRecordWithOnlyKeys(segment, GOLDEN_SEGMENT_KEYS)
      || !isText(segment.id)
      || ids.has(segment.id)
      || !isText(segment.label)
      || (segment.state !== "active" && segment.state !== "provisional")) {
      return false;
    }
    ids.add(segment.id);
  }
  return true;
}

function isGoldenRelation(value: unknown): value is { readonly kind: string; readonly targetTurnId: string } | undefined {
  return value === undefined
    || (isRecordWithOnlyKeys(value, GOLDEN_RELATION_KEYS)
      && (value.kind === "reply" || value.kind === "quote" || value.kind === "approval" || value.kind === "followup" || value.kind === "fork")
      && isText(value.targetTurnId));
}

function isGoldenExpected(value: unknown): value is ConversationContinuityGoldenExpectedV1 {
  if (!isRecordWithOnlyKeys(value, GOLDEN_EXPECTED_KEYS)
    || !includes(goldenContextSegmentActionsV1, value.segmentAction)
    || !isOptionalText(value.segmentId)
    || (value.intentAction !== undefined && !includes(channelIntentDecisionV2Actions, value.intentAction))
    || (value.targetResolver !== "skip" && value.targetResolver !== "run")
    || !isOptionalTextArray(value.missingFields)
    || (value.threadSurface !== undefined && !includes(lingThreadSurfaceKindsV2, value.threadSurface))
    || (value.forkCopiesParentItems !== undefined && typeof value.forkCopiesParentItems !== "boolean")
    || !isOptionalDomainRefTypeArray(value.forbiddenSourceRefTypes)
    || (value.staleResultDisposition !== undefined
      && value.staleResultDisposition !== "accept"
      && value.staleResultDisposition !== "rebase"
      && value.staleResultDisposition !== "reject")) {
    return false;
  }
  const action = value.intentAction as ChannelIntentDecisionV2Action | undefined;
  if (action === "clarify") {
    if (!Array.isArray(value.missingFields) || value.missingFields.length === 0) return false;
  } else if (value.missingFields !== undefined) {
    return false;
  }
  if (action === "execute") {
    if (value.targetResolver !== "run") return false;
  } else if (action !== "workflow_proposal" && value.targetResolver !== "skip") {
    return false;
  }
  if (value.segmentAction === "new_thread") {
    return value.threadSurface === "topic" || value.threadSurface === "branch";
  }
  return value.threadSurface !== "topic" && value.threadSurface !== "branch";
}

function isOptionalDomainRefTypeArray(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value)
      && new Set(value).size === value.length
      && value.every((item) => includes(conversationDomainRefTypes, item)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordWithOnlyKeys(value: unknown, allowedKeys: ReadonlySet<string>): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.has(key));
}

function includes<const T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value);
}

function isText(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isOptionalText(value: unknown, maxLength = 512): value is string | undefined {
  return value === undefined || isText(value, maxLength);
}

function isTextArray(value: unknown, maxItemLength = 512): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => isText(item, maxItemLength));
}

function isOptionalTextArray(value: unknown): value is readonly string[] | undefined {
  return value === undefined || isTextArray(value);
}

function isUniqueTextArray(value: unknown): value is readonly string[] {
  return isTextArray(value) && new Set(value).size === value.length;
}

function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is readonly T[] {
  return Array.isArray(value) && value.every(predicate);
}

function isUniqueArrayOf<T>(
  value: unknown,
  predicate: (item: unknown) => item is T,
  key: (item: T) => string,
): value is readonly T[] {
  if (!isArrayOf(value, predicate)) return false;
  return new Set(value.map(key)).size === value.length;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOptionalConfidence(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isOptionalCanonicalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isCanonicalTimestamp(value);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

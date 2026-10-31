import type {
  ChannelConversationSurface,
  ChannelReplyDisposition,
  ConversationDomainRef,
  ConversationItemV1,
  ConversationUserMessagePayloadV1,
} from "@ling-stack/contracts";
import type { LingTurnKind } from "./run-types.js";
import type { WorkflowStepStartOwnerV1 } from "./workflow-step-start-owner.js";

export interface AppendConversationUserTurnInput {
  readonly itemId?: string;
  readonly turnId?: string;
  /** Optional scope assertion. Channel turns still require their real channel id. */
  readonly channelId?: string;
  readonly threadId: string;
  /** Optional owner assertion; the persisted Turn always inherits its Thread owner. */
  readonly teammateId?: string;
  readonly turnKind?: LingTurnKind;
  readonly title: string;
  readonly userInstruction: string;
  readonly actorId?: string;
  /** System-dispatched input must not be relabelled as a local user action. */
  readonly actorType?: "local_user" | "system";
  /** Host-only generation assertion; verified under the canonical input transaction. */
  readonly workflowStepStart?: {
    readonly workflowId: string;
    readonly workflowStepId: string;
    readonly taskId: string;
    readonly owner: WorkflowStepStartOwnerV1;
    readonly parentRunId?: string;
  };
  readonly payload: ConversationUserMessagePayloadV1;
  readonly domainRefs?: readonly ConversationDomainRef[];
  readonly sourceTurnId?: string;
  /** Existing intervention lineage, preserved by atomic input creation and replay. */
  readonly interventionId?: string;
  readonly supersedesItemId?: string;
  readonly idempotencyKey: string;
  readonly dispatch?: {
    readonly schemaVersion: 1;
    readonly requestAiReply: boolean;
    readonly requestedProviderPresetId?: string;
    readonly requestedTeammateId?: string;
    readonly unavailableRequestedParticipantIds?: readonly string[];
    readonly explicitContextSegmentId?: string;
    readonly surface?: ChannelConversationSurface;
    readonly replyDisposition?: ChannelReplyDisposition;
  };
}

export interface ChannelTurnDispatchRequestV1 {
  readonly schemaVersion: 1;
  readonly sourceTurnId: string;
  readonly sourceItemId: string;
  readonly channelId: string;
  readonly threadId: string;
  readonly requestAiReply: boolean;
  readonly requestedProviderPresetId?: string;
  readonly requestedTeammateId?: string;
  readonly unavailableRequestedParticipantIds?: readonly string[];
  readonly explicitContextSegmentId?: string;
  readonly surface?: ChannelConversationSurface;
  readonly replyDisposition?: ChannelReplyDisposition;
}

export function isChannelTurnDispatchRequestV1(value: unknown): value is ChannelTurnDispatchRequestV1 {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "schemaVersion",
    "sourceTurnId",
    "sourceItemId",
    "channelId",
    "threadId",
    "requestAiReply",
    "requestedProviderPresetId",
    "requestedTeammateId",
    "unavailableRequestedParticipantIds",
    "explicitContextSegmentId",
    "surface",
    "replyDisposition",
  ]);
  return Object.keys(value).every((key) => allowedKeys.has(key))
    && value.schemaVersion === 1
    && isNonEmptyString(value.sourceTurnId)
    && isNonEmptyString(value.sourceItemId)
    && isNonEmptyString(value.channelId)
    && isNonEmptyString(value.threadId)
    && typeof value.requestAiReply === "boolean"
    && isOptionalNonEmptyString(value.requestedProviderPresetId)
    && isOptionalNonEmptyString(value.requestedTeammateId)
    && isOptionalUniqueNonEmptyStringArray(value.unavailableRequestedParticipantIds)
    && isOptionalNonEmptyString(value.explicitContextSegmentId)
    && (value.surface === undefined || isChannelConversationSurface(value.surface))
    && (value.replyDisposition === undefined || isChannelReplyDisposition(value.replyDisposition));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalUniqueNonEmptyStringArray(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length
  );
}

function isChannelConversationSurface(value: unknown): value is ChannelConversationSurface {
  if (!isRecord(value)) return false;
  if (value.kind === "channel_root") return Object.keys(value).length === 1;
  if (value.kind === "thread") return Object.keys(value).every((key) => key === "kind" || key === "threadId")
    && isNonEmptyString(value.threadId);
  if (value.kind === "topic") return Object.keys(value).every((key) => key === "kind" || key === "anchorItemId")
    && isNonEmptyString(value.anchorItemId);
  return false;
}

function isChannelReplyDisposition(value: unknown): value is ChannelReplyDisposition {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "mode" || key === "activeRunId")
    && value.mode === "queue_followup"
    && isOptionalNonEmptyString(value.activeRunId);
}

export interface AppendConversationUserTurnResult {
  readonly turnId: string;
  readonly item: ConversationItemV1;
  readonly contextSegmentId: string;
  readonly dispatchWorkUnitId?: string;
  readonly idempotentReplay: boolean;
}

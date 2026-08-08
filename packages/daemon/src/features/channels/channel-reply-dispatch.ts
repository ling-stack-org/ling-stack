import type { ChannelReplyDispatch } from "@ling-stack/contracts";
import type {
  ChannelMessage,
  RunInterventionMessagePayload,
  RunSession,
  RunStore,
} from "@ling-stack/core";
import { resolveAiTeammateReference } from "../teammates/identity.js";
import { isLingAgentExecutorId, LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import type { LingAgentTurnEnvelope } from "./ling-agent-turn-envelope.js";
import { resolveChannelConversationLineKey } from "./conversation-surface.js";

export function resolveChannelReplyTargetTeammateId(input: {
  readonly store: RunStore;
  readonly sourceMessage: ChannelMessage;
  readonly requestedTeammateId?: string;
}): string {
  const aiMentions = input.sourceMessage.mentions.filter((mention) => mention.kind === "ai-teammate");
  if (aiMentions.length > 1) {
    return LING_AGENT_EXECUTOR_ID;
  }
  const requestedId = aiMentions[0]?.id ?? input.requestedTeammateId ?? LING_AGENT_EXECUTOR_ID;
  if (isLingAgentExecutorId(requestedId)) {
    return LING_AGENT_EXECUTOR_ID;
  }
  return resolveAiTeammateReference(input.store, requestedId)?.id ?? requestedId;
}

export function findActiveChannelReplyRun(input: {
  readonly store: RunStore;
  readonly channelId: string;
  readonly sourceMessage: ChannelMessage;
  readonly activeRunId?: string;
}): RunSession | undefined {
  const requestedLineKey = resolveChannelConversationLineKey(
    input.store,
    input.channelId,
    input.sourceMessage,
  );
  const runs = input.activeRunId
    ? [input.store.getRun(input.activeRunId)].filter((run): run is RunSession => Boolean(run))
    : input.store.listRuns({ limit: 500 });
  return runs.find((run) => {
    if (run.channelId !== input.channelId || !isActiveReplyStatus(run.status)) {
      return false;
    }
    if (!run.workUnitId) return false;
    const workUnit = input.store.getWorkUnit(run.workUnitId);
    if (workUnit?.kind !== "channel_ai_reply" || workUnit.linkedRunId !== run.id) {
      return false;
    }
    const sourceMessageId = readRequestSnapshotString(run.requestSnapshot, "sourceMessageId");
    const sourceMessage = sourceMessageId ? input.store.getChannelMessage(sourceMessageId) : undefined;
    if (!sourceMessage || sourceMessage.channelId !== input.channelId) {
      return false;
    }
    return resolveChannelConversationLineKey(input.store, input.channelId, sourceMessage) === requestedLineKey;
  });
}

export function queueChannelReplyFollowup(input: {
  readonly store: RunStore;
  readonly activeRun: RunSession;
  readonly sourceMessage: ChannelMessage;
  readonly targetTeammateId: string;
  readonly turnEnvelope: LingAgentTurnEnvelope;
}): ChannelReplyDispatch {
  const sourceRunId = input.activeRun.parentRunId ?? input.activeRun.id;
  const instruction = input.sourceMessage.body.trim() || "User added attachments, link previews, or workspace file refs for the active reply.";
  const now = input.sourceMessage.createdAt;
  const sourceWorkUnit = input.activeRun.workUnitId
    ? input.store.getWorkUnit(input.activeRun.workUnitId)
    : undefined;
  const intervention = input.store.createRunIntervention({
    sourceRunId,
    sourceWorkUnitId: input.activeRun.workUnitId,
    sourceAttemptId: sourceWorkUnit?.activeAttemptId ?? (input.activeRun.workUnitId
      ? input.store.listWorkUnitAttempts(input.activeRun.workUnitId).at(-1)?.id
      : undefined),
    mode: "queue_followup",
    instruction,
    messagePayload: buildChannelReplyFollowupPayload(
      input.sourceMessage.body.trim(),
      input.sourceMessage,
      input.targetTeammateId,
      input.turnEnvelope,
    ),
    requestedBy: "local-user",
    idempotencyKey: `channel_message:${input.sourceMessage.id}:queue_followup`,
  }, now);
  appendInterventionEvent(input.store, sourceRunId, "run_intervention_created", {
    interventionId: intervention.id,
    mode: intervention.mode,
    status: intervention.status,
  });
  appendInterventionEvent(input.store, sourceRunId, "run_followup_queued", {
    interventionId: intervention.id,
    instruction: intervention.instruction,
  });
  return {
    targetTeammateId: input.targetTeammateId,
    disposition: "followup_queued",
    sourceRunId,
    intervention,
  };
}

function isActiveReplyStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting_for_approval";
}

function readRequestSnapshotString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function appendInterventionEvent(
  store: RunStore,
  runId: string,
  type: "run_intervention_created" | "run_followup_queued",
  data: unknown,
): void {
  try {
    store.appendEvent(runId, type, data);
  } catch {
    // The intervention row is authoritative; run events are audit hints.
  }
}

function buildChannelReplyFollowupPayload(
  body: string,
  sourceMessage: ChannelMessage,
  targetTeammateId: string,
  turnEnvelope: LingAgentTurnEnvelope,
): RunInterventionMessagePayload {
  return {
    sourceMessageId: sourceMessage.id,
    targetTeammateId,
    body,
    attachmentIds: sourceMessage.attachmentIds,
    linkPreviewIds: sourceMessage.linkPreviewIds,
    ...(turnEnvelope.attachments.length
      ? {
          attachments: turnEnvelope.attachments.map((attachment) => ({
            id: attachment.id,
            fileName: attachment.fileName,
            kind: attachment.kind,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
            materializationStatus: attachment.materializationStatus,
            previewStatus: attachment.previewStatus,
            ...(attachment.previewText ? { previewText: attachment.previewText } : {}),
            ...(attachment.reason ? { reason: attachment.reason } : {}),
          })),
        }
      : {}),
    ...(turnEnvelope.linkPreviews.length
      ? {
          linkPreviews: turnEnvelope.linkPreviews.map((preview) => ({
            id: preview.id,
            url: preview.url,
            normalizedUrl: preview.normalizedUrl,
            ...(preview.title ? { title: preview.title } : {}),
            ...(preview.description ? { description: preview.description } : {}),
            ...(preview.siteName ? { siteName: preview.siteName } : {}),
            status: preview.status,
            materializationStatus: preview.materializationStatus,
            ...(preview.previewText ? { previewText: preview.previewText } : {}),
            ...(preview.reason ? { reason: preview.reason } : {}),
          })),
        }
      : {}),
    ...(turnEnvelope.fileRefs.length
      ? {
          fileRefs: turnEnvelope.fileRefs.map((ref) => ({
            path: ref.path,
            ...(ref.label ? { label: ref.label } : {}),
            rootRelation: ref.rootRelation,
            kind: ref.kind,
            materializationStatus: ref.materializationStatus,
            ...(ref.previewText ? { previewText: ref.previewText } : {}),
            ...(ref.blockedReason ? { blockedReason: ref.blockedReason } : {}),
          })),
        }
      : {}),
  };
}

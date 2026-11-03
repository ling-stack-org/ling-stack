import type {
  ConversationAttachment,
  LingThread,
  LingTurn,
  RunIntervention,
  RunSession,
  RunStore,
} from "@ling-stack/core";
import type {
  ApprovalRequest,
  ChannelMessageFileRef,
  ConversationTranscriptMessage,
  ConversationTranscriptStatus,
  LingApprovalCheckpoint,
} from "@ling-stack/contracts";
import { readOptionalChannelMessageFileRefs } from "../channels/schemas.js";

export interface ConversationRuntimeProjection {
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalCheckpoints: readonly LingApprovalCheckpoint[];
  readonly interventions: readonly RunIntervention[];
  readonly interventionById: ReadonlyMap<string, RunIntervention>;
}

export function collectConversationRuntimeProjection(
  store: RunStore,
  runs: readonly RunSession[],
): ConversationRuntimeProjection {
  const interventions = uniqueRunInterventions(runs.flatMap((run) =>
    store.listRunInterventions({ sourceRunId: run.id, limit: 500 })
  ));
  const approvals = runs
    .flatMap((run) => store.listApprovalRequests({ runId: run.id, limit: 500 }))
    .filter((approval, index, all) => all.findIndex((candidate) => candidate.id === approval.id) === index)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const approvalCheckpoints = approvals
    .map((approval) => store.getApprovalCheckpointForApproval(approval.id))
    .filter((checkpoint): checkpoint is NonNullable<typeof checkpoint> => Boolean(checkpoint));
  return {
    approvals,
    approvalCheckpoints,
    interventions,
    interventionById: new Map(interventions.map((intervention) => [intervention.id, intervention])),
  };
}

export function projectConversationTurnUserRuntime(input: {
  readonly store: RunStore;
  readonly turn: LingTurn;
  readonly run?: RunSession;
  readonly intervention?: RunIntervention;
}): {
  readonly content: string;
  readonly attachments: readonly ConversationAttachment[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
} {
  return {
    content: input.intervention?.messagePayload?.body || input.intervention?.instruction || input.turn.userInstruction,
    attachments: input.intervention
      ? conversationAttachmentsFromIntervention(input.store, input.intervention)
      : conversationAttachmentsFromRunSnapshot(input.store, input.run),
    fileRefs: input.intervention
      ? conversationFileRefsFromIntervention(input.intervention)
      : conversationFileRefsFromRunSnapshot(input.run),
  };
}

export function projectUnboundConversationInterventionMessages(input: {
  readonly store: RunStore;
  readonly thread: LingThread;
  readonly runs: readonly RunSession[];
  readonly interventions: readonly RunIntervention[];
  readonly existingMessageIds: ReadonlySet<string>;
  /** Includes filtered/superseded Turns: their guidance must not reappear as unbound. */
  readonly boundInterventionIds: ReadonlySet<string>;
}): ConversationTranscriptMessage[] {
  return input.interventions.flatMap((intervention) => {
    const id = conversationInterventionMessageId(intervention.id);
    if (input.existingMessageIds.has(id) || input.boundInterventionIds.has(intervention.id)) return [];
    const attachments = conversationAttachmentsFromIntervention(input.store, intervention);
    const fileRefs = conversationFileRefsFromIntervention(intervention);
    const continuationRun = input.runs.find((run) => run.interventionId === intervention.id);
    return [{
      id,
      role: intervention.requestedBy === "system" ? "system" : "user",
      content: intervention.messagePayload?.body || intervention.instruction,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(fileRefs.length > 0 ? { fileRefs } : {}),
      status: interventionTranscriptStatus(intervention),
      threadId: input.thread.id,
      turnId: continuationRun ? input.store.getLingTurnForRun(continuationRun.id)?.id : undefined,
      revision: 1,
      createdAt: intervention.createdAt,
      updatedAt: intervention.updatedAt,
    }];
  });
}

function conversationAttachmentsFromRunSnapshot(store: RunStore, run: RunSession | undefined): readonly ConversationAttachment[] {
  const snapshot = readRecord(run?.requestSnapshot);
  const attachmentIds = readStringArray(snapshot.conversationAttachmentIds ?? snapshot.attachmentIds);
  return attachmentIds
    .map((attachmentId) => store.getConversationAttachment(attachmentId))
    .filter((attachment): attachment is ConversationAttachment => Boolean(attachment));
}

function conversationAttachmentsFromIntervention(store: RunStore, intervention: RunIntervention): readonly ConversationAttachment[] {
  return readStringArray(intervention.messagePayload?.attachmentIds)
    .map((attachmentId) => store.getConversationAttachment(attachmentId))
    .filter((attachment): attachment is ConversationAttachment => Boolean(attachment));
}

function conversationFileRefsFromRunSnapshot(run: RunSession | undefined): readonly ChannelMessageFileRef[] {
  return readOptionalChannelMessageFileRefs(readRecord(run?.requestSnapshot), "conversationFileRefs") ?? [];
}

function conversationFileRefsFromIntervention(intervention: RunIntervention): readonly ChannelMessageFileRef[] {
  return (intervention.messagePayload?.fileRefs ?? []).map((fileRef) => ({
    path: fileRef.path,
    ...(fileRef.label ? { label: fileRef.label } : {}),
    source: fileRef.source ?? "api" as const,
  }));
}

function conversationInterventionMessageId(interventionId: string): string {
  return `conversation-user:intervention:${interventionId}`;
}

function interventionTranscriptStatus(intervention: RunIntervention): ConversationTranscriptStatus {
  if (intervention.status === "failed") return "failed";
  if (intervention.status === "cancelled") return "cancelled";
  return "succeeded";
}

function uniqueRunInterventions(interventions: readonly RunIntervention[]): RunIntervention[] {
  return [...new Map(interventions.map((intervention) => [intervention.id, intervention])).values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

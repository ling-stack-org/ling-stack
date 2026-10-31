import { createRunIntervention, listRunInterventions } from "../../api.js";
import { guidanceLookupJournal } from "../../shared/conversation/conversation-submission-journal.js";
import { resolveGuidanceSubmission } from "../../shared/conversation/conversation-submission-recovery.js";
import type {
  ChannelMessageFileRef,
  ConversationAttachment,
  ConversationActiveReplyTarget,
  CreateRunInterventionRequest,
  RunIntervention,
} from "../../types.js";
import type { ConversationHomeMessage } from "./normal-conversation-types.js";

export interface NormalConversationGuidanceDraft {
  readonly body: string;
  readonly attachments: readonly ConversationAttachment[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
}

export async function queueNormalConversationGuidance(input: {
  readonly cwd: string;
  readonly sourceReply?: ConversationActiveReplyTarget;
  readonly threadId: string;
  readonly draft: NormalConversationGuidanceDraft;
  readonly onSubmitting: () => void;
  readonly notReadyMessage: string;
}): Promise<{ readonly intervention: RunIntervention; readonly queryOnly: boolean }> {
  const body = input.draft.body.trim();
  const attachmentIds = input.draft.attachments.map((attachment) => attachment.id);
  const instruction = body || summarizeGuidanceAttachments(input.draft.attachments, input.draft.fileRefs);
  const request = {
    mode: "queue_followup",
    instruction,
    messagePayload: {
      body,
      attachmentIds,
      linkPreviewIds: [],
      attachments: input.draft.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        kind: attachment.kind,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        materializationStatus: "metadata_only",
      })),
      fileRefs: input.draft.fileRefs.map((fileRef) => ({
        path: fileRef.path,
        ...(fileRef.label ? { label: fileRef.label } : {}),
        ...(fileRef.source ? { source: fileRef.source } : {}),
        rootRelation: "unknown",
        kind: "unknown",
        materializationStatus: "not_loaded",
      })),
    },
  } satisfies Omit<CreateRunInterventionRequest, "idempotencyKey">;
  return resolveGuidanceSubmission<RunIntervention>({
    scope: { cwd: input.cwd, surface: "normal", ownerId: input.threadId },
    journal: guidanceLookupJournal,
    prepare: () => {
      if (!input.sourceReply) throw new Error(input.notReadyMessage);
      return { key: `web-guidance:${crypto.randomUUID()}`, sourceId: input.sourceReply.sourceRunId,
        threadId: input.threadId, mode: "queue_followup" };
    },
    create: async record => {
      input.onSubmitting();
      const response = await createRunIntervention(input.cwd, record.sourceId, { ...request, idempotencyKey: record.key });
      if (response.cwd !== input.cwd || response.intervention.idempotencyKey !== record.key
        || response.intervention.sourceRunId !== record.sourceId || response.intervention.mode !== record.mode) {
        throw new Error("Guidance receipt scope mismatch");
      }
      return response.intervention;
    },
    read: async record => {
      const response = await listRunInterventions(input.cwd, record.sourceId, 1, record.key);
      if (response.cwd !== input.cwd || response.idempotencyKey !== record.key || response.interventions.length > 1
        || response.interventions.some(item => item.sourceRunId !== record.sourceId || item.idempotencyKey !== record.key || item.mode !== record.mode)) {
        throw new Error("Guidance receipt scope mismatch");
      }
      return response.interventions[0] ? { status: "accepted", intervention: response.interventions[0] } : { status: "unknown" };
    },
  });
}

export function hasPendingNormalGuidance(cwd: string, threadId: string | undefined): boolean {
  if (!threadId) return false;
  try { return Boolean(guidanceLookupJournal.read({ cwd, surface: "normal", ownerId: threadId })); }
  catch { return true; }
}

export function projectNormalConversationGuidanceMessage(input: {
  readonly intervention: RunIntervention;
  readonly threadId: string;
  readonly attachments: readonly ConversationAttachment[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
}): ConversationHomeMessage {
  return {
    id: normalConversationGuidanceMessageId(input.intervention.id),
    threadId: input.threadId,
    role: "user",
    content: input.intervention.messagePayload?.body || input.intervention.instruction,
    attachments: input.attachments,
    fileRefs: input.fileRefs,
    status: input.intervention.status === "failed"
      ? "failed"
      : input.intervention.status === "cancelled"
        ? "cancelled"
        : "succeeded",
    revision: 1,
    createdAt: input.intervention.createdAt,
    updatedAt: input.intervention.updatedAt,
  };
}

export function normalConversationGuidanceMessageId(interventionId: string): string {
  return `conversation-user:intervention:${interventionId}`;
}

function summarizeGuidanceAttachments(
  attachments: readonly ConversationAttachment[],
  fileRefs: readonly ChannelMessageFileRef[],
): string {
  const labels = [
    ...attachments.map((attachment) => attachment.fileName),
    ...fileRefs.map((fileRef) => fileRef.label || fileRef.path),
  ];
  return labels.length > 0 ? `Continue with: ${labels.join(", ")}` : "Continue with the queued user guidance.";
}

import { createRunIntervention } from "../../api.js";
import type {
  ChannelMessageFileRef,
  ConversationAttachment,
  ConversationActiveReplyTarget,
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
  readonly sourceReply: ConversationActiveReplyTarget;
  readonly draft: NormalConversationGuidanceDraft;
  readonly idempotencyKey: string;
}): Promise<RunIntervention> {
  const body = input.draft.body.trim();
  const attachmentIds = input.draft.attachments.map((attachment) => attachment.id);
  const instruction = body || summarizeGuidanceAttachments(input.draft.attachments, input.draft.fileRefs);
  const response = await createRunIntervention(input.cwd, input.sourceReply.sourceRunId, {
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
        rootRelation: "unknown",
        kind: "unknown",
        materializationStatus: "not_loaded",
      })),
    },
    idempotencyKey: input.idempotencyKey,
  });
  return response.intervention;
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

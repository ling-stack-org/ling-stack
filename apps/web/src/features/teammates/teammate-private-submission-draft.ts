import type { ChannelMessageFileRef, TeammateDirectMessage } from "@ling-stack/contracts";

export interface PrivateSubmissionDraft {
  readonly body: string;
  readonly attachmentIds: readonly string[];
  readonly pendingAttachmentCount: number;
  readonly linkPreviewIds: readonly string[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
}

export function privateSubmissionDraftMatches(draft: PrivateSubmissionDraft,
  message: Pick<TeammateDirectMessage, "body" | "attachmentIds" | "linkPreviewIds" | "fileRefs">): boolean {
  const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((id, index) => id === right[index]);
  return draft.body.trim() === message.body.trim()
    && draft.pendingAttachmentCount === draft.attachmentIds.length
    && sameIds(draft.attachmentIds, message.attachmentIds)
    && sameIds(draft.linkPreviewIds, message.linkPreviewIds)
    && draft.fileRefs.length === message.fileRefs.length
    && draft.fileRefs.every((ref, index) => ref.path === message.fileRefs[index].path && ref.line === message.fileRefs[index].line);
}

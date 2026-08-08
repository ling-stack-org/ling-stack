import type { ConversationGuidanceItem } from "../../shared/conversation/index.js";
import type { PendingAttachmentItem } from "../../shared/components/index.js";
import type { ChannelAttachment, ChannelLinkPreview, ChannelMessageFileRef, RunIntervention } from "../../types.js";

export interface OptimisticChannelGuidance {
  readonly channelId: string;
  readonly sourceMessageId?: string;
  readonly sourceRunId?: string;
  readonly item: ConversationGuidanceItem;
}

export function createOptimisticChannelGuidance(input: {
  readonly id: string;
  readonly channelId: string;
  readonly instruction: string;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly fileRefs: readonly ChannelMessageFileRef[];
  readonly statusLabel: string;
  readonly meta: string;
}): OptimisticChannelGuidance {
  return {
    channelId: input.channelId,
    item: {
      id: input.id,
      instruction: input.instruction,
      attachments: input.pendingAttachments.flatMap((attachment) => attachment.attachment
        ? [{ id: attachment.attachment.id, label: attachment.attachment.fileName }]
        : []),
      linkPreviews: input.linkPreviews.map((preview) => ({ id: preview.id, label: preview.title || preview.url })),
      fileRefs: input.fileRefs.map((fileRef, index) => ({
        id: `${fileRef.path}:${index}`,
        label: fileRef.label ?? fileRef.path,
      })),
      statusLabel: input.statusLabel,
      meta: input.meta,
    },
  };
}

export function upsertOptimisticChannelGuidance(
  current: readonly OptimisticChannelGuidance[],
  guidance: OptimisticChannelGuidance,
): readonly OptimisticChannelGuidance[] {
  return [
    ...current.filter((candidate) => candidate.item.id !== guidance.item.id),
    guidance,
  ];
}

export function confirmOptimisticChannelGuidance(
  current: readonly OptimisticChannelGuidance[],
  localId: string,
  intervention: RunIntervention,
  statusLabel: string,
): readonly OptimisticChannelGuidance[] {
  return current.map((guidance) => guidance.item.id === localId
    ? {
        ...guidance,
        sourceMessageId: intervention.messagePayload?.sourceMessageId,
        sourceRunId: intervention.sourceRunId,
        item: {
          ...guidance.item,
          id: intervention.id,
          statusLabel,
        },
      }
    : guidance);
}

export function removeOptimisticChannelGuidance(
  current: readonly OptimisticChannelGuidance[],
  guidanceId: string,
): readonly OptimisticChannelGuidance[] {
  return current.filter((guidance) => guidance.item.id !== guidanceId);
}

export function pruneVisibleOptimisticChannelGuidance(
  current: readonly OptimisticChannelGuidance[],
  visibleMessageIds: ReadonlySet<string>,
): readonly OptimisticChannelGuidance[] {
  return current.filter((guidance) => (
    !guidance.sourceMessageId || !visibleMessageIds.has(guidance.sourceMessageId)
  ));
}

export function projectOptimisticChannelGuidanceItems(input: {
  readonly current: readonly OptimisticChannelGuidance[];
  readonly channelId: string;
  readonly sourceRunId: string;
  readonly authoritativeInterventionIds: ReadonlySet<string>;
  readonly visibleMessageIds: ReadonlySet<string>;
}): readonly ConversationGuidanceItem[] {
  return input.current
    .filter((guidance) => (
      guidance.channelId === input.channelId &&
      (!guidance.sourceRunId || guidance.sourceRunId === input.sourceRunId) &&
      !input.authoritativeInterventionIds.has(guidance.item.id) &&
      (!guidance.sourceMessageId || !input.visibleMessageIds.has(guidance.sourceMessageId))
    ))
    .map((guidance) => guidance.item);
}

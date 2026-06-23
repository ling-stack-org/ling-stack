import type { Channel, ChannelInputMaterialization, ChannelStoreFacet, RunStorePathsFacet, Task } from "@ling-stack/core";
import {
  findAvailableChannelInputMaterializationForSource,
  materializationHasPromptContent,
} from "../channels/materialization/cache.js";
import { materializeChannelAttachmentIds } from "../channels/materialization/inline.js";
import { renderMaterializationForPrompt } from "../channels/materialization/prompt.js";
import type { LingImageVisionSummarizer } from "../channels/materialization/registry.js";

type TaskAttachmentPromptStore = ChannelStoreFacet & RunStorePathsFacet;

export interface MaterializeTaskAttachmentsForPromptInput {
  readonly store: TaskAttachmentPromptStore;
  readonly channel: Channel;
  readonly task: Pick<Task, "attachmentIds">;
  readonly now: string;
  readonly imageVisionSummarizer?: LingImageVisionSummarizer;
}

export async function materializeTaskAttachmentsForPrompt(
  input: MaterializeTaskAttachmentsForPromptInput,
): Promise<string | undefined> {
  const attachmentIds = [...new Set(input.task.attachmentIds)];
  if (attachmentIds.length === 0) {
    return undefined;
  }

  await materializeChannelAttachmentIds({
    store: input.store,
    channel: input.channel,
    attachmentIds,
    now: input.now,
    imageVisionSummarizer: input.imageVisionSummarizer,
  });

  const rendered = attachmentIds
    .map((attachmentId, index) => renderTaskAttachmentForPrompt(input.store, input.channel, attachmentId, index + 1))
    .filter((value): value is string => Boolean(value));
  if (rendered.length === 0) {
    return undefined;
  }
  return ["Task attachments:", ...rendered].join("\n");
}

function renderTaskAttachmentForPrompt(
  store: TaskAttachmentPromptStore,
  channel: Channel,
  attachmentId: string,
  position: number,
): string | undefined {
  const attachment = store.getChannelAttachment(attachmentId);
  if (!attachment) {
    return [`${position}. Missing attachment`, `   id: ${attachmentId}`, "   status: missing"].join("\n");
  }
  if (attachment.channelId !== channel.id) {
    return undefined;
  }

  const materialization = findAvailableChannelInputMaterializationForSource({
    store,
    channelId: channel.id,
    sourceKind: "attachment",
    sourceId: attachment.id,
  });
  const promptContent = materializationHasPromptContent(materialization)
    ? renderMaterializationForPrompt(materialization)
    : undefined;
  const lines = [
    `${position}. ${attachment.fileName}`,
    `   id: ${attachment.id}`,
    `   kind: ${attachment.kind}`,
    `   contentType: ${attachment.contentType || "unknown"}`,
    `   sizeBytes: ${attachment.sizeBytes}`,
    `   materialization: ${describeMaterialization(materialization)}`,
  ];
  if (promptContent) {
    lines.push("   content:");
    lines.push(indentPromptContent(promptContent, "     "));
  }
  return lines.join("\n");
}

function describeMaterialization(materialization: ChannelInputMaterialization | undefined): string {
  if (!materialization) {
    return "unavailable";
  }
  const status = materialization.truncated ? `${materialization.status} (truncated)` : materialization.status;
  if (materialization.status !== "available" && materialization.errorCode) {
    return `${status}; ${materialization.errorCode}`;
  }
  return status;
}

function indentPromptContent(value: string, prefix: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

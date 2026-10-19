import { LING_AGENT_ID, redactSecrets, type ConversationAttachment, type LingConversationTone, type LingThread, type LingTurn } from "@ling-stack/core";
import type { ConversationStreamRequest, ChannelMessageFileRef, ResponseLanguagePreference, RunTool } from "@ling-stack/contracts";
import type { ConversationAttachmentMaterialization } from "./materialization.js";
import { lingConversationToneInstruction } from "./conversation-tone.js";
import { inferUserLanguage, responseLanguageInstruction } from "../channels/response-language.js";
import { renderNormalConversationRunPrompt, type NormalConversationContextSnapshot } from "./normal-conversation-context.js";
import type { RunRequest } from "../runs/schemas.js";

const defaultConversationTools: readonly RunTool[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];

export function buildConversationRunRequest(input: {
  readonly workspaceCwd: string;
  readonly thread: LingThread;
  readonly turn: LingTurn;
  readonly input: ConversationStreamRequest;
  readonly lingConversationTone: LingConversationTone;
  readonly defaultReasoningSummary: NonNullable<ConversationStreamRequest["reasoningSummary"]>;
  readonly attachments: readonly ConversationAttachment[];
  readonly attachmentMaterializations: ReadonlyMap<string, ConversationAttachmentMaterialization>;
  readonly normalConversationContext: NormalConversationContextSnapshot;
  readonly normalConversationAcceptedSnapshotId?: string;
}): RunRequest {
  const toneInstruction = lingConversationToneInstruction(input.lingConversationTone);
  const responseLanguagePreference = input.input.responseLanguage ?? "follow_user";
  const responseLanguage = resolveConversationResponseLanguage(
    responseLanguagePreference,
    input.input.message,
  );
  const appendSystemPrompt = [
    toneInstruction,
    responseLanguageInstruction(responseLanguagePreference),
  ].filter((instruction) => instruction.trim());
  return {
    workspaceCwd: input.workspaceCwd,
    cwd: input.input.projectPath || input.workspaceCwd,
    task: redactSecrets({
      id: conversationRunTaskId(input.turn.id),
      title: input.turn.title,
      prompt: renderNormalConversationRunPrompt(input.normalConversationContext, buildConversationRunPrompt(
        input.input.message,
        input.attachments,
        input.attachmentMaterializations,
        input.input.fileRefs ?? [],
      )),
    }) as RunRequest["task"],
    threadId: input.thread.id,
    turnId: input.turn.id,
    teammateId: LING_AGENT_ID,
    createdByActor: input.turn.createdByActor,
    providerPresetId: input.input.executionBinding?.kind === "pi_provider" ? input.input.executionBinding.providerPresetId : input.input.providerPresetId,
    executionBinding: input.input.executionBinding,
    runnerId: input.input.executionBinding?.kind === "native_profile" ? input.input.executionBinding.engineId
      : input.input.executionBinding?.kind === "pi_provider" ? "pi" : undefined,
    tools: input.input.tools ?? defaultConversationTools,
    authorizationMode: input.input.authorizationMode,
    workspaceAccessMode: input.input.workspaceAccessMode,
    permissionPreset: input.input.permissionPreset,
    permissionMode: input.input.permissionMode,
    permissionConfirmation: input.input.permissionConfirmation,
    thinkingLevel: input.input.thinkingLevel,
    reasoningSummary: input.input.reasoningSummary ?? input.defaultReasoningSummary,
    lingConversationTone: input.lingConversationTone,
    responseLanguage,
    appendSystemPrompt,
    conversationAttachmentIds: input.attachments.map((attachment) => attachment.id),
    conversationFileRefs: input.input.fileRefs ?? [],
    normalConversationContext: input.normalConversationContext,
    normalConversationAcceptedSnapshotId: input.normalConversationAcceptedSnapshotId,
    contextProjection: input.normalConversationContext.projection,
    idempotencyKey: input.input.idempotencyKey ?? `conversation:${input.turn.id}`,
  };
}

export function resolveConversationResponseLanguage(
  responseLanguage: ResponseLanguagePreference | undefined,
  message: string,
): Exclude<ResponseLanguagePreference, "follow_user"> {
  return responseLanguage && responseLanguage !== "follow_user" ? responseLanguage : inferUserLanguage(message);
}

function buildConversationRunPrompt(
  message: string,
  attachments: readonly ConversationAttachment[],
  materializations: ReadonlyMap<string, ConversationAttachmentMaterialization>,
  fileRefs: readonly ChannelMessageFileRef[],
): string {
  const trimmedMessage = message.trim();
  const parts = [
    trimmedMessage || "User attached files.",
    renderConversationAttachmentsForPrompt(attachments, materializations),
    renderConversationFileRefsForPrompt(fileRefs),
  ].filter((part) => part.trim());
  return parts.join("\n\n");
}

function renderConversationFileRefsForPrompt(fileRefs: readonly ChannelMessageFileRef[]): string {
  if (fileRefs.length === 0) {
    return "";
  }
  return [
    "Workspace file references:",
    ...fileRefs.map((fileRef, index) => `- ${index + 1}. ${fileRef.label ? `${fileRef.label}: ` : ""}${fileRef.path}${fileRef.line ? `:${fileRef.line}` : ""}`),
    "Treat these as user-supplied references only. Existing workspace and approval policy still controls access.",
  ].join("\n");
}

function renderConversationAttachmentsForPrompt(
  attachments: readonly ConversationAttachment[],
  materializations: ReadonlyMap<string, ConversationAttachmentMaterialization>,
): string {
  if (attachments.length === 0) {
    return "";
  }
  return [
    "Attached files:",
    ...attachments.map((attachment, index) => {
      const materialization = materializations.get(attachment.id);
      const header = `- ${index + 1}. ${attachment.fileName} (${attachment.kind}, ${attachment.contentType}, ${attachment.sizeBytes} bytes, materialization=${materialization?.status ?? "metadata_only"})`;
      if (materialization?.status === "available" && materialization.contentText?.trim()) {
        return `${header}\n  Content${materialization.truncated ? " (truncated)" : ""}:\n${indentAttachmentContent(materialization.contentText)}`;
      }
      return header;
    }),
    "Use only the listed attachment content. Do not infer unseen file contents.",
  ].join("\n");
}

function indentAttachmentContent(content: string): string {
  return content.trim().split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

function conversationRunTaskId(turnId: string): string {
  return `conversation:${turnId}`;
}

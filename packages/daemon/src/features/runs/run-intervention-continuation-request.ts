import {
  isAuthorizationMode,
  isWorkspaceAccessMode,
  permissionPresets,
  redactSecrets,
  sessionPermissionModes,
  type PermissionConfirmation,
  type PermissionPreset,
  type RunIntervention,
  type RunInterventionMessagePayload,
  type RunSession,
  type RunStatus,
  type RunStore,
  type SecretResolver,
  type RunTool,
  type SessionPermissionMode,
  type SkillApprovalProfile,
} from "@ling-stack/core";
import type { PiRunnerProviderConfig } from "@ling-stack/runner-pi";
import { isConversationContextProjectionMetadata, isExternalExecutionEngineId, parseExecutionBindingRequest, type ConversationContextProjectionMetadata } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { buildChannelReplyContinuationContext } from "../channels/channel-reply-continuation-context.js";
import type { RunRequest } from "./schemas.js";
import { prepareNormalConversationInput } from "../conversations/normal-conversation-input.js";
import { saveNormalConversationPreparedRequest } from "../conversations/normal-conversation-prepared-request.js";
import { renderNormalConversationRunPrompt } from "../conversations/normal-conversation-context.js";
import { requireNormalContinuationSource } from "../conversations/normal-conversation-continuation-source.js";

export function buildRunInterventionContinuationRequest(
  store: RunStore,
  sourceRun: RunSession,
  intervention: RunIntervention,
  messageLink: { readonly sourceMessageId?: string; readonly linkedMessageId?: string } = {},
  secretResolver?: SecretResolver,
): RunRequest {
  const snapshot = isRecord(sourceRun.requestSnapshot) ? sourceRun.requestSnapshot : {};
  const executionBinding = snapshot.executionBinding === undefined ? undefined : parseExecutionBindingRequest(snapshot.executionBinding);
  if (!executionBinding && (isExternalExecutionEngineId(snapshot.runnerId) || isExternalExecutionEngineId(sourceRun.providerName))) {
    throw new HttpError(409, "legacy_runner_migration_required", "The source run has no native profile binding; select and validate a profile before continuing.");
  }
  const native = executionBinding?.kind === "native_profile";
  const taskSnapshot = isRecord(sourceRun.taskSnapshot) ? sourceRun.taskSnapshot : {};
  const originalTitle = readSnapshotString(taskSnapshot, "title") ?? readSnapshotString(isRecord(snapshot.task) ? snapshot.task : {}, "title") ?? sourceRun.taskId;
  const originalPrompt = readSnapshotString(taskSnapshot, "prompt") ?? readSnapshotString(isRecord(snapshot.task) ? snapshot.task : {}, "prompt") ?? "";
  const channelId =
    readSnapshotString(taskSnapshot, "channelId") ??
    readSnapshotString(isRecord(snapshot.task) ? snapshot.task : {}, "channelId") ??
    sourceRun.channelId;
  const permissionMode = readSnapshotSessionPermissionMode(snapshot, "permissionMode");
  const permissionPreset = readSnapshotPermissionPreset(snapshot, "permissionPreset");
  const permissionConfirmation = readSnapshotPermissionConfirmation(snapshot, "permissionConfirmation");
  const requestedSkillId = readSnapshotString(snapshot, "requestedSkillId") ?? sourceRun.selectedSkillId;
  const providerPresetId = readSnapshotString(snapshot, "providerPresetId") ?? sourceRun.providerPresetId;
  const inlineProvider = providerPresetId ? undefined : isRecord(snapshot.provider) ? snapshot.provider as unknown as PiRunnerProviderConfig
    : isRecord(sourceRun.providerSnapshot) ? sourceRun.providerSnapshot as unknown as PiRunnerProviderConfig : undefined;
  const tools = readSnapshotRunTools(snapshot, "tools");
  const appendSystemPrompt = readSnapshotStringArray(snapshot, "appendSystemPrompt");
  const sourceThread = sourceRun.threadId ? store.getLingThread(sourceRun.threadId) : undefined;
  const channelContinuation = messageLink.sourceMessageId && sourceRun.channelId
    ? buildChannelReplyContinuationContext({
        store,
        secretResolver,
        sourceRun,
        intervention,
        sourceMessageId: messageLink.sourceMessageId,
      })
    : undefined;
  const inheritedSystemPrompt = readSnapshotString(snapshot, "systemPrompt");
  const normalSource = sourceThread?.kind === "conversation" && !sourceThread.channelId
    ? requireNormalContinuationSource({ store, thread: sourceThread, sourceRun, intervention }) : undefined;
  const normalInput = normalSource && sourceThread
    ? prepareNormalConversationInput({ store, thread: sourceThread, title: `继续自上次运行: ${originalTitle}`,
        actorType: intervention.requestedBy === "system" ? "system" : "local_user",
        message: intervention.messagePayload?.body || intervention.instruction,
        attachmentIds: intervention.messagePayload?.attachmentIds ?? [],
        fileRefs: (intervention.messagePayload?.fileRefs ?? []).map((ref) => ({ path: ref.path, ...(ref.label ? { label: ref.label } : {}) })),
        sourceTurnId: normalSource.id,
        interventionId: intervention.id, turnKind: intervention.mode === "interrupt_redirect" ? "interrupt_redirect" : "queued_followup",
        idempotencyKey: `run_intervention:${intervention.id}`, now: new Date().toISOString() })
    : undefined;
  if (normalInput?.replayRequest) return normalInput.replayRequest;

  const request: RunRequest = {
    workspaceCwd: readSnapshotString(snapshot, "workspaceCwd") ?? sourceRun.cwd,
    cwd: readSnapshotString(snapshot, "cwd") ?? sourceRun.cwd,
    executionBinding,
    providerPresetId: native ? undefined : channelContinuation?.providerPresetId ?? providerPresetId,
    provider: executionBinding || channelContinuation ? undefined : inlineProvider,
    threadId: channelContinuation?.threadId ?? sourceRun.threadId,
    turnId: channelContinuation?.turnId ?? normalInput?.turn.id,
    teammateId: channelContinuation?.targetTeammateId ?? readSnapshotString(snapshot, "teammateId") ?? sourceRun.teammateId,
    runnerId: native ? executionBinding.engineId : channelContinuation?.runnerId ?? readSnapshotString(snapshot, "runnerId"),
    requestedSkillId,
    skipProviderPreflight: readSnapshotBoolean(snapshot, "skipProviderPreflight") ?? false,
    idempotencyKey: normalInput?.idempotencyKey ?? `run_intervention:${intervention.id}`,
    task: {
      id: `continuation_${intervention.id}`,
      title: channelContinuation?.title ?? (normalInput ? redactSecrets(`继续自上次运行: ${originalTitle}`) as string : `继续自上次运行: ${originalTitle}`),
      prompt: channelContinuation?.prompt ?? (normalInput
        ? renderNormalConversationRunPrompt(normalInput.context, [renderRunInterventionPayloadForPrompt(intervention.instruction, intervention.messagePayload),
            `Continuation of Run ${sourceRun.id} (${intervention.mode}). Re-check external state before repeating side effects; no additional permissions are granted.`].join("\n\n"),
            intervention.requestedBy === "system" ? "system" : "local_user")
        : renderRunInterventionContinuationPrompt({
        sourceRun,
        originalTitle,
        originalPrompt,
        sourceStatus: sourceRun.status,
        instruction: intervention.instruction,
        messagePayload: intervention.messagePayload,
        mode: intervention.mode,
      })),
      channelId,
    },
    tools,
    approvalProfile: isRecord(snapshot.approvalProfile) ? snapshot.approvalProfile as unknown as SkillApprovalProfile : undefined,
    permissionPreset,
    permissionMode,
    authorizationMode: typeof snapshot.authorizationMode === "string" && isAuthorizationMode(snapshot.authorizationMode) ? snapshot.authorizationMode : undefined,
    workspaceAccessMode: typeof snapshot.workspaceAccessMode === "string" && isWorkspaceAccessMode(snapshot.workspaceAccessMode) ? snapshot.workspaceAccessMode : undefined,
    permissionConfirmation,
    thinkingLevel: readSnapshotThinkingLevel(snapshot, "thinkingLevel"),
    reasoningSummary: readSnapshotReasoningSummary(snapshot, "reasoningSummary"),
    systemPrompt: channelContinuation?.systemPromptInstruction ?? inheritedSystemPrompt,
    appendSystemPrompt,
    contextProjection: channelContinuation?.contextProjection ?? normalInput?.context.projection ??
      (sourceThread?.kind === "conversation" ? undefined : readSnapshotContextProjection(snapshot)),
    normalConversationContext: normalInput?.context,
    normalConversationAcceptedSnapshotId: normalInput?.acceptedSnapshotId,
    agentDir: readSnapshotString(snapshot, "agentDir"),
    skipMemoryRecall: channelContinuation ? true : readSnapshotBoolean(snapshot, "skipMemoryRecall"),
    conversationAttachmentIds: intervention.messagePayload?.attachmentIds ?? [],
    sourceMessageId: normalInput?.turn.sourceItemId ?? messageLink.sourceMessageId ?? (sourceThread?.kind === "conversation"
      ? `conversation-user:intervention:${intervention.id}`
      : undefined),
    linkedMessageId: messageLink.linkedMessageId,
    createdByActor: intervention.requestedBy,
    parentRunId: sourceRun.id,
    interventionId: intervention.id,
    continuationReason: intervention.mode,
  };
  return normalInput ? saveNormalConversationPreparedRequest(store, request, new Date().toISOString()) : request;
}

function readSnapshotContextProjection(snapshot: Record<string, unknown>): ConversationContextProjectionMetadata | undefined {
  return isConversationContextProjectionMetadata(snapshot.contextProjection)
    ? snapshot.contextProjection
    : undefined;
}

function renderRunInterventionContinuationPrompt(input: {
  readonly sourceRun: RunSession;
  readonly originalTitle: string;
  readonly originalPrompt: string;
  readonly sourceStatus: RunStatus;
  readonly instruction: string;
  readonly messagePayload?: RunInterventionMessagePayload;
  readonly mode: RunIntervention["mode"];
}): string {
  return [
    "Continue a Ling Stack supervised run from preserved context.",
    "",
    "Original task:",
    `Title: ${input.originalTitle}`,
    input.originalPrompt,
    "",
    "Source run:",
    `Run id: ${input.sourceRun.id}`,
    `Status: ${input.sourceStatus}`,
    `Provider: ${input.sourceRun.providerName}/${input.sourceRun.providerModel}`,
    input.sourceRun.selectedSkillId ? `Selected skill: ${input.sourceRun.selectedSkillId}` : undefined,
    input.sourceRun.startedAt ? `Started at: ${input.sourceRun.startedAt}` : undefined,
    input.sourceRun.endedAt ? `Ended at: ${input.sourceRun.endedAt}` : undefined,
    "",
    input.mode === "interrupt_redirect" ? "User redirect:" : "Queued user guidance:",
    renderRunInterventionPayloadForPrompt(input.instruction, input.messagePayload),
    "",
    "Constraints:",
    "- Continue from durable source run context; do not assume unseen state.",
    "- The user guidance does not grant extra tools, approvals, secrets, MCP access, or external-send rights.",
    "- Re-check files or external state before repeating side effects that may have already happened.",
  ].filter((line): line is string => line !== undefined).join("\n");
}

function renderRunInterventionPayloadForPrompt(instruction: string, payload: RunInterventionMessagePayload | undefined): string {
  if (!payload) {
    return instruction;
  }
  const lines = [
    payload.body || instruction,
    renderRunInterventionAttachmentsForPrompt(payload),
    renderRunInterventionLinkPreviewsForPrompt(payload),
    renderRunInterventionWorkspaceFileRefsForPrompt(payload),
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function renderRunInterventionAttachmentsForPrompt(payload: RunInterventionMessagePayload): string | undefined {
  if (payload.attachments?.length) {
    return [
      "Attachments:",
      ...payload.attachments.map((attachment, index) => [
        `- ${index + 1}. ${attachment.fileName} (${attachment.kind}, ${attachment.contentType}, ${attachment.sizeBytes} bytes, materialization=${attachment.materializationStatus}${attachment.previewStatus ? `, preview=${attachment.previewStatus}` : ""})`,
        attachment.reason ? `  statusReason: ${attachment.reason}` : undefined,
        attachment.previewText ? `  preview:\n${indentPromptBlock(attachment.previewText)}` : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n")),
    ].join("\n");
  }
  return payload.attachmentIds.length > 0 ? `Attachments: ${payload.attachmentIds.join(", ")}` : undefined;
}

function renderRunInterventionLinkPreviewsForPrompt(payload: RunInterventionMessagePayload): string | undefined {
  if (payload.linkPreviews?.length) {
    return [
      "Link previews:",
      ...payload.linkPreviews.map((preview, index) => [
        `- ${index + 1}. ${preview.title ?? preview.normalizedUrl} (${preview.status}, materialization=${preview.materializationStatus})`,
        `  url: ${preview.url}`,
        preview.siteName ? `  site: ${preview.siteName}` : undefined,
        preview.description ? `  description: ${preview.description}` : undefined,
        preview.reason ? `  statusReason: ${preview.reason}` : undefined,
        preview.previewText ? `  preview:\n${indentPromptBlock(preview.previewText)}` : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n")),
    ].join("\n");
  }
  return payload.linkPreviewIds.length > 0 ? `Link previews: ${payload.linkPreviewIds.join(", ")}` : undefined;
}

function renderRunInterventionWorkspaceFileRefsForPrompt(payload: RunInterventionMessagePayload): string | undefined {
  if (!payload.fileRefs?.length) {
    return undefined;
  }
  return [
    "Workspace file refs:",
    ...payload.fileRefs.map((ref, index) => [
      `- ${index + 1}. ${ref.label ? `${ref.label}: ` : ""}${ref.path} (${ref.kind}, ${ref.rootRelation}, materialization=${ref.materializationStatus})`,
      ref.blockedReason ? `  statusReason: ${ref.blockedReason}` : undefined,
      ref.previewText ? `  preview:\n${indentPromptBlock(ref.previewText)}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n")),
  ].join("\n");
}

function indentPromptBlock(value: string): string {
  return value.split(/\r?\n/u).map((line) => `    ${line}`).join("\n");
}

function readSnapshotString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSnapshotBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readSnapshotStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function readSnapshotRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRunTool) : undefined;
}

function readSnapshotSessionPermissionMode(record: Record<string, unknown>, key: string): SessionPermissionMode | undefined {
  const value = record[key];
  return typeof value === "string" && sessionPermissionModes.includes(value as SessionPermissionMode)
    ? value as SessionPermissionMode
    : undefined;
}

function readSnapshotPermissionPreset(record: Record<string, unknown>, key: string): PermissionPreset | undefined {
  const value = record[key];
  return typeof value === "string" && permissionPresets.includes(value as PermissionPreset)
    ? value as PermissionPreset
    : undefined;
}

function readSnapshotPermissionConfirmation(record: Record<string, unknown>, key: string): PermissionConfirmation | undefined {
  const value = record[key];
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.mode !== "full_access" ||
    value.confirmed !== true ||
    typeof value.confirmedAt !== "string" ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    Number.isNaN(Date.parse(value.confirmedAt))
  ) {
    return undefined;
  }
  return {
    mode: "full_access",
    confirmed: true,
    confirmedAt: value.confirmedAt,
    reason: value.reason,
  };
}

function readSnapshotThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  const value = record[key];
  return typeof value === "string" && (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  )
    ? value
    : undefined;
}

function readSnapshotReasoningSummary(record: Record<string, unknown>, key: string): RunRequest["reasoningSummary"] {
  const value = record[key];
  return value === "auto" || value === "concise" || value === "detailed" || value === "none"
    ? value
    : undefined;
}

function isRunTool(value: unknown): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

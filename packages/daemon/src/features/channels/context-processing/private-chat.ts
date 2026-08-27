import type {
  AiTeammate,
  ChannelMessageFileRef,
  RunSession,
  RunStore,
  Task,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectThread,
  TeammatePrivateAttachment,
} from "@ling-stack/core";
import type { ChannelContextDroppedSource, ChannelContextSection, ChannelContextSource, ChannelContextSourceRef, ChannelContextView } from "./types.js";
import { buildChannelContextView } from "./views.js";

export interface PrivateChatAttachmentMaterialization {
  readonly attachmentId: string;
  readonly fileName: string;
  readonly status: "available" | "metadata_only" | "unsupported" | "blocked";
  readonly contentText?: string;
  readonly truncated?: boolean;
  readonly errorMessage?: string;
}

export interface BuildPrivateChatContextViewInput {
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly messages: readonly TeammateDirectMessage[];
  readonly sourceMessage: TeammateDirectMessage;
  readonly attachmentsById?: ReadonlyMap<string, TeammatePrivateAttachment>;
  readonly materializationsByAttachmentId?: ReadonlyMap<string, PrivateChatAttachmentMaterialization>;
  readonly memorySources?: readonly ChannelContextSource[];
  readonly memoryDropped?: readonly ChannelContextDroppedSource[];
  readonly now?: string;
}

export function buildPrivateChatContextView(input: BuildPrivateChatContextViewInput): ChannelContextView {
  const attachmentsById = input.attachmentsById ?? new Map();
  const materializationsByAttachmentId = input.materializationsByAttachmentId ?? new Map();
  const promptMessages = privatePromptMessages(input.messages, input.sourceMessage);
  const linkPreviewsById = collectDirectLinkPreviews(input.store, input.teammate.id, input.thread.id, promptMessages);
  const prompt = formatPrivateChatPrompt({
    teammate: input.teammate,
    messages: input.messages,
    sourceMessage: input.sourceMessage,
    attachmentsById,
    materializationsByAttachmentId,
    linkPreviewsById,
  });
  const promptSources = [
    collectTeammateProfileSource(input.teammate),
    ...collectPrivateMessageSources({
      teammate: input.teammate,
      thread: input.thread,
      messages: promptMessages,
      sourceMessage: input.sourceMessage,
      attachmentsById,
      materializationsByAttachmentId,
      linkPreviewsById,
    }),
    ...collectPrivateLinkedReferenceSources({
      store: input.store,
      teammate: input.teammate,
      thread: input.thread,
      messages: privatePromptMessages(input.messages, input.sourceMessage),
    }),
  ];
  const sections: readonly ChannelContextSection[] = [{
    id: "private_chat_prompt",
    role: "user",
    priority: "must_keep",
    compactionSurvival: "summarize",
    title: "private_chat_prompt",
    text: prompt,
    sourceRefIds: promptSources.map((source) => source.id),
    visibility: "prompt",
    quotePolicy: "influence_only",
    metadata: {
      teammateId: input.teammate.id,
      threadId: input.thread.id,
      sourceMessageId: input.sourceMessage.id,
    },
  }];

  return buildChannelContextView({
    kind: "private_chat_view",
    workspaceId: input.thread.workspaceId,
    consumerTeammateId: input.teammate.id,
    sections,
    sourceRefs: [],
    sources: [...promptSources, ...(input.memorySources ?? [])],
    dropped: input.memoryDropped,
    now: input.now,
  });
}

export function collectTeammateProfileSource(teammate: AiTeammate): ChannelContextSource {
  return {
    id: `teammate_profile:${teammate.id}`,
    kind: "teammate_profile",
    workspaceId: teammate.workspaceId,
    teammateId: teammate.id,
    sourceRefs: [{ type: "teammate", id: teammate.id, label: teammate.displayName }],
    title: teammate.displayName,
    text: [
      `Teammate: ${teammate.displayName}`,
      `Role: ${teammate.roleKey}`,
      `Description: ${teammate.description}`,
    ].join("\n"),
    metadata: {
      roleKey: teammate.roleKey,
      templateId: teammate.templateId,
      systemRole: teammate.systemRole,
      protectedProfile: teammate.protectedProfile,
    },
    sensitivity: "private",
    freshness: "durable",
  };
}

export function collectPrivateMessageSources(input: {
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly messages: readonly TeammateDirectMessage[];
  readonly sourceMessage: TeammateDirectMessage;
  readonly attachmentsById?: ReadonlyMap<string, TeammatePrivateAttachment>;
  readonly materializationsByAttachmentId?: ReadonlyMap<string, PrivateChatAttachmentMaterialization>;
  readonly linkPreviewsById?: ReadonlyMap<string, TeammateDirectLinkPreview>;
}): readonly ChannelContextSource[] {
  const attachmentsById = input.attachmentsById ?? new Map();
  const materializationsByAttachmentId = input.materializationsByAttachmentId ?? new Map();
  const linkPreviewsById = input.linkPreviewsById ?? new Map();
  return input.messages.map((message) => {
    const attachmentIds = message.attachmentIds ?? [];
    const linkPreviewIds = message.linkPreviewIds ?? [];
    const fileRefs = message.fileRefs ?? [];
    return {
      id: `private_message:${message.id}`,
      kind: "private_message" as const,
      workspaceId: input.thread.workspaceId,
      teammateId: input.teammate.id,
      sourceRefs: [
        { type: "teammate_direct_thread", id: input.thread.id, label: input.thread.title },
        { type: "teammate_direct_message", id: message.id, label: message.id === input.sourceMessage.id ? "Latest private message" : "Private chat history" },
        ...attachmentIds.map((attachmentId) => {
        const attachment = attachmentsById.get(attachmentId);
        return { type: "teammate_private_attachment", id: attachmentId, label: attachment?.fileName };
        }),
        ...linkPreviewIds.map((linkPreviewId) => {
        const preview = linkPreviewsById.get(linkPreviewId);
        return { type: "teammate_direct_link_preview", id: linkPreviewId, label: preview?.title ?? preview?.url };
        }),
        ...fileRefs.map((fileRef, index) => ({ type: "workspace_file_ref", id: `${message.id}:${index}`, label: renderPrivateFileRef(fileRef) })),
        ...(message.linkedTaskId ? [{ type: "task", id: message.linkedTaskId, label: "Linked task" }] : []),
        ...(message.linkedRunId ? [{ type: "run", id: message.linkedRunId, label: "Linked run" }] : []),
      ],
      title: message.id === input.sourceMessage.id ? "Latest private message" : `Private ${message.authorType} message`,
      text: renderPrivateMessageLine(
        input.teammate,
        message,
        attachmentsById,
        message.id === input.sourceMessage.id ? materializationsByAttachmentId : new Map(),
        linkPreviewsById,
      ),
      metadata: {
        threadId: input.thread.id,
        authorType: message.authorType,
        authorId: message.authorId,
        status: message.status,
        attachmentCount: attachmentIds.length,
        linkPreviewCount: linkPreviewIds.length,
        fileRefCount: fileRefs.length,
        materializedAttachmentCount: attachmentIds
          .map((attachmentId) => materializationsByAttachmentId.get(attachmentId))
          .filter(hasPrivateAttachmentPromptContent).length,
        linkedTaskId: message.linkedTaskId,
        linkedRunId: message.linkedRunId,
        createdAt: message.createdAt,
      },
      sensitivity: "private" as const,
      freshness: message.id === input.sourceMessage.id ? "current_turn" as const : "recent" as const,
    };
  });
}

export function collectPrivateLinkedReferenceSources(input: {
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly messages: readonly TeammateDirectMessage[];
}): readonly ChannelContextSource[] {
  const sources: ChannelContextSource[] = [];
  for (const message of input.messages) {
    if (message.linkedTaskId) {
      const task = input.store.getTask(message.linkedTaskId);
      sources.push(linkedTaskSource({
        teammate: input.teammate,
        thread: input.thread,
        message,
        taskId: message.linkedTaskId,
        task,
      }));
    }
    if (message.linkedRunId) {
      const run = input.store.getRun(message.linkedRunId);
      sources.push(linkedRunSource({
        store: input.store,
        teammate: input.teammate,
        thread: input.thread,
        message,
        runId: message.linkedRunId,
        run,
      }));
    }
  }
  return uniqueSources(sources);
}

function formatPrivateChatPrompt(input: {
  readonly teammate: AiTeammate;
  readonly messages: readonly TeammateDirectMessage[];
  readonly sourceMessage: TeammateDirectMessage;
  readonly attachmentsById: ReadonlyMap<string, TeammatePrivateAttachment>;
  readonly materializationsByAttachmentId: ReadonlyMap<string, PrivateChatAttachmentMaterialization>;
  readonly linkPreviewsById: ReadonlyMap<string, TeammateDirectLinkPreview>;
}): string {
  const history = input.messages
    .filter((message) => message.status === "ready" && message.id !== input.sourceMessage.id && !isHistoricalGuidanceMessage(message))
    .slice(-20)
    .map((message) => renderPrivateMessageLine(input.teammate, message, input.attachmentsById, new Map(), input.linkPreviewsById))
    .join("\n");
  const latestMessage = renderPrivateMessageLine(input.teammate, input.sourceMessage, input.attachmentsById, input.materializationsByAttachmentId, input.linkPreviewsById);
  return [
    `Teammate: ${input.teammate.displayName}`,
    `Role: ${input.teammate.roleKey}`,
    `Description: ${input.teammate.description}`,
    "",
    "Private conversation:",
    history || "No prior messages.",
    "",
    "Latest message to answer now:",
    latestMessage,
    "",
    "Reply to the Latest message to answer now. Use older conversation only as context.",
    "If the latest message includes attachments, use only attachment content explicitly listed under Attachment content. Metadata-only attachments do not expose their body. Do not infer unseen attachment contents, including image, PDF, Office, or file contents.",
    "If the latest message includes links or workspace file references, use only the explicit metadata and paths listed in this private chat context. Do not claim to have opened files or web pages unless their content is included.",
  ].join("\n");
}

function privatePromptMessages(
  messages: readonly TeammateDirectMessage[],
  sourceMessage: TeammateDirectMessage,
): readonly TeammateDirectMessage[] {
  const historical = messages
    .filter((message) => message.status === "ready" && message.id !== sourceMessage.id && !isHistoricalGuidanceMessage(message))
    .slice(-20);
  return [...historical, sourceMessage];
}

function isHistoricalGuidanceMessage(message: TeammateDirectMessage): boolean {
  if (message.authorType !== "system") {
    return false;
  }
  const body = message.body.trim();
  return body.startsWith("排队引导：") || body.startsWith("已停止上一条回复，并按新引导继续：");
}

function renderPrivateMessageLine(
  teammate: AiTeammate,
  message: TeammateDirectMessage,
  attachmentsById: ReadonlyMap<string, TeammatePrivateAttachment>,
  materializationsByAttachmentId: ReadonlyMap<string, PrivateChatAttachmentMaterialization>,
  linkPreviewsById: ReadonlyMap<string, TeammateDirectLinkPreview>,
): string {
  const author = message.authorType === "ai-teammate"
    ? teammate.displayName
    : message.authorType === "system"
      ? "System"
      : "User";
  const body = message.body.trim() || "(no text)";
  const attachmentIds = message.attachmentIds ?? [];
  const linkPreviewIds = message.linkPreviewIds ?? [];
  const fileRefs = message.fileRefs ?? [];
  const attachments = attachmentIds
    .map((attachmentId) => attachmentsById.get(attachmentId))
    .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))
    .map((attachment) => `${attachment.fileName} (${attachment.kind}, ${attachment.contentType}, ${formatBytes(attachment.sizeBytes)})`);
  const attachmentContent = attachmentIds
    .map((attachmentId) => materializationsByAttachmentId.get(attachmentId))
    .filter(hasPrivateAttachmentPromptContent)
    .map((materialization) => [
      `- ${materialization.fileName}${materialization.truncated ? " (truncated)" : ""}:`,
      materialization.contentText?.trim(),
    ].filter(Boolean).join("\n"));
  const links = linkPreviewIds
    .map((linkPreviewId) => linkPreviewsById.get(linkPreviewId))
    .filter((preview): preview is TeammateDirectLinkPreview => Boolean(preview))
    .map((preview) => `${preview.title?.trim() || preview.siteName?.trim() || preview.url} (${preview.normalizedUrl})`);
  const fileRefLabels = fileRefs.map(renderPrivateFileRef);
  if (attachments.length === 0 && links.length === 0 && fileRefLabels.length === 0) {
    return `${author}: ${body}`;
  }
  return [
    `${author}: ${body}`,
    `Attachments: ${attachments.join("; ")}`,
    links.length > 0 ? `Links: ${links.join("; ")}` : undefined,
    fileRefLabels.length > 0 ? `Workspace file refs: ${fileRefLabels.join("; ")}` : undefined,
    attachmentContent.length > 0 ? `Attachment content:\n${attachmentContent.join("\n")}` : undefined,
  ].filter(Boolean).join("\n");
}

function collectDirectLinkPreviews(
  store: RunStore,
  teammateId: string,
  threadId: string,
  messages: readonly TeammateDirectMessage[],
): ReadonlyMap<string, TeammateDirectLinkPreview> {
  const previews = new Map<string, TeammateDirectLinkPreview>();
  const linkPreviewIds = new Set(messages.flatMap((message) => message.linkPreviewIds ?? []));
  if (linkPreviewIds.size === 0) {
    return previews;
  }
  const getLinkPreview = (store as { getTeammateDirectLinkPreview?: (id: string) => TeammateDirectLinkPreview | undefined }).getTeammateDirectLinkPreview;
  if (!getLinkPreview) {
    return previews;
  }
  for (const linkPreviewId of linkPreviewIds) {
    const preview = getLinkPreview.call(store, linkPreviewId);
    if (preview && preview.teammateId === teammateId && preview.threadId === threadId) {
      previews.set(preview.id, preview);
    }
  }
  return previews;
}

function renderPrivateFileRef(fileRef: ChannelMessageFileRef): string {
  const line = fileRef.line ? `:${fileRef.line}` : "";
  return `${fileRef.label?.trim() || fileRef.path}${line}`;
}

function hasPrivateAttachmentPromptContent(
  materialization: PrivateChatAttachmentMaterialization | undefined,
): materialization is PrivateChatAttachmentMaterialization & { readonly contentText: string } {
  return Boolean(materialization?.status === "available" && materialization.contentText?.trim());
}

function linkedTaskSource(input: {
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly message: TeammateDirectMessage;
  readonly taskId: string;
  readonly task?: Task;
}): ChannelContextSource {
  return {
    id: `private_ref:task:${input.taskId}`,
    kind: "active_work",
    workspaceId: input.thread.workspaceId,
    channelId: input.task?.channelId,
    teammateId: input.teammate.id,
    sourceRefs: [
      { type: "teammate_direct_message", id: input.message.id, label: "Private message explicit reference" },
      { type: "task", id: input.taskId, label: input.task?.title ?? "Linked task" },
      ...(input.task?.channelId ? [{ type: "channel", id: input.task.channelId, label: "Linked task channel" }] : []),
    ],
    title: input.task?.title ?? "Linked task",
    text: input.task ? boundedText(input.task.prompt, 1_200) : undefined,
    metadata: {
      explicitReference: true,
      entityType: "task",
      taskId: input.taskId,
      status: input.task?.status,
      sourceMessageId: input.message.id,
    },
    sensitivity: "normal",
    freshness: "durable",
  };
}

function linkedRunSource(input: {
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: TeammateDirectThread;
  readonly message: TeammateDirectMessage;
  readonly runId: string;
  readonly run?: RunSession;
}): ChannelContextSource {
  const workflowStep = input.run?.workflowStepId ? input.store.getChannelWorkflowStep(input.run.workflowStepId) : undefined;
  const workflow = workflowStep ? input.store.getChannelWorkflow(workflowStep.workflowId) : undefined;
  const task = input.run ? input.store.getTask(input.run.taskId) : undefined;
  return {
    id: `private_ref:run:${input.runId}`,
    kind: "active_work",
    workspaceId: input.thread.workspaceId,
    channelId: input.run?.channelId ?? task?.channelId ?? workflow?.channelId,
    teammateId: input.teammate.id,
    sourceRefs: [
      { type: "teammate_direct_message", id: input.message.id, label: "Private message explicit reference" },
      { type: "run", id: input.runId, label: "Linked run" },
      ...(task ? [{ type: "task", id: task.id, label: task.title }] : []),
      ...(workflow ? [{ type: "workflow", id: workflow.id, label: workflow.title }] : []),
      ...(workflowStep ? [{ type: "workflow_step", id: workflowStep.id, label: workflowStep.title }] : []),
    ],
    title: runTitle(input.run) ?? "Linked run",
    text: input.run?.errorMessage ? boundedText(input.run.errorMessage, 800) : undefined,
    metadata: {
      explicitReference: true,
      entityType: "run",
      runId: input.runId,
      status: input.run?.status,
      taskId: input.run?.taskId,
      workflowStepId: input.run?.workflowStepId,
      sourceMessageId: input.message.id,
    },
    sensitivity: "normal",
    freshness: "durable",
  };
}

function runTitle(run: RunSession | undefined): string | undefined {
  const snapshot = run?.taskSnapshot;
  if (snapshot && typeof snapshot === "object") {
    const title = (snapshot as { readonly title?: unknown }).title;
    if (typeof title === "string" && title.trim().length > 0) {
      return title.trim();
    }
  }
  return run?.taskId;
}

function boundedText(text: string, maxLength: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 24))}\n[truncated reference]`;
}

function uniqueSources(sources: readonly ChannelContextSource[]): readonly ChannelContextSource[] {
  const seen = new Set<string>();
  const unique: ChannelContextSource[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) {
      continue;
    }
    seen.add(source.id);
    unique.push(source);
  }
  return unique;
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 B";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const sizeKiB = sizeBytes / 1024;
  if (sizeKiB < 1024) {
    return `${sizeKiB.toFixed(sizeKiB >= 10 ? 0 : 1)} KiB`;
  }
  const sizeMiB = sizeKiB / 1024;
  return `${sizeMiB.toFixed(sizeMiB >= 10 ? 0 : 1)} MiB`;
}

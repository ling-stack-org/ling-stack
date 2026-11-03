import { statSync } from "node:fs";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import type {
  Channel,
  ChannelAttachment,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessage,
  ChannelMessageFileRef,
  ChannelStoreFacet,
  RunStorePathsFacet,
} from "@ling-stack/core";
import {
  findAvailableChannelInputMaterializationForSource,
  findChannelInputMaterialization,
  materializationHasPromptContent,
} from "./materialization/cache.js";
import {
  attachmentMaterializationFingerprintCandidates,
  linkPreviewMaterializationFingerprint,
  workspaceFileRefMaterializationFingerprint,
} from "./materialization/fingerprints.js";
import { imageVisionExtractorV1 } from "./materialization/extractors/image.js";
import { linkBodyExtractorV1 } from "./materialization/extractors/link-body.js";
import { officeExtractorV1 } from "./materialization/extractors/office.js";
import { pdfExtractorV1 } from "./materialization/extractors/pdf.js";
import { textAttachmentExtractorV1 } from "./materialization/extractors/text-attachment.js";

export type LingTurnAttachmentPreviewStatus = "available" | "blocked" | "unsupported" | "not_loaded";
export type LingTurnMaterializationStatus = "available" | "metadata_only" | "not_loaded" | "unsupported" | "blocked";

export interface LingTurnAttachmentRef {
  readonly id: string;
  readonly fileName: string;
  readonly kind: ChannelAttachment["kind"] | "other";
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly previewStatus: LingTurnAttachmentPreviewStatus;
  readonly materializationStatus: LingTurnMaterializationStatus;
  readonly materializationId?: string;
  readonly previewText?: string;
  readonly reason?: string;
}

export interface LingTurnLinkPreviewRef {
  readonly id: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly title?: string;
  readonly description?: string;
  readonly siteName?: string;
  readonly status: ChannelLinkPreview["status"] | "missing" | "channel_mismatch";
  readonly materializationStatus: LingTurnMaterializationStatus;
  readonly materializationId?: string;
  readonly previewText?: string;
  readonly reason?: string;
}

export interface LingTurnWorkspaceFileRef {
  readonly path: string;
  readonly label?: string;
  readonly source?: ChannelMessageFileRef["source"];
  readonly line?: number;
  readonly rootRelation: "inside_workspace" | "outside_workspace" | "unknown";
  readonly kind: "file" | "directory" | "glob" | "unknown";
  readonly materializationStatus: LingTurnMaterializationStatus;
  readonly materializationId?: string;
  readonly previewText?: string;
  readonly blockedReason?: string;
}

export interface LingTurnGuidancePayload {
  readonly mode?: string;
  readonly targetRunId?: string;
}

export interface LingAgentTurnEnvelope {
  readonly sourceMessageId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly authorType: ChannelMessage["authorType"];
  readonly authorId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachments: readonly LingTurnAttachmentRef[];
  readonly linkPreviews: readonly LingTurnLinkPreviewRef[];
  readonly fileRefs: readonly LingTurnWorkspaceFileRef[];
  readonly guidancePayload?: LingTurnGuidancePayload;
  readonly activeRunId?: string;
}

export interface BuildLingAgentTurnEnvelopeInput {
  readonly store: LingAgentTurnEnvelopeStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly activeRunId?: string;
  readonly guidancePayload?: LingTurnGuidancePayload;
}

const MAX_LINK_PREVIEW_CHARS = 1_200;
const MAX_FILE_REFS = 8;

type LingAgentTurnEnvelopeStore = ChannelStoreFacet & RunStorePathsFacet;

export function buildLingAgentTurnEnvelope(input: BuildLingAgentTurnEnvelopeInput): LingAgentTurnEnvelope {
  return {
    sourceMessageId: input.sourceMessage.id,
    channelId: input.channel.id,
    threadId: input.sourceMessage.threadId,
    authorType: input.sourceMessage.authorType,
    authorId: input.sourceMessage.authorId,
    body: input.sourceMessage.body,
    mentions: input.sourceMessage.mentions,
    attachments: input.sourceMessage.attachmentIds.map((attachmentId) => buildAttachmentRef(input.store, input.channel.id, attachmentId)),
    linkPreviews: input.sourceMessage.linkPreviewIds.map((linkPreviewId) => buildLinkPreviewRef(input.store, input.channel.id, linkPreviewId)),
    fileRefs: buildWorkspaceFileRefs(input.store, input.channel.id, input.sourceMessage.fileRefs, input.sourceMessage.body),
    guidancePayload: input.guidancePayload,
    activeRunId: input.activeRunId,
  };
}

export function turnEnvelopeHasUserInput(envelope: LingAgentTurnEnvelope): boolean {
  return Boolean(
    envelope.body.trim() ||
      envelope.attachments.length > 0 ||
      envelope.linkPreviews.length > 0 ||
      envelope.fileRefs.length > 0 ||
      envelope.guidancePayload,
  );
}

export function renderLingAgentTurnEnvelopeForPrompt(envelope: LingAgentTurnEnvelope): string {
  const lines = [
    "Turn envelope:",
    envelope.body.trim() ? `Text:\n${envelope.body}` : "Text: none",
    envelope.mentions.length > 0
      ? `Mentions: ${envelope.mentions.map((mention) => `@${mention.label} (${mention.kind}:${mention.id})`).join(", ")}`
      : "Mentions: none",
    renderAttachmentRefsForPrompt(envelope.attachments),
    renderLinkPreviewRefsForPrompt(envelope.linkPreviews),
    renderWorkspaceFileRefsForPrompt(envelope.fileRefs),
    envelope.activeRunId ? `Active run target: ${envelope.activeRunId}` : undefined,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function renderLingAgentTurnEnvelopeSearchText(envelope: LingAgentTurnEnvelope): string {
  return [
    envelope.body,
    ...envelope.attachments.map((attachment) => [
      attachment.fileName,
      attachment.contentType,
      attachment.previewText,
    ].filter(Boolean).join(" ")),
    ...envelope.linkPreviews.map((preview) => [
      preview.title,
      preview.description,
      preview.url,
      preview.previewText,
    ].filter(Boolean).join(" ")),
    ...envelope.fileRefs.map((ref) => [
      ref.label,
      ref.path,
      ref.source,
      ref.line?.toString(),
      ref.rootRelation,
      ref.kind,
      ref.blockedReason,
    ].filter(Boolean).join(" ")),
  ].join("\n").trim();
}

function buildAttachmentRef(store: LingAgentTurnEnvelopeStore, channelId: string, attachmentId: string): LingTurnAttachmentRef {
  const attachment = store.getChannelAttachment(attachmentId);
  if (!attachment) {
    return {
      id: attachmentId,
      fileName: attachmentId,
      kind: "other",
      contentType: "application/octet-stream",
      sizeBytes: 0,
      previewStatus: "blocked",
      materializationStatus: "blocked",
      reason: "Attachment record is missing.",
    };
  }
  if (attachment.channelId !== channelId) {
    return {
      id: attachment.id,
      fileName: attachment.fileName,
      kind: attachment.kind,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      previewStatus: "blocked",
      materializationStatus: "blocked",
      reason: "Attachment belongs to a different channel.",
    };
  }
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    kind: attachment.kind,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    ...materializeAttachmentPreview(store, channelId, attachment),
  };
}

function materializeAttachmentPreview(
  store: LingAgentTurnEnvelopeStore,
  channelId: string,
  attachment: ChannelAttachment,
): Pick<LingTurnAttachmentRef, "previewStatus" | "materializationStatus" | "materializationId" | "previewText" | "reason"> {
  const extractorId = attachmentExtractorIdForKind(attachment.kind);
  const cached = attachmentMaterializationFingerprintCandidates(attachment, { attachmentsDir: store.paths.attachmentsDir })
    .map((sourceFingerprint) => findChannelInputMaterialization({
      store,
      channelId,
      sourceKind: "attachment",
      sourceId: attachment.id,
      sourceFingerprint,
      extractorId,
    }))
    .find(Boolean) ?? findAvailableChannelInputMaterializationForSource({
      store,
      channelId,
      sourceKind: "attachment",
      sourceId: attachment.id,
      extractorId,
    });
  if (cached) {
    return {
      previewStatus: previewStatusForCachedMaterialization(cached.status),
      materializationStatus: cached.status,
      materializationId: cached.id,
      previewText: cached.contentText,
      reason: cached.errorMessage,
    };
  }
  if (attachment.kind !== "text") {
    return {
      previewStatus: "unsupported",
      materializationStatus: "unsupported",
      reason: `${attachment.kind} attachment body is not materialized in this turn envelope.`,
    };
  }
  return {
    previewStatus: "not_loaded",
    materializationStatus: "not_loaded",
    reason: "Text attachment body has not been materialized for this turn envelope.",
  };
}

function attachmentExtractorIdForKind(kind: ChannelAttachment["kind"]): string {
  if (kind === "text") {
    return textAttachmentExtractorV1.id;
  }
  if (kind === "pdf") {
    return pdfExtractorV1.id;
  }
  if (kind === "office") {
    return officeExtractorV1.id;
  }
  return imageVisionExtractorV1.id;
}

function previewStatusForCachedMaterialization(status: LingTurnMaterializationStatus): LingTurnAttachmentPreviewStatus {
  if (status === "available") {
    return "available";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (status === "unsupported") {
    return "unsupported";
  }
  return "not_loaded";
}

function buildLinkPreviewRef(store: LingAgentTurnEnvelopeStore, channelId: string, linkPreviewId: string): LingTurnLinkPreviewRef {
  const preview = store.getChannelLinkPreview(linkPreviewId);
  if (!preview) {
    return {
      id: linkPreviewId,
      url: linkPreviewId,
      normalizedUrl: linkPreviewId,
      status: "missing",
      materializationStatus: "blocked",
      reason: "Link preview record is missing.",
    };
  }
  if (preview.channelId !== channelId) {
    return {
      id: preview.id,
      url: preview.url,
      normalizedUrl: preview.normalizedUrl,
      title: preview.title,
      description: preview.description,
      siteName: preview.siteName,
      status: "channel_mismatch",
      materializationStatus: "blocked",
      reason: "Link preview belongs to a different channel.",
    };
  }
  const cached = findChannelInputMaterialization({
    store,
    channelId,
    sourceKind: "link_preview",
    sourceId: preview.id,
    sourceFingerprint: linkPreviewMaterializationFingerprint(preview),
    extractorId: linkBodyExtractorV1.id,
  });
  return {
    id: preview.id,
    url: preview.url,
    normalizedUrl: preview.normalizedUrl,
    title: preview.title,
    description: preview.description,
    siteName: preview.siteName,
    status: preview.status,
    materializationStatus: cached?.status ?? materializationStatusForLinkPreview(preview),
    materializationId: cached?.id,
    previewText: materializationHasPromptContent(cached) ? cached.contentText : renderLinkPreviewText(preview),
    reason: cached?.errorMessage ?? preview.errorMessage,
  };
}

function renderAttachmentRefsForPrompt(attachments: readonly LingTurnAttachmentRef[]): string {
  if (attachments.length === 0) {
    return "Attachments: none";
  }
  return [
    "Attachments:",
    ...attachments.map((attachment, index) => [
      `- ${index + 1}. ${attachment.fileName} (${attachment.kind}, ${attachment.contentType}, ${attachment.sizeBytes} bytes, materialization=${attachment.materializationStatus}, preview=${attachment.previewStatus})`,
      attachment.reason ? `  statusReason: ${attachment.reason}` : undefined,
      attachment.previewText ? `  preview:\n${indent(attachment.previewText)}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n")),
  ].join("\n");
}

function renderLinkPreviewRefsForPrompt(previews: readonly LingTurnLinkPreviewRef[]): string {
  if (previews.length === 0) {
    return "Link previews: none";
  }
  return [
    "Link previews:",
    ...previews.map((preview, index) => [
      `- ${index + 1}. ${preview.title ?? preview.normalizedUrl} (${preview.status}, materialization=${preview.materializationStatus})`,
      `  url: ${preview.url}`,
      preview.siteName ? `  site: ${preview.siteName}` : undefined,
      preview.description ? `  description: ${preview.description}` : undefined,
      preview.previewText ? `  preview:\n${indent(preview.previewText)}` : undefined,
      preview.reason ? `  statusReason: ${preview.reason}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n")),
  ].join("\n");
}

function renderWorkspaceFileRefsForPrompt(fileRefs: readonly LingTurnWorkspaceFileRef[]): string {
  if (fileRefs.length === 0) {
    return "Workspace file refs: none";
  }
  return [
    "Workspace file refs:",
    ...fileRefs.map((ref, index) => [
      `- ${index + 1}. ${ref.label ? `${ref.label}: ` : ""}${ref.path} (${ref.kind}, ${ref.rootRelation}, materialization=${ref.materializationStatus})`,
      ref.line !== undefined ? `  line: ${ref.line}` : undefined,
      ref.source ? `  source: ${ref.source}` : undefined,
      ref.blockedReason ? `  statusReason: ${ref.blockedReason}` : undefined,
      ref.previewText ? `  preview:\n${indent(ref.previewText)}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n")),
  ].join("\n");
}

function renderLinkPreviewText(preview: ChannelLinkPreview): string | undefined {
  const text = [
    preview.title,
    preview.siteName,
    preview.description,
    preview.normalizedUrl,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return text ? text.slice(0, MAX_LINK_PREVIEW_CHARS) : undefined;
}

function materializationStatusForLinkPreview(preview: ChannelLinkPreview): LingTurnMaterializationStatus {
  if (preview.status !== "ready") {
    return "blocked";
  }
  return renderLinkPreviewText(preview) ? "metadata_only" : "not_loaded";
}

function buildWorkspaceFileRefs(
  store: LingAgentTurnEnvelopeStore,
  channelId: string,
  messageFileRefs: readonly ChannelMessageFileRef[],
  body: string,
): readonly LingTurnWorkspaceFileRef[] {
  const refs: LingTurnWorkspaceFileRef[] = [];
  const seen = new Set<string>();
  for (const fileRef of messageFileRefs) {
    // The composer can recognize command operands, code examples or future
    // output paths for display. Only an explicit reference requests context
    // materialization. Keep lexical tokens in the unchanged body, not in this
    // file-loading lane, and do not stat them relative to the workspace root.
    if (fileRef.source === "inferred_text") continue;
    if (refs.length >= MAX_FILE_REFS) {
      break;
    }
    const rawPath = fileRef.path.trim();
    if (!rawPath) {
      continue;
    }
    const key = workspaceFileRefKey(rawPath, fileRef.line);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(buildWorkspaceFileRef(store, channelId, {
      path: rawPath,
      label: fileRef.label,
      source: fileRef.source ?? "composer",
      line: fileRef.line,
    }));
  }
  const matcher = /\b(?:file|path):([^\s,;]+)/giu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(body)) !== null && refs.length < MAX_FILE_REFS) {
    const rawPath = stripTrailingPathPunctuation(match[1] ?? "");
    const key = workspaceFileRefKey(rawPath);
    if (!rawPath || seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(buildWorkspaceFileRef(store, channelId, {
      path: rawPath,
      label: rawPath,
      source: "explicit_text",
    }));
  }
  return refs;
}

function buildWorkspaceFileRef(
  store: LingAgentTurnEnvelopeStore,
  channelId: string,
  input: Pick<ChannelMessageFileRef, "path" | "label" | "source" | "line">,
): LingTurnWorkspaceFileRef {
  const normalizedPath = input.path.trim();
  const absolutePath = isAbsolute(normalizedPath) ? resolvePath(normalizedPath) : resolvePath(store.paths.cwd, normalizedPath);
  const rootRelation = workspaceRootRelation(store.paths.cwd, absolutePath);
  if (rootRelation === "outside_workspace") {
    return {
      path: normalizedPath,
      label: input.label ?? normalizedPath,
      source: input.source,
      line: input.line,
      rootRelation,
      kind: pathLooksLikeGlob(normalizedPath) ? "glob" : "unknown",
      materializationStatus: "blocked",
      blockedReason: "Workspace file ref points outside the active workspace.",
    };
  }
  const kind = resolveWorkspaceFileRefKind(absolutePath, normalizedPath);
  return withWorkspaceFileRefMaterialization(store, channelId, {
    path: normalizedPath,
    label: input.label ?? normalizedPath,
    source: input.source,
    line: input.line,
    rootRelation,
    kind,
    materializationStatus: kind === "unknown" ? "not_loaded" : "metadata_only",
    ...(kind === "unknown" ? { blockedReason: "Workspace file ref metadata could not be resolved." } : {}),
  });
}

function withWorkspaceFileRefMaterialization(
  store: LingAgentTurnEnvelopeStore,
  channelId: string,
  ref: LingTurnWorkspaceFileRef,
): LingTurnWorkspaceFileRef {
  const cached = findChannelInputMaterialization({
    store,
    channelId,
    sourceKind: "workspace_file_ref",
    sourceId: ref.path,
    sourceFingerprint: workspaceFileRefMaterializationFingerprint(ref),
  });
  if (!cached) {
    return ref;
  }
  return {
    ...ref,
    materializationStatus: cached.status,
    materializationId: cached.id,
    previewText: cached.contentText,
    blockedReason: cached.errorMessage ?? ref.blockedReason,
  };
}

function workspaceFileRefKey(path: string, line?: number): string {
  return `${path}\0${line ?? ""}`;
}

function workspaceRootRelation(workspaceCwd: string, absolutePath: string): LingTurnWorkspaceFileRef["rootRelation"] {
  const relation = relativePath(resolvePath(workspaceCwd), absolutePath);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation)) ? "inside_workspace" : "outside_workspace";
}

function resolveWorkspaceFileRefKind(absolutePath: string, rawPath: string): LingTurnWorkspaceFileRef["kind"] {
  if (pathLooksLikeGlob(rawPath)) {
    return "glob";
  }
  try {
    const stat = statSync(absolutePath);
    if (stat.isFile()) {
      return "file";
    }
    if (stat.isDirectory()) {
      return "directory";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function pathLooksLikeGlob(value: string): boolean {
  return /[*?[\]{}]/u.test(value);
}

function stripTrailingPathPunctuation(value: string): string {
  return value.replace(/[)\].,，。；;:]+$/u, "");
}

function indent(value: string): string {
  return value.split(/\r?\n/u).map((line) => `    ${line}`).join("\n");
}

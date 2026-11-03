import type { SQLOutputValue } from "node:sqlite";
import {
  type RunIntervention,
  type RunInterventionAttachmentPayload,
  type RunInterventionLinkPreviewPayload,
  type RunInterventionMaterializationStatus,
  type RunInterventionMessagePayload,
  type RunInterventionMode,
  type RunInterventionStatus,
  type RunInterventionWorkspaceFilePayload,
} from "../../run-types.js";
import {
  type TeammateDirectReplyIntervention,
  type TeammateDirectReplyInterventionMessagePayload,
  type TeammateDirectReplyInterventionMode,
  type TeammateDirectReplyInterventionStatus,
} from "../../workspace-types.js";
import {
  isRecord,
  omitUndefined,
  parseJson,
  readNullableString,
  readString,
  stringifyJson,
} from "./helpers.js";
import {
  isChannelMessageFileRefSource,
  normalizeChannelMessageFileRefs,
  parseChannelMessageFileRefs,
} from "./channel-message-parsers.js";

export function mapRunIntervention(row: Record<string, SQLOutputValue>): RunIntervention {
  const instruction = readString(row, "instruction");
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    sourceRunId: readString(row, "source_run_id"),
    sourceWorkUnitId: readNullableString(row, "source_work_unit_id"),
    sourceAttemptId: readNullableString(row, "source_attempt_id"),
    continuationRunId: readNullableString(row, "continuation_run_id"),
    continuationWorkUnitId: readNullableString(row, "continuation_work_unit_id"),
    mode: readString(row, "mode") as RunInterventionMode,
    status: readString(row, "status") as RunInterventionStatus,
    instruction,
    messagePayload: parseRunInterventionMessagePayload(readNullableString(row, "message_payload_json"), instruction),
    requestedBy: readString(row, "requested_by") as RunIntervention["requestedBy"],
    idempotencyKey: readString(row, "idempotency_key"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    startedAt: readNullableString(row, "started_at"),
    completedAt: readNullableString(row, "completed_at"),
    failureReason: readNullableString(row, "failure_reason"),
  });
}

export function mapTeammateDirectReplyIntervention(row: Record<string, SQLOutputValue>): TeammateDirectReplyIntervention {
  const instruction = readString(row, "instruction");
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    threadId: readString(row, "thread_id"),
    sourceMessageId: readString(row, "source_message_id"),
    sourceWorkUnitId: readNullableString(row, "source_work_unit_id"),
    sourceAttemptId: readNullableString(row, "source_attempt_id"),
    mode: readString(row, "mode") as TeammateDirectReplyInterventionMode,
    status: readString(row, "status") as TeammateDirectReplyInterventionStatus,
    instruction,
    messagePayload: parseTeammateDirectReplyInterventionMessagePayload(readNullableString(row, "message_payload_json"), instruction),
    idempotencyKey: readString(row, "idempotency_key"),
    requestedBy: readString(row, "requested_by") as TeammateDirectReplyIntervention["requestedBy"],
    continuationMessageId: readNullableString(row, "continuation_message_id"),
    continuationWorkUnitId: readNullableString(row, "continuation_work_unit_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    startedAt: readNullableString(row, "started_at"),
    completedAt: readNullableString(row, "completed_at"),
    failureReason: readNullableString(row, "failure_reason"),
  });
}

export function normalizeRunInterventionMessagePayload(payload: RunInterventionMessagePayload): RunInterventionMessagePayload {
  const attachments = normalizeRunInterventionAttachmentPayloads(payload.attachments);
  const linkPreviews = normalizeRunInterventionLinkPreviewPayloads(payload.linkPreviews);
  const fileRefs = normalizeRunInterventionWorkspaceFilePayloads(payload.fileRefs);
  return {
    ...(payload.sourceMessageId?.trim() ? { sourceMessageId: payload.sourceMessageId.trim() } : {}),
    ...(payload.targetTeammateId?.trim() ? { targetTeammateId: payload.targetTeammateId.trim() } : {}),
    body: payload.body.trim(),
    attachmentIds: normalizeStringList(payload.attachmentIds),
    linkPreviewIds: normalizeStringList(payload.linkPreviewIds),
    ...(attachments ? { attachments } : {}),
    ...(linkPreviews ? { linkPreviews } : {}),
    ...(fileRefs ? { fileRefs } : {}),
  };
}

export function normalizeTeammateDirectReplyInterventionMessagePayload(
  payload: TeammateDirectReplyInterventionMessagePayload,
): TeammateDirectReplyInterventionMessagePayload {
  const fileRefs = normalizeChannelMessageFileRefs(payload.fileRefs);
  return {
    body: payload.body.trim(),
    attachmentIds: normalizeStringList(payload.attachmentIds ?? []),
    linkPreviewIds: normalizeStringList(payload.linkPreviewIds ?? []),
    ...(fileRefs.length > 0 ? { fileRefs } : {}),
  };
}

function normalizeRunInterventionAttachmentPayloads(
  attachments: readonly RunInterventionAttachmentPayload[] | undefined,
): readonly RunInterventionAttachmentPayload[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    id: attachment.id.trim(),
    fileName: attachment.fileName.trim() || attachment.id.trim(),
    kind: attachment.kind,
    contentType: attachment.contentType.trim() || "application/octet-stream",
    sizeBytes: Math.max(0, Math.trunc(attachment.sizeBytes)),
    materializationStatus: attachment.materializationStatus,
    ...(attachment.previewStatus?.trim() ? { previewStatus: attachment.previewStatus.trim() } : {}),
    ...(attachment.previewText ? { previewText: attachment.previewText } : {}),
    ...(attachment.reason?.trim() ? { reason: attachment.reason.trim() } : {}),
  }));
}

function normalizeRunInterventionLinkPreviewPayloads(
  linkPreviews: readonly RunInterventionLinkPreviewPayload[] | undefined,
): readonly RunInterventionLinkPreviewPayload[] | undefined {
  if (!linkPreviews || linkPreviews.length === 0) {
    return undefined;
  }
  return linkPreviews.map((preview) => ({
    id: preview.id.trim(),
    url: preview.url.trim() || preview.normalizedUrl.trim() || preview.id.trim(),
    normalizedUrl: preview.normalizedUrl.trim() || preview.url.trim() || preview.id.trim(),
    ...(preview.title?.trim() ? { title: preview.title.trim() } : {}),
    ...(preview.description?.trim() ? { description: preview.description.trim() } : {}),
    ...(preview.siteName?.trim() ? { siteName: preview.siteName.trim() } : {}),
    status: preview.status,
    materializationStatus: preview.materializationStatus,
    ...(preview.previewText ? { previewText: preview.previewText } : {}),
    ...(preview.reason?.trim() ? { reason: preview.reason.trim() } : {}),
  }));
}

function normalizeRunInterventionWorkspaceFilePayloads(
  fileRefs: readonly RunInterventionWorkspaceFilePayload[] | undefined,
): readonly RunInterventionWorkspaceFilePayload[] | undefined {
  if (!fileRefs || fileRefs.length === 0) {
    return undefined;
  }
  return fileRefs.map((ref) => ({
    path: ref.path.trim(),
    ...(ref.label?.trim() ? { label: ref.label.trim() } : {}),
    ...(ref.source && isChannelMessageFileRefSource(ref.source) ? { source: ref.source } : {}),
    rootRelation: readRunInterventionWorkspaceFileRootRelation(ref.rootRelation),
    kind: readRunInterventionWorkspaceFileKind(ref.kind),
    materializationStatus: ref.materializationStatus,
    ...(ref.previewText ? { previewText: ref.previewText } : {}),
    ...(ref.blockedReason?.trim() ? { blockedReason: ref.blockedReason.trim() } : {}),
  }));
}

function parseRunInterventionMessagePayload(value: string | undefined, instruction: string): RunInterventionMessagePayload {
  if (!value) {
    return {
      body: instruction,
      attachmentIds: [],
      linkPreviewIds: [],
    };
  }
  const parsed = parseJson(value);
  if (!isRecord(parsed)) {
    throw new Error("Expected run intervention message payload from SQLite");
  }
  const body = typeof parsed.body === "string" ? parsed.body : instruction;
  const sourceMessageId = typeof parsed.sourceMessageId === "string" ? parsed.sourceMessageId : undefined;
  const targetTeammateId = typeof parsed.targetTeammateId === "string" ? parsed.targetTeammateId : undefined;
  const attachmentIds = Array.isArray(parsed.attachmentIds) ? parsed.attachmentIds : [];
  const linkPreviewIds = Array.isArray(parsed.linkPreviewIds) ? parsed.linkPreviewIds : [];
  if (attachmentIds.some((item) => typeof item !== "string") || linkPreviewIds.some((item) => typeof item !== "string")) {
    throw new Error("Expected run intervention message payload ids from SQLite");
  }
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments.map(parseRunInterventionAttachmentPayload) : undefined;
  const linkPreviews = Array.isArray(parsed.linkPreviews) ? parsed.linkPreviews.map(parseRunInterventionLinkPreviewPayload) : undefined;
  const fileRefs = Array.isArray(parsed.fileRefs) ? parsed.fileRefs.map(parseRunInterventionWorkspaceFilePayload) : undefined;
  return normalizeRunInterventionMessagePayload({
    sourceMessageId,
    targetTeammateId,
    body,
    attachmentIds: attachmentIds as string[],
    linkPreviewIds: linkPreviewIds as string[],
    attachments,
    linkPreviews,
    fileRefs,
  });
}

function parseRunInterventionAttachmentPayload(value: unknown): RunInterventionAttachmentPayload {
  if (!isRecord(value)) {
    throw new Error("Expected run intervention attachment payload object from SQLite");
  }
  const id = readPayloadString(value, "id");
  const materializationStatus = readRunInterventionMaterializationStatus(value.materializationStatus);
  const previewStatus = readPayloadOptionalString(value, "previewStatus");
  const previewText = readPayloadOptionalString(value, "previewText");
  const reason = readPayloadOptionalString(value, "reason");
  return {
    id,
    fileName: readPayloadOptionalString(value, "fileName") ?? id,
    kind: readRunInterventionAttachmentKind(value.kind),
    contentType: readPayloadOptionalString(value, "contentType") ?? "application/octet-stream",
    sizeBytes: readPayloadNonNegativeNumber(value, "sizeBytes"),
    materializationStatus,
    ...(previewStatus ? { previewStatus } : {}),
    ...(previewText ? { previewText } : {}),
    ...(reason ? { reason } : {}),
  };
}

function parseRunInterventionLinkPreviewPayload(value: unknown): RunInterventionLinkPreviewPayload {
  if (!isRecord(value)) {
    throw new Error("Expected run intervention link preview payload object from SQLite");
  }
  const id = readPayloadString(value, "id");
  const url = readPayloadOptionalString(value, "url") ?? id;
  const normalizedUrl = readPayloadOptionalString(value, "normalizedUrl") ?? url;
  const title = readPayloadOptionalString(value, "title");
  const description = readPayloadOptionalString(value, "description");
  const siteName = readPayloadOptionalString(value, "siteName");
  const previewText = readPayloadOptionalString(value, "previewText");
  const reason = readPayloadOptionalString(value, "reason");
  return {
    id,
    url,
    normalizedUrl,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    status: readRunInterventionLinkPreviewStatus(value.status),
    materializationStatus: readRunInterventionMaterializationStatus(value.materializationStatus),
    ...(previewText ? { previewText } : {}),
    ...(reason ? { reason } : {}),
  };
}

function parseRunInterventionWorkspaceFilePayload(value: unknown): RunInterventionWorkspaceFilePayload {
  if (!isRecord(value)) {
    throw new Error("Expected run intervention workspace file payload object from SQLite");
  }
  const label = readPayloadOptionalString(value, "label");
  const previewText = readPayloadOptionalString(value, "previewText");
  const blockedReason = readPayloadOptionalString(value, "blockedReason");
  const source = readPayloadOptionalString(value, "source");
  return {
    path: readPayloadString(value, "path"),
    ...(label ? { label } : {}),
    ...(source && isChannelMessageFileRefSource(source) ? { source } : {}),
    rootRelation: readRunInterventionWorkspaceFileRootRelation(value.rootRelation),
    kind: readRunInterventionWorkspaceFileKind(value.kind),
    materializationStatus: readRunInterventionMaterializationStatus(value.materializationStatus),
    ...(previewText ? { previewText } : {}),
    ...(blockedReason ? { blockedReason } : {}),
  };
}

function parseTeammateDirectReplyInterventionMessagePayload(
  value: string | undefined,
  instruction: string,
): TeammateDirectReplyInterventionMessagePayload {
  if (!value) {
    return {
      body: instruction,
      attachmentIds: [],
      linkPreviewIds: [],
    };
  }
  const parsed = parseJson(value);
  if (!isRecord(parsed)) {
    throw new Error("Expected teammate direct reply intervention message payload from SQLite");
  }
  const body = typeof parsed.body === "string" ? parsed.body : instruction;
  const attachmentIds = Array.isArray(parsed.attachmentIds) ? parsed.attachmentIds : [];
  const linkPreviewIds = Array.isArray(parsed.linkPreviewIds) ? parsed.linkPreviewIds : [];
  if (attachmentIds.some((item) => typeof item !== "string") || linkPreviewIds.some((item) => typeof item !== "string")) {
    throw new Error("Expected teammate direct reply intervention payload ids from SQLite");
  }
  const fileRefs = Array.isArray(parsed.fileRefs) ? parseChannelMessageFileRefs(stringifyJson(parsed.fileRefs)) : [];
  return normalizeTeammateDirectReplyInterventionMessagePayload({
    body,
    attachmentIds: attachmentIds as string[],
    linkPreviewIds: linkPreviewIds as string[],
    fileRefs,
  });
}

function readPayloadString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty ${key} in run intervention payload`);
  }
  return value.trim();
}

function readPayloadOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPayloadNonNegativeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function readRunInterventionMaterializationStatus(value: unknown): RunInterventionMaterializationStatus {
  if (value === "available" || value === "metadata_only" || value === "not_loaded" || value === "unsupported" || value === "blocked") {
    return value;
  }
  return "metadata_only";
}

function readRunInterventionAttachmentKind(value: unknown): RunInterventionAttachmentPayload["kind"] {
  return value === "image" || value === "pdf" || value === "office" || value === "text" || value === "other" ? value : "other";
}

function readRunInterventionLinkPreviewStatus(value: unknown): RunInterventionLinkPreviewPayload["status"] {
  return value === "ready" || value === "blocked" || value === "failed" || value === "missing" || value === "channel_mismatch" ? value : "missing";
}

function readRunInterventionWorkspaceFileRootRelation(value: unknown): RunInterventionWorkspaceFilePayload["rootRelation"] {
  return value === "inside_workspace" || value === "outside_workspace" || value === "unknown" ? value : "unknown";
}

function readRunInterventionWorkspaceFileKind(value: unknown): RunInterventionWorkspaceFilePayload["kind"] {
  return value === "file" || value === "directory" || value === "glob" || value === "unknown" ? value : "unknown";
}

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item.toLowerCase())) {
      continue;
    }
    seen.add(item.toLowerCase());
    normalized.push(item);
  }
  return normalized;
}

import type { Translate } from "../../i18n.js";
import { composerWorkspaceFileParts, createLocalComposerAssetId, type PendingAttachmentItem } from "../../shared/components/index.js";
import type {
  AiTeammate,
  ChannelMessageFileRef,
  DirectWorkspaceResponse,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  TeammatePrivateAttachment,
} from "../../types.js";

export interface TeammateSettingsForm {
  readonly displayName: string;
  readonly description: string;
  readonly modelBindingMode: AiTeammate["modelBindingMode"];
  readonly providerPresetId: string;
  readonly status: AiTeammate["status"];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly systemPrompt: string;
  readonly appendSystemPromptText: string;
}

export function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeManualSkillId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const urlSkillId = parseSkillIdFromUrl(trimmed);
  const candidate = urlSkillId || trimmed;
  return candidate
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function parseSkillIdFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return [url.hostname, ...segments.slice(-2)].join("/");
  } catch {
    return "";
  }
}

export function teammateToSettingsForm(teammate: AiTeammate): TeammateSettingsForm {
  return {
    displayName: teammate.displayName,
    description: teammate.description,
    modelBindingMode: teammate.modelBindingMode,
    providerPresetId: teammate.providerPresetId ?? "",
    status: teammate.status,
    pinned: teammate.pinned,
    hidden: teammate.hidden,
    systemPrompt: teammate.systemPrompt ?? "",
    appendSystemPromptText: teammate.appendSystemPrompt.join("\n\n"),
  };
}

export function splitAdditionalInstructions(value: string): readonly string[] {
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

export function upsertDirectMessages(
  current: readonly TeammateDirectMessage[],
  nextMessages: readonly TeammateDirectMessage[],
): readonly TeammateDirectMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of nextMessages) {
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function uniqueDirectLinkPreviews(previews: readonly TeammateDirectLinkPreview[]): readonly TeammateDirectLinkPreview[] {
  const byId = new Map<string, TeammateDirectLinkPreview>();
  for (const preview of previews) {
    byId.set(preview.id, preview);
  }
  return [...byId.values()];
}

export function directComposerFileRefs(parts: ReturnType<typeof composerWorkspaceFileParts>): readonly ChannelMessageFileRef[] {
  return parts.map((part) => ({
    path: part.path,
    source: "inferred_text" as const,
    ...(part.line ? { line: part.line } : {}),
  }));
}

export function directFileRefLabel(fileRef: ChannelMessageFileRef): string {
  const line = fileRef.line ? `:${fileRef.line}` : "";
  return `${fileRef.label?.trim() || fileRef.path}${line}`;
}

export function directGuidanceDraftText(payload: NonNullable<TeammateDirectReplyIntervention["messagePayload"]>): string {
  const body = payload.body.trim();
  const missingFileTokens = (payload.fileRefs ?? [])
    .filter((fileRef) => !body.includes(fileRef.path))
    .map((fileRef) => fileRef.line ? `${fileRef.path}:${fileRef.line}` : fileRef.path);
  return [payload.body, ...missingFileTokens].filter((part) => part.trim()).join("\n");
}

export function pendingAttachmentItemsFromIds(
  attachmentIds: readonly string[],
  attachmentById: ReadonlyMap<string, TeammatePrivateAttachment>,
): readonly PendingAttachmentItem<TeammatePrivateAttachment>[] {
  return attachmentIds
    .map((attachmentId) => attachmentById.get(attachmentId))
    .filter((attachment): attachment is TeammatePrivateAttachment => Boolean(attachment))
    .map((attachment) => ({
      localId: createLocalComposerAssetId("attachment"),
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      state: "ready" as const,
      attachment,
    }));
}

export function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[),.;!?]+$/u, "")))];
}

export function directWorkspaceStatusLabel(workspace: DirectWorkspaceResponse | undefined, t: Translate): string {
  const status = workspace?.binding.status;
  if (status === "ready") {
    return t("Ready");
  }
  if (status === "missing") {
    return t("Missing");
  }
  if (status === "blocked" || status === "unsupported") {
    return t("Blocked");
  }
  return t("Not created");
}

export function directWorkspacePathLabel(workspace: DirectWorkspaceResponse | undefined, t: Translate): string {
  if (!workspace || workspace.binding.status === "not_created") {
    return t("Worktree will be created when this private chat first runs.");
  }
  const snapshot = workspace?.snapshot;
  const executionCwd = snapshot?.executionCwd || workspace?.binding.executionPath || workspace?.binding.worktreePath;
  if (!executionCwd) {
    return t("Worktree will be created when this private chat first runs.");
  }
  const label = shortWorkspacePath(executionCwd);
  if ((workspace?.binding.mode ?? "managed_worktree") === "managed_worktree") {
    return `${t("Worktree")} ${label}`;
  }
  if (workspace?.binding.mode === "external_path") {
    return `${t("External")} ${label}`;
  }
  return `${t("Local")} ${label}`;
}

function shortWorkspacePath(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.length <= 3 ? path : `.../${parts.slice(-3).join("/")}`;
}

export function teammateDirectInterventionStatusLabel(status: TeammateDirectReplyIntervention["status"], t: Translate): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "cancelling_source":
      return t("Stopping");
    case "starting_continuation":
      return t("Continuing");
    case "started":
      return t("Continued with new guidance");
    case "cancelled":
      return t("Cancelled");
    case "failed":
      return t("Guidance failed");
  }
}

export function teammateDirectInterventionModeLabel(mode: TeammateDirectReplyIntervention["mode"], t: Translate): string {
  switch (mode) {
    case "queue_followup":
      return t("Continue after reply");
    case "interrupt_redirect":
      return t("Stop and continue");
  }
}

export function summarizeDirectGuidancePayload(
  payload: {
    readonly body: string;
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds?: readonly string[];
    readonly fileRefs?: readonly ChannelMessageFileRef[];
  },
  t: Translate,
): string {
  if (payload.body.trim()) {
    return payload.body.trim();
  }
  if (payload.fileRefs?.length) {
    return t("Queued guidance with {count} file reference(s)", { count: payload.fileRefs.length });
  }
  if ((payload.linkPreviewIds?.length ?? 0) > 0) {
    return t("Queued guidance with {count} link(s)", { count: payload.linkPreviewIds?.length ?? 0 });
  }
  if (payload.attachmentIds.length > 0) {
    return t("Queued guidance with {count} attachment(s)", { count: payload.attachmentIds.length });
  }
  return t("Queued guidance");
}

export function isHistoricalProviderPreflightMessage(message: TeammateDirectMessage): boolean {
  if (message.status !== "blocked") {
    return false;
  }
  const text = `${message.body} ${message.errorMessage ?? ""}`.toLowerCase();
  return (
    (text.includes("provider_preflight_failed") ||
      text.includes("provider check failed") ||
      text.includes("provider has not been checked")) &&
    (text.includes("network_failed") || text.includes("timeout") || text.includes("aborted"))
  );
}

import type { Translate } from "../../i18n.js";
import { composerWorkspaceFileParts, createLocalComposerAssetId, type PendingAttachmentItem } from "../../shared/components/index.js";
import type {
  AiTeammate,
  Channel,
  ChannelMessageFileRef,
  DirectWorkspaceResponse,
  EffectiveTeammateSkill,
  MemoryHealthReport,
  MemoryObject,
  MemoryReviewAction,
  MemoryReviewMode,
  SkillSourceSnapshot,
  TeammateDirectLinkPreview,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  TeammatePrivateAttachment,
  TeammateSkillBinding,
} from "../../types.js";

export interface TeammateSettingsForm {
  readonly displayName: string;
  readonly description: string;
  readonly providerPresetId: string;
  readonly status: AiTeammate["status"];
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly systemPrompt: string;
  readonly appendSystemPromptText: string;
}

export interface TeammateSkillRowModel {
  readonly id: string;
  readonly skill: import("@ling-stack/core/skill-types").SkillDefinition | undefined;
  readonly binding: TeammateSkillBinding | undefined;
  readonly effectiveSkill: EffectiveTeammateSkill | undefined;
  readonly sourceSnapshot: SkillSourceSnapshot | undefined;
}

export type SkillBindingFilter = "all" | "bound" | "executable" | "blocked" | "available";

export function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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

export function filterTeammateSkillRows(
  rows: readonly TeammateSkillRowModel[],
  searchQuery: string,
  filter: SkillBindingFilter,
): readonly TeammateSkillRowModel[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return rows
    .filter((row) => {
      if (filter === "bound" && !row.binding?.enabled) {
        return false;
      }
      if (filter === "executable" && !row.effectiveSkill?.executable) {
        return false;
      }
      if (filter === "blocked" && (!row.binding?.enabled || row.effectiveSkill?.executable)) {
        return false;
      }
      if (filter === "available" && row.binding) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const searchable = [
        row.id,
        row.skill?.name ?? "",
        row.skill?.summary ?? "",
        row.skill?.workflowPhase ?? "",
        ...(row.skill?.requiredTools ?? []),
        ...(row.skill?.requiredProviderCapabilities ?? []),
        row.sourceSnapshot?.sourcePath ?? "",
        row.sourceSnapshot?.upstreamSkillPath ?? "",
        row.sourceSnapshot?.sourceChecksum ?? "",
        ...(row.sourceSnapshot?.warnings.map((warning) => `${warning.code} ${warning.message}`) ?? []),
        ...(row.effectiveSkill?.blockedReasons.map((reason) => `${reason.code} ${reason.message} ${(reason.missing ?? []).join(" ")}`) ?? []),
      ].join(" ").toLowerCase();
      return searchable.includes(normalizedQuery);
    })
    .sort((left, right) => {
      const leftBoundRank = left.binding?.enabled ? 0 : left.binding ? 1 : 2;
      const rightBoundRank = right.binding?.enabled ? 0 : right.binding ? 1 : 2;
      if (leftBoundRank !== rightBoundRank) {
        return leftBoundRank - rightBoundRank;
      }
      return (left.skill?.name ?? left.id).localeCompare(right.skill?.name ?? right.id);
    });
}

export function teammateSkillFilterLabel(filter: SkillBindingFilter, t: Translate): string {
  if (filter === "bound") {
    return t("Bound");
  }
  if (filter === "executable") {
    return t("Executable");
  }
  if (filter === "blocked") {
    return t("Blocked");
  }
  if (filter === "available") {
    return t("Bindable");
  }
  return t("All");
}

export function skillExecutionState(
  binding: TeammateSkillBinding | undefined,
  effectiveSkill: EffectiveTeammateSkill | undefined,
  t: Translate,
): { readonly label: string; readonly tone: "executable" | "blocked" | "disabled" | "available" } {
  if (!binding) {
    return { label: t("Bindable"), tone: "available" };
  }
  if (!binding.enabled) {
    return { label: t("Disabled"), tone: "disabled" };
  }
  if (effectiveSkill?.executable) {
    return { label: t("Executable"), tone: "executable" };
  }
  return { label: t("Blocked"), tone: "blocked" };
}

export function memoryOwnerLabel(memory: MemoryObject, channelsById: ReadonlyMap<string, Channel>, teammate: AiTeammate, t: Translate): string {
  if (memory.scopeType === "channel") {
    return channelsById.get(memory.ownerId)?.name ?? memory.ownerId;
  }
  if (memory.scopeType === "teammate" && memory.ownerId === teammate.id) {
    return teammate.displayName;
  }
  if (memory.scopeType === "workspace") {
    return t("Workspace");
  }
  return memory.ownerId;
}

export function truncateMemoryBody(value: string, limit = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

export function memoryReviewModeDescription(mode: MemoryReviewMode): string {
  switch (mode) {
    case "conservative":
      return "Most extracted memories stay candidates until reviewed.";
    case "balanced":
      return "Low-risk same-scope memories can become active; high-impact items still need review.";
    case "fast":
      return "Same-scope memories auto-activate more often; cross-scope and sensitive items still need review.";
  }
}

export function memoryReviewActionMessage(action: MemoryReviewAction): string {
  switch (action) {
    case "approve":
      return "Memory approved";
    case "edit_and_approve":
      return "Memory edited and approved";
    case "keep_candidate":
      return "Memory kept as candidate";
    case "reject":
      return "Memory rejected";
    case "archive":
      return "Memory archived";
    case "quarantine":
      return "Memory quarantined";
  }
}

export function memoryHealthStatus(report: MemoryHealthReport | undefined): string {
  if (!report) {
    return "optional";
  }
  if (report.summary.findings.critical > 0) {
    return "failed";
  }
  if (report.summary.findings.warning > 0) {
    return "paused";
  }
  return "active";
}

export function memoryHealthFindingTitle(kind: MemoryHealthReport["findings"][number]["kind"]): string {
  switch (kind) {
    case "missing_source_refs":
      return "Missing source";
    case "expired_candidate":
      return "Expired candidate";
    case "volatile_without_verify_before_use":
      return "Needs verification";
    case "duplicate_candidate":
      return "Duplicate candidate";
    case "superseded_active_memory":
      return "Superseded active memory";
    case "secret_adjacent_recallable":
      return "Secret-adjacent recall";
    case "authority_changing_claim":
      return "Authority-changing claim";
    case "stale_candidate":
      return "Stale candidate";
    case "high_review_backlog":
      return "High review backlog";
  }
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
    source: "composer" as const,
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

import type {
  ChannelSessionListResponse,
  ChannelSessionSummary,
  CreateChannelSessionRequest,
  UpdateChannelSessionRequest,
} from "./channel-sessions.js";

const summaryKeys = new Set(["id", "channelId", "legacyBranchId", "title", "isDefault", "surfaceKind",
  "createdAt", "activityAt", "archivedAt", "latestNotificationRevision", "pendingApprovalCount", "activeRunIds", "pendingApprovalIds", "runtimeState"]);
const runtimeStates = new Set(["idle", "queued", "running", "waiting", "blocked", "failed"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function only(value: unknown, keys: ReadonlySet<string>): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => keys.has(key));
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function title(value: unknown): value is string { return text(value) && [...value.trim()].length <= 120; }

export function isCreateChannelSessionRequest(value: unknown): value is CreateChannelSessionRequest {
  return only(value, new Set(["title", "idempotencyKey"]))
    && text(value.idempotencyKey) && value.idempotencyKey.length <= 256
    && (value.title === undefined || title(value.title));
}

export function isUpdateChannelSessionRequest(value: unknown): value is UpdateChannelSessionRequest {
  return only(value, new Set(["title", "archived"]))
    && (value.title !== undefined || value.archived !== undefined)
    && (value.title === undefined || title(value.title))
    && (value.archived === undefined || typeof value.archived === "boolean");
}

export function isChannelSessionSummary(value: unknown): value is ChannelSessionSummary {
  if (!only(value, summaryKeys) || !text(value.id) || !text(value.channelId) || !text(value.title)
    || typeof value.isDefault !== "boolean" || !timestamp(value.createdAt) || !timestamp(value.activityAt)
    || (value.archivedAt !== undefined && !timestamp(value.archivedAt))
    || !count(value.latestNotificationRevision) || !count(value.pendingApprovalCount)
    || !ids(value.activeRunIds) || !ids(value.pendingApprovalIds)
    || value.pendingApprovalCount !== value.pendingApprovalIds.length
    || !runtimeStates.has(value.runtimeState as string)) return false;
  if (value.isDefault) return value.surfaceKind === "channel_root" && value.legacyBranchId === undefined;
  return (value.surfaceKind === "channel_session" || value.surfaceKind === "branch") && text(value.legacyBranchId);
}

export function isChannelSessionListResponse(value: unknown): value is ChannelSessionListResponse {
  if (!only(value, new Set(["cwd", "channelId", "defaultSession", "sessions", "nextCursor", "diagnostics",
    "notificationWatermarks", "aggregate"])) || !text(value.cwd) || !text(value.channelId)
    || (value.nextCursor !== undefined && !text(value.nextCursor))
    || (value.defaultSession !== undefined && (!isChannelSessionSummary(value.defaultSession)
      || !value.defaultSession.isDefault || value.defaultSession.channelId !== value.channelId))
    || !Array.isArray(value.sessions) || !value.sessions.every((s) => isChannelSessionSummary(s)
      && !s.isDefault && s.channelId === value.channelId)
    || new Set(value.sessions.map((s) => s.id)).size !== value.sessions.length
    || !Array.isArray(value.diagnostics) || !value.diagnostics.every((d) => only(d, new Set(["branchId", "code"]))
      && text(d.branchId) && text(d.code))
    || !Array.isArray(value.notificationWatermarks) || !value.notificationWatermarks.every((w) =>
      only(w, new Set(["id", "latestNotificationRevision"])) && text(w.id) && count(w.latestNotificationRevision))
    || new Set(value.notificationWatermarks.map((w) => w.id)).size !== value.notificationWatermarks.length
    || !only(value.aggregate, new Set(["pendingApprovalCount", "runningCount", "waitingCount", "failedCount"]))) return false;
  const aggregate = value.aggregate;
  return ["pendingApprovalCount", "runningCount", "waitingCount", "failedCount"].every((key) => count(aggregate[key]));
}

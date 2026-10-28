import type { Translate } from "../../i18n.js";
import type {
  AiTeammate,
  Channel,
  MemoryHealthFinding,
  MemoryHealthReport,
  MemoryMarkdownImportPlan,
  MemoryObject,
  MemoryPromotionInboxItem,
  MemoryReviewAction,
  MemoryReviewPolicy,
  TeammateMemoryScope,
  UsedMemoryEvent,
} from "../../types.js";

export type MemoryStatusTone = "neutral" | "success" | "warning" | "danger" | "info";
export type MemoryTransferBusy = "" | "export" | "preview" | "import";

export interface MemoryReviewEditForm {
  readonly title: string;
  readonly body: string;
  readonly sensitivity: MemoryObject["sensitivity"];
}

export interface TeammateMemorySnapshot {
  readonly scopes: readonly TeammateMemoryScope[];
  readonly memories: readonly MemoryObject[];
  readonly health: MemoryHealthReport;
  readonly policy: MemoryReviewPolicy;
  readonly inbox: readonly MemoryPromotionInboxItem[];
  readonly usedEvents: readonly UsedMemoryEvent[];
  readonly vectorRetrieval: { readonly status: "not_installed" | "not_configured" | "rebuilding" | "ready" | "degraded" | "unavailable"; readonly optional: true };
}

export type TeammateMemoryDetail =
  | { readonly kind: "scope"; readonly scope: TeammateMemoryScope }
  | { readonly kind: "health"; readonly finding: MemoryHealthFinding }
  | { readonly kind: "memory"; readonly item: MemoryPromotionInboxItem };

export interface TeammateMemoryScopeRow {
  readonly scope: TeammateMemoryScope;
  readonly title: string;
  readonly summary: string;
  readonly tone: MemoryStatusTone;
  readonly statusLabel: string;
}

export interface TeammateMemoryReviewRow {
  readonly item: MemoryPromotionInboxItem;
  readonly ownerLabel: string;
  readonly primaryAction: MemoryReviewAction;
  readonly primaryActionLabel: string;
  readonly scopeLabel: string;
  readonly statusLabel: string;
  readonly statusTone: MemoryStatusTone;
  readonly usedCount: number;
}

export interface TeammateMemoryViewModel {
  readonly healthLabel: string;
  readonly healthTone: MemoryStatusTone;
  readonly reviewRows: readonly TeammateMemoryReviewRow[];
  readonly scopeRows: readonly TeammateMemoryScopeRow[];
}

export const emptyMemoryReviewEditForm: MemoryReviewEditForm = {
  title: "",
  body: "",
  sensitivity: "normal",
};

export function buildTeammateMemoryViewModel(input: {
  readonly snapshot: TeammateMemorySnapshot | undefined;
  readonly teammate: AiTeammate;
  readonly channels: readonly Channel[];
  readonly t: Translate;
}): TeammateMemoryViewModel {
  const { snapshot, teammate, channels, t } = input;
  if (!snapshot) {
    return {
      healthLabel: t("Not loaded"),
      healthTone: "neutral",
      reviewRows: [],
      scopeRows: [],
    };
  }
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  const usedCountByMemoryId = countMemoryUsage(snapshot.usedEvents);
  return {
    ...memoryHealthStatus(snapshot.health, t),
    reviewRows: snapshot.inbox.map((item) => ({
      item,
      ownerLabel: memoryOwnerLabel(item.memory, channelsById, teammate, t),
      primaryAction: resolvePrimaryReviewAction(item),
      primaryActionLabel: t(memoryReviewActionLabel(resolvePrimaryReviewAction(item))),
      scopeLabel: t(memoryScopeTypeLabel(item.memory.scopeType)),
      statusLabel: t(item.memory.sensitivity === "secret-adjacent" ? "Needs verification" : "Needs review"),
      statusTone: item.memory.sensitivity === "secret-adjacent" ? "warning" : "neutral",
      usedCount: usedCountByMemoryId.get(item.memory.id) ?? 0,
    })),
    scopeRows: snapshot.scopes.map((scope) => ({
      scope,
      title: t(memoryScopeKindLabel(scope.kind)),
      summary: scope.channelId
        ? channelsById.get(scope.channelId)?.name ?? t("Channel unavailable")
        : t("Private workspace"),
      tone: scope.enabled ? "success" : "warning",
      statusLabel: t(scope.enabled ? "Active" : "Paused"),
    })),
  };
}

export function memoryHealthStatus(report: MemoryHealthReport, t: Translate): {
  readonly healthLabel: string;
  readonly healthTone: MemoryStatusTone;
} {
  if (report.summary.findings.critical > 0) {
    return { healthLabel: t("Critical attention"), healthTone: "danger" };
  }
  if (report.summary.findings.warning > 0) {
    return { healthLabel: t("Needs attention"), healthTone: "warning" };
  }
  return { healthLabel: t("Healthy"), healthTone: "success" };
}

export function memoryHealthFindingTitle(kind: MemoryHealthFinding["kind"]): string {
  switch (kind) {
    case "missing_source_refs": return "Missing source";
    case "expired_candidate": return "Expired candidate";
    case "volatile_without_verify_before_use": return "Needs verification";
    case "duplicate_candidate": return "Duplicate candidate";
    case "superseded_active_memory": return "Superseded active memory";
    case "secret_adjacent_recallable": return "Secret-adjacent recall";
    case "authority_changing_claim": return "Authority-changing claim";
    case "stale_candidate": return "Stale candidate";
    case "high_review_backlog": return "High review backlog";
  }
}

export function memoryReviewActionLabel(action: MemoryReviewAction): string {
  switch (action) {
    case "approve": return "Approve";
    case "edit_and_approve": return "Save and approve";
    case "keep_candidate": return "Keep candidate";
    case "reject": return "Reject";
    case "archive": return "Archive";
    case "quarantine": return "Quarantine";
  }
}

export function memoryReviewActionMessage(action: MemoryReviewAction): string {
  switch (action) {
    case "approve": return "Memory approved";
    case "edit_and_approve": return "Memory edited and approved";
    case "keep_candidate": return "Memory kept as candidate";
    case "reject": return "Memory rejected";
    case "archive": return "Memory archived";
    case "quarantine": return "Memory quarantined";
  }
}

export function memoryReviewActionConfirmation(action: MemoryReviewAction): string {
  switch (action) {
    case "reject": return "Reject this memory?";
    case "archive": return "Archive this memory?";
    case "quarantine": return "Quarantine this memory?";
    default: return "Review this memory?";
  }
}

export function isDestructiveMemoryReviewAction(action: MemoryReviewAction): boolean {
  return action === "reject" || action === "archive" || action === "quarantine";
}

export function memoryScopeKindLabel(kind: TeammateMemoryScope["kind"]): string {
  switch (kind) {
    case "private-chat-summary": return "Private chat summary";
    case "private-notes": return "Private notes";
    case "channel-brief": return "Channel brief";
    case "channel-decisions": return "Channel decisions";
  }
}

export function memoryScopeTypeLabel(scopeType: MemoryObject["scopeType"]): string {
  switch (scopeType) {
    case "workspace": return "Workspace memory";
    case "channel": return "Channel memory";
    case "teammate": return "Teammate memory";
    case "task": return "Task memory";
    case "run": return "Run memory";
  }
}

export function importPlanWarningCount(plan: MemoryMarkdownImportPlan | undefined): number {
  return plan?.candidates.reduce((count, candidate) => count + candidate.warnings.length, 0) ?? 0;
}

export function createMemoryEditForm(item: MemoryPromotionInboxItem): MemoryReviewEditForm {
  return {
    title: item.memory.title,
    body: item.memory.body,
    sensitivity: item.memory.sensitivity,
  };
}

function resolvePrimaryReviewAction(item: MemoryPromotionInboxItem): MemoryReviewAction {
  if (item.memory.sensitivity === "secret-adjacent") return "quarantine";
  return item.recommendedAction === "edit_and_approve" ? "approve" : item.recommendedAction;
}

function memoryOwnerLabel(
  memory: MemoryObject,
  channelsById: ReadonlyMap<string, Channel>,
  teammate: AiTeammate,
  t: Translate,
): string {
  if (memory.scopeType === "channel") return channelsById.get(memory.ownerId)?.name ?? t("Channel unavailable");
  if (memory.scopeType === "teammate") return memory.ownerId === teammate.id ? teammate.displayName : t("Another teammate");
  if (memory.scopeType === "workspace") return t("Workspace");
  return t(memoryScopeTypeLabel(memory.scopeType));
}

function countMemoryUsage(events: readonly UsedMemoryEvent[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const memoryId of event.memoryIds) counts.set(memoryId, (counts.get(memoryId) ?? 0) + 1);
  }
  return counts;
}

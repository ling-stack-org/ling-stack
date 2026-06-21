import { randomUUID } from "node:crypto";
import type { MemoryHealthFinding } from "./memory-health.js";
import type { MemoryObject } from "./memory-types.js";
import { DEFAULT_WORKSPACE_ID } from "./workspace-types.js";

export type GovernanceNotificationSurfaceKind =
  | "teammate_direct"
  | "channel"
  | "ling_agent"
  | "workspace";

export type GovernanceNotificationSurface =
  | { readonly kind: "teammate_direct"; readonly teammateId: string; readonly threadId: string }
  | { readonly kind: "channel"; readonly channelId: string }
  | { readonly kind: "ling_agent"; readonly teammateId: string }
  | { readonly kind: "workspace" };

export type GovernanceNotificationKind =
  | "memory_candidate"
  | "memory_health_finding"
  | "skill_candidate"
  | "procedure_cluster"
  | "channel_protocol_candidate"
  | "channel_playbook_candidate"
  | "workflow_fanin";

export type GovernanceNotificationSeverity = "info" | "warning" | "action_required" | "critical";

export type GovernanceNotificationStatus = "unread" | "seen" | "dismissed" | "resolved";

export type GovernanceNotificationDeliveryStatus = "pending" | "delivered" | "suppressed";

export type GovernanceNotificationDeliveryBlockedReason =
  | "active_private_chat"
  | "teammate_reply_running"
  | "recent_user_input"
  | "surface_muted"
  | "source_resolved";

export type GovernanceNotificationSourceRefType =
  | "memory"
  | "memory_health_finding"
  | "skill_candidate"
  | "procedure_cluster"
  | "channel_protocol_candidate"
  | "channel_playbook_candidate"
  | "run"
  | "workflow"
  | "workflow_step"
  | "message";

export interface GovernanceNotificationSourceRef {
  readonly type: GovernanceNotificationSourceRefType;
  readonly id: string;
  readonly label?: string;
}

export type GovernanceNotificationRoute =
  | { readonly page: "memory_promotion_inbox"; readonly memoryId?: string; readonly channelId?: string; readonly teammateId?: string }
  | { readonly page: "memory_health"; readonly findingId?: string; readonly channelId?: string; readonly teammateId?: string }
  | { readonly page: "skill_candidate"; readonly candidateId: string }
  | { readonly page: "procedure_cluster"; readonly clusterId: string }
  | { readonly page: "channel_protocol_candidate"; readonly channelId: string; readonly candidateId: string }
  | { readonly page: "channel_playbook_candidate"; readonly channelId: string; readonly candidateId: string };

export interface GovernanceNotification {
  readonly id: string;
  readonly workspaceId: string;
  readonly surface: GovernanceNotificationSurface;
  readonly kind: GovernanceNotificationKind;
  readonly severity: GovernanceNotificationSeverity;
  readonly title: string;
  readonly summary: string;
  readonly sourceRefs: readonly GovernanceNotificationSourceRef[];
  readonly targetRoute: GovernanceNotificationRoute;
  readonly status: GovernanceNotificationStatus;
  readonly deliveryStatus: GovernanceNotificationDeliveryStatus;
  readonly deliveryBlockedReason?: GovernanceNotificationDeliveryBlockedReason;
  readonly deliverAfter?: string;
  readonly deliveredAt?: string;
  readonly dedupeKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}

export interface CreateGovernanceNotificationInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly surface: GovernanceNotificationSurface;
  readonly kind: GovernanceNotificationKind;
  readonly severity: GovernanceNotificationSeverity;
  readonly title: string;
  readonly summary: string;
  readonly sourceRefs: readonly GovernanceNotificationSourceRef[];
  readonly targetRoute: GovernanceNotificationRoute;
  readonly status?: GovernanceNotificationStatus;
  readonly deliveryStatus?: GovernanceNotificationDeliveryStatus;
  readonly deliveryBlockedReason?: GovernanceNotificationDeliveryBlockedReason;
  readonly deliverAfter?: string | null;
  readonly deliveredAt?: string | null;
  readonly dedupeKey: string;
}

export interface UpsertGovernanceNotificationResult {
  readonly notification: GovernanceNotification;
  readonly created: boolean;
}

export interface UpdateGovernanceNotificationDeliveryInput {
  readonly deliveryStatus?: GovernanceNotificationDeliveryStatus;
  readonly deliveryBlockedReason?: GovernanceNotificationDeliveryBlockedReason | null;
  readonly deliverAfter?: string | null;
  readonly deliveredAt?: string | null;
}

export interface ListGovernanceNotificationsOptions {
  readonly workspaceId?: string;
  readonly surface?: GovernanceNotificationSurfaceKind;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly threadId?: string;
  readonly kind?: GovernanceNotificationKind;
  readonly status?: GovernanceNotificationStatus;
  readonly includeResolved?: boolean;
  readonly includeDismissed?: boolean;
  readonly limit?: number;
}

export interface GovernanceNotificationSummaryBucket {
  readonly surface: GovernanceNotificationSurface;
  readonly total: number;
  readonly unread: number;
  readonly seen: number;
  readonly dismissed: number;
  readonly resolved: number;
  readonly pendingDelivery: number;
  readonly bySeverity: Partial<Record<GovernanceNotificationSeverity, number>>;
  readonly byKind: Partial<Record<GovernanceNotificationKind, number>>;
  readonly latestUpdatedAt?: string;
}

export interface GovernanceNotificationSummary {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly total: number;
  readonly actionable: number;
  readonly unread: number;
  readonly pendingDelivery: number;
  readonly bySurface: readonly GovernanceNotificationSummaryBucket[];
}

export function createGovernanceNotificationId(): string {
  return `governance_notification_${randomUUID()}`;
}

export function governanceNotificationSurfaceKey(surface: GovernanceNotificationSurface): string {
  switch (surface.kind) {
    case "channel":
      return `channel:${surface.channelId}`;
    case "teammate_direct":
      return `teammate_direct:${surface.teammateId}:${surface.threadId}`;
    case "ling_agent":
      return `ling_agent:${surface.teammateId}`;
    case "workspace":
      return "workspace";
  }
}

export function memoryCandidateGovernanceNotificationInput(
  memory: MemoryObject,
  surface: GovernanceNotificationSurface,
): CreateGovernanceNotificationInput | undefined {
  if (memory.reviewState !== "candidate" && memory.reviewState !== "disabled") {
    return undefined;
  }
  const route = memoryRouteForSurface(memory, surface);
  return {
    workspaceId: memory.workspaceId || DEFAULT_WORKSPACE_ID,
    surface,
    kind: "memory_candidate",
    severity: memory.sensitivity === "secret-adjacent" || memory.reviewState === "disabled" ? "critical" : "warning",
    title: "Memory candidate needs review",
    summary: memory.sensitivity === "secret-adjacent"
      ? "A secret-adjacent memory item needs review before it can be used."
      : "A memory candidate is waiting in the promotion inbox.",
    sourceRefs: [{ type: "memory", id: memory.id, label: memory.title }],
    targetRoute: route,
    deliveryStatus: surface.kind === "teammate_direct" || surface.kind === "ling_agent" ? "pending" : "delivered",
    dedupeKey: memoryCandidateGovernanceNotificationDedupeKey(memory, surface),
  };
}

export function memoryCandidateGovernanceNotificationDedupeKey(
  memory: Pick<MemoryObject, "workspaceId" | "id" | "reviewState">,
  surface: GovernanceNotificationSurface,
): string {
  return [
    memory.workspaceId || DEFAULT_WORKSPACE_ID,
    governanceNotificationSurfaceKey(surface),
    "memory_candidate",
    memory.id,
    memory.reviewState,
  ].join(":");
}

export function memoryHealthGovernanceNotificationInput(
  finding: MemoryHealthFinding,
  surface: GovernanceNotificationSurface,
  workspaceId = DEFAULT_WORKSPACE_ID,
): CreateGovernanceNotificationInput {
  const severity: GovernanceNotificationSeverity =
    finding.severity === "critical" ? "critical" : finding.severity === "warning" ? "warning" : "info";
  return {
    workspaceId,
    surface,
    kind: "memory_health_finding",
    severity,
    title: finding.title,
    summary: finding.recommendation,
    sourceRefs: [
      { type: "memory_health_finding", id: finding.id, label: finding.kind },
      ...(finding.memoryId ? [{ type: "memory" as const, id: finding.memoryId }] : []),
    ],
    targetRoute: {
      page: "memory_health",
      findingId: finding.id,
      ...(finding.scopeType === "channel" && finding.ownerId ? { channelId: finding.ownerId } : {}),
      ...(finding.scopeType === "teammate" && finding.ownerId ? { teammateId: finding.ownerId } : {}),
    },
    deliveryStatus: surface.kind === "teammate_direct" || surface.kind === "ling_agent" ? "pending" : "delivered",
    dedupeKey: [
      workspaceId,
      governanceNotificationSurfaceKey(surface),
      "memory_health_finding",
      finding.kind,
      finding.memoryId ?? finding.id,
    ].join(":"),
  };
}

function memoryRouteForSurface(
  memory: MemoryObject,
  surface: GovernanceNotificationSurface,
): GovernanceNotificationRoute {
  return {
    page: "memory_promotion_inbox",
    memoryId: memory.id,
    ...(surface.kind === "channel" ? { channelId: surface.channelId } : {}),
    ...(surface.kind === "teammate_direct" ? { teammateId: surface.teammateId } : {}),
  };
}

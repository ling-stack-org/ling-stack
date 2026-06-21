export type GovernanceNotificationSurfaceKind =
  | "teammate_direct"
  | "channel"
  | "ling_agent"
  | "workspace";

export type GovernanceNotificationSurface =
  /** Delivered to one teammate private thread after the quiet-window gate passes. */
  | { readonly kind: "teammate_direct"; readonly teammateId: string; readonly threadId: string }
  /** Rendered as a channel-header notification, never as a channel message row. */
  | { readonly kind: "channel"; readonly channelId: string }
  /** Delivered to Ling Agent as a grouped private system digest for workspace-level pressure. */
  | { readonly kind: "ling_agent"; readonly teammateId: string }
  /** Reserved for a future workspace notification center projection. */
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

export interface GovernanceNotificationListRequest {
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

export interface GovernanceNotificationListResponse {
  readonly cwd: string;
  readonly notifications: readonly GovernanceNotification[];
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

export interface GovernanceNotificationSummaryResponse {
  readonly cwd: string;
  readonly summary: GovernanceNotificationSummary;
}

export interface GovernanceNotificationMutationResponse {
  readonly cwd: string;
  readonly notification: GovernanceNotification;
}

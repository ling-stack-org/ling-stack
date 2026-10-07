import type {
  GovernanceNotification,
  GovernanceNotificationDeliveryBlockedReason,
  GovernanceNotificationRoute,
  RunStore,
  TeammateDirectMessage,
  TeammateDirectReplyIntervention,
  WorkUnitStatus,
} from "@ling-stack/core";

export const DEFAULT_TEAMMATE_DIRECT_NOTIFICATION_QUIET_WINDOW_MS = 15 * 60 * 1000;

const ACTIVE_DIRECT_REPLY_WORK_UNIT_STATUSES = new Set<WorkUnitStatus>([
  "claimed",
  "running",
  "waiting_for_approval",
  "cancelling",
]);

const ACTIVE_DIRECT_INTERVENTION_STATUSES = new Set<TeammateDirectReplyIntervention["status"]>([
  "queued",
  "cancelling_source",
  "starting_continuation",
]);

export interface FlushTeammateDirectGovernanceNotificationsOptions {
  readonly now?: string;
  readonly quietWindowMs?: number;
  readonly teammateId?: string;
  readonly threadId?: string;
  readonly limit?: number;
  readonly ignoreDeliverAfter?: boolean;
}

export interface FlushTeammateDirectGovernanceNotificationsResult {
  readonly checked: number;
  readonly delivered: number;
  readonly deferred: number;
  readonly suppressed: number;
}

export function flushTeammateDirectGovernanceNotifications(
  store: RunStore,
  options: FlushTeammateDirectGovernanceNotificationsOptions = {},
): FlushTeammateDirectGovernanceNotificationsResult {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const quietWindowMs = Math.max(options.quietWindowMs ?? DEFAULT_TEAMMATE_DIRECT_NOTIFICATION_QUIET_WINDOW_MS, 0);
  const result = { checked: 0, delivered: 0, deferred: 0, suppressed: 0 };
  const notifications = store.listGovernanceNotifications({
    surface: "teammate_direct",
    teammateId: options.teammateId,
    threadId: options.threadId,
    includeDismissed: false,
    includeResolved: false,
    limit: options.limit ?? 500,
  });

  for (const notification of notifications) {
    if (notification.deliveryStatus !== "pending") {
      continue;
    }
    result.checked += 1;
    if (!options.ignoreDeliverAfter && notification.deliverAfter && safeTimeMs(notification.deliverAfter) > nowMs) {
      result.deferred += 1;
      continue;
    }
    if (notification.surface.kind !== "teammate_direct") {
      continue;
    }
    if (!isNotificationSourceStillReviewWorthy(store, notification)) {
      store.resolveGovernanceNotificationByDedupeKey(notification.workspaceId, notification.dedupeKey, now);
      result.suppressed += 1;
      continue;
    }

    const gate = evaluateTeammateDirectDeliveryGate(store, notification, nowMs, quietWindowMs);
    if (!gate.allowed) {
      store.updateGovernanceNotificationDelivery(
        notification.id,
        {
          deliveryStatus: "pending",
          deliveryBlockedReason: gate.reason,
          deliverAfter: gate.deliverAfter,
        },
        now,
      );
      result.deferred += 1;
      continue;
    }

    try {
      store.createTeammateDirectMessage(
        {
          threadId: notification.surface.threadId,
          teammateId: notification.surface.teammateId,
          authorType: "system",
          authorId: "system",
          systemPurpose: "governance_notification",
          body: renderTeammateDirectNotificationBody(notification),
          status: "ready",
        },
        now,
      );
      store.updateGovernanceNotificationDelivery(
        notification.id,
        {
          deliveryStatus: "delivered",
          deliveryBlockedReason: null,
          deliverAfter: null,
          deliveredAt: now,
        },
        now,
      );
      result.delivered += 1;
    } catch {
      store.updateGovernanceNotificationDelivery(
        notification.id,
        {
          deliveryStatus: "pending",
          deliveryBlockedReason: "surface_muted",
          deliverAfter: new Date(nowMs + quietWindowMs).toISOString(),
        },
        now,
      );
      result.deferred += 1;
    }
  }
  return result;
}

export function flushLingAgentGovernanceNotificationDigests(
  store: RunStore,
  options: Omit<FlushTeammateDirectGovernanceNotificationsOptions, "threadId"> = {},
): FlushTeammateDirectGovernanceNotificationsResult {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const quietWindowMs = Math.max(options.quietWindowMs ?? DEFAULT_TEAMMATE_DIRECT_NOTIFICATION_QUIET_WINDOW_MS, 0);
  const result = { checked: 0, delivered: 0, deferred: 0, suppressed: 0 };
  const notifications = store
    .listGovernanceNotifications({
      surface: "ling_agent",
      teammateId: options.teammateId,
      includeDismissed: false,
      includeResolved: false,
      limit: options.limit ?? 500,
    })
    .filter((notification) => notification.deliveryStatus === "pending")
    .filter((notification) => options.ignoreDeliverAfter || !notification.deliverAfter || safeTimeMs(notification.deliverAfter) <= nowMs);

  const byTeammate = new Map<string, GovernanceNotification[]>();
  for (const notification of notifications) {
    result.checked += 1;
    if (notification.surface.kind !== "ling_agent") {
      continue;
    }
    if (!isNotificationSourceStillReviewWorthy(store, notification)) {
      store.resolveGovernanceNotificationByDedupeKey(notification.workspaceId, notification.dedupeKey, now);
      result.suppressed += 1;
      continue;
    }
    const group = byTeammate.get(notification.surface.teammateId) ?? [];
    group.push(notification);
    byTeammate.set(notification.surface.teammateId, group);
  }

  for (const [teammateId, group] of byTeammate) {
    const thread = store.getOrCreateTeammateDirectThread(teammateId, now);
    const gate = evaluateTeammateDirectDeliveryGate(
      store,
      {
        ...group[0],
        surface: { kind: "teammate_direct", teammateId, threadId: thread.id },
      },
      nowMs,
      quietWindowMs,
    );
    if (!gate.allowed) {
      for (const notification of group) {
        store.updateGovernanceNotificationDelivery(
          notification.id,
          {
            deliveryStatus: "pending",
            deliveryBlockedReason: gate.reason,
            deliverAfter: gate.deliverAfter,
          },
          now,
        );
      }
      result.deferred += group.length;
      continue;
    }

    try {
      store.createTeammateDirectMessage(
        {
          threadId: thread.id,
          teammateId,
          authorType: "system",
          authorId: "system",
          systemPurpose: "governance_notification",
          body: renderLingAgentDigestBody(group),
          status: "ready",
        },
        now,
      );
      for (const notification of group) {
        store.updateGovernanceNotificationDelivery(
          notification.id,
          {
            deliveryStatus: "delivered",
            deliveryBlockedReason: null,
            deliverAfter: null,
            deliveredAt: now,
          },
          now,
        );
      }
      result.delivered += group.length;
    } catch {
      for (const notification of group) {
        store.updateGovernanceNotificationDelivery(
          notification.id,
          {
            deliveryStatus: "pending",
            deliveryBlockedReason: "surface_muted",
            deliverAfter: new Date(nowMs + quietWindowMs).toISOString(),
          },
          now,
        );
      }
      result.deferred += group.length;
    }
  }

  return result;
}

type DeliveryGateResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: GovernanceNotificationDeliveryBlockedReason;
      readonly deliverAfter: string;
    };

function evaluateTeammateDirectDeliveryGate(
  store: RunStore,
  notification: GovernanceNotification,
  nowMs: number,
  quietWindowMs: number,
): DeliveryGateResult {
  if (notification.surface.kind !== "teammate_direct") {
    return { allowed: true };
  }
  const { teammateId, threadId } = notification.surface;
  const activeWorkUnit = store
    .listWorkUnits({ kind: "teammate_direct_reply", teammateId, limit: 500 })
    .find((workUnit) => {
      if (!ACTIVE_DIRECT_REPLY_WORK_UNIT_STATUSES.has(workUnit.status)) {
        return false;
      }
      if (!workUnit.linkedMessageId) {
        return false;
      }
      const message = store.getTeammateDirectMessage(workUnit.linkedMessageId);
      return message?.teammateId === teammateId && message.threadId === threadId;
    });
  if (activeWorkUnit) {
    return blockDelivery("teammate_reply_running", Math.max(nowMs + Math.min(quietWindowMs, 60_000), safeTimeMs(activeWorkUnit.updatedAt) + 60_000));
  }

  const latestPendingReply = latestTeammateDirectMessage(
    store
      .listTeammateDirectMessages({ teammateId, threadId, limit: 50 })
      .filter((message) => message.authorType === "ai-teammate" && message.status === "pending"),
  );
  if (latestPendingReply) {
    return blockDelivery("teammate_reply_running", latestMessageActivityMs(latestPendingReply) + quietWindowMs);
  }

  const latestOpenIntervention = latestDirectIntervention(
    store
      .listTeammateDirectReplyInterventions({ teammateId, threadId, limit: 100 })
      .filter((intervention) => ACTIVE_DIRECT_INTERVENTION_STATUSES.has(intervention.status)),
  );
  if (latestOpenIntervention) {
    return blockDelivery("active_private_chat", safeTimeMs(latestOpenIntervention.updatedAt) + quietWindowMs);
  }

  const latestMessage = latestTeammateDirectMessage(store.listTeammateDirectMessages({ teammateId, threadId, limit: 50 }));
  if (latestMessage) {
    const deliverAtMs = latestMessageActivityMs(latestMessage) + quietWindowMs;
    if (deliverAtMs > nowMs) {
      return blockDelivery(latestMessage.authorType === "local-user" ? "recent_user_input" : "active_private_chat", deliverAtMs);
    }
  }

  return { allowed: true };
}

function isNotificationSourceStillReviewWorthy(store: RunStore, notification: GovernanceNotification): boolean {
  for (const sourceRef of notification.sourceRefs) {
    if (sourceRef.type !== "memory") {
      continue;
    }
    const memory = store.getMemoryObject(sourceRef.id);
    if (!memory || (memory.reviewState !== "candidate" && memory.reviewState !== "disabled")) {
      return false;
    }
  }
  return true;
}

function blockDelivery(reason: GovernanceNotificationDeliveryBlockedReason, deliverAfterMs: number): DeliveryGateResult {
  return {
    allowed: false,
    reason,
    deliverAfter: new Date(deliverAfterMs).toISOString(),
  };
}

function latestTeammateDirectMessage(messages: readonly TeammateDirectMessage[]): TeammateDirectMessage | undefined {
  return messages.reduce<TeammateDirectMessage | undefined>((latest, message) => {
    if (!latest || latestMessageActivityMs(message) > latestMessageActivityMs(latest)) {
      return message;
    }
    return latest;
  }, undefined);
}

function latestDirectIntervention(
  interventions: readonly TeammateDirectReplyIntervention[],
): TeammateDirectReplyIntervention | undefined {
  return interventions.reduce<TeammateDirectReplyIntervention | undefined>((latest, intervention) => {
    if (!latest || safeTimeMs(intervention.updatedAt) > safeTimeMs(latest.updatedAt)) {
      return intervention;
    }
    return latest;
  }, undefined);
}

function latestMessageActivityMs(message: TeammateDirectMessage): number {
  return Math.max(safeTimeMs(message.createdAt), safeTimeMs(message.updatedAt));
}

function safeTimeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderTeammateDirectNotificationBody(notification: GovernanceNotification): string {
  const title = truncateLine(notification.title, 120);
  const summary = truncateLine(notification.summary, 220);
  const routeLabel = renderRouteLabel(notification.targetRoute);
  return `Review needed: ${title}\n${summary}\nOpen ${routeLabel}.`;
}

function renderLingAgentDigestBody(notifications: readonly GovernanceNotification[]): string {
  const sorted = [...notifications].sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
  const lines = sorted.slice(0, 5).map((notification) => {
    const severity = renderSeverityLabel(notification.severity);
    const routeLabel = renderRouteLabel(notification.targetRoute);
    return `- ${severity}: ${renderDigestNotificationLabel(notification)} (${routeLabel})`;
  });
  const remaining = sorted.length > lines.length ? `\n+${sorted.length - lines.length} more in governance notifications.` : "";
  return [
    `Workspace review digest: ${sorted.length} item${sorted.length === 1 ? "" : "s"} need attention.`,
    ...lines,
    `Open the relevant review surface before approving, rejecting, or publishing anything.${remaining}`,
  ].join("\n");
}

function renderDigestNotificationLabel(notification: GovernanceNotification): string {
  const sourceLabel = notification.sourceRefs.find((sourceRef) => sourceRef.label?.trim())?.label;
  const label = sourceLabel && sourceLabel !== notification.title
    ? `${notification.title}: ${sourceLabel}`
    : notification.title;
  return truncateLine(label, 90);
}

function renderRouteLabel(route: GovernanceNotificationRoute): string {
  switch (route.page) {
    case "memory_promotion_inbox":
      return "Memory Review";
    case "memory_health":
      return "Memory Health";
    case "skill_candidate":
      return "Skill Candidate";
    case "procedure_cluster":
      return "Procedure Cluster";
    case "channel_protocol_candidate":
      return "Channel Protocol";
    case "channel_playbook_candidate":
      return "Channel Playbook";
  }
}

function truncateLine(value: string, maxLength: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(maxLength - 1, 0)).trim()}...`;
}

function renderSeverityLabel(severity: GovernanceNotification["severity"]): string {
  switch (severity) {
    case "critical":
      return "Critical";
    case "action_required":
      return "Action required";
    case "warning":
      return "Warning";
    case "info":
      return "Info";
  }
}

function severityRank(severity: GovernanceNotification["severity"]): number {
  switch (severity) {
    case "critical":
      return 4;
    case "action_required":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}

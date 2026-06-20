import type { SQLOutputValue } from "node:sqlite";
import {
  createGovernanceNotificationId,
  governanceNotificationSurfaceKey,
  type CreateGovernanceNotificationInput,
  type GovernanceNotification,
  type GovernanceNotificationDeliveryBlockedReason,
  type GovernanceNotificationDeliveryStatus,
  type GovernanceNotificationKind,
  type GovernanceNotificationRoute,
  type GovernanceNotificationSeverity,
  type GovernanceNotificationSourceRef,
  type GovernanceNotificationSourceRefType,
  type GovernanceNotificationStatus,
  type GovernanceNotificationSummary,
  type GovernanceNotificationSurface,
  type GovernanceNotificationSurfaceKind,
  type ListGovernanceNotificationsOptions,
  type UpdateGovernanceNotificationDeliveryInput,
  type UpsertGovernanceNotificationResult,
} from "../../governance-notification-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { parseJson, readNullableString, readString, stringifyJson } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const governanceNotificationSelectSql = `
  SELECT
    id,
    workspace_id,
    surface_kind,
    surface_teammate_id,
    surface_thread_id,
    surface_channel_id,
    kind,
    severity,
    title,
    summary,
    source_refs_json,
    target_route_json,
    status,
    delivery_status,
    delivery_blocked_reason,
    deliver_after,
    delivered_at,
    dedupe_key,
    created_at,
    updated_at,
    resolved_at
  FROM governance_notifications
`;

export class SqliteGovernanceNotificationStore {
  constructor(private readonly context: SqliteStoreContext) {}

  upsertGovernanceNotification(input: CreateGovernanceNotificationInput, now: string): UpsertGovernanceNotificationResult {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = this.getGovernanceNotificationByDedupeKey(workspaceId, input.dedupeKey);
    if (existing) {
      const nextStatus = input.status ?? (existing.status === "resolved" ? "unread" : existing.status);
      const nextDeliveryStatus = input.deliveryStatus ?? existing.deliveryStatus;
      const next: GovernanceNotification = {
        ...existing,
        surface: input.surface,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        summary: input.summary,
        sourceRefs: input.sourceRefs,
        targetRoute: input.targetRoute,
        status: nextStatus,
        deliveryStatus: nextDeliveryStatus,
        deliveryBlockedReason: input.deliveryBlockedReason ?? existing.deliveryBlockedReason,
        deliverAfter: nullableInput(input.deliverAfter, existing.deliverAfter),
        deliveredAt: nullableInput(input.deliveredAt, existing.deliveredAt),
        updatedAt: now,
        resolvedAt: nextStatus === "resolved" ? existing.resolvedAt ?? now : undefined,
      };
      validateGovernanceNotification(next);
      this.context.database
        .prepare(`
          UPDATE governance_notifications
          SET
            surface_kind = ?,
            surface_teammate_id = ?,
            surface_thread_id = ?,
            surface_channel_id = ?,
            kind = ?,
            severity = ?,
            title = ?,
            summary = ?,
            source_refs_json = ?,
            target_route_json = ?,
            status = ?,
            delivery_status = ?,
            delivery_blocked_reason = ?,
            deliver_after = ?,
            delivered_at = ?,
            updated_at = ?,
            resolved_at = ?
          WHERE workspace_id = ? AND dedupe_key = ?
        `)
        .run(
          next.surface.kind,
          surfaceTeammateId(next.surface),
          surfaceThreadId(next.surface),
          surfaceChannelId(next.surface),
          next.kind,
          next.severity,
          next.title,
          next.summary,
          stringifyJson(next.sourceRefs),
          stringifyJson(next.targetRoute),
          next.status,
          next.deliveryStatus,
          next.deliveryBlockedReason ?? null,
          next.deliverAfter ?? null,
          next.deliveredAt ?? null,
          next.updatedAt,
          next.resolvedAt ?? null,
          next.workspaceId,
          next.dedupeKey,
        );
      const updated = this.getGovernanceNotification(existing.id);
      if (!updated) {
        throw new Error(`Governance notification disappeared after update: ${existing.id}`);
      }
      return { notification: updated, created: false };
    }

    const notification: GovernanceNotification = {
      id: input.id ?? createGovernanceNotificationId(),
      workspaceId,
      surface: input.surface,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      sourceRefs: input.sourceRefs,
      targetRoute: input.targetRoute,
      status: input.status ?? "unread",
      deliveryStatus: input.deliveryStatus ?? "pending",
      deliveryBlockedReason: input.deliveryBlockedReason,
      deliverAfter: input.deliverAfter ?? undefined,
      deliveredAt: input.deliveredAt ?? undefined,
      dedupeKey: input.dedupeKey,
      createdAt: now,
      updatedAt: now,
      resolvedAt: input.status === "resolved" ? now : undefined,
    };
    validateGovernanceNotification(notification);
    this.context.database
      .prepare(`
        INSERT INTO governance_notifications (
          id,
          workspace_id,
          surface_kind,
          surface_teammate_id,
          surface_thread_id,
          surface_channel_id,
          kind,
          severity,
          title,
          summary,
          source_refs_json,
          target_route_json,
          status,
          delivery_status,
          delivery_blocked_reason,
          deliver_after,
          delivered_at,
          dedupe_key,
          created_at,
          updated_at,
          resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        notification.id,
        notification.workspaceId,
        notification.surface.kind,
        surfaceTeammateId(notification.surface),
        surfaceThreadId(notification.surface),
        surfaceChannelId(notification.surface),
        notification.kind,
        notification.severity,
        notification.title,
        notification.summary,
        stringifyJson(notification.sourceRefs),
        stringifyJson(notification.targetRoute),
        notification.status,
        notification.deliveryStatus,
        notification.deliveryBlockedReason ?? null,
        notification.deliverAfter ?? null,
        notification.deliveredAt ?? null,
        notification.dedupeKey,
        notification.createdAt,
        notification.updatedAt,
        notification.resolvedAt ?? null,
      );
    return { notification, created: true };
  }

  getGovernanceNotification(id: string): GovernanceNotification | undefined {
    const row = this.context.database
      .prepare(`${governanceNotificationSelectSql} WHERE id = ?`)
      .get(id);
    return row ? mapGovernanceNotification(row as Record<string, SQLOutputValue>) : undefined;
  }

  getGovernanceNotificationByDedupeKey(workspaceId: string, dedupeKey: string): GovernanceNotification | undefined {
    const row = this.context.database
      .prepare(`${governanceNotificationSelectSql} WHERE workspace_id = ? AND dedupe_key = ?`)
      .get(workspaceId, dedupeKey);
    return row ? mapGovernanceNotification(row as Record<string, SQLOutputValue>) : undefined;
  }

  listGovernanceNotifications(options: ListGovernanceNotificationsOptions = {}): GovernanceNotification[] {
    const conditions = ["workspace_id = ?"];
    const params: Array<string | number> = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.surface) {
      conditions.push("surface_kind = ?");
      params.push(options.surface);
    }
    if (options.channelId) {
      conditions.push("surface_channel_id = ?");
      params.push(options.channelId);
    }
    if (options.teammateId) {
      conditions.push("surface_teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.threadId) {
      conditions.push("surface_thread_id = ?");
      params.push(options.threadId);
    }
    if (options.kind) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }
    if (options.status) {
      conditions.push("status = ?");
      params.push(options.status);
    } else {
      if (!options.includeResolved) {
        conditions.push("status <> 'resolved'");
      }
      if (!options.includeDismissed) {
        conditions.push("status <> 'dismissed'");
      }
    }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
    return this.context.database
      .prepare(`${governanceNotificationSelectSql} WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapGovernanceNotification(row as Record<string, SQLOutputValue>));
  }

  updateGovernanceNotificationDelivery(
    id: string,
    input: UpdateGovernanceNotificationDeliveryInput,
    now: string,
  ): GovernanceNotification | undefined {
    const existing = this.getGovernanceNotification(id);
    if (!existing) {
      return undefined;
    }
    const next: GovernanceNotification = {
      ...existing,
      deliveryStatus: input.deliveryStatus ?? existing.deliveryStatus,
      deliveryBlockedReason: nullableInput(input.deliveryBlockedReason, existing.deliveryBlockedReason),
      deliverAfter: nullableInput(input.deliverAfter, existing.deliverAfter),
      deliveredAt: nullableInput(input.deliveredAt, existing.deliveredAt),
      updatedAt: now,
    };
    validateGovernanceNotification(next);
    this.context.database
      .prepare(`
        UPDATE governance_notifications
        SET
          delivery_status = ?,
          delivery_blocked_reason = ?,
          deliver_after = ?,
          delivered_at = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.deliveryStatus,
        next.deliveryBlockedReason ?? null,
        next.deliverAfter ?? null,
        next.deliveredAt ?? null,
        next.updatedAt,
        id,
      );
    return this.getGovernanceNotification(id);
  }

  markGovernanceNotificationSeen(id: string, now: string): GovernanceNotification | undefined {
    const existing = this.getGovernanceNotification(id);
    if (!existing) {
      return undefined;
    }
    const nextStatus = existing.status === "unread" ? "seen" : existing.status;
    this.context.database
      .prepare(`
        UPDATE governance_notifications
        SET status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(nextStatus, nextStatus === existing.status ? existing.updatedAt : now, id);
    return this.getGovernanceNotification(id);
  }

  dismissGovernanceNotification(id: string, now: string): GovernanceNotification | undefined {
    const existing = this.getGovernanceNotification(id);
    if (!existing) {
      return undefined;
    }
    const nextStatus = existing.status === "resolved" ? "resolved" : "dismissed";
    this.context.database
      .prepare(`
        UPDATE governance_notifications
        SET status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(nextStatus, nextStatus === existing.status ? existing.updatedAt : now, id);
    return this.getGovernanceNotification(id);
  }

  resolveGovernanceNotificationByDedupeKey(
    workspaceId: string,
    dedupeKey: string,
    now: string,
  ): GovernanceNotification | undefined {
    const existing = this.getGovernanceNotificationByDedupeKey(workspaceId, dedupeKey);
    if (!existing) {
      return undefined;
    }
    const deliveryStatus = existing.deliveryStatus === "pending" ? "suppressed" : existing.deliveryStatus;
    const deliveryBlockedReason = existing.deliveryStatus === "pending" ? "source_resolved" : existing.deliveryBlockedReason;
    this.context.database
      .prepare(`
        UPDATE governance_notifications
        SET
          status = 'resolved',
          delivery_status = ?,
          delivery_blocked_reason = ?,
          updated_at = ?,
          resolved_at = ?
        WHERE workspace_id = ? AND dedupe_key = ?
      `)
      .run(deliveryStatus, deliveryBlockedReason ?? null, now, existing.resolvedAt ?? now, workspaceId, dedupeKey);
    return this.getGovernanceNotification(existing.id);
  }

  getGovernanceNotificationSummary(
    workspaceId = DEFAULT_WORKSPACE_ID,
    generatedAt = new Date().toISOString(),
  ): GovernanceNotificationSummary {
    const notifications = this.listGovernanceNotifications({
      workspaceId,
      includeDismissed: true,
      includeResolved: true,
      limit: 500,
    });
    const buckets = new Map<string, MutableSummaryBucket>();
    let unread = 0;
    let pendingDelivery = 0;
    let actionable = 0;
    for (const notification of notifications) {
      if (notification.status === "unread") {
        unread += 1;
      }
      if (notification.deliveryStatus === "pending") {
        pendingDelivery += 1;
      }
      if (notification.status !== "dismissed" && notification.status !== "resolved") {
        actionable += 1;
      }
      const key = governanceNotificationSurfaceKey(notification.surface);
      const bucket = buckets.get(key) ?? createSummaryBucket(notification.surface);
      bucket.total += 1;
      bucket[notification.status] += 1;
      if (notification.deliveryStatus === "pending") {
        bucket.pendingDelivery += 1;
      }
      bucket.bySeverity[notification.severity] = (bucket.bySeverity[notification.severity] ?? 0) + 1;
      bucket.byKind[notification.kind] = (bucket.byKind[notification.kind] ?? 0) + 1;
      if (!bucket.latestUpdatedAt || notification.updatedAt > bucket.latestUpdatedAt) {
        bucket.latestUpdatedAt = notification.updatedAt;
      }
      buckets.set(key, bucket);
    }
    return {
      workspaceId,
      generatedAt,
      total: notifications.length,
      actionable,
      unread,
      pendingDelivery,
      bySurface: [...buckets.values()]
        .sort((left, right) => (right.latestUpdatedAt ?? "").localeCompare(left.latestUpdatedAt ?? ""))
        .map((bucket) => ({
          surface: bucket.surface,
          total: bucket.total,
          unread: bucket.unread,
          seen: bucket.seen,
          dismissed: bucket.dismissed,
          resolved: bucket.resolved,
          pendingDelivery: bucket.pendingDelivery,
          bySeverity: bucket.bySeverity,
          byKind: bucket.byKind,
          latestUpdatedAt: bucket.latestUpdatedAt,
        })),
    };
  }
}

interface MutableSummaryBucket {
  surface: GovernanceNotificationSurface;
  total: number;
  unread: number;
  seen: number;
  dismissed: number;
  resolved: number;
  pendingDelivery: number;
  bySeverity: Partial<Record<GovernanceNotificationSeverity, number>>;
  byKind: Partial<Record<GovernanceNotificationKind, number>>;
  latestUpdatedAt?: string;
}

function createSummaryBucket(surface: GovernanceNotificationSurface): MutableSummaryBucket {
  return {
    surface,
    total: 0,
    unread: 0,
    seen: 0,
    dismissed: 0,
    resolved: 0,
    pendingDelivery: 0,
    bySeverity: {},
    byKind: {},
  };
}

function mapGovernanceNotification(row: Record<string, SQLOutputValue>): GovernanceNotification {
  const surface = mapSurface(row);
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    surface,
    kind: readString(row, "kind") as GovernanceNotificationKind,
    severity: readString(row, "severity") as GovernanceNotificationSeverity,
    title: readString(row, "title"),
    summary: readString(row, "summary"),
    sourceRefs: parseSourceRefs(readString(row, "source_refs_json")),
    targetRoute: parseTargetRoute(readString(row, "target_route_json")),
    status: readString(row, "status") as GovernanceNotificationStatus,
    deliveryStatus: readString(row, "delivery_status") as GovernanceNotificationDeliveryStatus,
    deliveryBlockedReason: readNullableString(row, "delivery_blocked_reason") as GovernanceNotificationDeliveryBlockedReason | undefined,
    deliverAfter: readNullableString(row, "deliver_after"),
    deliveredAt: readNullableString(row, "delivered_at"),
    dedupeKey: readString(row, "dedupe_key"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    resolvedAt: readNullableString(row, "resolved_at"),
  };
}

function mapSurface(row: Record<string, SQLOutputValue>): GovernanceNotificationSurface {
  const kind = readString(row, "surface_kind") as GovernanceNotificationSurfaceKind;
  switch (kind) {
    case "channel":
      return { kind, channelId: requiredNullable(row, "surface_channel_id") };
    case "teammate_direct":
      return {
        kind,
        teammateId: requiredNullable(row, "surface_teammate_id"),
        threadId: requiredNullable(row, "surface_thread_id"),
      };
    case "ling_agent":
      return { kind, teammateId: requiredNullable(row, "surface_teammate_id") };
    case "workspace":
      return { kind };
  }
}

function parseSourceRefs(value: string): readonly GovernanceNotificationSourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected governance notification source refs array from SQLite");
  }
  return parsed.map((item) => {
    if (!isPlainRecord(item)) {
      throw new Error("Expected governance notification source ref object from SQLite");
    }
    return {
      type: readRecordString(item, "type") as GovernanceNotificationSourceRefType,
      id: readRecordString(item, "id"),
      ...(typeof item.label === "string" ? { label: item.label } : {}),
    };
  });
}

function parseTargetRoute(value: string): GovernanceNotificationRoute {
  const parsed = parseJson(value);
  if (!isPlainRecord(parsed)) {
    throw new Error("Expected governance notification target route object from SQLite");
  }
  return parsed as unknown as GovernanceNotificationRoute;
}

function validateGovernanceNotification(notification: GovernanceNotification): void {
  if (!notification.workspaceId.trim() || !notification.dedupeKey.trim()) {
    throw new Error("Governance notification workspaceId and dedupeKey are required");
  }
  if (!notification.title.trim() || !notification.summary.trim()) {
    throw new Error("Governance notification title and summary are required");
  }
  validateSurface(notification.surface);
  if (!isSupportedKind(notification.kind)) {
    throw new Error("Governance notification kind is not supported");
  }
  if (!isSupportedSeverity(notification.severity)) {
    throw new Error("Governance notification severity is not supported");
  }
  if (!isSupportedStatus(notification.status)) {
    throw new Error("Governance notification status is not supported");
  }
  if (!isSupportedDeliveryStatus(notification.deliveryStatus)) {
    throw new Error("Governance notification delivery status is not supported");
  }
  if (notification.deliveryBlockedReason && !isSupportedDeliveryBlockedReason(notification.deliveryBlockedReason)) {
    throw new Error("Governance notification delivery blocked reason is not supported");
  }
  if (notification.sourceRefs.length === 0) {
    throw new Error("Governance notification requires at least one source ref");
  }
}

function validateSurface(surface: GovernanceNotificationSurface): void {
  if (surface.kind === "channel" && !surface.channelId.trim()) {
    throw new Error("Governance notification channel surface requires channelId");
  }
  if (surface.kind === "teammate_direct" && (!surface.teammateId.trim() || !surface.threadId.trim())) {
    throw new Error("Governance notification teammate_direct surface requires teammateId and threadId");
  }
  if (surface.kind === "ling_agent" && !surface.teammateId.trim()) {
    throw new Error("Governance notification ling_agent surface requires teammateId");
  }
}

function isSupportedKind(value: string): value is GovernanceNotificationKind {
  return value === "memory_candidate" ||
    value === "memory_health_finding" ||
    value === "skill_candidate" ||
    value === "procedure_cluster" ||
    value === "channel_protocol_candidate" ||
    value === "channel_playbook_candidate" ||
    value === "workflow_fanin";
}

function isSupportedSeverity(value: string): value is GovernanceNotificationSeverity {
  return value === "info" || value === "warning" || value === "action_required" || value === "critical";
}

function isSupportedStatus(value: string): value is GovernanceNotificationStatus {
  return value === "unread" || value === "seen" || value === "dismissed" || value === "resolved";
}

function isSupportedDeliveryStatus(value: string): value is GovernanceNotificationDeliveryStatus {
  return value === "pending" || value === "delivered" || value === "suppressed";
}

function isSupportedDeliveryBlockedReason(value: string): value is GovernanceNotificationDeliveryBlockedReason {
  return value === "active_private_chat" ||
    value === "teammate_reply_running" ||
    value === "recent_user_input" ||
    value === "surface_muted" ||
    value === "source_resolved";
}

function surfaceTeammateId(surface: GovernanceNotificationSurface): string | null {
  return surface.kind === "teammate_direct" || surface.kind === "ling_agent" ? surface.teammateId : null;
}

function surfaceThreadId(surface: GovernanceNotificationSurface): string | null {
  return surface.kind === "teammate_direct" ? surface.threadId : null;
}

function surfaceChannelId(surface: GovernanceNotificationSurface): string | null {
  return surface.kind === "channel" ? surface.channelId : null;
}

function requiredNullable(row: Record<string, SQLOutputValue>, key: string): string {
  const value = readNullableString(row, key);
  if (!value) {
    throw new Error(`Expected SQLite column ${key} to be a non-empty string`);
  }
  return value;
}

function nullableInput<T>(value: T | null | undefined, existing: T | undefined): T | undefined {
  if (value === undefined) {
    return existing;
  }
  if (value === null) {
    return undefined;
  }
  return value;
}

function readRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected ${key} to be a non-empty string`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

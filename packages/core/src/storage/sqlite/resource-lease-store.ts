import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  createResourceLeaseId,
  type CreateResourceLeaseInput,
  type ListResourceLeasesOptions,
  type ResourceLease,
  type ResourceLeaseOwnerType,
} from "../../channel-runtime-types.js";
import { mapResourceLease } from "./runtime-work-mappers.js";
import { resourceLeaseSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteResourceLeaseStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined {
    const lease: ResourceLease = {
      id: createResourceLeaseId(),
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      status: "active",
      acquiredAt: input.acquiredAt,
      expiresAt: input.expiresAt,
      lastRenewedAt: input.lastRenewedAt ?? input.acquiredAt,
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
    };
    try {
      this.context.database
        .prepare(`
          INSERT INTO resource_leases (
            id,
            workspace_id,
            resource_type,
            resource_key,
            owner_type,
            owner_id,
            status,
            acquired_at,
            expires_at,
            last_renewed_at,
            released_at,
            release_reason,
            work_unit_id,
            attempt_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          lease.id,
          lease.workspaceId,
          lease.resourceType,
          lease.resourceKey,
          lease.ownerType,
          lease.ownerId,
          lease.status,
          lease.acquiredAt,
          lease.expiresAt,
          lease.lastRenewedAt ?? lease.acquiredAt,
          null,
          null,
          lease.workUnitId ?? null,
          lease.attemptId ?? null,
        );
      return lease;
    } catch {
      return undefined;
    }
  }

  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerType, ownerId: string, releasedAt: string): number {
    const result = this.context.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'released', released_at = ?, release_reason = COALESCE(release_reason, 'released')
        WHERE owner_type = ? AND owner_id = ? AND status = 'active'
      `)
      .run(releasedAt, ownerType, ownerId);
    return Number(result.changes);
  }

  renewActiveResourceLeasesForAttempt(attemptId: string, renewedAt: string): number {
    const result = this.context.database
      .prepare("UPDATE resource_leases SET last_renewed_at = ? WHERE attempt_id = ? AND status = 'active'")
      .run(renewedAt, attemptId);
    return Number(result.changes);
  }

  expireResourceLeases(now: string): number {
    const result = this.context.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'expired', released_at = ?, release_reason = COALESCE(release_reason, 'expired')
        WHERE status = 'active' AND expires_at <= ?
      `)
      .run(now, now);
    return Number(result.changes);
  }

  listResourceLeases(options: ListResourceLeasesOptions = {}): ResourceLease[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.ownerType) {
      clauses.push("owner_type = ?");
      params.push(options.ownerType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.resourceType) {
      clauses.push("resource_type = ?");
      params.push(options.resourceType);
    }
    if (options.resourceKey) {
      clauses.push("resource_key = ?");
      params.push(options.resourceKey);
    }
    if (options.workUnitId) {
      clauses.push("work_unit_id = ?");
      params.push(options.workUnitId);
    }
    if (options.attemptId) {
      clauses.push("attempt_id = ?");
      params.push(options.attemptId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.context.database
      .prepare(`${resourceLeaseSelectSql(whereClause)} ORDER BY acquired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapResourceLease);
  }

  getBlockingResourceLease(resourceType: ResourceLease["resourceType"], resourceKey: string): ResourceLease | undefined {
    const row = this.context.database
      .prepare(resourceLeaseSelectSql("WHERE workspace_id = ? AND resource_type = ? AND resource_key = ? AND status = 'active'"))
      .get(DEFAULT_WORKSPACE_ID, resourceType, resourceKey);
    return row ? mapResourceLease(row) : undefined;
  }
}

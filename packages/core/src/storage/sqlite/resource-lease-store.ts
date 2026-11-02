import type { SQLOutputValue } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import type { RuntimeAttemptFenceV1, RuntimeResourceRenewal } from "../../runtime-supervisor-types.js";
import { assertRuntimeResourceRenewal } from "../../runtime-resource-renewal.js";
import {
  createResourceLeaseId,
  type CreateResourceLeaseInput,
  type ListResourceLeasesOptions,
  type ResourceLease,
  type ResourceLeaseOwnerLevelType,
} from "../../channel-runtime-types.js";
import { mapResourceLease } from "./runtime-work-mappers.js";
import { resourceLeaseSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { withCancelledAttemptResourceVeto } from "./cancelled-attempt-resource-veto.js";

export class SqliteResourceLeaseStore {
  private readonly context: SqliteStoreContext;

  constructor(context: SqliteStoreContext) {
    this.context = context;
  }

  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined {
    if (!isValidResourceLeaseInput(input)) {
      return undefined;
    }
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
      runtimeInstanceId: input.runtimeInstanceId,
      fencingToken: input.fencingToken,
    };
    try {
      const result = this.context.database
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
            attempt_id,
            runtime_instance_id,
            fencing_token
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ? IN ('workflow_step','system') OR EXISTS (
            SELECT 1 FROM work_unit_attempts AS attempts
            JOIN work_units AS units ON units.id=attempts.work_unit_id
            WHERE attempts.id=? AND attempts.work_unit_id=? AND attempts.runtime_instance_id=?
              AND attempts.fencing_token=? AND units.active_attempt_id=attempts.id
              AND units.workspace_id=? AND attempts.status IN ('created','started','waiting_for_approval','cancelling')
          )
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
          lease.runtimeInstanceId ?? null,
          lease.fencingToken ?? null,
          lease.ownerType,
          lease.attemptId ?? null,
          lease.workUnitId ?? null,
          lease.runtimeInstanceId ?? null,
          lease.fencingToken ?? null,
          lease.workspaceId,
        );
      return Number(result.changes) === 1 ? lease : undefined;
    } catch {
      return undefined;
    }
  }

  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerLevelType, ownerId: string, releasedAt: string): number {
    if (ownerType !== "workflow_step" && ownerType !== "system") {
      throw new Error("Owner-level resource lease release requires workflow_step or system ownership");
    }
    const result = this.context.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'released', released_at = ?, release_reason = COALESCE(release_reason, 'released')
        WHERE owner_type = ? AND owner_id = ? AND status = 'active' AND attempt_id IS NULL
      `)
      .run(releasedAt, ownerType, ownerId);
    return Number(result.changes);
  }

  /** Release only the captured lease, never a successor sharing its logical owner. */
  releaseResourceLease(id: string, ownerType: ResourceLeaseOwnerLevelType, ownerId: string, releasedAt: string): number {
    if (ownerType !== "workflow_step" && ownerType !== "system") {
      throw new Error("Exact resource lease release requires workflow_step or system ownership");
    }
    const result = this.context.database.prepare(`
      UPDATE resource_leases SET status = 'released', released_at = ?, release_reason = COALESCE(release_reason, 'released')
      WHERE id = ? AND owner_type = ? AND owner_id = ? AND status = 'active' AND attempt_id IS NULL
    `).run(releasedAt, id, ownerType, ownerId);
    return Number(result.changes);
  }

  renewResourceLeasesForAttempt(fence: RuntimeAttemptFenceV1, renewal: RuntimeResourceRenewal): number {
    assertRuntimeResourceRenewal(renewal);
    const result = this.context.database
      .prepare(`
        UPDATE resource_leases
        SET last_renewed_at = MAX(COALESCE(last_renewed_at, acquired_at), ?), expires_at = MAX(expires_at, ?)
        WHERE work_unit_id = ?
          AND attempt_id = ?
          AND runtime_instance_id = ?
          AND fencing_token = ?
          AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM work_unit_attempts AS attempts
            JOIN work_units AS units ON units.id = attempts.work_unit_id
            WHERE attempts.id = resource_leases.attempt_id
              AND attempts.work_unit_id = resource_leases.work_unit_id
              AND attempts.runtime_instance_id = resource_leases.runtime_instance_id
              AND attempts.fencing_token = resource_leases.fencing_token
              AND units.active_attempt_id = attempts.id
              AND units.workspace_id = resource_leases.workspace_id
              AND attempts.status IN ('created','started','waiting_for_approval','cancelling')
          )
      `)
      .run(renewal.renewedAt, renewal.expiresAt, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken);
    return Number(result.changes);
  }

  releaseResourceLeasesForAttempt(fence: RuntimeAttemptFenceV1, releasedAt: string, releaseReason: string): number {
    return withCancelledAttemptResourceVeto(this.context.database, fence, releasedAt, () => {
      const result = this.context.database
        .prepare(`
        UPDATE resource_leases
        SET status = 'released', released_at = ?, release_reason = ?
        WHERE work_unit_id = ?
          AND attempt_id = ?
          AND runtime_instance_id = ?
          AND fencing_token = ?
          AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM work_unit_attempts AS attempts
            JOIN work_units AS units ON units.id = attempts.work_unit_id
            WHERE attempts.id = resource_leases.attempt_id
              AND attempts.work_unit_id = resource_leases.work_unit_id
              AND attempts.runtime_instance_id = resource_leases.runtime_instance_id
              AND attempts.fencing_token = resource_leases.fencing_token
              AND units.active_attempt_id = attempts.id
          )
        `)
        .run(
          releasedAt,
          releaseReason,
          fence.workUnitId,
          fence.attemptId,
          fence.runtimeInstanceId,
          fence.fencingToken,
        );
      return Number(result.changes);
    });
  }

  expireResourceLeases(now: string): number {
    const rows = this.context.database.prepare(`
      SELECT id, work_unit_id, attempt_id, runtime_instance_id, fencing_token
      FROM resource_leases
      WHERE status = 'active' AND expires_at <= ?
        AND (
          (owner_type IN ('workflow_step','system') AND work_unit_id IS NULL AND attempt_id IS NULL
            AND runtime_instance_id IS NULL AND fencing_token IS NULL)
          OR EXISTS (
            SELECT 1 FROM work_unit_attempts AS attempts
            JOIN work_units AS units ON units.id = attempts.work_unit_id
            WHERE attempts.id = resource_leases.attempt_id
              AND attempts.work_unit_id = resource_leases.work_unit_id
              AND attempts.runtime_instance_id = resource_leases.runtime_instance_id
              AND attempts.fencing_token = resource_leases.fencing_token
              AND units.workspace_id = resource_leases.workspace_id
              AND attempts.status IN ('succeeded','failed','cancelled','lost','yielded')
              AND attempts.ended_at IS NOT NULL
          )
        )
      ORDER BY id
    `).all(now) as Record<string, SQLOutputValue>[];
    let count = 0;
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : undefined;
      if (!id) continue;
      if (row.attempt_id === null) {
        count += Number(this.context.database.prepare(`
          UPDATE resource_leases
          SET status = 'expired', released_at = ?, release_reason = COALESCE(release_reason, 'expired')
          WHERE id = ? AND status = 'active' AND expires_at <= ?
            AND owner_type IN ('workflow_step','system') AND work_unit_id IS NULL AND attempt_id IS NULL
            AND runtime_instance_id IS NULL AND fencing_token IS NULL
        `).run(now, id, now).changes);
        continue;
      }
      if (typeof row.work_unit_id !== "string" || typeof row.attempt_id !== "string"
        || typeof row.runtime_instance_id !== "string" || typeof row.fencing_token !== "string") continue;
      const fence = { workUnitId: row.work_unit_id, attemptId: row.attempt_id,
        runtimeInstanceId: row.runtime_instance_id, fencingToken: row.fencing_token };
      count += withCancelledAttemptResourceVeto(this.context.database, fence, now, () =>
        Number(this.context.database.prepare(`
          UPDATE resource_leases
          SET status = 'expired', released_at = ?, release_reason = COALESCE(release_reason, 'expired')
          WHERE id = ? AND status = 'active' AND expires_at <= ?
            AND work_unit_id = ? AND attempt_id = ? AND runtime_instance_id = ? AND fencing_token = ?
            AND EXISTS (
              SELECT 1 FROM work_unit_attempts AS attempts
              JOIN work_units AS units ON units.id = attempts.work_unit_id
              WHERE attempts.id = resource_leases.attempt_id
                AND attempts.work_unit_id = resource_leases.work_unit_id
                AND attempts.runtime_instance_id = resource_leases.runtime_instance_id
                AND attempts.fencing_token = resource_leases.fencing_token
                AND units.workspace_id = resource_leases.workspace_id
                AND attempts.status IN ('succeeded','failed','cancelled','lost','yielded')
                AND attempts.ended_at IS NOT NULL
            )
        `).run(now, id, now, fence.workUnitId, fence.attemptId, fence.runtimeInstanceId, fence.fencingToken).changes));
    }
    return count;
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

function isValidResourceLeaseInput(input: CreateResourceLeaseInput): boolean {
  if (input.ownerType === "run" || input.ownerType === "work_unit_attempt") {
    return isNonEmptyString(input.workUnitId)
      && isNonEmptyString(input.attemptId)
      && isNonEmptyString(input.runtimeInstanceId)
      && isNonEmptyString(input.fencingToken);
  }
  return input.workUnitId === undefined
    && input.attemptId === undefined
    && input.runtimeInstanceId === undefined
    && input.fencingToken === undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

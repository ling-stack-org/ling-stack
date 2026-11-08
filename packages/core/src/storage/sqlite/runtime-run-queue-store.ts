import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SQLOutputValue } from "node:sqlite";
import type { RunStore } from "../../run-types.js";
import type { RuntimeAttemptFenceV1 } from "../../runtime-supervisor-types.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import type { ClaimNextRuntimeRunInput, DispatchRuntimeQueuedRunInput, DispatchRuntimeQueuedRunResult,
  EnqueueRuntimeRunInput, RuntimeRunQueueClaim, RuntimeRunQueueEntry, RuntimeRunQueueStore } from "../../runtime-run-queue-types.js";
import { readNumber, readString, rollbackOwnedSqliteTransaction } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";
import type { SqliteRuntimeSemaphoreStore } from "./runtime-semaphore-store.js";
import type { SqliteRuntimeHostCapacityStore } from "./runtime-host-capacity-store.js";

type Ports = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt" | "getTask" | "getChannel" | "getAiTeammate" | "acquireResourceLease"
  | "transitionTaskStatus" | "transitionWorkUnitStatus" | "getRuntimeConcurrencyPolicy"
  | "findStateTransitionByIdempotency" | "appendRuntimeEvent">;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new TypeError(`Invalid runtime queue ${label}.`);
}
function timestamp(value: unknown): asserts value is string {
  text(value, "timestamp");
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new RangeError("Invalid runtime queue timestamp.");
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new RangeError("Invalid runtime queue integer.");
}
function validateFence(fence: RuntimeAttemptFenceV1): void {
  for (const key of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const) text(fence?.[key], key);
}
function reason(value: unknown): void {
  if (value !== "resource_conflict" && value !== "runtime_semaphore_conflict") throw new TypeError("Invalid runtime queue reason.");
}
function mapEntry(row: Record<string, SQLOutputValue>): RuntimeRunQueueEntry {
  const sourceFence = { workUnitId: readString(row, "work_unit_id"), attemptId: readString(row, "attempt_id"),
    runtimeInstanceId: readString(row, "runtime_instance_id"), fencingToken: readString(row, "fencing_token") };
  const runId = readString(row, "run_id"), revision = readNumber(row, "revision");
  return { sequence: readNumber(row, "sequence"), runId, workspaceId: readString(row, "workspace_id"), sourceFence,
    snapshotDigest: readString(row, "snapshot_digest"), groupKey: readString(row, "group_key"), queuedAt: readString(row, "queued_at"),
    reason: readString(row, "reason") as RuntimeRunQueueEntry["reason"], revision, lastSelected: readNumber(row, "last_selected"),
    ...(typeof row.claim_owner_id === "string" ? { claim: { runId, revision, sourceFence, ownerId: row.claim_owner_id,
      token: readString(row, "claim_token"), runtimeInstanceId: readString(row, "claim_runtime_instance_id") },
      claimExpiresAt: readString(row, "claim_expires_at") } : {}),
    ...(typeof row.retry_at === "string" ? { retryAt: row.retry_at } : {}),
    ...(typeof row.dispatched_at === "string" ? { dispatchedAt: row.dispatched_at } : {}),
  };
}

/** Preparation claims hold no execution resources; admission and the dispatch gate commit together. */
export class SqliteRuntimeRunQueueStore implements RuntimeRunQueueStore {
  constructor(private readonly context: SqliteStoreContext, private readonly ports: Ports,
    private readonly semaphores: Pick<SqliteRuntimeSemaphoreStore, "ensureRuntimeSemaphoreSlotForAttemptWithinTransaction">,
    private readonly hostCapacity: (workspaceId: string) => Pick<SqliteRuntimeHostCapacityStore, "consumeDispatchGateWithinTransaction">) {}

  getRuntimeRunQueueEntry(runId: string): RuntimeRunQueueEntry | undefined {
    text(runId, "runId");
    const row = this.context.database.prepare("SELECT * FROM runtime_run_queue WHERE run_id=?").get(runId);
    return row ? mapEntry(row) : undefined;
  }

  enqueueRuntimeRun(input: EnqueueRuntimeRunInput): ReturnType<RuntimeRunQueueStore["enqueueRuntimeRun"]> {
    text(input.runId, "runId"); validateFence(input.sourceFence); timestamp(input.now); reason(input.reason);
    return this.write<ReturnType<RuntimeRunQueueStore["enqueueRuntimeRun"]>>(() => {
      const source = this.source(input.runId, input.sourceFence);
      if (!source || !this.isPrestart(source)) return { status: "changed" };
      const existing = this.getRuntimeRunQueueEntry(input.runId);
      if (existing) return existing.snapshotDigest === source.digest && isDeepStrictEqual(existing.sourceFence, input.sourceFence)
        ? { status: "duplicate", entry: existing } : { status: "changed" };
      if (this.hasResources(input.sourceFence)) return { status: "changed" };
      this.context.database.prepare(`INSERT INTO runtime_run_queue
        (run_id,workspace_id,work_unit_id,attempt_id,runtime_instance_id,fencing_token,snapshot_digest,group_key,queued_at,reason)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.runId, source.unit.workspaceId, input.sourceFence.workUnitId,
          input.sourceFence.attemptId, input.sourceFence.runtimeInstanceId, input.sourceFence.fencingToken,
          source.digest, source.groupKey, input.now, input.reason);
      const entry = this.getRuntimeRunQueueEntry(input.runId)!;
      integer(entry.sequence, 1);
      return { status: "enqueued", entry };
    });
  }

  claimNextRuntimeRun(input: ClaimNextRuntimeRunInput): ReturnType<RuntimeRunQueueStore["claimNextRuntimeRun"]> {
    text(input.workspaceId, "workspaceId"); text(input.runtimeInstanceId, "runtimeInstanceId"); text(input.ownerId, "ownerId");
    if (input.runId !== undefined) text(input.runId, "runId");
    integer(input.leaseMs, 1, 60_000); timestamp(input.now);
    const expiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    let deferredInvalidHead = false;
    return this.write<ReturnType<RuntimeRunQueueStore["claimNextRuntimeRun"]>>(() => {
      const policy = this.ports.getRuntimeConcurrencyPolicy(input.workspaceId);
      if (!policy || policy.runtimeInstanceId !== input.runtimeInstanceId) return { status: "changed" };
      // Group FIFO and a persisted least-recently-selected group order survive new Stores and processes.
      const select = this.context.database.prepare(`SELECT q.* FROM runtime_run_queue q
        JOIN run_sessions r ON r.id=q.run_id JOIN work_units u ON u.id=q.work_unit_id
        JOIN work_unit_attempts a ON a.id=q.attempt_id
        WHERE q.workspace_id=? AND q.dispatched_at IS NULL AND r.status='queued' AND r.ended_at IS NULL
          AND u.status='queued' AND u.ended_at IS NULL AND u.active_attempt_id=a.id
          AND a.status='created' AND a.ended_at IS NULL AND a.abort_requested_at IS NULL
          AND (q.claim_expires_at IS NULL OR q.claim_expires_at<=?) AND (q.retry_at IS NULL OR q.retry_at<=?)
          AND NOT EXISTS (SELECT 1 FROM runtime_run_queue p JOIN run_sessions pr ON pr.id=p.run_id
            JOIN work_units pu ON pu.id=p.work_unit_id JOIN work_unit_attempts pa ON pa.id=p.attempt_id
            WHERE p.workspace_id=q.workspace_id AND p.group_key=q.group_key AND p.sequence<q.sequence
              AND p.dispatched_at IS NULL AND pr.status='queued' AND pr.ended_at IS NULL
              AND pu.status='queued' AND pu.ended_at IS NULL AND pu.active_attempt_id=pa.id
              AND pa.status='created' AND pa.ended_at IS NULL AND pa.abort_requested_at IS NULL)
        ORDER BY (SELECT MAX(g.last_selected) FROM runtime_run_queue g
          WHERE g.workspace_id=q.workspace_id AND g.group_key=q.group_key),q.sequence LIMIT 1`);
      let before: RuntimeRunQueueEntry | undefined;
      // Invalid heads remain visible, but cannot monopolize arbitration for unrelated groups.
      for (let inspected = 0; inspected < 64; inspected++) {
        const row = select.get(input.workspaceId, input.now, input.now);
        if (!row || input.runId !== undefined && row.run_id !== input.runId) return { status: "empty" };
        const candidate = mapEntry(row), source = this.source(candidate.runId, candidate.sourceFence);
        if (source && this.isPrestart(source) && source.digest === candidate.snapshotDigest && !this.hasResources(candidate.sourceFence)) {
          before = candidate;
          break;
        }
        this.context.database.prepare("UPDATE runtime_run_queue SET retry_at=? WHERE run_id=? AND revision=? AND dispatched_at IS NULL")
          .run(new Date(Date.parse(input.now) + 60_000).toISOString(), candidate.runId, candidate.revision);
        deferredInvalidHead = true;
      }
      if (!before) return { status: "changed" };
      const selected = Number(this.context.database.prepare("SELECT MAX(last_selected) AS n FROM runtime_run_queue WHERE workspace_id=?")
        .get(input.workspaceId)?.n ?? 0) + 1;
      integer(selected, 1); integer(before.revision + 1, 1);
      this.context.database.prepare(`UPDATE runtime_run_queue SET revision=revision+1,last_selected=?,claim_owner_id=?,claim_token=?,
        claim_runtime_instance_id=?,claim_expires_at=?,retry_at=NULL WHERE run_id=? AND revision=? AND dispatched_at IS NULL`)
        .run(selected, input.ownerId, randomUUID(), input.runtimeInstanceId, expiresAt, before.runId, before.revision);
      const entry = this.getRuntimeRunQueueEntry(before.runId)!;
      return { status: "claimed", entry, claim: entry.claim! };
    }, () => deferredInvalidHead);
  }

  deferRuntimeQueuedRun(input: Parameters<RuntimeRunQueueStore["deferRuntimeQueuedRun"]>[0]): boolean {
    this.validateClaim(input.claim); timestamp(input.now); timestamp(input.retryAt); reason(input.reason);
    if (input.retryAt <= input.now || Date.parse(input.retryAt) - Date.parse(input.now) > 3_600_000) throw new RangeError("Invalid runtime queue retry.");
    return this.write<boolean>(() => {
      const entry = this.currentClaim(input.claim, input.now);
      if (!entry || this.hasResources(entry.sourceFence)) return false;
      integer(entry.revision + 1, 1);
      const result = this.context.database.prepare(`UPDATE runtime_run_queue SET revision=revision+1,reason=?,retry_at=?,
        claim_owner_id=NULL,claim_token=NULL,claim_runtime_instance_id=NULL,claim_expires_at=NULL
        WHERE run_id=? AND revision=? AND dispatched_at IS NULL`).run(input.reason, input.retryAt, entry.runId, entry.revision);
      return Number(result.changes) === 1;
    });
  }

  dispatchRuntimeQueuedRun(input: DispatchRuntimeQueuedRunInput): DispatchRuntimeQueuedRunResult {
    this.validateClaim(input.claim); timestamp(input.now);
    return this.write<DispatchRuntimeQueuedRunResult>(() => {
      const entry = this.currentClaim(input.claim, input.now), source = entry && this.source(entry.runId, entry.sourceFence);
      if (!entry || !source || !this.isPrestart(source) || source.digest !== entry.snapshotDigest
        || this.hasResources(entry.sourceFence) || !this.validResources(input, entry, source)) return { status: "changed" };
      const hostIntent = this.context.database.prepare("SELECT intent_id FROM runtime_host_capacity_intents WHERE attempt_id=?")
        .get(entry.sourceFence.attemptId);
      if (hostIntent ? !input.hostCapacity || hostIntent.intent_id !== input.hostCapacity.intentId
        : input.hostCapacity !== undefined) return { status: "changed" };
      const leases = [];
      for (const candidate of input.leases) {
        const acquired = this.ports.acquireResourceLease(candidate);
        if (!acquired) return { status: "busy", reason: "resource_conflict" };
        leases.push(acquired);
      }
      const semaphores = [];
      for (const candidate of input.semaphores) {
        const acquired = this.semaphores.ensureRuntimeSemaphoreSlotForAttemptWithinTransaction(candidate);
        if (acquired.status !== "acquired") return acquired.status === "full"
          ? { status: "busy", reason: "runtime_semaphore_conflict" } : { status: "changed" };
        semaphores.push(acquired.slot);
      }
      if (hostIntent && (!input.hostCapacity || !this.hostCapacity(entry.workspaceId).consumeDispatchGateWithinTransaction({
        intentId: input.hostCapacity.intentId, token: input.hostCapacity.dispatchToken,
        source: { runId: entry.runId, ...entry.sourceFence }, now: input.now,
      }))) return { status: "changed" };
      const task = this.ports.getTask(source.run.taskId);
      if (task) {
        if (task.status !== "todo" && task.status !== "failed") return { status: "changed" };
        const idempotencyKey = (source.run.requestSnapshot as Record<string, unknown>).idempotencyKey;
        if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey
          || this.ports.findStateTransitionByIdempotency("task", task.id, idempotencyKey))) return { status: "changed" };
        const claimed = this.ports.transitionTaskStatus({ taskId: task.id, expectedStatus: task.status,
          event: task.status === "todo" ? "claim" : "retry", actor: "system", reason: `run:${entry.runId}`,
          currentRunId: entry.runId, idempotencyKey: idempotencyKey as string | undefined, now: input.now });
        if (!claimed.ok) return { status: "changed" };
      }
      const claimed = this.ports.transitionWorkUnitStatus({ ...entry.sourceFence, expectedStatus: "queued", event: "claim",
        actor: "system", now: input.now, activeAttemptId: entry.sourceFence.attemptId });
      if (!claimed.ok) return { status: "changed" };
      this.ports.appendRuntimeEvent({ ...entry.sourceFence, type: "work_unit_claimed", actor: "system",
        ts: input.now, data: { runId: entry.runId } });
      integer(entry.revision + 1, 1);
      const dispatched = this.context.database.prepare("UPDATE runtime_run_queue SET revision=revision+1,dispatched_at=? WHERE run_id=? AND revision=? AND dispatched_at IS NULL")
        .run(input.now, entry.runId, entry.revision);
      if (Number(dispatched.changes) !== 1) return { status: "changed" };
      return { status: "admitted", entry: this.getRuntimeRunQueueEntry(entry.runId)!, leases, semaphores };
    });
  }

  hasRuntimeRunQueueCustody(runId: string): boolean {
    const entry = this.getRuntimeRunQueueEntry(runId);
    if (!entry) return false;
    const source = this.source(runId, entry.sourceFence);
    if (!source || source.digest !== entry.snapshotDigest) return false;
    return entry.dispatchedAt ? ["queued", "running", "waiting_for_approval"].includes(source.run.status)
      && ["claimed", "running", "waiting_for_approval", "cancelling"].includes(source.unit.status)
      && ["created", "started", "waiting_for_approval", "cancelling"].includes(source.attempt.status)
      && !source.run.endedAt && !source.unit.endedAt && !source.attempt.endedAt : this.isPrestart(source);
  }

  private source(runId: string, fence: RuntimeAttemptFenceV1) {
    const run = this.ports.getRun(runId), unit = this.ports.getWorkUnit(fence.workUnitId), attempt = this.ports.getWorkUnitAttempt(fence.attemptId);
    if (!run || !unit || !attempt || run.workUnitId !== unit.id || unit.linkedRunId !== run.id || unit.activeAttemptId !== attempt.id
      || unit.attemptCount !== 1 || attempt.attemptNumber !== 1 || !isDeepStrictEqual(toRuntimeAttemptFence(attempt), fence)
      || !["task_run", "conversation_run", "teammate_direct_reply"].includes(unit.kind) || unit.ownerType === "delegation_step"
      || run.workflowStepId || run.parentRunId || run.continuationReason || run.interventionId
      || !record(run.requestSnapshot) || !record(unit.request) || !record(run.requestSnapshot.effectivePolicySnapshot)
      || !record(run.requestSnapshot.runnerExecutionInput) || run.requestSnapshot.runnerExecutionInput.schemaVersion !== 1
      || run.requestSnapshot.runnerExecutionInput.runnerId !== "pi" || !record(run.requestSnapshot.runnerExecutionInput.input)
      || !Array.isArray(run.requestSnapshot.runnerExecutionInput.input.tools)
      || !isDeepStrictEqual(run.requestSnapshot.runnerExecutionInput, unit.request.runnerExecutionInput)
      || !isDeepStrictEqual(run.requestSnapshot.effectivePolicySnapshot, unit.request.effectivePolicySnapshot)) return undefined;
    const groupKey = run.channelId ? `channel:${run.channelId}` : run.threadId ? `thread:${run.threadId}` : `owner:${unit.ownerType}:${unit.ownerId}`;
    const digest = createHash("sha256").update(JSON.stringify({ runId, cwd: run.cwd, taskId: run.taskId, channelId: run.channelId,
      threadId: run.threadId, providerPresetId: run.providerPresetId, providerName: run.providerName,
      providerModel: run.providerModel, selectedSkillId: run.selectedSkillId, task: run.taskSnapshot,
      provider: run.providerSnapshot, request: run.requestSnapshot, unitRequest: unit.request })).digest("hex");
    return { run, unit, attempt, groupKey, digest };
  }

  private isPrestart(source: NonNullable<ReturnType<SqliteRuntimeRunQueueStore["source"]>>): boolean {
    return source.run.status === "queued" && source.unit.status === "queued" && source.attempt.status === "created"
      && !source.run.startedAt && !source.run.endedAt && !source.unit.startedAt && !source.unit.endedAt
      && !source.attempt.startedAt && !source.attempt.endedAt && !source.attempt.abortRequestedAt;
  }

  private currentClaim(claim: RuntimeRunQueueClaim, now: string): RuntimeRunQueueEntry | undefined {
    const entry = this.getRuntimeRunQueueEntry(claim.runId);
    if (!entry?.claim || entry.dispatchedAt || !entry.claimExpiresAt || entry.claimExpiresAt <= now
      || !isDeepStrictEqual(entry.claim, claim)) return undefined;
    const policy = this.ports.getRuntimeConcurrencyPolicy(entry.workspaceId);
    return policy?.runtimeInstanceId === claim.runtimeInstanceId ? entry : undefined;
  }

  private hasResources(fence: RuntimeAttemptFenceV1): boolean {
    return Boolean(this.context.database.prepare(`SELECT 1 FROM resource_leases WHERE attempt_id=? AND status='active'
      UNION ALL SELECT 1 FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active' LIMIT 1`).get(fence.attemptId, fence.attemptId));
  }

  private validResources(input: DispatchRuntimeQueuedRunInput, entry: RuntimeRunQueueEntry,
    source: NonNullable<ReturnType<SqliteRuntimeRunQueueStore["source"]>>): boolean {
    const matches = (value: RuntimeAttemptFenceV1 & { workspaceId: string; acquiredAt: string; expiresAt: string }) =>
      value.workUnitId === entry.sourceFence.workUnitId && value.attemptId === entry.sourceFence.attemptId
      && value.runtimeInstanceId === entry.sourceFence.runtimeInstanceId && value.fencingToken === entry.sourceFence.fencingToken
      && value.workspaceId === entry.workspaceId && value.acquiredAt === input.now
      && Number.isFinite(Date.parse(value.expiresAt)) && new Date(value.expiresAt).toISOString() === value.expiresAt
      && value.expiresAt > input.now && Date.parse(value.expiresAt) - Date.parse(input.now) <= 6 * 60 * 60 * 1000;
    const providerKey = source.run.providerPresetId ?? `${source.run.providerName}:${source.run.providerModel}`;
    const channel = source.run.channelId ? this.ports.getChannel(source.run.channelId) : undefined;
    if (source.run.channelId && (!channel || channel.status !== "active")) return false;
    const teammate = source.run.teammateId ? this.ports.getAiTeammate(source.run.teammateId) : undefined;
    if (source.run.teammateId && (!teammate || teammate.status !== "active" || teammate.hidden)) return false;
    const expectedLeases = new Map<string, string>();
    if (this.ports.getTask(source.run.taskId)) expectedLeases.set("task", source.run.taskId);
    const execution = (source.run.requestSnapshot as Record<string, unknown>).runnerExecutionInput as { input: { tools: unknown[] } };
    if (execution.input.tools.some(tool => tool === "bash" || tool === "edit" || tool === "write")) {
      const scope = channel?.runtimePolicy.writeLockScope ?? "boundPath";
      if (scope === "workspace" || scope === "channel" && !channel) expectedLeases.set("workspace", entry.workspaceId);
      else if (scope === "channel" && channel) expectedLeases.set("channel", channel.id);
      else {
        let path = resolve(source.run.cwd);
        try { path = realpathSync.native(path); } catch { /* Unavailable paths retain their absolute identity. */ }
        expectedLeases.set("bound_path", path);
      }
    }
    if (input.leases.some(value => !matches(value as typeof value & RuntimeAttemptFenceV1)
        || value.ownerType !== "run" || value.ownerId !== entry.runId || expectedLeases.get(value.resourceType) !== value.resourceKey)
      || input.leases.length !== expectedLeases.size
      || input.semaphores.some(value => !matches(value) || value.ownerType !== "work_unit_attempt" || value.ownerId !== entry.sourceFence.attemptId
        || value.limit !== (value.resourceType === "channel_parallel" ? channel?.runtimePolicy.maxConcurrentRuns : 4))
      || new Set(input.leases.map(value => `${value.resourceType}:${value.resourceKey}`)).size !== input.leases.length
      || new Set(input.semaphores.map(value => value.resourceType)).size !== input.semaphores.length) return false;
    return input.semaphores.length === (source.run.channelId ? 3 : 2)
      && input.semaphores.some(value => value.resourceType === "provider" && value.resourceKey === providerKey)
      && input.semaphores.some(value => value.resourceType === "runner" && value.resourceKey === (source.attempt.effectiveRunnerId ?? source.attempt.runnerId))
      && (!source.run.channelId || input.semaphores.some(value => value.resourceType === "channel_parallel" && value.resourceKey === source.run.channelId));
  }

  private validateClaim(claim: RuntimeRunQueueClaim): void {
    text(claim?.runId, "runId"); text(claim.ownerId, "ownerId"); text(claim.token, "claimToken");
    text(claim.runtimeInstanceId, "runtimeInstanceId"); integer(claim.revision, 1); validateFence(claim.sourceFence);
  }

  private write<T>(action: () => T, persistDeferredHeads?: () => boolean): T {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      const commit = typeof result === "boolean" ? result : persistDeferredHeads?.()
        || record(result) && ["enqueued", "duplicate", "claimed", "admitted"].includes(String(result.status));
      this.context.database.exec(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      rollbackOwnedSqliteTransaction(this.context.database);
      throw error;
    }
  }
}

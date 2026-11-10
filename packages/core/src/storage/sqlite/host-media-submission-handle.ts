import { isDeepStrictEqual } from "node:util";
import type { HostMediaExecutionRecord } from "../../host-media-operation-types.js";
import type { HostMediaSubmission, HostMediaSubmissionExecutionProjection } from "../../host-media-receipt-types.js";
import type { MediaJobExecutionHandle } from "../../media-types.js";
import { redactSecrets } from "../../redaction.js";
import { hostOperationTimestamp } from "./host-operation-journal-evidence.js";
import { mediaFactFailure } from "./host-media-operation-records.js";
import { SqliteMediaStore } from "./media-store.js";
import type { SqliteStoreContext } from "./store-context.js";

const invalid = (): never => mediaFactFailure("host_media_handle_projection_invalid");
const conflict = (): never => mediaFactFailure("host_media_handle_projection_conflict");

/** Fixed caller-data snapshot, outside the journal writer. No toJSON/getter/function can run under its lock. */
export function snapshotMediaSubmissionProjection(input: HostMediaSubmissionExecutionProjection): HostMediaSubmissionExecutionProjection {
  if (!plainRecord(input) || Reflect.ownKeys(input).some(key => typeof key !== "string"
    || !["recovery", "nextPollAt", "pollAttempts"].includes(key))) return invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Object.values(fields).some(field => field.get || field.set)) return invalid();
  const recovery = fields.recovery?.value, nextPollAt = fields.nextPollAt?.value, pollAttempts = fields.pollAttempts?.value;
  if (!plainRecord(recovery) || (nextPollAt !== undefined && nextPollAt !== null && typeof nextPollAt !== "string")
    || (pollAttempts !== undefined && (!Number.isSafeInteger(pollAttempts) || pollAttempts < 0))) return invalid();
  if (typeof nextPollAt === "string") hostOperationTimestamp(nextPollAt);
  return Object.freeze({ recovery: snapshotJson(recovery, new Set(), 0) as Readonly<Record<string, unknown>>,
    ...(nextPollAt === undefined ? {} : { nextPollAt }), ...(pollAttempts === undefined ? {} : { pollAttempts }) });
}

/** Called only by the fixed receipt writer in the original-source journal's existing transaction. No nested BEGIN. */
export function writeMediaSubmissionExecutionHandle(context: SqliteStoreContext, execution: HostMediaExecutionRecord,
  submission: HostMediaSubmission, projection: HostMediaSubmissionExecutionProjection): void {
  const fence = execution.childFence;
  if (!fence || execution.finalizationArtifactId) return conflict();
  const child = context.database.prepare(`SELECT attempt.id FROM work_units unit
    JOIN work_unit_attempts attempt ON attempt.id=unit.active_attempt_id
    WHERE unit.id=? AND attempt.id=? AND attempt.work_unit_id=unit.id AND attempt.runtime_instance_id=?
      AND attempt.fencing_token=? AND attempt.ended_at IS NULL AND attempt.abort_requested_at IS NULL
      AND attempt.status IN ('created','started','waiting_for_approval')
      AND unit.status IN ('queued','claimed','running','waiting_for_approval')`).get(fence.workUnitId, fence.attemptId,
        fence.runtimeInstanceId, fence.fencingToken);
  if (!child) return mediaFactFailure("host_media_child_stale");
  const media = new SqliteMediaStore(context), existing = media.getMediaJobExecutionHandle(execution.mediaJobId);
  const recovery = redactSecrets(projection.recovery) as Record<string, unknown>;
  const nextPollAt = projection.nextPollAt === undefined ? existing?.nextPollAt : projection.nextPollAt ?? undefined;
  const pollAttempts = projection.pollAttempts ?? existing?.pollAttempts ?? 0;
  const pending = existing?.externalOperationId === `ling-pending:${execution.mediaJobId}`
    && existing.recovery.phase === "waiting_for_submission";
  if (existing) {
    if (existing.adapterKind !== execution.adapterId || existing.workUnitId !== fence.workUnitId || existing.attemptId !== fence.attemptId
      || (!pending && existing.externalOperationId !== submission.externalOperationId)) return conflict();
    if (!pending) {
      if (!sameProjection(existing, recovery, nextPollAt, pollAttempts)) return conflict();
      return; // Exact retry must not rewrite polling progress or its timestamps.
    }
  }
  const handle = media.upsertMediaJobExecutionHandle({ mediaJobId: execution.mediaJobId, adapterKind: execution.adapterId,
    externalOperationId: submission.externalOperationId, workUnitId: fence.workUnitId, attemptId: fence.attemptId,
    recovery, nextPollAt: nextPollAt ?? null, pollAttempts }, new Date().toISOString());
  if (handle.mediaJobId !== execution.mediaJobId || handle.adapterKind !== execution.adapterId
    || handle.externalOperationId !== submission.externalOperationId || handle.workUnitId !== fence.workUnitId
    || handle.attemptId !== fence.attemptId || !sameProjection(handle, recovery, nextPollAt, pollAttempts)) return conflict();
}

function sameProjection(handle: MediaJobExecutionHandle, recovery: Record<string, unknown>, nextPollAt: string | undefined,
  pollAttempts: number): boolean {
  return isDeepStrictEqual(handle.recovery, recovery) && handle.nextPollAt === nextPollAt && handle.pollAttempts === pollAttempts;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function snapshotJson(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalid();
  if (!value || typeof value !== "object" || depth > 64 || ancestors.has(value)
    || (!Array.isArray(value) && !plainRecord(value))) return invalid();
  ancestors.add(value);
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string") || Object.values(fields).some(field => field.get || field.set)) return invalid();
    if (Array.isArray(value)) {
      if (Object.keys(fields).some(key => key !== "length" && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) return invalid();
      const copy = [];
      for (let index = 0; index < value.length; index++) {
        if (!fields[String(index)]) return invalid();
        copy.push(snapshotJson(fields[String(index)].value, ancestors, depth + 1));
      }
      return Object.freeze(copy);
    }
    const copy: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(fields)) {
      if (!field.enumerable) return invalid();
      Object.defineProperty(copy, key, { value: snapshotJson(field.value, ancestors, depth + 1), enumerable: true });
    }
    return Object.freeze(copy);
  } finally { ancestors.delete(value); }
}

import type { SQLOutputValue } from "node:sqlite";
import { approvalSideEffectFingerprintV1, isApprovalResumeBasisV1,
  type LingApprovalCheckpoint } from "../../approval-checkpoints.js";
import type { HostAttemptCompletionRecord } from "../../host-attempt-completion-types.js";
import type { HostOperationSource } from "../../host-operation-journal-types.js";
import type { RunStore } from "../../run-types.js";
import type { UserInputYieldCheckpoint } from "../../user-input-wait-types.js";
import { hostAttemptReadScopeForSource } from "./host-attempt-read-scope.js";
import type { SqliteStoreContext } from "./store-context.js";
import { assertUserInputDurableQuiescence } from "./user-input-durable-quiescence.js";
import { mapUserInputRequest, userInputHash } from "./user-input-records.js";
import { assertUserInputQuiescence } from "./user-input-wait-evidence.js";

export type RuntimeHostCapacityStopProofPorts = Pick<RunStore,
  "getHostAttemptCompletion" | "getUserInputWait" | "getApprovalCheckpoint" | "getApprovalRequest">;

export interface RuntimeHostCapacityStopProofInput {
  readonly source: HostOperationSource;
  readonly dispatchedAt: string;
  readonly now: string;
}

interface StopAudit {
  readonly id: string;
  readonly seq: number;
  readonly ts: string;
  readonly source: HostOperationSource;
}
interface StopCommit {
  readonly seq: number;
  readonly ts: string;
  readonly idempotencyKey: string;
}
export type RuntimeHostCapacityPausedStopWitness = {
  readonly schemaVersion: 1;
  readonly kind: "user_input_yield";
  readonly waitRevision: number;
  readonly checkpoint: UserInputYieldCheckpoint;
  readonly checkpointFingerprint: string;
  readonly audit: StopAudit;
  readonly commit: StopCommit;
} | {
  readonly schemaVersion: 1;
  readonly kind: "approval_suspension";
  readonly suspendedRevision: number;
  readonly checkpoint: LingApprovalCheckpoint;
  readonly audit: StopAudit;
  readonly commit: StopCommit;
};

/** Serializable evidence for the existing stopped-release outbox, not a dispatch capability. */
export interface RuntimeHostCapacityPausedStopProof {
  readonly attemptStatus: "yielded" | "lost";
  readonly attemptStartedAt: string;
  readonly attemptEndedAt: string;
  readonly completion: HostAttemptCompletionRecord;
  readonly settlements: readonly (readonly [string, string])[];
  readonly pausedStop: RuntimeHostCapacityPausedStopWitness;
}

type Row = Record<string, SQLOutputValue>;
const fields = ["runId", "workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"] as const;
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
const integer = (value: unknown, minimum = 1): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const timestamp = (value: unknown): value is string => typeof value === "string" && value.length === 24
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sourceMatches = (value: unknown, source: HostOperationSource): boolean => {
  const candidate = object(value);
  return !!candidate && fields.every(field => text(source[field]) && candidate[field] === source[field]);
};

/** Call in the journal's owning write transaction; logical obligations are exempted only by the exact witness. */
export function readRuntimeHostCapacityPausedStopProof(context: SqliteStoreContext, ports: RuntimeHostCapacityStopProofPorts,
  input: RuntimeHostCapacityStopProofInput): RuntimeHostCapacityPausedStopProof | undefined {
  try {
    const { database } = context, { source, dispatchedAt, now } = input;
    if (!database.isTransaction || !sourceMatches(source, source) || !timestamp(dispatchedAt) || !timestamp(now) || dispatchedAt > now) return undefined;
    const row = database.prepare(`SELECT r.status AS run_status,r.ended_at AS run_ended_at,r.task_id,r.thread_id,r.cwd,
      u.workspace_id,u.status AS unit_status,u.active_attempt_id,
      a.status AS attempt_status,a.started_at AS attempt_started_at,a.ended_at AS attempt_ended_at,
      a.error_code,a.error_message,COALESCE(a.effective_runner_id,a.runner_id) AS runner_id
      FROM run_sessions r JOIN work_units u ON u.id=r.work_unit_id AND u.linked_run_id=r.id
      JOIN work_unit_attempts a ON a.work_unit_id=u.id
      WHERE r.id=? AND u.id=? AND a.id=? AND a.runtime_instance_id=? AND a.fencing_token=?`)
      .get(...fields.map(field => source[field]));
    if (!row || row.runner_id !== "pi" || !["yielded", "lost"].includes(String(row.attempt_status))) return undefined;
    const completion = ports.getHostAttemptCompletion(source);
    const base = { attemptStatus: row.attempt_status, attemptStartedAt: row.attempt_started_at,
      attemptEndedAt: row.attempt_ended_at, completion };
    if (!validLifetime(base, input) || database.prepare(`SELECT 1 FROM resource_leases WHERE attempt_id=? AND status='active'
      UNION ALL SELECT 1 FROM runtime_semaphore_slots WHERE attempt_id=? AND status='active'
      UNION ALL SELECT 1 FROM delegation_budget_charges WHERE (run_id=? OR attempt_id=?)
        AND state NOT IN ('measured','cancelled_before_dispatch') LIMIT 1`)
      .get(source.attemptId, source.attemptId, source.runId, source.attemptId)) return undefined;
    const pausedStop = row.attempt_status === "yielded" ? readYield(context, ports, input, row) : readApproval(context, ports, input, row);
    if (!pausedStop || hasOtherObligations(context, source, pausedStop)) return undefined;
    const settlements = assertUserInputDurableQuiescence(database, source.runId, source, Date.parse(base.attemptEndedAt as string),
      hostAttemptReadScopeForSource(database, source));
    const proof = { ...base, settlements: [...settlements].sort(([left], [right]) => left.localeCompare(right)), pausedStop };
    if (!isRuntimeHostCapacityPausedStopProof(proof, input)) return undefined;
    return JSON.parse(JSON.stringify(proof)) as RuntimeHostCapacityPausedStopProof;
  } catch { return undefined; }
}

/** Validates the frozen outbox evidence without re-resolving a checkpoint that its successor may have advanced. */
export function isRuntimeHostCapacityPausedStopProof(value: unknown, input: RuntimeHostCapacityStopProofInput): value is RuntimeHostCapacityPausedStopProof {
  try {
    const proof = object(value), pause = object(proof?.pausedStop), checkpoint = object(pause?.checkpoint);
    if (!proof || !validLifetime(proof, input) || !pause || pause.schemaVersion !== 1 || !checkpoint
      || !validAudit(pause.audit, input.source) || !validCommit(pause.commit)
      || !Array.isArray(proof.settlements) || proof.settlements.some(entry => !Array.isArray(entry)
        || entry.length !== 2 || !entry.every(text))) return false;
    const audit = pause.audit as StopAudit, commit = pause.commit as StopCommit, endedAt = proof.attemptEndedAt as string;
    if (pause.kind === "user_input_yield") {
      const source = object(checkpoint.source), fence = object(source?.fence), quiescence = object(checkpoint.quiescence);
      return proof.attemptStatus === "yielded" && integer(pause.waitRevision) && checkpoint.schemaVersion === 1
        && text(checkpoint.requestId) && integer(checkpoint.requestVersion) && text(checkpoint.taskId)
        && !!source && source.runId === input.source.runId && !!fence
        && fields.filter(field => field !== "runId").every(field => fence[field] === input.source[field])
        && object(source.taskBinding)?.taskId === checkpoint.taskId && !!quiescence && quiescence.kind === "runner_quiesced"
        && quiescence.runnerId === "pi" && quiescence.stoppedAt === endedAt && integer(quiescence.lastRunEventSeq, 0)
        && timestamp(checkpoint.committedAt) && checkpoint.committedAt >= endedAt && checkpoint.committedAt <= input.now
        && pause.checkpointFingerprint === userInputHash(checkpoint) && audit.ts === checkpoint.committedAt
        && commit.ts === checkpoint.committedAt && commit.idempotencyKey === `user-input-wait:${checkpoint.requestId}:1`;
    }
    if (pause.kind !== "approval_suspension" || proof.attemptStatus !== "lost" || !integer(pause.suspendedRevision, 2)
      || !integer(checkpoint.revision) || checkpoint.revision < pause.suspendedRevision || !text(checkpoint.id)
      || !["pending", "approved"].includes(String(checkpoint.status)) || !isApprovalResumeBasisV1(checkpoint.resumeBasis)
      || !timestamp(checkpoint.createdAt) || checkpoint.createdAt > endedAt || !timestamp(checkpoint.updatedAt)
      || checkpoint.updatedAt < endedAt || checkpoint.updatedAt > input.now) return false;
    const basis = checkpoint.resumeBasis;
    return checkpoint.runId === input.source.runId && basis.runId === input.source.runId
      && basis.workUnitId === input.source.workUnitId && basis.priorAttemptId === input.source.attemptId
      && basis.approvalId === checkpoint.approvalId && basis.toolCallId === checkpoint.toolCallId
      && basis.actionType === checkpoint.actionType && basis.sideEffectFingerprint === approvalSideEffectFingerprintV1({
        actionType: basis.actionType, toolCallId: basis.toolCallId, sideEffect: checkpoint.sideEffect as LingApprovalCheckpoint["sideEffect"] })
      && audit.ts === endedAt && commit.ts === endedAt
      && commit.idempotencyKey === `approval-resume-suspend:approval_wait:${checkpoint.id}:${pause.suspendedRevision - 1}:${input.source.attemptId}:runs`;
  } catch { return false; }
}

function validLifetime(proof: Record<string, unknown>, input: RuntimeHostCapacityStopProofInput): boolean {
  const completion = object(proof.completion);
  return sourceMatches(input.source, input.source) && timestamp(input.dispatchedAt) && timestamp(input.now)
    && ["yielded", "lost"].includes(String(proof.attemptStatus))
    && timestamp(proof.attemptStartedAt) && timestamp(proof.attemptEndedAt)
    && proof.attemptStartedAt >= input.dispatchedAt && proof.attemptEndedAt >= proof.attemptStartedAt
    && !!completion && completion.schemaVersion === 1 && sourceMatches(completion.source, input.source)
    && timestamp(completion.registeredAt) && completion.registeredAt >= proof.attemptStartedAt
    && completion.registeredAt <= proof.attemptEndedAt && timestamp(completion.drainedAt)
    && completion.drainedAt >= proof.attemptEndedAt && completion.drainedAt >= completion.registeredAt
    && completion.drainedAt <= input.now && ["pi_no_tools_v1", "pi_tracked_tools_v1"].includes(String(completion.effectCoverage));
}

function validAudit(value: unknown, source: HostOperationSource): value is StopAudit {
  const audit = object(value);
  return !!audit && text(audit.id) && integer(audit.seq) && timestamp(audit.ts) && sourceMatches(audit.source, source);
}
function validCommit(value: unknown): value is StopCommit {
  const commit = object(value);
  return !!commit && integer(commit.seq) && timestamp(commit.ts) && text(commit.idempotencyKey);
}
function auditWitness(row: Row, source: HostOperationSource): StopAudit {
  return { id: String(row.id), seq: Number(row.seq), ts: String(row.ts), source: { ...source } };
}
function commitWitness(row: Row): StopCommit {
  return { seq: Number(row.seq), ts: String(row.ts), idempotencyKey: String(row.idempotency_key) };
}

function readYield(context: SqliteStoreContext, ports: RuntimeHostCapacityStopProofPorts, input: RuntimeHostCapacityStopProofInput,
  row: Row): Extract<RuntimeHostCapacityPausedStopWitness, { kind: "user_input_yield" }> | undefined {
  const { database } = context, { source } = input;
  if (row.run_status !== "yielded" || row.unit_status !== "waiting_for_input" || row.active_attempt_id !== null
    || row.run_ended_at !== row.attempt_ended_at) return undefined;
  const candidates = database.prepare(`SELECT * FROM user_input_requests WHERE source_run_id=? AND source_attempt_id=?
    AND wait_status IN ('waiting','resuming')`).all(source.runId, source.attemptId);
  if (candidates.length !== 1) return undefined;
  const requestRow = candidates[0]!, request = mapUserInputRequest(requestRow);
  const wait = ports.getUserInputWait(request.source.threadId, request.requestId), checkpoint = wait?.checkpoint;
  if (!wait || !checkpoint || request.waitMode !== "required" || !["pending", "answered"].includes(request.status)
    || userInputHash(checkpoint.source) !== userInputHash(request.source) || checkpoint.requestId !== request.requestId
    || checkpoint.requestVersion !== request.requestVersion || request.source.runId !== source.runId
    || !sourceMatches({ runId: request.source.runId, ...request.source.fence }, source)
    || request.source.workspaceId !== row.workspace_id || request.source.threadId !== row.thread_id
    || request.source.cwd !== row.cwd || checkpoint.taskId !== row.task_id || request.createdAt > checkpoint.quiescence.stoppedAt
    || checkpoint.quiescence.stoppedAt !== row.attempt_ended_at || checkpoint.quiescence.runnerId !== row.runner_id
    || requestRow.wait_checkpoint_fingerprint !== userInputHash(checkpoint)) return undefined;
  assertUserInputQuiescence(database, source.runId, checkpoint.quiescence, checkpoint.committedAt, source);
  const audits = database.prepare(`SELECT id,seq,ts,data_json FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
    AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_waiting_for_input' AND ts=?`).all(
      source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken, checkpoint.committedAt)
    .filter(audit => {
      const data = object(JSON.parse(String(audit.data_json)));
      return data?.requestId === request.requestId && data.requestVersion === request.requestVersion
        && data.runId === source.runId && data.checkpointFingerprint === requestRow.wait_checkpoint_fingerprint;
    });
  const commit = database.prepare(`SELECT seq,ts,idempotency_key FROM control_plane_events WHERE workspace_id=? AND entity_id=?
    AND domain='runs' AND entity_type='user_input_wait' AND action='waiting' AND idempotency_key=?`).get(
      row.workspace_id!, request.requestId, `user-input-wait:${request.requestId}:1`);
  if (audits.length !== 1 || !commit) return undefined;
  return { schemaVersion: 1, kind: "user_input_yield", waitRevision: wait.revision, checkpoint,
    checkpointFingerprint: String(requestRow.wait_checkpoint_fingerprint), audit: auditWitness(audits[0]!, source), commit: commitWitness(commit) };
}

function readApproval(context: SqliteStoreContext, ports: RuntimeHostCapacityStopProofPorts, input: RuntimeHostCapacityStopProofInput,
  row: Row): Extract<RuntimeHostCapacityPausedStopWitness, { kind: "approval_suspension" }> | undefined {
  const { database } = context, { source } = input;
  if (row.error_code !== "runtime_suspend" || row.run_status !== "waiting_for_approval" || row.unit_status !== "waiting_for_approval"
    || row.active_attempt_id !== source.attemptId || row.run_ended_at !== null) return undefined;
  const audits = database.prepare(`SELECT id,seq,ts,data_json FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
    AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_stale' AND ts=?`).all(
      source.workUnitId, source.attemptId, source.runtimeInstanceId, source.fencingToken, row.attempt_ended_at!);
  if (audits.length !== 1) return undefined;
  const audit = audits[0]!, data = object(JSON.parse(String(audit.data_json)));
  if (data?.reason !== "runtime_suspend" || data.recoverable !== true || data.cause !== row.error_message || !text(data.checkpointId)) return undefined;
  const checkpoint = ports.getApprovalCheckpoint(data.checkpointId);
  const approval = checkpoint && ports.getApprovalRequest(checkpoint.approvalId), basis = checkpoint?.resumeBasis;
  if (!checkpoint || !approval || !basis || !isApprovalResumeBasisV1(basis) || checkpoint.runId !== source.runId
    || approval.runId !== source.runId || approval.taskId !== row.task_id || checkpoint.taskId !== row.task_id
    || approval.status !== checkpoint.status || !text(approval.toolCallId) || approval.toolCallId !== basis.toolCallId
    || approval.actionType !== basis.actionType || basis.sideEffectFingerprint !== approvalSideEffectFingerprintV1({
      actionType: approval.actionType, toolCallId: approval.toolCallId, sideEffect: approval.payload })) return undefined;
  const prefix = `approval-resume-suspend:approval_wait:${checkpoint.id}:`, suffix = `:${source.attemptId}:runs`;
  const commits = database.prepare(`SELECT seq,ts,idempotency_key FROM control_plane_events WHERE workspace_id=? AND entity_id=?
    AND domain='runs' AND entity_type='run' AND action='run.approval_resume_suspended' AND ts=?`).all(
      row.workspace_id!, source.runId, row.attempt_ended_at!).filter(commit => {
        const key = String(commit.idempotency_key), revision = key.slice(prefix.length, -suffix.length);
        return key.startsWith(prefix) && key.endsWith(suffix) && /^[1-9][0-9]*$/u.test(revision)
          && integer(Number(revision)) && Number(revision) < checkpoint.revision;
      });
  if (commits.length !== 1) return undefined;
  const commit = commits[0]!, previousRevision = Number(String(commit.idempotency_key).slice(prefix.length, -suffix.length));
  return { schemaVersion: 1, kind: "approval_suspension", suspendedRevision: previousRevision + 1, checkpoint,
    audit: auditWitness(audit, source), commit: commitWitness(commit) };
}

function hasOtherObligations(context: SqliteStoreContext, source: HostOperationSource, pause: RuntimeHostCapacityPausedStopWitness): boolean {
  const requestId = pause.kind === "user_input_yield" ? pause.checkpoint.requestId : "";
  const approvalId = pause.kind === "approval_suspension" ? pause.checkpoint.approvalId : "";
  return !!context.database.prepare(`SELECT 1 FROM user_input_requests WHERE (source_run_id=? OR source_attempt_id=?)
    AND request_id<>? AND (status='pending' OR wait_status IN ('waiting','resuming','blocked')
      OR EXISTS (SELECT 1 FROM user_input_answers a JOIN user_input_deliveries d ON d.answer_id=a.answer_id
        WHERE a.request_id=user_input_requests.request_id AND d.status IN ('pending','claimed','failed')))
    UNION ALL SELECT 1 FROM approval_requests WHERE run_id=? AND status='pending' AND id<>? LIMIT 1`)
    .get(source.runId, source.attemptId, requestId, source.runId, approvalId);
}

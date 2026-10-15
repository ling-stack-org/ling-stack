import { createHash } from "node:crypto";
import type { RunnerContinuationV1 } from "@ling-stack/contracts";
import type { LingApprovalCheckpoint } from "../../approval-checkpoints.js";
import type { RunSession, RunStore } from "../../run-types.js";
import { toRuntimeAttemptFence, type RuntimeAttemptFenceV1, type WorkUnit, type WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import { runtimeAttemptIdentity, runtimeRecord, sameTeammateDirectRuntimeFence } from "../../teammate-direct-message-runtime-validation.js";
import type { SqliteStoreContext } from "./store-context.js";

type ChainPorts = Pick<RunStore, "getRunnerContinuation" | "getWorkUnitAttempt" | "getArtifact">;
const MAX_APPROVAL_CONTINUATION_HOPS = 64;
const intermediateStates = new Set(["prepared", "claimed", "running", "recovery_pending"]);

/**
 * Prove a terminal approval's complete persisted lineage without rewriting its
 * immutable root basis. A lost pre-dispatch target is an intermediate fence,
 * never a new approval root or authority to replay an unknown effect.
 */
export function readTeammateDirectApprovalContinuationChain(
  context: SqliteStoreContext, ports: ChainPorts,
  run: RunSession, unit: WorkUnit, current: WorkUnitAttempt,
  checkpoint: LingApprovalCheckpoint, terminal: RunnerContinuationV1,
): readonly unknown[] | undefined {
  const basis = checkpoint.resumeBasis;
  if (!basis || checkpoint.runnerResumeHandle?.attemptId !== current.id) return undefined;
  const witness: unknown[] = [], seenAttempts = new Set<string>(), seenContinuations = new Set<string>();
  let target = current, upperSuspensionRevision = checkpoint.revision;
  for (let depth = 0; depth < MAX_APPROVAL_CONTINUATION_HOPS; depth += 1) {
    if (seenAttempts.has(target.id)) return undefined;
    seenAttempts.add(target.id);
    // Search globally: an extra foreign-Run predecessor is ambiguity, not evidence.
    const rows = context.database.prepare("SELECT id FROM runner_continuations WHERE target_attempt_id=? ORDER BY id LIMIT 2").all(target.id);
    if (rows.length !== 1) return undefined;
    const continuation = ports.getRunnerContinuation(String(rows[0]!.id));
    if (!continuation || seenContinuations.has(continuation.id)
      || !validHop(continuation, target, depth === 0)) return undefined;
    seenContinuations.add(continuation.id);
    const source = ports.getWorkUnitAttempt(continuation.sourceAttemptId);
    if (!source || source.status !== "lost" || seenAttempts.has(source.id) || !validAttempt(source, continuation.runnerId)
      || !Number.isSafeInteger(target.attemptNumber) || target.attemptNumber !== source.attemptNumber + 1
      || !increasingFence(source.fencingToken, target.fencingToken)
      || source.createdAt > target.createdAt || !source.endedAt || source.endedAt > target.createdAt) return undefined;
    const artifact = ports.getArtifact(continuation.contextSnapshotArtifactId);
    const replay = runtimeRecord(artifact?.sealedPayload), sourceFence = runtimeRecord(replay?.sourceFence);
    if (!artifact || artifact.runId !== run.id || artifact.type !== "json"
      || artifact.contentType !== "application/vnd.ling.runner-continuation-replay+json"
      || !replay || artifact.contentSha256 !== hash(replay)
      || !validReplay(replay, sourceFence, source, continuation)) return undefined;
    let suspension: { readonly revision: number; readonly witness: unknown } | undefined;
    if (source.id !== basis.priorAttemptId) {
      if (source.status !== "lost" || source.errorCode !== "runtime_suspend") return undefined;
      const prior = runtimeRecord(replay.priorAttempt);
      if (prior?.status !== source.status || prior.endedAt !== source.endedAt || prior.errorCode !== source.errorCode) return undefined;
      suspension = readSuspension(source, upperSuspensionRevision);
      if (!suspension) return undefined;
      upperSuspensionRevision = suspension.revision;
    }
    witness.push({ continuation, source: runtimeAttemptIdentity(source),
      artifact: { id: artifact.id, contentSha256: artifact.contentSha256, fingerprint: replay.fingerprint },
      ...(suspension ? { suspension: suspension.witness } : {}) });
    if (source.id === basis.priorAttemptId) return witness;
    target = source;
  }
  return undefined;

  function validAttempt(attempt: WorkUnitAttempt, runnerId: string): boolean {
    return attempt.workUnitId === unit.id && attempt.runnerId === runnerId && attempt.effectiveRunnerId === runnerId
      && Number.isSafeInteger(attempt.attemptNumber) && attempt.attemptNumber >= 1
      && [attempt.id, attempt.runtimeInstanceId, attempt.fencingToken].every(value => typeof value === "string" && value.length > 0);
  }

  function validHop(value: RunnerContinuationV1, targetAttempt: WorkUnitAttempt, latest: boolean): boolean {
    return value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0
      && Number.isSafeInteger(value.generation) && value.generation >= 0
      && value.runId === run.id && value.workUnitId === unit.id && value.origin === "approval_resume"
      && value.strategy === "deterministic_replay" && value.targetAttemptId === targetAttempt.id
      && value.runnerId === current.runnerId && validAttempt(targetAttempt, value.runnerId)
      && value.contextViewId === run.contextViewId && value.createdAt === targetAttempt.createdAt
      && value.idempotencyKey === `runner-continuation:${run.id}:${value.sourceAttemptId}:approval_resume:${value.generation}:${checkpoint.approvalId}`
      && (latest ? value.id === terminal.id && value.state === run.status : intermediateStates.has(value.state));
  }

  function validReplay(replay: Record<string, unknown>, fence: Record<string, unknown> | undefined,
    source: WorkUnitAttempt, continuation: RunnerContinuationV1): boolean {
    const { fingerprint, ...body } = replay;
    const evidence = Array.isArray(replay.approvalEvidence) && replay.approvalEvidence.length === 1
      ? runtimeRecord(replay.approvalEvidence[0]) : undefined;
    return replay.schemaVersion === 1 && replay.boundary === "runner-continuation-replay" && fingerprint === hash(body)
      && replay.runId === run.id && replay.sourceRunId === run.id && replay.workUnitId === unit.id
      && replay.sourceWorkUnitId === unit.id && replay.origin === "approval_resume"
      && replay.contextViewId === continuation.contextViewId && replay.runnerId === continuation.runnerId
      && replay.runnerCapabilityRevision === continuation.runnerCapabilityRevision
      && Boolean(fence && sameTeammateDirectRuntimeFence(fence as unknown as RuntimeAttemptFenceV1, toRuntimeAttemptFence(source)))
      && evidence?.approvalId === checkpoint.approvalId && evidence.decision === "approved"
      && evidence.sideEffectFingerprint === basis!.sideEffectFingerprint;
  }

  function readSuspension(source: WorkUnitAttempt, upperRevision: number): { readonly revision: number; readonly witness: unknown } | undefined {
    const audits = context.database.prepare(`SELECT id,seq,ts,actor,data_json FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
      AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_stale' AND ts=?`).all(
      unit.id, source.id, source.runtimeInstanceId, source.fencingToken, source.endedAt!).filter(row => {
        const data = parseRecord(row.data_json);
        return row.actor === "system" && data?.reason === "runtime_suspend" && data.recoverable === true && data.checkpointId === checkpoint.id;
      });
    const prefix = `approval-resume-suspend:resume_pre_dispatch:${checkpoint.id}:`, suffix = `:${source.id}:runs`;
    const commits = context.database.prepare(`SELECT seq,ts,domain,entity_type,action,idempotency_key FROM control_plane_events
      WHERE workspace_id=? AND entity_id=? AND ts=?`).all(unit.workspaceId, run.id, source.endedAt!).filter(row => {
        const key = String(row.idempotency_key);
        return key.startsWith(prefix) && key.endsWith(suffix);
      });
    if (audits.length !== 1 || commits.length !== 1) return undefined;
    const commit = commits[0]!, token = String(commit.idempotency_key).slice(prefix.length, -suffix.length), revision = Number(token);
    if (!/^[1-9]\d*$/.test(token) || !Number.isSafeInteger(revision) || revision + 1 >= upperRevision
      || commit.domain !== "runs" || commit.entity_type !== "run" || commit.action !== "run.approval_resume_suspended") return undefined;
    const started = context.database.prepare(`SELECT 1 FROM run_events WHERE run_id=? AND type='tool_start'
      AND (json_extract(data_json,'$.attemptId')=? OR json_type(data_json,'$.attemptId') IS NOT 'text'
        OR length(trim(json_extract(data_json,'$.attemptId')))=0) LIMIT 1`).get(run.id, source.id);
    return started ? undefined : { revision, witness: { audit: audits[0], commit } };
  }
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function parseRecord(value: unknown): Record<string, unknown> | undefined {
  try { return runtimeRecord(JSON.parse(String(value))); } catch { return undefined; }
}
function increasingFence(source: string, target: string): boolean {
  return /^[1-9]\d*$/.test(source) && /^[1-9]\d*$/.test(target) && BigInt(source) < BigInt(target);
}

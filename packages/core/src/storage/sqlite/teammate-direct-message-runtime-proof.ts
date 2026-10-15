import type { RunStore, RunSession, LingTurn } from "../../run-types.js";
import type { WorkUnit, WorkUnitAttempt } from "../../runtime-supervisor-types.js";
import { toRuntimeAttemptFence } from "../../runtime-supervisor-types.js";
import type { TeammateDirectMessageRuntimeState } from "../../teammate-direct-message-runtime-types.js";
import { isTeammateDirectRuntimeActive, isTeammateDirectRuntimeApprovalBasis,
  isTeammateDirectRuntimeResumeHandle, runtimeRecord, sameTeammateDirectRuntimeFence } from "../../teammate-direct-message-runtime-validation.js";
import { assertUserInputWaitingSource } from "./user-input-wait-source.js";
import { readUserInputRunEventPosition } from "./user-input-event-position.js";
import { assertUserInputQuiescence } from "./user-input-wait-evidence.js";
import { userInputHash } from "./user-input-records.js";
import type { SqliteStoreContext } from "./store-context.js";
import { readTeammateDirectApprovalContinuationChain } from "./teammate-direct-approval-continuation-proof.js";

export type TeammateDirectRuntimeReadPorts = Pick<RunStore,
  "getTeammateDirectMessage" | "getRun" | "getLingThread" | "getLingTurn" | "getLingTurnForRun" | "listLingTurnRuns"
  | "getConversationItem" | "listConversationItemsForTurn" | "getTeammateDirectInputSnapshot"
  | "getWorkUnit" | "getWorkUnitAttempt" | "getApprovalCheckpoint" | "getApprovalRequest"
  | "getUserInputRequest" | "getUserInputWait" | "getTask" | "getChannelWorkflowStep" | "listEvents"
  | "getRunnerContinuation" | "getArtifact" | "listWorkUnits" | "getMediaJob">;

interface LifecycleProof {
  readonly state: TeammateDirectMessageRuntimeState;
  readonly witness: unknown;
  readonly attempt?: WorkUnitAttempt;
}
const unknown = (reason: string): LifecycleProof => ({ state: { kind: "indeterminate", reason }, witness: reason });

/** Only durable facts from this Run are considered; errors never manufacture a safe wait. */
export function readTeammateDirectRuntimeLifecycle(
  context: SqliteStoreContext, ports: TeammateDirectRuntimeReadPorts,
  run: RunSession, unit: WorkUnit, attempt: WorkUnitAttempt | undefined, turn: LingTurn,
): LifecycleProof {
  const { database } = context;
  if (attempt && [attempt.id, attempt.workUnitId, attempt.runtimeInstanceId, attempt.fencingToken, attempt.runnerId]
    .some(value => typeof value !== "string" || value.length === 0)) return unknown("invalid_attempt_fence");
  const checkpoints = database.prepare("SELECT id FROM approval_checkpoints WHERE run_id=? ORDER BY created_at,id")
    .all(run.id).map(row => ports.getApprovalCheckpoint(String(row.id))!);
  if (checkpoints.some(checkpoint => !checkpoint)) return unknown("invalid_approval_proof");
  const approvals = checkpoints.map(checkpoint => ({ checkpoint, approval: ports.getApprovalRequest(checkpoint.approvalId),
    prior: checkpoint.resumeBasis ? ports.getWorkUnitAttempt(checkpoint.resumeBasis.priorAttemptId) : undefined }));
  const approvalWitness = approvals.map(value => ({ checkpoint: value.checkpoint, approval: value.approval,
    prior: value.prior ? { id: value.prior.id, workUnitId: value.prior.workUnitId, status: value.prior.status,
      runtimeInstanceId: value.prior.runtimeInstanceId, fencingToken: value.prior.fencingToken,
      endedAt: value.prior.endedAt, errorCode: value.prior.errorCode } : null }));

  // An independently closed current Attempt takes precedence over old waiting checkpoints.
  if (["succeeded", "failed", "cancelled"].includes(run.status)) {
    if (!attempt || !run.endedAt || !unit.endedAt || unit.status !== run.status || unit.activeAttemptId !== attempt.id
      || attempt.workUnitId !== unit.id || !attempt.endedAt) return unknown("terminal_owner_conflict");
    const currentCheckpoints = approvals.filter(({ checkpoint }) => checkpoint.runnerResumeHandle?.attemptId === attempt.id);
    for (const { checkpoint, approval, prior } of currentCheckpoints) {
      if (!isTeammateDirectRuntimeApprovalBasis(checkpoint, approval, run, unit, prior)
        || !isTeammateDirectRuntimeResumeHandle(checkpoint, attempt, run)
        || !(run.status === "succeeded" ? checkpoint.status === "resumed" :
          run.status === "cancelled" ? ["cancelled", "resume_failed", "resumed"].includes(checkpoint.status) : checkpoint.status === "resume_failed")) {
        return unknown("terminal_approval_conflict");
      }
    }
    const continuationRows = database.prepare("SELECT id FROM runner_continuations WHERE run_id=? AND target_attempt_id=? ORDER BY id").all(run.id, attempt.id);
    const continuations = continuationRows.map(row => ports.getRunnerContinuation(String(row.id)));
    const continuationEnforced = runtimeRecord(runtimeRecord(run.requestSnapshot)?.harnessFeatureSnapshot)?.continuations === "enforce";
    if (currentCheckpoints.some(({ checkpoint }) => checkpoint.runnerResumeHandle?.kind === "ling_continuation")
      && !continuations.some(value => value?.origin === "approval_resume")
      && (continuationEnforced || database.prepare("SELECT 1 FROM runner_continuations WHERE run_id=? AND origin='approval_resume' LIMIT 1").get(run.id))) {
      return unknown("terminal_continuation_conflict");
    }
    if (continuations.some(value => !value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision)
      || value.runId !== run.id || value.workUnitId !== unit.id
      || value.targetAttemptId !== attempt.id || value.runnerId !== attempt.runnerId || value.state !== run.status
      || ports.getWorkUnitAttempt(value.sourceAttemptId)?.workUnitId !== unit.id)) {
      return unknown("terminal_continuation_conflict");
    }
    const approvalContinuationChains: unknown[] = [];
    for (const value of continuations) {
      if (value?.origin !== "approval_resume") continue;
      const chains = currentCheckpoints.map(({ checkpoint }) =>
        readTeammateDirectApprovalContinuationChain(context, ports, run, unit, attempt, checkpoint, value)).filter(value => value !== undefined);
      if (chains.length !== 1) return unknown("terminal_continuation_conflict");
      approvalContinuationChains.push(chains[0]);
    }
    const lostFailure = run.status === "failed" && attempt.status === "lost" && approvals.some(({ checkpoint, approval, prior }) =>
      isTeammateDirectRuntimeApprovalBasis(checkpoint, approval, run, unit, prior)
      && (checkpoint.resumeBasis?.priorAttemptId === attempt.id || checkpoint.runnerResumeHandle?.attemptId === attempt.id)
      && (checkpoint.status === "resume_failed" || checkpoint.status === "denied" && approval?.status === "denied"));
    if (attempt.status !== run.status && !lostFailure) return unknown("terminal_attempt_conflict");
    return { state: { kind: "terminal", status: run.status as "succeeded" | "failed" | "cancelled" },
      witness: { approvalWitness, continuations, approvalContinuationChains }, attempt };
  }

  if (run.status === "yielded") return readYield();
  if (!attempt) return unknown("missing_attempt");
  if (attempt.status === "lost") {
    const candidates = approvals.filter(({ checkpoint }) => checkpoint.status === "resume_pending"
      ? checkpoint.runnerResumeHandle?.attemptId === attempt.id : checkpoint.resumeBasis?.priorAttemptId === attempt.id);
    for (const { checkpoint, approval, prior } of candidates) {
      if (!isTeammateDirectRuntimeApprovalBasis(checkpoint, approval, run, unit, prior)) continue;
      const kind = checkpoint.status === "resume_pending" ? "resume_pre_dispatch" : "approval_wait";
      const compatible = kind === "approval_wait"
        ? run.status === "waiting_for_approval" && unit.status === "waiting_for_approval"
          && ((checkpoint.status === "pending" && approval.status === "pending") || (checkpoint.status === "approved" && approval.status === "approved"))
        : run.status === "running" && unit.status === "running" && approval.status === "approved"
          && isTeammateDirectRuntimeResumeHandle(checkpoint, attempt, run);
      if (!compatible || unit.activeAttemptId !== attempt.id || attempt.workUnitId !== unit.id
        || attempt.errorCode !== "runtime_suspend" || !attempt.endedAt || run.endedAt || checkpoint.revision < 2) continue;
      const audit = database.prepare(`SELECT id,seq,ts,data_json FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
        AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_stale' AND ts=?`).all(
        unit.id, attempt.id, attempt.runtimeInstanceId, attempt.fencingToken, attempt.endedAt).find(row => {
          const data = runtimeRecord(JSON.parse(String(row.data_json)));
          return data?.reason === "runtime_suspend" && data.recoverable === true && data.checkpointId === checkpoint.id;
        });
      const commit = database.prepare(`SELECT seq,ts FROM control_plane_events WHERE workspace_id=? AND entity_id=? AND idempotency_key=?`).get(
        unit.workspaceId, run.id, `approval-resume-suspend:${kind}:${checkpoint.id}:${checkpoint.revision - 1}:${attempt.id}:runs`);
      if (!audit || !commit || commit.ts !== attempt.endedAt || checkpoint.updatedAt !== attempt.endedAt) continue;
      return { state: { kind: "logical_wait", proof: { kind, id: checkpoint.id, revision: checkpoint.revision } },
        witness: { approvalWitness, audit, commit }, attempt };
    }
    return unknown("invalid_suspension_proof");
  }

  if (!isTeammateDirectRuntimeActive(run, unit, attempt)) return unknown("inactive_execution_owner");
  if (run.status === "waiting_for_approval" || unit.status === "waiting_for_approval" || attempt.status === "waiting_for_approval") {
    if (run.status !== "waiting_for_approval" || unit.status !== "waiting_for_approval" || attempt.status !== "waiting_for_approval"
      || !approvals.some(({ checkpoint, approval, prior }) =>
        isTeammateDirectRuntimeApprovalBasis(checkpoint, approval, run, unit, prior) && prior?.id === attempt.id
        && ((checkpoint.status === "pending" && approval.status === "pending") || (checkpoint.status === "approved" && approval.status === "approved")))) {
      return unknown("invalid_active_approval_proof");
    }
  }
  return { state: { kind: "active" }, witness: approvalWitness, attempt };

  function readYield(): LifecycleProof {
    const anchors = ports.listConversationItemsForTurn({ turnId: turn.id }).filter(item => item.kind === "user_input_request"
      && item.domainRefs.some(ref => ref.type === "run" && ref.id === run.id));
    const candidates: LifecycleProof[] = [];
    for (const anchor of anchors) {
      if (anchor.kind !== "user_input_request") continue;
      const request = ports.getUserInputRequest(turn.threadId, anchor.payload.requestId);
      const wait = request ? ports.getUserInputWait(turn.threadId, request.requestId) : undefined;
      if (!request || !wait || request.itemId !== anchor.id || request.waitMode !== "required"
        || !["waiting", "resuming", "cancelled"].includes(wait.status)) continue;
      const source = request.source, sourceAttempt = ports.getWorkUnitAttempt(source.fence.attemptId);
      const item = ports.getConversationItem(source.itemId);
      if (!sourceAttempt || !item || source.runId !== run.id || source.threadId !== turn.threadId || source.turnId !== turn.id
        || source.workspaceId !== unit.workspaceId || source.participantId !== run.teammateId || source.channelId !== undefined
        || source.workflowStepId !== undefined || source.visibility !== "agent_private" || source.visibilityOwnerId !== run.teammateId
        || source.taskBinding.taskId !== run.taskId || source.cwd !== run.cwd || sourceAttempt.status !== "yielded"
        || !sameTeammateDirectRuntimeFence(source.fence, toRuntimeAttemptFence(sourceAttempt))
        || source.fence.workUnitId !== unit.id || unit.activeAttemptId || sourceAttempt.endedAt !== wait.checkpoint.quiescence.stoppedAt
        || run.endedAt !== wait.checkpoint.quiescence.stoppedAt || sourceAttempt.runnerId !== wait.checkpoint.quiescence.runnerId
        || anchor.workspaceId !== source.workspaceId || anchor.threadId !== source.threadId || anchor.turnId !== source.turnId
        || anchor.status !== "committed" || anchor.visibility !== source.visibility || anchor.visibilityOwnerId !== source.visibilityOwnerId
        || anchor.actorType !== "teammate" || anchor.actorId !== source.participantId || anchor.payload.requestVersion !== request.requestVersion
        || !anchor.domainRefs.some(ref => ref.type === "user_input_request" && ref.id === request.requestId)
        || !anchor.domainRefs.some(ref => ref.type === "conversation_item" && ref.id === item.id)
        || item.workspaceId !== source.workspaceId || item.threadId !== source.threadId || item.turnId !== source.turnId
        || item.visibility !== source.visibility || item.visibilityOwnerId !== source.visibilityOwnerId || item.status !== "committed") continue;
      const position = readUserInputRunEventPosition(context, anchor.payload.runEventPosition, source);
      if (!position || position.afterEventSequence > wait.checkpoint.quiescence.lastRunEventSeq) continue;
      const yieldAudit = database.prepare(`SELECT id,seq,data_json FROM runtime_events WHERE work_unit_id=? AND attempt_id=?
        AND runtime_instance_id=? AND fencing_token=? AND type='work_unit_waiting_for_input' AND ts=?`).all(
        unit.id, sourceAttempt.id, sourceAttempt.runtimeInstanceId, sourceAttempt.fencingToken, wait.checkpoint.committedAt).find(row => {
          const data = runtimeRecord(JSON.parse(String(row.data_json)));
          return data?.requestId === request.requestId && data.requestVersion === request.requestVersion
            && data.runId === run.id && data.checkpointFingerprint === userInputHash(wait.checkpoint);
        });
      const yieldCommit = database.prepare(`SELECT seq,ts FROM control_plane_events
        WHERE workspace_id=? AND entity_id=? AND idempotency_key=?`).get(source.workspaceId, request.requestId, `user-input-wait:${request.requestId}:1`);
      if (!yieldAudit || !yieldCommit || yieldCommit.ts !== wait.checkpoint.committedAt) continue;
      const tail = database.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM run_events WHERE run_id=?").get(run.id);
      if (tail?.seq === wait.checkpoint.quiescence.lastRunEventSeq) {
        assertUserInputQuiescence(database, run.id, wait.checkpoint.quiescence, wait.checkpoint.committedAt, source.fence);
      } else if (Number(tail?.seq ?? 0) < wait.checkpoint.quiescence.lastRunEventSeq || database.prepare(`SELECT 1 FROM run_events
        WHERE run_id=? AND seq>? AND type<>'stale_runner_completion_ignored' LIMIT 1`).get(run.id, wait.checkpoint.quiescence.lastRunEventSeq)) continue;
      if (wait.status === "cancelled") {
        if (unit.status !== "cancelled" || !unit.endedAt || !["cancelled", "answered"].includes(request.status)) continue;
        const audit = database.prepare(`SELECT id,seq,data_json FROM runtime_events WHERE work_unit_id=?
          AND type='work_unit_cancelled' AND ts=?`).all(unit.id, unit.endedAt).find(row => {
            const data = runtimeRecord(JSON.parse(String(row.data_json))), fence = runtimeRecord(data?.sourceFence);
            return data?.reason === "user_input_wait_cancelled" && data.requestId === request.requestId
              && data.sourceRunId === run.id && fence && sameTeammateDirectRuntimeFence(source.fence, fence as unknown as ReturnType<typeof toRuntimeAttemptFence>);
          });
        if (!audit) continue;
        candidates.push({ state: { kind: "terminal", status: "cancelled" }, witness: { request, wait, anchor, position, yieldAudit, yieldCommit, audit }, attempt: sourceAttempt });
      } else {
        assertUserInputWaitingSource(ports, request, wait);
        candidates.push({ state: { kind: "logical_wait", proof: { kind: "user_input_yield", id: request.requestId, revision: wait.revision } },
          witness: { request, wait, anchor, position, yieldAudit, yieldCommit }, attempt: sourceAttempt });
      }
    }
    return candidates.length === 1 ? candidates[0]! : unknown("invalid_yield_proof");
  }
}

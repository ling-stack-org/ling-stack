import type { SQLOutputValue } from "node:sqlite";
import type { ApprovalRequest } from "../../approval-types.js";
import { NativeExecutionJournalError, type NativeApprovalRecord, type NativeApprovalWaitSnapshot,
  type NativeSubmission } from "../../native-execution-types.js";
import type { RunEventEnvelope, RunStore } from "../../run-types.js";
import { mapRunEvent } from "./run-mappers.js";
import type { SqliteStoreContext } from "./store-context.js";

export type NativeApprovalWaitPorts = Pick<RunStore, "getRun" | "getWorkUnit" | "getWorkUnitAttempt"
  | "transitionRunStatus" | "transitionWorkUnitStatus" | "updateWorkUnitAttemptStatus"
  | "getLingThread" | "updateLingThread" | "expireApprovalRequest" | "appendEvent">;

/** Called only inside the native journal's write transaction, after its full owner check. */
export function synchronizeNativeApprovalWait(context: SqliteStoreContext, ports: NativeApprovalWaitPorts,
  submission: NativeSubmission, records: readonly NativeApprovalRecord[], now: string): NativeApprovalWaitSnapshot {
  const run = ports.getRun(submission.runId)!;
  const work = ports.getWorkUnit(submission.fence.workUnitId)!;
  const attempt = ports.getWorkUnitAttempt(submission.fence.attemptId)!;
  if (!["running", "waiting_for_approval"].includes(run.status)
    || !["running", "waiting_for_approval", "cancelling"].includes(work.status)
    || !["started", "waiting_for_approval", "cancelling"].includes(attempt.status)) {
    throw new NativeExecutionJournalError("native_submission_conflict");
  }
  const approvals = records.map(record => {
    const approval = record.approval;
    if (approval.status !== "pending" || !approval.expiresAt) return record;
    const deadline = Date.parse(approval.expiresAt);
    if (!Number.isFinite(deadline)) throw new NativeExecutionJournalError("native_journal_invalid");
    if (deadline > Date.parse(now)) return record;
    const expired = ports.expireApprovalRequest(approval.id, { reason: "Native approval deadline elapsed." }, now);
    if (!expired) throw new NativeExecutionJournalError("native_approval_unavailable");
    return { ...record, approval: expired };
  });
  const pendingApprovalIds = approvals.filter(record => record.approval.status === "pending"
    && !record.correlation.resolvedAt).map(record => record.approval.id);
  const status = pendingApprovalIds.length ? "waiting_for_approval" : "running";
  const event = status === "running" ? "approval_wait_ended" : "approval_requested";
  // Cancelling is owned by the cancellation/terminal path, never by an approval decision.
  if (work.status !== "cancelling" && attempt.status !== "cancelling") {
    if (work.status !== status && !ports.transitionWorkUnitStatus({ ...submission.fence,
      expectedStatus: work.status, event, actor: "system", now, lastEventAt: now }).ok) fail();
    const attemptStatus = status === "running" ? "started" : "waiting_for_approval";
    if (attempt.status !== attemptStatus && !ports.updateWorkUnitAttemptStatus({ ...submission.fence,
      status: attemptStatus, now, lastEventAt: now })) fail();
    if (run.status !== status && !ports.transitionRunStatus({ runId: run.id, expectedStatus: run.status,
      event, actor: "system", now }).ok) fail();
    const thread = run.threadId ? ports.getLingThread(run.threadId) : undefined;
    if (thread?.activeRunId === run.id) {
      const anyWaiting = context.database.prepare("SELECT 1 FROM run_sessions WHERE thread_id = ? AND status = 'waiting_for_approval' LIMIT 1")
        .get(thread.id);
      const threadStatus = anyWaiting ? "waiting_for_approval" : "running";
      if (thread.status !== threadStatus) ports.updateLingThread(thread.id, { status: threadStatus }, now);
    }
  }

  const events: RunEventEnvelope[] = [];
  for (const { approval } of approvals) {
    events.push(existingApprovalEvent(context, run.id, approval.id, "approval_requested") ?? ports.appendEvent(run.id, "approval_requested", {
      approvalId: approval.id, toolCallId: approval.toolCallId, actionType: approval.actionType,
      risk: approval.risk, title: approval.title, description: approval.description, payload: approval.payload,
      previewArtifactIds: [], expiresAt: approval.expiresAt, availableDecisions: approval.availableDecisions,
      proposedCommandRule: approval.proposedCommandRule,
    }));
    if (approval.status === "pending") continue;
    events.push(publishNativeApprovalDecision(context, ports, approval));
  }
  return { approvals, pendingApprovalIds, events: events.sort((a, b) => a.seq - b.seq) };
}

/** Both HTTP publication and native synchronization enter through the journal write transaction. */
export function publishNativeApprovalDecision(context: SqliteStoreContext, ports: Pick<NativeApprovalWaitPorts, "appendEvent">,
  approval: ApprovalRequest): RunEventEnvelope {
  if (!approval.runId || approval.status === "pending") throw new NativeExecutionJournalError("native_approval_unavailable");
  const type = approval.status === "approved" ? "approval_approved" : approval.status === "denied" ? "approval_denied"
    : approval.status === "expired" ? "approval_expired" : "approval_cancelled";
  return existingApprovalEvent(context, approval.runId, approval.id, type) ?? ports.appendEvent(approval.runId, type, {
    approvalId: approval.id, status: approval.status, resolvedBy: approval.resolvedBy,
    decisionReason: approval.decisionReason, decisionKind: approval.decisionKind, decisionRuleId: approval.decisionRuleId,
  });
}

function existingApprovalEvent(context: SqliteStoreContext, runId: string, approvalId: string, type: string): RunEventEnvelope | undefined {
  const row = context.database.prepare(`SELECT id, run_id, seq, ts, type, data_json FROM run_events
    WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.approvalId') = ? ORDER BY seq LIMIT 1`)
    .get(runId, type, approvalId);
  return row ? mapRunEvent(row as Record<string, SQLOutputValue>) : undefined;
}

function fail(): never { throw new NativeExecutionJournalError("native_owner_mismatch"); }

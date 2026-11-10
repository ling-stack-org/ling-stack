import type { RunEventEnvelope, RunEventType, RunStore } from "@ling-stack/core";
import { isTerminalWorkUnitStatus, transitionWorkUnitTerminal } from "../../runtime/work-units.js";
import { approvalEventReflectsRunState } from "./approval-event-state.js";
import { isNativeApprovalEvent } from "./native-approval-events.js";

export function syncWorkUnitForRunEvent(
  store: RunStore,
  workUnitId: string,
  attemptId: string,
  type: RunEventType,
  envelope: RunEventEnvelope,
): void {
  if (isNativeApprovalEvent(store, envelope)) return;
  const current = store.getWorkUnit(workUnitId);
  if (!current || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
    return;
  }
  const attempt = store.getWorkUnitAttempt(attemptId);
  if (!attempt || attempt.workUnitId !== workUnitId || current.activeAttemptId !== attempt.id) return;
  if (!approvalEventReflectsRunState(store, envelope)) return;
  const now = envelope.ts;
  if (type === "approval_requested" && current.status === "running") {
    const transition = store.transitionWorkUnitStatus({
      workUnitId,
      attemptId: attempt.id,
      activeAttemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      expectedStatus: current.status,
      event: "approval_requested",
      actor: "system",
      now,
      lastEventAt: now,
    });
    if (transition.ok) {
      store.updateWorkUnitAttemptStatus({
        attemptId,
        workUnitId: attempt.workUnitId,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        status: "waiting_for_approval",
        now,
        lastEventAt: now,
      });
      store.appendRuntimeEvent({
        workUnitId,
        attemptId,
        runtimeInstanceId: attempt.runtimeInstanceId,
        fencingToken: attempt.fencingToken,
        type: "work_unit_approval_requested",
        actor: "system",
        ts: now,
        data: { runEventId: envelope.id, runEventSeq: envelope.seq },
      });
    }
    return;
  }
  if (type === "approval_approved" && current.status === "waiting_for_approval") {
    store.transitionWorkUnitStatus({
      workUnitId,
      attemptId: attempt.id,
      activeAttemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      expectedStatus: current.status,
      event: "approval_approved",
      actor: "local-user",
      now,
      lastEventAt: now,
    });
    store.updateWorkUnitAttemptStatus({
      attemptId,
      workUnitId: attempt.workUnitId,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      status: "started",
      now,
      lastEventAt: now,
    });
    return;
  }
  if ((type === "approval_denied" || type === "approval_expired") && current.status === "waiting_for_approval") {
    transitionWorkUnitTerminal(store, {
      workUnitId,
      attemptId,
      event: type === "approval_expired" ? "approval_expired" : "approval_denied",
      attemptStatus: "failed",
      runtimeEventType: "work_unit_failed",
      actor: type === "approval_expired" ? "system" : "local-user",
      now,
      errorCode: type,
      errorMessage: type,
    });
  }
}

export function appendRuntimeProgressForRunEvent(
  store: RunStore,
  workUnitId: string,
  attemptId: string,
  type: RunEventType,
  envelope: RunEventEnvelope,
): void {
  try {
    const attempt = store.getWorkUnitAttempt(attemptId);
    if (!attempt || attempt.workUnitId !== workUnitId) return;
    store.appendRuntimeEvent({
      workUnitId,
      attemptId,
      runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken,
      type: type === "artifact_created" ? "artifact_created" : "work_unit_progress",
      actor: "runner",
      ts: envelope.ts,
      data: {
        runId: envelope.runId,
        runEventId: envelope.id,
        runEventSeq: envelope.seq,
        runEventType: type,
      },
    });
  } catch {
    // Runtime events are diagnostic projections; run event persistence remains authoritative.
  }
}

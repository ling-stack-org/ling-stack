import type { RunSession, WorkUnitDetailResponse } from "../types.js";

export function isTerminalRunStop(run: RunSession, detail?: WorkUnitDetailResponse): boolean {
  return ["cancelled", "failed", "succeeded"].includes(run.status)
    || (run.status === "yielded" && detail?.workUnit.status === "cancelled");
}

export function isWorkUnitStopSettled(
  detail: WorkUnitDetailResponse,
  expectedAttemptId?: string,
  run = detail.run,
): boolean {
  const unit = detail.workUnit;
  const settledAttempt = (status: string) => ["cancelled", "failed", "succeeded", "yielded", "lost"].includes(status);
  const expectedIds = [expectedAttemptId, unit.activeAttemptId].filter((id): id is string => Boolean(id));
  const evidence = detail.stopEvidence;
  const hostSettled = evidence?.schemaVersion === 1 && evidence.workUnitId === unit.id
    && evidence.attempts.length === detail.attempts.length
    && new Set(evidence.attempts.map(attempt => attempt.attemptId)).size === evidence.attempts.length
    && detail.attempts.every(attempt => evidence.attempts.some(proof => proof.attemptId === attempt.id
      && Boolean(attempt.runtimeInstanceId && attempt.fencingToken)
      && proof.runtimeInstanceId === attempt.runtimeInstanceId && proof.fencingToken === attempt.fencingToken
      && proof.localExecution === "drained" && proof.effects === "settled"));
  return ["cancelled", "failed", "succeeded"].includes(unit.status)
    && hostSettled
    && (!unit.linkedRunId || Boolean(run && run.id === unit.linkedRunId && isTerminalRunStop(run, detail)))
    && expectedIds.every(id => detail.attempts.some(attempt => attempt.id === id && attempt.workUnitId === unit.id && settledAttempt(attempt.status)))
    && detail.attempts.every(attempt => attempt.workUnitId === unit.id && settledAttempt(attempt.status))
    && !detail.leases.some(lease => lease.status === "active")
    && !detail.semaphoreSlots.some(slot => slot.status === "active");
}

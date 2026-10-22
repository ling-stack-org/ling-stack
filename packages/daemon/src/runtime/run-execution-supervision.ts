import { createRuntimeResourceRenewal, type RunStore, type WorkUnit, type WorkUnitAttempt } from "@ling-stack/core";
import type { ActiveRunRegistry } from "./active-runs.js";
import { isActiveWorkUnitStatus, isTerminalWorkUnitStatus } from "./work-units.js";

export interface RunExecutionSupervision {
  start(): void;
  activity(): void;
  heartbeat(source?: "supervisor" | "runner", detail?: unknown): void;
  pause(): void;
  resume(): void;
  approvalWaitChanged(waiting: boolean): void;
  requestAbort(code: "idle_timeout" | "hard_timeout" | "execution_loop_detected", reason?: string): void;
  stopWatchdogs(): void;
  dispose(): void;
}

/** One attempt owns its clocks and exact-fence heartbeat/stop writes, for Pi and native execution. */
export function createRunExecutionSupervision(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly workUnit: WorkUnit;
  readonly attempt: WorkUnitAttempt;
  readonly activeRuns: ActiveRunRegistry;
  readonly signal: AbortSignal;
  readonly now?: () => string;
  readonly retainAuthority?: () => boolean;
  readonly waitingForContinuation?: () => boolean;
}): RunExecutionSupervision {
  const { store, runId, workUnit, attempt, activeRuns, signal } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const retained = () => input.retainAuthority?.() === true;
  let lastActivityAt = performance.now();
  let remainingMs = workUnit.timeoutPolicy.hardTimeoutMs;
  let activeSince = performance.now();
  let pauseDepth = 0;
  let approvalPaused = false;
  let started = false;
  let stopped = false;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;

  const heartbeat = (source: "supervisor" | "runner" = "supervisor", detail?: unknown): void => {
    const ts = now();
    try { store.recordRuntimeHeartbeat({ workUnitId: workUnit.id, attemptId: attempt.id,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken, ts,
      resourceExpiresAt: createRuntimeResourceRenewal(ts).expiresAt, source, detail }); }
    catch { /* Diagnostics expose stale persistence; output and owned cleanup must still drain. */ }
  };
  const requestAbort: RunExecutionSupervision["requestAbort"] = (code, reason = code): void => {
    const current = store.getWorkUnit(workUnit.id);
    if (!current || current.status === "cancelling" || isTerminalWorkUnitStatus(current.status) || current.status === "stale") return;
    const ts = now();
    const transition = store.transitionWorkUnitStatus({ workUnitId: workUnit.id, attemptId: attempt.id,
      activeAttemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
      expectedStatus: current.status, event: code, actor: "system", reason, now: ts, lastHeartbeatAt: ts });
    if (!transition.ok) return;
    store.updateWorkUnitAttemptStatus({ attemptId: attempt.id, workUnitId: attempt.workUnitId,
      runtimeInstanceId: attempt.runtimeInstanceId, fencingToken: attempt.fencingToken,
      status: "cancelling", now: ts, abortRequestedAt: ts, errorCode: code, errorMessage: reason });
    store.appendRuntimeEvent({ workUnitId: workUnit.id, attemptId: attempt.id, runtimeInstanceId: attempt.runtimeInstanceId,
      fencingToken: attempt.fencingToken, type: "work_unit_cancelling", actor: "system", ts, data: { reason, code } });
    activeRuns.requestStop(runId, { kind: "runtime_failure", code, reason });
  };
  const clearHard = (): void => { if (hardTimer !== undefined) clearTimeout(hardTimer); hardTimer = undefined; };
  const account = (): void => {
    const monotonic = performance.now();
    if (started) remainingMs -= Math.max(0, monotonic - activeSince);
    activeSince = monotonic;
  };
  const expiredHard = (): boolean => {
    if (stopped || retained() || !started || pauseDepth > 0 || signal.aborted) return false;
    if (Math.max(0, performance.now() - activeSince) < remainingMs) return false;
    requestAbort("hard_timeout");
    return true;
  };
  const scheduleHard = (): void => {
    if (hardTimer !== undefined || stopped || !started || pauseDepth > 0 || signal.aborted) return;
    hardTimer = setTimeout(() => {
      hardTimer = undefined;
      if (retained()) return;
      if (store.getWorkUnit(workUnit.id)?.status === "waiting_for_approval") { approvalWaitChanged(true); return; }
      account();
      if (remainingMs <= 0) requestAbort("hard_timeout");
      else scheduleHard();
    }, Math.max(1, remainingMs));
    hardTimer.unref?.();
  };
  const pause = (): void => {
    if (++pauseDepth > 1) return;
    account(); clearHard();
    if (started && remainingMs <= 0 && !retained()) requestAbort("hard_timeout");
  };
  const resume = (): void => {
    if (pauseDepth === 0 || --pauseDepth > 0) return;
    activeSince = performance.now();
    if (!started) return;
    if (remainingMs <= 0) requestAbort("hard_timeout");
    else scheduleHard();
  };
  const approvalWaitChanged = (waiting: boolean): void => {
    if (waiting === approvalPaused) return;
    approvalPaused = waiting;
    lastActivityAt = performance.now();
    if (waiting) pause(); else resume();
  };
  const heartbeatTimer = setInterval(() => {
    if (!started) return;
    heartbeat();
    if (stopped || retained()) return;
    const current = store.getWorkUnit(workUnit.id);
    if (!current || !isActiveWorkUnitStatus(current.status)) return;
    if (input.waitingForContinuation?.() || approvalPaused || current.status === "waiting_for_approval") {
      lastActivityAt = performance.now(); return;
    }
    // Delayed timers must preserve the earlier hard deadline over idle expiry.
    if (expiredHard()) return;
    if (performance.now() - lastActivityAt > current.timeoutPolicy.idleTimeoutMs) requestAbort("idle_timeout");
  }, workUnit.timeoutPolicy.heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return {
    start() { started = true; activeSince = performance.now(); clearHard(); scheduleHard(); },
    activity() { lastActivityAt = performance.now(); }, heartbeat, pause, resume, approvalWaitChanged, requestAbort,
    stopWatchdogs() { stopped = true; clearHard(); },
    dispose() { stopped = true; clearHard(); clearInterval(heartbeatTimer); },
  };
}

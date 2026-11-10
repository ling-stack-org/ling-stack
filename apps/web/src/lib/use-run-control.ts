import { useEffect, useRef, useState } from "react";
import { cancelRun, cancelWorkUnit, getRun, getRunEvents, getWorkUnit } from "../api.js";
import type { RunEventEnvelope, RunSession } from "../types.js";
import { useI18n } from "../i18n.js";
import { isTerminalRunStop, isWorkUnitStopSettled } from "./run-stop-settlement.js";
import { runStopLookupJournal, type RunStopLookupRecord } from "./run-stop-lookup-journal.js";

interface PendingRunStop {
  readonly key: string;
  readonly runId: string;
  readonly cwd: string;
  readonly workspaceCwd: string;
  workUnitId?: string;
  attemptId?: string;
  lookupRecord?: RunStopLookupRecord;
  timer?: ReturnType<typeof setTimeout>;
}

export function useRunControl(options: {
  readonly defaultCwd: string;
  readonly activeRunId: string;
  readonly currentRun: RunSession | undefined;
  readonly runs: readonly RunSession[];
  readonly abortCurrentRun: () => void;
  readonly setRun: (run: RunSession | undefined) => void;
  readonly setEvents: (events: readonly RunEventEnvelope[]) => void;
  readonly setIsRunning: (isRunning: boolean) => void;
  readonly clearError: () => void;
  readonly reportError: (message: string) => void;
  readonly refreshRuns: (cwd: string) => Promise<void>;
  readonly refreshApprovals: (cwd: string, runId?: string) => Promise<void>;
  readonly refreshRuntimeState: (cwd: string, run?: RunSession) => Promise<void>;
  readonly refreshHealth: () => Promise<void>;
  readonly readRunWorkspaceCwd: (run: RunSession, fallbackCwd: string) => string;
}): {
  readonly cancellingRunId: string;
  readonly cancellingRunIds: readonly string[];
  readonly cancelRunOrWorkUnit: (targetRun?: RunSession) => Promise<void>;
} {
  const { t } = useI18n();
  const [pendingIds, setPendingIds] = useState<readonly string[]>([]);
  const pendingRef = useRef(new Map<string, PendingRunStop>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    setPendingIds([]);
    const pending = pendingRef.current;
    try {
      for (const record of runStopLookupJournal.read(options.defaultCwd)) {
        const key = JSON.stringify([options.defaultCwd, record]);
        const operation: PendingRunStop = { key, ...record, workspaceCwd: options.defaultCwd, lookupRecord: record };
        pending.set(key, operation);
        void reconcile(operation);
      }
      setPendingIds([...pending.values()].map(item => item.runId));
    } catch {
      optionsRef.current.reportError(t("Pending confirmation"));
    }
    return () => {
      for (const operation of pending.values()) clearTimeout(operation.timer);
      pending.clear();
    };
    // Stored operations resume GET-only reconciliation, never the cancel mutation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.defaultCwd]);

  function isCurrent(operation: PendingRunStop): boolean {
    return pendingRef.current.get(operation.key) === operation
      && optionsRef.current.defaultCwd === operation.workspaceCwd;
  }

  function ownsSelection(operation: PendingRunStop): boolean {
    const current = optionsRef.current;
    return isCurrent(operation) && (current.currentRun?.id || current.activeRunId) === operation.runId;
  }

  function finish(operation: PendingRunStop): void {
    if (!isCurrent(operation)) return;
    if (operation.lookupRecord) {
      try {
        runStopLookupJournal.forget(operation.workspaceCwd, operation.lookupRecord);
      } catch {
        throw new Error(t("Pending confirmation"));
      }
    }
    clearTimeout(operation.timer);
    pendingRef.current.delete(operation.key);
    setPendingIds([...pendingRef.current.values()].map(item => item.runId));
  }

  async function reconcile(operation: PendingRunStop, rejected = false): Promise<void> {
    if (!isCurrent(operation)) return;
    try {
      const run = await getRun(operation.runId, operation.cwd);
      if (!isCurrent(operation)) return;
      if (run.id !== operation.runId || (operation.workUnitId && run.workUnitId && operation.workUnitId !== run.workUnitId)) {
        throw new Error(t("Pending confirmation"));
      }
      operation.workUnitId ??= run.workUnitId;
      const detail = operation.workUnitId ? await getWorkUnit(operation.cwd, operation.workUnitId) : undefined;
      if (!isCurrent(operation)) return;
      if (detail && (detail.cwd.trim() !== operation.cwd.trim() || detail.workUnit.id !== operation.workUnitId
        || detail.workUnit.linkedRunId !== operation.runId)) throw new Error(t("Pending confirmation"));
      operation.attemptId ??= detail?.workUnit.activeAttemptId;
      const terminal = isTerminalRunStop(run, detail);
      const resourcesReleased = detail && isWorkUnitStopSettled(detail, operation.attemptId, run);
      if (!terminal || !resourcesReleased) {
        if (rejected && !terminal && (!detail || detail.workUnit.status !== "cancelling")) finish(operation);
        return;
      }
      const events = await getRunEvents(operation.runId, operation.cwd);
      if (!isCurrent(operation)) return;
      if (events.runId !== operation.runId || events.events.some(event => event.runId !== operation.runId)) {
        throw new Error(t("Pending confirmation"));
      }
      const current = optionsRef.current;
      if (ownsSelection(operation)) {
        current.setRun(run);
        if (events.events.length) current.setEvents(events.events);
        current.abortCurrentRun();
        current.setIsRunning(false);
      }
      finish(operation);
      await Promise.allSettled([
        current.refreshRuns(operation.cwd), current.refreshApprovals(operation.cwd, operation.runId),
        current.refreshRuntimeState(operation.cwd, run), current.refreshHealth(),
      ]);
    } catch (error) {
      if (ownsSelection(operation)) optionsRef.current.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      // An accepted command or unreachable response is not proof that execution stopped.
      if (isCurrent(operation)) operation.timer = setTimeout(() => { void reconcile(operation); }, 750);
    }
  }

  async function cancelRunOrWorkUnit(targetRun?: RunSession): Promise<void> {
    const targetRunId = targetRun?.id || options.activeRunId;
    if (!targetRunId) return;
    const key = `${options.defaultCwd}::${targetRunId}`;
    if ([...pendingRef.current.values()].some(operation => operation.runId === targetRunId)) return;

    const target = targetRun ?? (options.currentRun?.id === targetRunId ? options.currentRun : options.runs.find((item) => item.id === targetRunId));
    const cancelCwd = target ? options.readRunWorkspaceCwd(target, options.defaultCwd) : options.defaultCwd;
    const operation: PendingRunStop = { key, runId: targetRunId, cwd: cancelCwd,
      workspaceCwd: options.defaultCwd, workUnitId: target?.workUnitId };
    pendingRef.current.set(key, operation);
    setPendingIds([...pendingRef.current.values()].map(item => item.runId));
    let dispatched = false;
    try {
      options.clearError();
      if (target?.workUnitId) {
        const detail = await getWorkUnit(cancelCwd, target.workUnitId);
        if (!isCurrent(operation)) return;
        if (detail.cwd.trim() !== cancelCwd.trim() || detail.workUnit.id !== target.workUnitId || detail.workUnit.linkedRunId !== targetRunId) {
          if (ownsSelection(operation)) optionsRef.current.reportError(t("Pending confirmation"));
          finish(operation);
          return;
        }
        operation.attemptId = detail.workUnit.activeAttemptId;
      }
      const record: RunStopLookupRecord = { cwd: cancelCwd, runId: targetRunId,
        workUnitId: operation.workUnitId, attemptId: operation.attemptId };
      try {
        runStopLookupJournal.remember(operation.workspaceCwd, record);
      } catch {
        throw new Error(t("Pending confirmation"));
      }
      operation.lookupRecord = record;
      dispatched = true;
      if (target?.workUnitId) await cancelWorkUnit(cancelCwd, target.workUnitId, {
        expectedAttemptId: operation.attemptId ?? null, expectedRunId: targetRunId,
      });
      else await cancelRun(cancelCwd, targetRunId);
      await reconcile(operation);
    } catch (error) {
      if (!isCurrent(operation)) return;
      if (ownsSelection(operation)) optionsRef.current.reportError(error instanceof Error ? error.message : String(error));
      if (!dispatched) {
        finish(operation);
        return;
      }
      const rejected = error instanceof Error && "status" in error && typeof error.status === "number"
        && error.status >= 400 && error.status < 500 && error.status !== 408;
      await reconcile(operation, rejected);
    }
  }

  const selectedId = options.currentRun?.id || options.activeRunId;
  return { cancellingRunId: pendingIds.includes(selectedId) ? selectedId : "", cancellingRunIds: pendingIds, cancelRunOrWorkUnit };
}

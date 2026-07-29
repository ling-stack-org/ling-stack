import { useState } from "react";
import { cancelRun, cancelWorkUnit, getRun, getRunEvents } from "../api.js";
import type { RunEventEnvelope, RunSession } from "../types.js";

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
  readonly cancelRunOrWorkUnit: (targetRun?: RunSession) => Promise<void>;
} {
  const [cancellingRunId, setCancellingRunId] = useState("");

  async function cancelRunOrWorkUnit(targetRun?: RunSession): Promise<void> {
    const targetRunId = targetRun?.id || options.activeRunId;
    if (!targetRunId || cancellingRunId) {
      options.setIsRunning(false);
      return;
    }

    const target = targetRun ?? (options.currentRun?.id === targetRunId ? options.currentRun : options.runs.find((item) => item.id === targetRunId));
    const cancelCwd = target ? options.readRunWorkspaceCwd(target, options.defaultCwd) : options.defaultCwd;
    setCancellingRunId(targetRunId);
    try {
      options.clearError();
      if (target?.workUnitId) {
        const response = await cancelWorkUnit(cancelCwd, target.workUnitId);
        if (response.workUnit.linkedRunId) {
          const cancelledRun = await getRun(response.workUnit.linkedRunId, cancelCwd);
          options.setRun(cancelledRun);
        }
      } else {
        const response = await cancelRun(cancelCwd, targetRunId);
        if (response.run) {
          options.setRun(response.run);
        }
      }
      options.abortCurrentRun();
      const eventResult = await getRunEvents(targetRunId, cancelCwd);
      options.setEvents(eventResult.events);
      await Promise.all([
        options.refreshRuns(cancelCwd),
        options.refreshApprovals(cancelCwd, targetRunId),
        options.refreshRuntimeState(cancelCwd, target),
      ]);
    } catch (error) {
      options.reportError(error instanceof Error ? error.message : String(error));
    } finally {
      options.setIsRunning(false);
      setCancellingRunId("");
      await options.refreshHealth();
    }
  }

  return { cancellingRunId, cancelRunOrWorkUnit };
}

import type { RunEventEnvelope, RunSession, RunStore, WorkUnit } from "@ling-stack/core";
import { ensureRunCancelled } from "./features/runs/cancellation.js";
import { cancelStandaloneWorkUnit } from "./runtime/work-units.js";

export interface ActiveRunHandle {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}

export interface RunControlCancelRunResult {
  readonly cancelled: boolean;
  readonly active: boolean;
  readonly run?: RunSession;
  readonly event?: RunEventEnvelope;
}

export interface RunControlCancelWorkUnitResult {
  readonly workUnit: WorkUnit;
  readonly run?: RunSession;
  readonly event?: RunEventEnvelope;
}

export class RunControlService {
  cancelRun(input: {
    readonly store: RunStore;
    readonly runId: string;
    readonly reason: string;
    readonly activeRun?: ActiveRunHandle;
    readonly expectedAttemptId?: string | null;
    readonly expectedRunId?: string | null;
  }): RunControlCancelRunResult {
    const current = input.store.getRun(input.runId);
    if (!current) return { cancelled: false, active: false };
    if (["succeeded", "failed", "cancelled"].includes(current.status)) {
      return { cancelled: current.status === "cancelled", active: false, run: current };
    }
    const result = ensureRunCancelled({ ...input, taskId: current.taskId, startedAt: current.startedAt,
      active: Boolean(input.activeRun), streamEnvelope: input.activeRun?.streamEnvelope });
    // Safe yielded work is cancelled logically; its old or successor Host must not be aborted.
    const active = !result.inputWait && Boolean(input.activeRun);
    if (active) input.activeRun?.abortController.abort();
    return { cancelled: true, active, run: input.store.getRun(current.id), event: result.event };
  }

  cancelRunForRedirect(input: { readonly store: RunStore; readonly run: RunSession; readonly activeRun?: ActiveRunHandle }): RunControlCancelRunResult {
    return this.cancelRun({ store: input.store, runId: input.run.id, reason: "interrupt_redirect", activeRun: input.activeRun });
  }

  cancelWorkUnit(input: {
    readonly store: RunStore;
    readonly workUnit: WorkUnit;
    readonly reason: string;
    readonly activeRun?: ActiveRunHandle;
    readonly expectedAttemptId?: string | null;
    readonly expectedRunId?: string | null;
  }): RunControlCancelWorkUnitResult {
    const runId = input.workUnit.linkedRunId;
    const expected = {
      expectedAttemptId: input.expectedAttemptId === undefined ? input.workUnit.activeAttemptId ?? null : input.expectedAttemptId,
      expectedRunId: input.expectedRunId === undefined ? runId ?? null : input.expectedRunId,
    };
    if (runId && input.store.getRun(runId)) {
      const cancellation = this.cancelRun({ ...input, ...expected, runId });
      return { workUnit: input.store.getWorkUnit(input.workUnit.id) ?? input.workUnit,
        run: cancellation.run, event: cancellation.event };
    }
    const workUnit = cancelStandaloneWorkUnit(input.store, input.workUnit, input.reason, expected);
    input.activeRun?.abortController.abort();
    return { workUnit };
  }
}

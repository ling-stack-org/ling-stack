import {
  getRunSummaryPath,
  writeRunSummary,
  type RunEventEnvelope,
  type RunSession,
  type RunStatus,
  type RunStore,
  type RunSummary,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitStatus,
  type RuntimeEvent,
} from "@ling-stack/core";

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
  }): RunControlCancelRunResult {
    const current = input.store.getRun(input.runId);
    if (!current) {
      return { cancelled: false, active: false };
    }
    if (isTerminalRunStatus(current.status)) {
      return {
        cancelled: current.status === "cancelled",
        active: false,
        run: current,
      };
    }

    const active = Boolean(input.activeRun);
    const event = this.transitionRunCancelled({
      store: input.store,
      run: current,
      reason: input.reason,
      active,
      streamEnvelope: input.activeRun?.streamEnvelope,
    });
    input.activeRun?.abortController.abort();

    return {
      cancelled: true,
      active,
      run: input.store.getRun(input.runId),
      event,
    };
  }

  cancelRunForRedirect(input: {
    readonly store: RunStore;
    readonly run: RunSession;
    readonly activeRun?: ActiveRunHandle;
  }): RunControlCancelRunResult {
    return this.cancelRun({
      store: input.store,
      runId: input.run.id,
      reason: "interrupt_redirect",
      activeRun: input.activeRun,
    });
  }

  cancelWorkUnit(input: {
    readonly store: RunStore;
    readonly workUnit: WorkUnit;
    readonly reason: string;
    readonly activeRun?: ActiveRunHandle;
  }): RunControlCancelWorkUnitResult {
    const runId = input.workUnit.linkedRunId;
    if (runId) {
      const run = input.store.getRun(runId);
      if (run) {
        const cancellation = this.cancelRun({
          store: input.store,
          runId,
          reason: input.reason,
          activeRun: input.activeRun,
        });
        return {
          workUnit: input.store.getWorkUnit(input.workUnit.id) ?? input.workUnit,
          run: cancellation.run,
          event: cancellation.event,
        };
      }
    }

    const workUnit = this.cancelStandaloneWorkUnit(input.store, input.workUnit, input.reason);
    input.activeRun?.abortController.abort();
    return { workUnit };
  }

  private transitionRunCancelled(input: {
    readonly store: RunStore;
    readonly run: RunSession;
    readonly reason: string;
    readonly active: boolean;
    readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
  }): RunEventEnvelope | undefined {
    const current = input.store.getRun(input.run.id);
    if (!current || isTerminalRunStatus(current.status)) {
      return undefined;
    }

    const endedAt = new Date().toISOString();
    this.cancelPendingApprovalsForRun(input.store, input.run.id, endedAt, `Run cancelled: ${input.reason}`, input.streamEnvelope);
    const event = input.store.appendEvent(input.run.id, "run_cancelled", {
      reason: input.reason,
      active: input.active,
    });
    input.streamEnvelope?.(event);
    const summaryPath = writeTerminalSummary(getRunSummaryPath(input.store.paths, input.run.id), {
      runId: input.run.id,
      status: "cancelled",
      taskId: input.run.taskId,
      eventCount: event.seq,
      startedAt: input.run.startedAt,
      endedAt,
      errorMessage: null,
    });
    input.store.transitionRunStatus({
      runId: input.run.id,
      expectedStatus: current.status,
      event: "cancel",
      actor: "local-user",
      reason: input.reason,
      now: endedAt,
      endedAt,
      summaryPath,
      errorMessage: null,
    });
    const task = input.store.getTask(input.run.taskId);
    if (task && task.status !== "done" && task.status !== "cancelled") {
      input.store.transitionTaskStatus({
        taskId: input.run.taskId,
        expectedStatus: task.status,
        event: "cancel",
        actor: "local-user",
        reason: input.reason,
        now: endedAt,
        currentRunId: input.run.id,
      });
    }
    input.store.releaseResourceLeasesForOwner("run", input.run.id, endedAt);
    if (current.workUnitId) {
      const workUnit = input.store.getWorkUnit(current.workUnitId);
      const attemptId = workUnit?.activeAttemptId ?? input.store.listWorkUnitAttempts(current.workUnitId).at(-1)?.id;
      if (attemptId) {
        this.transitionWorkUnitCancelled(input.store, current.workUnitId, attemptId, input.reason);
      }
      if (workUnit) {
        this.releaseWorkUnitRuntimeResources(input.store, workUnit, endedAt, "cancelled");
      }
    }
    return event;
  }

  private cancelPendingApprovalsForRun(
    store: RunStore,
    runId: string,
    now: string,
    reason: string,
    streamEnvelope?: (envelope: RunEventEnvelope) => void,
  ): void {
    const pendingApprovals = store.listApprovalRequests({ runId, status: "pending", limit: 500 });
    for (const approval of pendingApprovals) {
      const cancelled = store.cancelApprovalRequest(approval.id, { reason, resolvedBy: "local-user" }, now);
      if (!cancelled) {
        continue;
      }
      const event = store.appendEvent(runId, "approval_cancelled", {
        approvalId: cancelled.id,
        status: cancelled.status,
        resolvedBy: cancelled.resolvedBy,
        decisionReason: cancelled.decisionReason,
      });
      streamEnvelope?.(event);
    }
  }

  private cancelStandaloneWorkUnit(store: RunStore, workUnit: WorkUnit, reason: string): WorkUnit {
    const attemptId = workUnit.activeAttemptId ?? store.listWorkUnitAttempts(workUnit.id).at(-1)?.id;
    if (attemptId) {
      this.transitionWorkUnitCancelled(store, workUnit.id, attemptId, reason);
    } else if (!isTerminalWorkUnitStatus(workUnit.status) && workUnit.status !== "stale") {
      const now = new Date().toISOString();
      const cancelling = store.transitionWorkUnitStatus({
        workUnitId: workUnit.id,
        expectedStatus: workUnit.status,
        event: "cancel",
        actor: "local-user",
        reason,
        now,
      });
      if (cancelling.ok) {
        store.transitionWorkUnitStatus({
          workUnitId: workUnit.id,
          expectedStatus: "cancelling",
          event: "runner_cancelled",
          actor: "system",
          reason,
          now,
          endedAt: now,
        });
      }
    }
    return this.releaseWorkUnitRuntimeResources(store, workUnit, new Date().toISOString(), "cancelled");
  }

  private releaseWorkUnitRuntimeResources(store: RunStore, workUnit: WorkUnit, now: string, releaseReason: string): WorkUnit {
    for (const attempt of store.listWorkUnitAttempts(workUnit.id)) {
      store.releaseRuntimeSemaphoreSlotsForOwner(attempt.id, now, releaseReason);
    }
    for (const lease of store.listResourceLeases({ workUnitId: workUnit.id, status: "active", limit: 500 })) {
      store.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, now);
    }
    return store.getWorkUnit(workUnit.id) ?? workUnit;
  }

  private transitionWorkUnitCancelled(store: RunStore, workUnitId: string, attemptId: string, reason: string): void {
    const current = store.getWorkUnit(workUnitId);
    if (!current || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
      return;
    }
    const now = new Date().toISOString();
    const cancelling =
      current.status === "cancelling"
        ? { ok: true as const, from: current.status, to: current.status }
        : store.transitionWorkUnitStatus({
            workUnitId,
            expectedStatus: current.status,
            event: "cancel",
            actor: "local-user",
            reason,
            now,
          });
    if (!cancelling.ok) {
      return;
    }
    const latest = store.getWorkUnit(workUnitId);
    if (!latest || latest.status !== "cancelling") {
      return;
    }
    this.transitionWorkUnitTerminal(store, {
      workUnitId,
      attemptId,
      event: "runner_cancelled",
      attemptStatus: "cancelled",
      runtimeEventType: "work_unit_cancelled",
      actor: "runner",
      now,
      errorCode: "cancelled",
      errorMessage: reason,
    });
  }

  private transitionWorkUnitTerminal(
    store: RunStore,
    input: {
      readonly workUnitId: string;
      readonly attemptId: string;
      readonly event: Parameters<RunStore["transitionWorkUnitStatus"]>[0]["event"];
      readonly attemptStatus: WorkUnitAttempt["status"];
      readonly runtimeEventType: RuntimeEvent["type"];
      readonly actor: Parameters<RunStore["transitionWorkUnitStatus"]>[0]["actor"];
      readonly now: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
    },
  ): void {
    const current = store.getWorkUnit(input.workUnitId);
    if (!current || isTerminalWorkUnitStatus(current.status) || current.status === "stale") {
      return;
    }
    const transition = store.transitionWorkUnitStatus({
      workUnitId: input.workUnitId,
      expectedStatus: current.status,
      event: input.event,
      actor: input.actor,
      now: input.now,
      endedAt: input.now,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    });
    if (!transition.ok) {
      return;
    }
    store.updateWorkUnitAttemptStatus({
      attemptId: input.attemptId,
      status: input.attemptStatus,
      now: input.now,
      endedAt: input.now,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    });
    store.appendRuntimeEvent({
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
      type: input.runtimeEventType,
      actor: input.actor === "runner" ? "runner" : input.actor === "provider" ? "provider" : "system",
      ts: input.now,
      data: {
        fromStatus: transition.from,
        toStatus: transition.to,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      },
    });
  }
}

function writeTerminalSummary(summaryPath: string, summary: RunSummary): string | undefined {
  try {
    writeRunSummary(summaryPath, summary);
    return summaryPath;
  } catch {
    return undefined;
  }
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isTerminalWorkUnitStatus(status: WorkUnitStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

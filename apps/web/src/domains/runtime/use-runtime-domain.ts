import { useState } from "react";
import {
  cancelWorkUnit,
  getRuntimeDiagnostics,
  getWorkUnit,
  listResourceLeases,
  listStateTransitions,
  listWorkUnits,
  reconcileWorkUnit,
  retryWorkUnit,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type {
  ResourceLease,
  RuntimeDiagnosticsResponse,
  RunSession,
  StateTransitionEvent,
  WorkUnit,
  WorkUnitDetailResponse,
} from "../../types.js";

export interface RuntimeState {
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly runtimeDiagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly selectedWorkUnitDetail: WorkUnitDetailResponse | undefined;
  readonly runtimeLoading: boolean;
  readonly runtimeActionWorkUnitId: string;
}

export interface RuntimeActions {
  readonly setSelectedWorkUnitDetail: (detail: WorkUnitDetailResponse | undefined) => void;
  readonly refreshRuntimeState: (cwd?: string, sourceRun?: RunSession) => Promise<void>;
  readonly runWorkUnitAction: (workUnitId: string, action: "cancel" | "retry" | "reconcile") => Promise<void>;
  readonly resetForCwd: () => void;
}

export type RuntimeController = DomainController<RuntimeState, RuntimeActions>;

export function useRuntimeDomain(input: {
  readonly cwd: string;
  readonly setErrorMessage: (message: string) => void;
  readonly onWorkUnitActionComplete?: (workUnitId: string, action: "cancel" | "retry" | "reconcile") => Promise<void> | void;
}): RuntimeController {
  const [stateTransitions, setStateTransitions] = useState<readonly StateTransitionEvent[]>([]);
  const [resourceLeases, setResourceLeases] = useState<readonly ResourceLease[]>([]);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnosticsResponse | undefined>();
  const [workUnits, setWorkUnits] = useState<readonly WorkUnit[]>([]);
  const [selectedWorkUnitDetail, setSelectedWorkUnitDetail] = useState<WorkUnitDetailResponse | undefined>();
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeActionWorkUnitId, setRuntimeActionWorkUnitId] = useState("");
  const [error, setError] = useState<DomainError | undefined>();

  async function refreshRuntimeState(cwd = input.cwd, sourceRun?: RunSession): Promise<void> {
    if (!cwd) {
      setResourceLeases([]);
      setStateTransitions([]);
      setRuntimeDiagnostics(undefined);
      setWorkUnits([]);
      setSelectedWorkUnitDetail(undefined);
      return;
    }

    setRuntimeLoading(true);
    try {
      setError(undefined);
      const transitionRequests = [
        listStateTransitions(cwd, { limit: 30 }).then((response) => response.transitions),
        listStateTransitions(cwd, { entityType: "run", limit: 30 }).then((response) => response.transitions),
        listStateTransitions(cwd, { entityType: "work_unit", limit: 30 }).then((response) => response.transitions),
      ];
      if (sourceRun) {
        transitionRequests.push(listStateTransitions(cwd, { entityType: "run", entityId: sourceRun.id, limit: 50 }).then((response) => response.transitions));
        const taskTransitionId = typeof sourceRun.taskSnapshot === "object" && sourceRun.taskSnapshot && "id" in sourceRun.taskSnapshot
          ? String(sourceRun.taskSnapshot.id)
          : sourceRun.taskId;
        if (taskTransitionId) {
          transitionRequests.push(listStateTransitions(cwd, { entityType: "task", entityId: taskTransitionId, limit: 50 }).then((response) => response.transitions));
        }
        if (sourceRun.workUnitId) {
          transitionRequests.push(listStateTransitions(cwd, { entityType: "work_unit", entityId: sourceRun.workUnitId, limit: 50 }).then((response) => response.transitions));
        }
      }

      const [leasesResponse, transitionResponses, diagnosticsResponse, workUnitsResponse] = await Promise.all([
        listResourceLeases(cwd, { status: "active", limit: 50 }),
        Promise.all(transitionRequests),
        getRuntimeDiagnostics(cwd).catch(() => undefined),
        listWorkUnits(cwd, { limit: 100 }).catch(() => ({ cwd, workUnits: [] })),
      ]);
      const uniqueTransitions = new Map<string, StateTransitionEvent>();
      for (const transition of transitionResponses.flat()) {
        uniqueTransitions.set(transition.id, transition);
      }
      setResourceLeases(diagnosticsResponse?.leases ?? leasesResponse.leases);
      setRuntimeDiagnostics(diagnosticsResponse);
      setWorkUnits(workUnitsResponse.workUnits);
      setStateTransitions([...uniqueTransitions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (caught) {
      setResourceLeases([]);
      setStateTransitions([]);
      setRuntimeDiagnostics(undefined);
      setWorkUnits([]);
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
    } finally {
      setRuntimeLoading(false);
    }
  }

  async function runWorkUnitAction(workUnitId: string, action: "cancel" | "retry" | "reconcile"): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || runtimeActionWorkUnitId) {
      return;
    }

    setRuntimeActionWorkUnitId(workUnitId);
    try {
      input.setErrorMessage("");
      setError(undefined);
      const response = action === "cancel"
        ? await cancelWorkUnit(cwd, workUnitId)
        : action === "retry"
          ? await retryWorkUnit(cwd, workUnitId)
          : await reconcileWorkUnit(cwd, workUnitId);
      setWorkUnits((current) =>
        current.map((item) => item.id === response.workUnit.id ? response.workUnit : item),
      );
      if (selectedWorkUnitDetail?.workUnit.id === workUnitId) {
        try {
          setSelectedWorkUnitDetail(await getWorkUnit(cwd, workUnitId));
        } catch {
          setSelectedWorkUnitDetail(undefined);
        }
      }
      await refreshRuntimeState(cwd);
      await input.onWorkUnitActionComplete?.(workUnitId, action);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setRuntimeActionWorkUnitId("");
    }
  }

  function resetForCwd(): void {
    setStateTransitions([]);
    setResourceLeases([]);
    setRuntimeDiagnostics(undefined);
    setWorkUnits([]);
    setSelectedWorkUnitDetail(undefined);
    setRuntimeLoading(false);
    setRuntimeActionWorkUnitId("");
    setError(undefined);
  }

  return {
    state: {
      stateTransitions,
      resourceLeases,
      runtimeDiagnostics,
      workUnits,
      selectedWorkUnitDetail,
      runtimeLoading,
      runtimeActionWorkUnitId,
    },
    actions: {
      setSelectedWorkUnitDetail,
      refreshRuntimeState,
      runWorkUnitAction,
      resetForCwd,
    },
    refresh: refreshRuntimeState,
    isLoading: runtimeLoading,
    error,
    clearError: () => setError(undefined),
  };
}

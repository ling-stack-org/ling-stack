import { useState } from "react";
import {
  cancelWorkUnit,
  getControlPlaneSnapshot,
  getRuntimeDiagnostics,
  getWorkUnit,
  listResourceLeases,
  listStateTransitions,
  listWorkUnits,
  reconcileWorkUnit,
  retryWorkUnit,
} from "../../api.js";
import type { DomainController } from "../../app/domain-controller.js";
import {
  domainErrorMessage,
  type FocusedDomainError,
  type FocusedErrorRequest,
  useFocusedDomainErrorOwner,
} from "../../app/use-focused-domain-error-owner.js";
import type {
  ResourceLease,
  RuntimeDiagnosticsResponse,
  RunSession,
  StateTransitionEvent,
  WorkUnit,
  WorkUnitDetailResponse,
  WorkUnitsDomainSnapshot,
} from "../../types.js";
import { readControlPlaneDomainData, workUnitsFromControlPlaneSnapshot } from "../../lib/control-plane.js";

export interface RuntimeState {
  readonly stateTransitions: readonly StateTransitionEvent[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly runtimeDiagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly selectedWorkUnitDetail: WorkUnitDetailResponse | undefined;
  readonly runtimeLoading: boolean;
  readonly runtimeActionWorkUnitId: string;
  readonly runtimeErrors: readonly RuntimeDomainError[];
}

export interface RuntimeActions {
  readonly setSelectedWorkUnitDetail: (detail: WorkUnitDetailResponse | undefined) => void;
  readonly refreshRuntimeState: (cwd?: string, sourceRun?: RunSession) => Promise<void>;
  readonly runWorkUnitAction: (workUnitId: string, action: "cancel" | "retry" | "reconcile") => Promise<void>;
  readonly resetForCwd: () => void;
}

export type RuntimeErrorAction = "load" | "cancel" | "retry" | "reconcile";

export type RuntimeDomainError = FocusedDomainError<"runtime", RuntimeErrorAction>;

export type RuntimeController = Omit<DomainController<RuntimeState, RuntimeActions>, "error"> & {
  readonly error: RuntimeDomainError | undefined;
};

export function useRuntimeDomain(input: {
  readonly cwd: string;
  readonly onWorkUnitActionComplete?: (workUnitId: string, action: "cancel" | "retry" | "reconcile") => Promise<void> | void;
}): RuntimeController {
  const [stateTransitions, setStateTransitions] = useState<readonly StateTransitionEvent[]>([]);
  const [resourceLeases, setResourceLeases] = useState<readonly ResourceLease[]>([]);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnosticsResponse | undefined>();
  const [workUnits, setWorkUnits] = useState<readonly WorkUnit[]>([]);
  const [selectedWorkUnitDetail, setSelectedWorkUnitDetail] = useState<WorkUnitDetailResponse | undefined>();
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeActionWorkUnitId, setRuntimeActionWorkUnitId] = useState("");
  const runtimeIdentity = input.cwd.trim() || "workspace:unavailable";
  const errorOwner = useFocusedDomainErrorOwner<"runtime", RuntimeErrorAction>(runtimeIdentity);

  function isCurrentRuntimeRequest(
    request: FocusedErrorRequest<"runtime", RuntimeErrorAction>,
    cwd: string,
  ): boolean {
    return errorOwner.isCurrent(request)
      && request.identity === (cwd.trim() || "workspace:unavailable");
  }

  async function refreshRuntimeState(cwd = input.cwd, sourceRun?: RunSession): Promise<void> {
    if (!cwd) {
      setResourceLeases([]);
      setStateTransitions([]);
      setRuntimeDiagnostics(undefined);
      setWorkUnits([]);
      setSelectedWorkUnitDetail(undefined);
      errorOwner.clearAll();
      return;
    }

    const request = errorOwner.begin("runtime", "runtime-state", "load");
    errorOwner.clear(request);
    if (request.identity === (cwd.trim() || "workspace:unavailable")) setRuntimeLoading(true);
    const snapshotWorkUnits = await getControlPlaneSnapshot(cwd, ["work_units"])
      .then((snapshot) => readControlPlaneDomainData<WorkUnitsDomainSnapshot>(snapshot, "work_units"))
      .then((snapshot) => snapshot ? workUnitsFromControlPlaneSnapshot(snapshot) : undefined)
      .catch(() => undefined);
    if (snapshotWorkUnits && isCurrentRuntimeRequest(request, cwd)) {
      setWorkUnits(snapshotWorkUnits);
    }
    try {
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
        listWorkUnits(cwd, { limit: 100 }).catch(() => ({ cwd, workUnits: snapshotWorkUnits ?? [] })),
      ]);
      const uniqueTransitions = new Map<string, StateTransitionEvent>();
      for (const transition of transitionResponses.flat()) {
        uniqueTransitions.set(transition.id, transition);
      }
      if (isCurrentRuntimeRequest(request, cwd)) {
        setResourceLeases(diagnosticsResponse?.leases ?? leasesResponse.leases);
        setRuntimeDiagnostics(diagnosticsResponse);
        setWorkUnits(workUnitsResponse.workUnits);
        setStateTransitions([...uniqueTransitions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        errorOwner.clear(request);
      }
    } catch (caught) {
      if (isCurrentRuntimeRequest(request, cwd)) {
        setResourceLeases([]);
        setStateTransitions([]);
        setRuntimeDiagnostics(undefined);
        setWorkUnits(snapshotWorkUnits ?? []);
        errorOwner.report(request, { scope: "load", message: domainErrorMessage(caught) });
      }
    } finally {
      if (isCurrentRuntimeRequest(request, cwd)) setRuntimeLoading(false);
    }
  }

  async function runWorkUnitAction(workUnitId: string, action: "cancel" | "retry" | "reconcile"): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd || runtimeActionWorkUnitId) {
      return;
    }
    if (errorOwner.identity() !== (cwd || "workspace:unavailable")) return;

    const request = errorOwner.begin("runtime", workUnitId, action);
    errorOwner.clear(request);
    setRuntimeActionWorkUnitId(workUnitId);
    try {
      const response = action === "cancel"
        ? await cancelWorkUnit(cwd, workUnitId)
        : action === "retry"
          ? await retryWorkUnit(cwd, workUnitId)
          : await reconcileWorkUnit(cwd, workUnitId);
      if (isCurrentRuntimeRequest(request, cwd)) {
        setWorkUnits((current) =>
          current.map((item) => item.id === response.workUnit.id ? response.workUnit : item),
        );
      }
      if (selectedWorkUnitDetail?.workUnit.id === workUnitId && isCurrentRuntimeRequest(request, cwd)) {
        try {
          const detail = await getWorkUnit(cwd, workUnitId);
          if (isCurrentRuntimeRequest(request, cwd)) setSelectedWorkUnitDetail(detail);
        } catch {
          if (isCurrentRuntimeRequest(request, cwd)) setSelectedWorkUnitDetail(undefined);
        }
      }
      if (isCurrentRuntimeRequest(request, cwd)) await refreshRuntimeState(cwd);
      if (isCurrentRuntimeRequest(request, cwd)) {
        errorOwner.clear(request);
        await input.onWorkUnitActionComplete?.(workUnitId, action);
      }
    } catch (caught) {
      if (isCurrentRuntimeRequest(request, cwd)) {
        errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(caught) });
      }
    } finally {
      if (isCurrentRuntimeRequest(request, cwd)) setRuntimeActionWorkUnitId("");
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
    errorOwner.clearAll();
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
      runtimeErrors: errorOwner.errors() as readonly RuntimeDomainError[],
    },
    actions: {
      setSelectedWorkUnitDetail,
      refreshRuntimeState,
      runWorkUnitAction,
      resetForCwd,
    },
    refresh: refreshRuntimeState,
    isLoading: runtimeLoading,
    error: errorOwner.latest() as RuntimeDomainError | undefined,
    clearError: errorOwner.clearAll,
  };
}

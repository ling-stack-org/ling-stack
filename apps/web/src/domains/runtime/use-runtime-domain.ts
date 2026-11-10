import { useRef, useState } from "react";
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
import { DaemonObservationDeferredError, isDaemonObservationPausedForWorkspace, liveDaemonObservation, shouldDeferDaemonObservationError, type DaemonObservation } from "../../shared/conversation/observation/daemon-observation.js";

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
  readonly observation?: DaemonObservation;
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
  const observationRef = useRef(input.observation ?? liveDaemonObservation);
  observationRef.current = input.observation ?? liveDaemonObservation;

  function isCurrentRuntimeRequest(
    request: FocusedErrorRequest<"runtime", RuntimeErrorAction>,
    cwd: string,
  ): boolean {
    return errorOwner.isCurrent(request)
      && request.identity === (cwd.trim() || "workspace:unavailable");
  }

  async function refreshRuntimeState(cwd = input.cwd, sourceRun?: RunSession): Promise<void> {
    if (errorOwner.identity() !== (cwd.trim() || "workspace:unavailable")) return;
    if (!cwd) {
      setResourceLeases([]);
      setStateTransitions([]);
      setRuntimeDiagnostics(undefined);
      setWorkUnits([]);
      setSelectedWorkUnitDetail(undefined);
      errorOwner.clearAll();
      return;
    }

    const observation = observationRef.current;
    if (isDaemonObservationPausedForWorkspace(observation, cwd)) return;
    const request = errorOwner.begin("runtime", "runtime-state", "load");
    const canCommit = () => isCurrentRuntimeRequest(request, cwd) && observationRef.current.epoch === observation.epoch
      && observationRef.current.baseUrl === observation.baseUrl && observationRef.current.workspaceCwd === observation.workspaceCwd
      && !isDaemonObservationPausedForWorkspace(observationRef.current, cwd);
    const assertReadCurrent = (): void => { if (!canCommit()) throw new DaemonObservationDeferredError(); };
    let snapshotWorkUnits: readonly WorkUnit[] | undefined;
    let optionalReadFailed = false;
    // These endpoints already have fallbacks. Keep those fallbacks without
    // swallowing real errors or treating a paused transport as a fresh snapshot.
    function optionalReadFallback<T>(caught: unknown, fallback: T): T {
      if (caught instanceof DaemonObservationDeferredError || shouldDeferDaemonObservationError(caught, observationRef.current, cwd)) {
        throw caught instanceof DaemonObservationDeferredError ? caught : new DaemonObservationDeferredError();
      }
      optionalReadFailed = true;
      if (isCurrentRuntimeRequest(request, cwd)) {
        errorOwner.report(request, { scope: "load", message: domainErrorMessage(caught) });
      }
      return fallback;
    }
    errorOwner.clear(request);
    if (request.identity === (cwd.trim() || "workspace:unavailable")) setRuntimeLoading(current => canCommit() ? true : current);
    try {
      snapshotWorkUnits = await getControlPlaneSnapshot(cwd, ["work_units"])
        .then((snapshot) => readControlPlaneDomainData<WorkUnitsDomainSnapshot>(snapshot, "work_units"))
        .then((snapshot) => snapshot ? workUnitsFromControlPlaneSnapshot(snapshot) : undefined)
        .catch((caught: unknown) => optionalReadFallback(caught, undefined));
      assertReadCurrent();
      if (snapshotWorkUnits) {
        const units = snapshotWorkUnits;
        setWorkUnits(current => canCommit() ? units : current);
      }
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
        getRuntimeDiagnostics(cwd).catch((caught: unknown) => optionalReadFallback(caught, undefined)),
        listWorkUnits(cwd, { limit: 100 }).catch((caught: unknown) => optionalReadFallback(caught, { cwd, workUnits: snapshotWorkUnits ?? [] })),
      ]);
      assertReadCurrent();
      const uniqueTransitions = new Map<string, StateTransitionEvent>();
      for (const transition of transitionResponses.flat()) {
        uniqueTransitions.set(transition.id, transition);
      }
      setResourceLeases(current => canCommit() ? diagnosticsResponse?.leases ?? leasesResponse.leases : current);
      setRuntimeDiagnostics(current => canCommit() ? diagnosticsResponse : current);
      setWorkUnits(current => canCommit() ? workUnitsResponse.workUnits : current);
      setStateTransitions(current => canCommit() ? [...uniqueTransitions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : current);
      if (!optionalReadFailed) errorOwner.clear(request);
    } catch (caught) {
      if (caught instanceof DaemonObservationDeferredError || shouldDeferDaemonObservationError(caught, observationRef.current, cwd)) return;
      if (canCommit()) {
        setResourceLeases(current => canCommit() ? [] : current);
        setStateTransitions(current => canCommit() ? [] : current);
        setRuntimeDiagnostics(current => canCommit() ? undefined : current);
        setWorkUnits(current => canCommit() ? snapshotWorkUnits ?? [] : current);
      }
      if (isCurrentRuntimeRequest(request, cwd)) {
        errorOwner.report(request, { scope: "load", message: domainErrorMessage(caught) });
      }
    } finally {
      if (isCurrentRuntimeRequest(request, cwd)) setRuntimeLoading(current => isCurrentRuntimeRequest(request, cwd) ? false : current);
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

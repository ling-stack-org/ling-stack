import type {
  HarnessDiagnosticCursorV1,
  HarnessDiagnosticObservationV1,
  HarnessDiagnosticQueryV1,
  WorkUnitHarnessDiagnosticsResponse,
} from "../../types.js";
import { validHarnessDiagnosticsResponse } from "./harness-diagnostics-response.js";

export interface HarnessDiagnosticsScope {
  readonly cwd: string;
  readonly runId: string;
  readonly workUnitId: string;
  readonly linkedWorkUnitId: string | undefined;
  readonly linkedRunId: string | undefined;
}

export type HarnessDiagnosticsIssue = "workspace_uninitialized" | "not_found" | "invalid_query" | "unavailable" | "invalid_response";
export type HarnessDiagnosticsAvailability = WorkUnitHarnessDiagnosticsResponse["status"] | "linkage_unloaded";

export interface HarnessDiagnosticsState {
  readonly phase: "idle" | "loading" | "ready" | "error" | "unavailable";
  readonly items: readonly HarnessDiagnosticObservationV1[];
  readonly observedAt?: string;
  readonly nextCursor?: HarnessDiagnosticCursorV1;
  readonly availability?: HarnessDiagnosticsAvailability;
  readonly issue?: HarnessDiagnosticsIssue;
}

export type HarnessDiagnosticsRead = (
  cwd: string,
  workUnitId: string,
  query: HarnessDiagnosticQueryV1,
) => Promise<WorkUnitHarnessDiagnosticsResponse>;

/** Observational, scoped paging only. No mutation, recovery or execution API is reachable here. */
export function createHarnessDiagnosticsController(read: HarnessDiagnosticsRead, initialScope: HarnessDiagnosticsScope) {
  let scope = initialScope;
  let generation = 0;
  let active = false;
  let state: HarnessDiagnosticsState = idleState(scope);
  const listeners = new Set<() => void>();
  const publish = (next: HarnessDiagnosticsState): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  async function request(cursor?: HarnessDiagnosticCursorV1): Promise<void> {
    if (!active || !canRead(scope)) return;
    const requestScope = scope;
    const requestGeneration = ++generation;
    const prior = cursor ? state.items : [];
    publish({ phase: "loading", items: prior, ...(cursor ? { nextCursor: cursor, observedAt: state.observedAt } : {}) });
    try {
      const response = await read(requestScope.cwd, requestScope.workUnitId, { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!active || generation !== requestGeneration) return;
      if (!validHarnessDiagnosticsResponse(response, requestScope, cursor, prior)) {
        publish({ phase: "error", items: prior, issue: "invalid_response", ...(cursor ? { nextCursor: cursor, observedAt: state.observedAt } : {}) });
        return;
      }
      if (response.status !== "available") {
        publish({ phase: "unavailable", items: [], availability: response.status, observedAt: response.observedAt });
        return;
      }
      publish({ phase: "ready", items: [...prior, ...response.items], observedAt: response.observedAt, nextCursor: response.nextCursor });
    } catch (caught) {
      if (!active || generation !== requestGeneration) return;
      publish({ phase: "error", items: prior, issue: safeIssue(caught), ...(cursor ? { nextCursor: cursor, observedAt: state.observedAt } : {}) });
    }
  }

  return {
    getSnapshot: (): HarnessDiagnosticsState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate(): Promise<void> {
      active = true;
      return state.phase === "idle" ? request() : Promise.resolve();
    },
    suspend(): void {
      active = false;
      generation += 1;
      publish(idleState(scope));
    },
    /** Immediately removes old observations and invalidates both late successes and failures. */
    setScope(next: HarnessDiagnosticsScope): void {
      scope = next;
      generation += 1;
      publish(idleState(scope));
    },
    refresh(): Promise<void> { return request(); },
    loadMore(): Promise<void> {
      return state.phase === "ready" && state.nextCursor ? request(state.nextCursor) : Promise.resolve();
    },
  };
}

function canRead(scope: HarnessDiagnosticsScope): boolean {
  return Boolean(scope.cwd && scope.runId && scope.workUnitId && scope.linkedWorkUnitId === scope.workUnitId && scope.linkedRunId === scope.runId);
}

function idleState(scope: HarnessDiagnosticsScope): HarnessDiagnosticsState {
  if (!scope.workUnitId) return { phase: "unavailable", items: [], availability: "run_unlinked" };
  if (scope.linkedWorkUnitId === undefined) return { phase: "unavailable", items: [], availability: "linkage_unloaded" };
  if (scope.linkedWorkUnitId !== scope.workUnitId) return { phase: "unavailable", items: [], availability: "lineage_mismatch" };
  if (!scope.linkedRunId) return { phase: "unavailable", items: [], availability: "run_unlinked" };
  if (scope.linkedRunId !== scope.runId) return { phase: "unavailable", items: [], availability: "lineage_mismatch" };
  if (!scope.cwd || !scope.runId) return { phase: "error", items: [], issue: "invalid_query" };
  return { phase: "idle", items: [] };
}

function safeIssue(caught: unknown): HarnessDiagnosticsIssue {
  const code = caught && typeof caught === "object" && "code" in caught ? caught.code : undefined;
  switch (code) {
    case "harness_workspace_uninitialized": return "workspace_uninitialized";
    case "work_unit_not_found": return "not_found";
    case "harness_diagnostics_invalid_query": return "invalid_query";
    default: return "unavailable";
  }
}

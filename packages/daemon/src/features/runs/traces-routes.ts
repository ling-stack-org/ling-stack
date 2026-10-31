import type { ServerResponse } from "node:http";
import {
  DEFAULT_WORKSPACE_ID,
  createLingTraceId,
  projectLingTrace,
  type ExecutionAction,
  type LingThread,
  type ProjectLingTraceInput,
  type RunArtifact,
  type RunIntervention,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { listAllExecutionActionsForRun } from "./execution-actions.js";

export type TraceRoute =
  | { readonly kind: "detail"; readonly traceId: string }
  | { readonly kind: "spans"; readonly traceId: string };

export function handleTracesCollection(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const threadId = url.searchParams.get("threadId") ?? undefined;
    const runId = url.searchParams.get("runId") ?? undefined;
    if (!threadId && !runId) {
      writeJson(response, 400, { error: "bad_request", message: "threadId or runId query parameter is required" });
      return;
    }
    const result = threadId
      ? buildThreadTrace(storeRegistry.getStore(cwd), threadId, readOptionalIntegerQuery(url, "limit", 1))
      : buildRunTrace(storeRegistry, cwd, runId as string);
    if (!result) {
      writeJson(response, 404, { error: "trace_not_found", message: "Trace source was not found." });
      return;
    }
    writeJson(response, 200, { cwd, traces: [result.trace] });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export function handleTraceItem(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  route: TraceRoute,
): void {
  const cwd = url.searchParams.get("cwd") ?? undefined;
  const parsed = parseTraceId(route.traceId);
  if (!parsed) {
    writeJson(response, 404, { error: "trace_not_found", message: `Trace id is not recognized: ${route.traceId}` });
    return;
  }
  if (!cwd && parsed.subjectKind === "thread") {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required for thread traces" });
    return;
  }

  try {
    const result = parsed.subjectKind === "thread"
      ? buildThreadTrace(storeRegistry.getStore(cwd as string), parsed.subjectId)
      : buildRunTrace(storeRegistry, cwd, parsed.subjectId);
    if (!result) {
      writeJson(response, 404, { error: "trace_not_found", message: `Trace source was not found: ${route.traceId}` });
      return;
    }
    if (route.kind === "spans") {
      writeJson(response, 200, { cwd: result.cwd, traceId: result.trace.id, spans: result.spans });
      return;
    }
    writeJson(response, 200, { cwd: result.cwd, trace: result.trace, spans: result.spans });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function buildThreadTrace(
  store: RunStore,
  threadId: string,
  limit = 100,
): ReturnType<typeof projectLingTrace> & { readonly cwd: string } | undefined {
  const thread = store.getLingThread(threadId);
  if (!thread) {
    return undefined;
  }
  const runs = [...store.listRuns({ threadId, limit })].sort(compareRuns);
  const input = buildTraceProjectionInput({
    store,
    subjectKind: "thread",
    subjectId: thread.id,
    workspaceId: thread.workspaceId,
    title: thread.title,
    status: traceStatusFromThread(thread.status),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    runs,
    actions: collectThreadActions(store, runs),
    transitions: collectStateTransitionsForRuns(store, runs, thread),
    interventions: collectRunInterventions(store, runs),
  });
  return { cwd: store.paths.cwd, ...projectLingTrace(input) };
}

function buildRunTrace(
  storeRegistry: RunStoreRegistry,
  cwd: string | undefined,
  runId: string,
): ReturnType<typeof projectLingTrace> & { readonly cwd: string } | undefined {
  const store = storeRegistry.findStoreForRun(runId, cwd);
  const run = store?.getRun(runId);
  if (!store || !run) {
    return undefined;
  }
  const thread = run.threadId ? store.getLingThread(run.threadId) : undefined;
  const input = buildTraceProjectionInput({
    store,
    subjectKind: "run",
    subjectId: run.id,
    workspaceId: thread?.workspaceId ?? DEFAULT_WORKSPACE_ID,
    title: thread ? `${thread.title} / ${run.id}` : `Run ${run.id}`,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    runs: [run],
    actions: listAllExecutionActionsForRun(store, run.id),
    transitions: collectStateTransitionsForRuns(store, [run], thread),
    interventions: collectRunInterventions(store, [run]),
  });
  return { cwd: store.paths.cwd, ...projectLingTrace(input) };
}

function buildTraceProjectionInput(input: {
  readonly store: RunStore;
  readonly subjectKind: ProjectLingTraceInput["subjectKind"];
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly status: ProjectLingTraceInput["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runs: readonly RunSession[];
  readonly actions: readonly ExecutionAction[];
  readonly transitions: ProjectLingTraceInput["transitions"];
  readonly interventions: readonly RunIntervention[];
}): ProjectLingTraceInput {
  const eventsByRunId: Record<string, ReturnType<RunStore["listEvents"]>> = {};
  const runtimeEventsByWorkUnitId: Record<string, ReturnType<RunStore["listRuntimeEvents"]>> = {};
  const artifacts: RunArtifact[] = [];
  for (const run of input.runs) {
    // Canonical actions above read every event page. This bounded raw window
    // is diagnostic-only; any unmatched fallback explicitly declares partial.
    eventsByRunId[run.id] = input.store.listEvents(run.id, { limit: 1000 });
    artifacts.push(...input.store.listArtifacts(run.id));
    if (run.workUnitId) {
      runtimeEventsByWorkUnitId[run.workUnitId] = input.store.listRuntimeEvents(run.workUnitId, { limit: 1000 });
    }
  }
  return {
    workspaceId: input.workspaceId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    title: input.title,
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    runs: input.runs,
    eventsByRunId,
    runtimeEventsByWorkUnitId,
    artifacts,
    executionActions: input.actions,
    approvals: input.runs.flatMap((run) => input.store.listApprovalRequests({ runId: run.id, complete: true })),
    transitions: input.transitions,
    interventions: input.interventions,
    generatedAt: new Date().toISOString(),
  };
}

function collectThreadActions(store: RunStore, runs: readonly RunSession[]): ExecutionAction[] {
  // Completeness is per selected Run, not a workspace-wide or thread-wide
  // action window that may silently exclude this Run or include sibling work.
  return uniqueById(runs.flatMap((run) => listAllExecutionActionsForRun(store, run.id)));
}

function collectStateTransitionsForRuns(
  store: RunStore,
  runs: readonly RunSession[],
  thread: LingThread | undefined,
): ReturnType<RunStore["listStateTransitionEvents"]> {
  const runIds = new Set(runs.map((run) => run.id));
  const workUnitIds = new Set(runs.map((run) => run.workUnitId).filter((id): id is string => Boolean(id)));
  return store.listStateTransitionEvents({ limit: 1000 }).filter((transition) => {
    if (transition.entityType === "run" && runIds.has(transition.entityId)) {
      return true;
    }
    if (transition.entityType === "work_unit" && workUnitIds.has(transition.entityId)) {
      return true;
    }
    if (!thread) {
      return false;
    }
    return (
      (transition.entityType === "task" && transition.entityId === thread.taskId) ||
      (transition.entityType === "workflow" && transition.entityId === thread.workflowId) ||
      (transition.entityType === "workflow_step" && transition.entityId === thread.workflowStepId)
    );
  });
}

function collectRunInterventions(store: RunStore, runs: readonly RunSession[]): RunIntervention[] {
  const runIds = new Set(runs.map((run) => run.id));
  return store.listRunInterventions({ limit: 500 }).filter((intervention) =>
    runIds.has(intervention.sourceRunId) ||
    (intervention.continuationRunId ? runIds.has(intervention.continuationRunId) : false));
}

function parseTraceId(traceId: string): { readonly subjectKind: "thread" | "run"; readonly subjectId: string } | undefined {
  const threadPrefix = "trace_thread_";
  if (traceId.startsWith(threadPrefix)) {
    return { subjectKind: "thread", subjectId: traceId.slice(threadPrefix.length) };
  }
  const runPrefix = "trace_run_";
  if (traceId.startsWith(runPrefix)) {
    return { subjectKind: "run", subjectId: traceId.slice(runPrefix.length) };
  }
  return undefined;
}

function traceStatusFromThread(status: LingThread["status"]): ProjectLingTraceInput["status"] {
  if (status === "open" || status === "running" || status === "blocked" || status === "archived") {
    return "running";
  }
  return status;
}

function compareRuns(left: RunSession, right: RunSession): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function uniqueById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export function traceIdForThread(threadId: string): string {
  return createLingTraceId("thread", threadId);
}

export function traceIdForRun(runId: string): string {
  return createLingTraceId("run", runId);
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { daemonClient } from "../../api/client.js";
import { listChannelWorkflows, listChannelWorkflowSteps } from "../../api/channels.js";
import { listExternalWorkActions, listGitHubExternalWorkCiTriage } from "../../api/external-work.js";
import { listRuns } from "../../api/runs.js";
import { listWorkItems } from "../../api/work-items.js";
import { buildWorkItemViews, type WorkItemView } from "../../lib/work-items.js";
import { readSavedWorkspaceCwd } from "../../lib/local-storage.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelWorkflowStep,
  ExternalWorkActionView,
  ExternalWorkCiTriageView,
  RunSession,
  Task,
  WorkItemView as DurableWorkItemView,
} from "../../types.js";
import type { WorkBoardFreshness, WorkBoardSourceIssue, WorkBoardSourceName } from "../../features/work-board/work-board-types.js";

interface SourceSnapshot {
  readonly cwd: string;
  readonly tasks: readonly Task[];
  readonly runs: readonly RunSession[];
  readonly approvals: readonly ApprovalRequest[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly externalActions: readonly ExternalWorkActionView[];
  readonly externalCi: readonly ExternalWorkCiTriageView[];
  readonly durableItems: readonly DurableWorkItemView[];
  readonly successfulSources: ReadonlySet<WorkBoardSourceName>;
}

interface ProjectionState {
  readonly snapshot: SourceSnapshot;
  readonly issues: readonly WorkBoardSourceIssue[];
  readonly freshness: WorkBoardFreshness;
  readonly loading: boolean;
}

const sourceLimits = { tasks: 500, runs: 200, approvals: 500, "work-items": 500, "external-actions": 500, "external-ci": 500 } as const;
const sourceNames: readonly WorkBoardSourceName[] = ["tasks", "runs", "approvals", "work-items", "workflows", "external-actions", "external-ci"];

export function useWorkBoardSourceProjection(input: { readonly cwd?: string; readonly channels: readonly Channel[] }) {
  const cwd = input.cwd?.trim() || readSavedWorkspaceCwd();
  const channelRevision = useMemo(() => input.channels.map((channel) => `${channel.id}:${channel.status}:${channel.updatedAt}`).sort().join("|"), [input.channels]);
  const channelsRef = useRef(input.channels);
  const identityRef = useRef({ cwd, channelRevision });
  const requestIdRef = useRef(0);
  const lastAutoRefreshIdentityRef = useRef("");
  const stateRef = useRef<ProjectionState>(emptyProjectionState(cwd));
  const [state, setState] = useState<ProjectionState>(() => stateRef.current);

  identityRef.current = { cwd, channelRevision };
  channelsRef.current = input.channels;
  function publish(next: ProjectionState): void {
    stateRef.current = next;
    setState(next);
  }

  const refresh = useCallback(async (): Promise<void> => {
    const identity = { cwd, channelRevision };
    if (!identity.cwd) {
      publish(emptyProjectionState(""));
      return;
    }
    const requestId = ++requestIdRef.current;
    const previous = stateRef.current.snapshot.cwd === identity.cwd ? stateRef.current : emptyProjectionState(identity.cwd);
    publish({ ...previous, loading: true, freshness: previous.snapshot.successfulSources.size > 0 ? "refreshing" : "initial" });

    const requests: Record<WorkBoardSourceName, Promise<readonly unknown[]>> = {
      tasks: daemonClient.listTasks(identity.cwd, { limit: sourceLimits.tasks }).then((response) => response.tasks),
      runs: listRuns(identity.cwd, { limit: sourceLimits.runs }).then((response) => response.runs),
      approvals: daemonClient.listApprovals(identity.cwd, { limit: sourceLimits.approvals }).then((response) => response.approvals),
      "work-items": listWorkItems(identity.cwd, { limit: sourceLimits["work-items"] }).then((response) => response.workItems),
      "external-actions": listExternalWorkActions(identity.cwd, { limit: sourceLimits["external-actions"] }).then((response) => response.actions),
      "external-ci": listGitHubExternalWorkCiTriage(identity.cwd, { limit: sourceLimits["external-ci"] }).then((response) => response.records),
      workflows: loadWorkflowSteps(identity.cwd, channelsRef.current),
    };
    const settled = await Promise.all(sourceNames.map(async (source) => ({ source, result: await settle(requests[source]) })));
    if (requestId !== requestIdRef.current || identityRef.current.cwd !== identity.cwd || identityRef.current.channelRevision !== identity.channelRevision) return;

    const nextValues = snapshotValues(previous.snapshot);
    const successfulSources = new Set(previous.snapshot.successfulSources);
    const issues: WorkBoardSourceIssue[] = [];
    let fulfilled = 0;
    for (const { source, result } of settled) {
      if (result.ok) {
        fulfilled += 1;
        successfulSources.add(source);
        assignSource(nextValues, source, result.value);
        const limit = source in sourceLimits ? sourceLimits[source as keyof typeof sourceLimits] : undefined;
        if (limit && result.value.length === limit) issues.push({ kind: "capped", source, message: "Showing the latest available records" });
      } else {
        issues.push({ kind: "load", source, message: `Could not refresh ${source}`, technicalMessage: result.message });
      }
    }
    const loadIssueCount = issues.filter((issue) => issue.kind === "load").length;
    const hadPrevious = previous.snapshot.successfulSources.size > 0;
    const freshness: WorkBoardFreshness = loadIssueCount === sourceNames.length && !hadPrevious
      ? "error"
      : loadIssueCount > 0
        ? hadPrevious ? "stale" : "partial"
        : issues.some((issue) => issue.kind === "capped") ? "capped" : "fresh";
    publish({
      snapshot: { cwd: identity.cwd, ...nextValues, successfulSources },
      issues,
      freshness: fulfilled === 0 && !hadPrevious ? "error" : freshness,
      loading: false,
    });
  }, [channelRevision, cwd]);

  useEffect(() => {
    const autoIdentity = `${cwd}:${channelRevision}`;
    if (lastAutoRefreshIdentityRef.current === autoIdentity) return;
    lastAutoRefreshIdentityRef.current = autoIdentity;
    requestIdRef.current += 1;
    publish(emptyProjectionState(cwd));
    if (cwd) void refresh();
  }, [cwd, channelRevision, refresh]);

  const externalActionMap = useMemo(() => Object.fromEntries(state.snapshot.externalActions.map((view) => [view.action.id, view])), [state.snapshot.externalActions]);
  const items = useMemo<readonly WorkItemView[]>(() => buildWorkItemViews({
    tasks: state.snapshot.tasks,
    runs: state.snapshot.runs,
    approvals: state.snapshot.approvals,
    workflowSteps: state.snapshot.workflowSteps,
    externalActions: externalActionMap,
    externalWorkCiTriage: state.snapshot.externalCi,
    durableWorkItems: state.snapshot.durableItems,
  }), [externalActionMap, state.snapshot]);

  return { items, freshness: state.freshness, issues: state.issues, loading: state.loading, refresh, active: Boolean(cwd) };
}

async function loadWorkflowSteps(cwd: string, channels: readonly Channel[]): Promise<readonly ChannelWorkflowStep[]> {
  const workflowResponses = await Promise.all(channels.filter((channel) => channel.status === "active").map((channel) => listChannelWorkflows(cwd, channel.id)));
  const stepResponses = await Promise.all(workflowResponses.flatMap((response) => response.workflows).map((workflow) => listChannelWorkflowSteps(cwd, workflow.id)));
  return stepResponses.flatMap((response) => response.workflowSteps);
}

async function settle<T>(request: Promise<T>): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }> {
  try { return { ok: true, value: await request }; }
  catch (caught) { return { ok: false, message: caught instanceof Error ? caught.message : String(caught) }; }
}

function emptyProjectionState(cwd: string): ProjectionState {
  return { snapshot: { cwd, tasks: [], runs: [], approvals: [], workflowSteps: [], externalActions: [], externalCi: [], durableItems: [], successfulSources: new Set() }, issues: [], freshness: "initial", loading: false };
}

function snapshotValues(snapshot: SourceSnapshot) {
  return { tasks: snapshot.tasks, runs: snapshot.runs, approvals: snapshot.approvals, workflowSteps: snapshot.workflowSteps, externalActions: snapshot.externalActions, externalCi: snapshot.externalCi, durableItems: snapshot.durableItems };
}

function assignSource(values: ReturnType<typeof snapshotValues>, source: WorkBoardSourceName, records: readonly unknown[]): void {
  if (source === "tasks") values.tasks = records as readonly Task[];
  else if (source === "runs") values.runs = records as readonly RunSession[];
  else if (source === "approvals") values.approvals = records as readonly ApprovalRequest[];
  else if (source === "workflows") values.workflowSteps = records as readonly ChannelWorkflowStep[];
  else if (source === "external-actions") values.externalActions = records as readonly ExternalWorkActionView[];
  else if (source === "external-ci") values.externalCi = records as readonly ExternalWorkCiTriageView[];
  else values.durableItems = records as readonly DurableWorkItemView[];
}

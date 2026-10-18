import { useMemo, useRef, useState } from "react";
import {
  daemonBaseUrl,
  getRun,
  getRunEvents,
  getWorkUnit,
  listRunArtifacts,
  listRuns,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import { readDataString } from "../../lib/data.js";
import { inferRunStatus } from "../../lib/run-evidence.js";
import { useRunControl } from "../../lib/use-run-control.js";
import { useLatestKeyedRequestGuard } from "../../lib/use-latest-request.js";
import { useI18n } from "../../i18n.js";
import { streamRun, type StreamJsonResponseParser } from "../../sse.js";
import type {
  RunArtifact,
  RunEventEnvelope,
  RunSession,
  WorkUnitDetailResponse,
} from "../../types.js";

export interface RunsState {
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly lookupRunId: string;
  readonly selectedRun: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly assistantText: string;
  readonly latestStatus: string;
  readonly isRunning: boolean;
  readonly isLoading: boolean;
  readonly isRunLoading: boolean;
  readonly cancellingRunId: string;
  readonly cancellingRunIds: readonly string[];
}

export interface RunsActions {
  readonly setLookupRunId: (runId: string) => void;
  readonly setIsRunning: (isRunning: boolean) => void;
  readonly loadRun: (runId?: string, cwd?: string) => Promise<void>;
  readonly refreshRunList: (cwd?: string) => Promise<void>;
  readonly runWithRequest: (requestBody: unknown, cwd: string, afterRunLoaded?: (runId: string) => Promise<void>) => Promise<void>;
  readonly streamRunRequest: <TResponse = never>(
    url: string,
    requestBody: unknown,
    cwd: string,
    afterRunLoaded?: (runId: string) => Promise<void>,
    parseJsonResponse?: StreamJsonResponseParser<TResponse>,
  ) => Promise<TResponse | undefined>;
  readonly abortCurrentRun: () => void;
  readonly cancelRunOrWorkUnit: (targetRun?: RunSession) => Promise<void>;
  readonly resetForCwd: () => void;
}

export type RunsController = DomainController<RunsState, RunsActions>;

export function useRunsDomain(input: {
  readonly cwd: string;
  readonly confirmFullAccessRunIfNeeded: (requestBody: unknown) => Promise<unknown | undefined>;
  readonly setSelectedWorkUnitDetail: (detail: WorkUnitDetailResponse | undefined) => void;
  readonly refreshApprovals: (cwd: string, runId?: string) => Promise<void>;
  readonly refreshRuntimeState: (cwd: string, run?: RunSession) => Promise<void>;
  readonly refreshHealth: () => Promise<void>;
  readonly refreshUsedMemoryAudit: (cwd: string) => Promise<void>;
  readonly readRunWorkspaceCwd: (run: RunSession, fallbackCwd: string) => string;
}): RunsController {
  const { t } = useI18n();
  const [activeRunId, setActiveRunId] = useState("");
  const [lookupRunId, setLookupRunId] = useState("");
  const [run, setRun] = useState<RunSession | undefined>();
  const [runs, setRuns] = useState<readonly RunSession[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [events, setEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [artifacts, setArtifacts] = useState<readonly RunArtifact[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<DomainError | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runLoadGuard = useLatestKeyedRequestGuard();

  const assistantText = useMemo(
    () =>
      events
        .filter((event) => event.type === "assistant_text_delta")
        .map((event) => readDataString(event.data, "text"))
        .join(""),
    [events],
  );
  const latestStatus = run?.status ?? inferRunStatus(events, isRunning);

  async function loadRun(runId = lookupRunId, cwd = input.cwd): Promise<void> {
    const trimmedRunId = runId.trim();
    if (!trimmedRunId) {
      setError({ scope: "load", message: t("Enter a Run ID") });
      return;
    }

    const requestToken = runLoadGuard.next(trimmedRunId);
    setRunLoading(true);
    try {
      setError(undefined);
      const [runResult, eventResult, artifactResult] = await Promise.all([
        getRun(trimmedRunId, cwd),
        getRunEvents(trimmedRunId, cwd),
        listRunArtifacts(trimmedRunId, cwd),
      ]);
      if (!runLoadGuard.isCurrent(trimmedRunId, requestToken)) {
        return;
      }
      setRun(runResult);
      setEvents(eventResult.events);
      setArtifacts(artifactResult.artifacts);
      setActiveRunId(runResult.id);
      setLookupRunId(runResult.id);
      if (runResult.workUnitId) {
        try {
          input.setSelectedWorkUnitDetail(await getWorkUnit(cwd, runResult.workUnitId));
        } catch {
          input.setSelectedWorkUnitDetail(undefined);
        }
      } else {
        input.setSelectedWorkUnitDetail(undefined);
      }
      await input.refreshRuntimeState(cwd, runResult);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      throw caught;
    } finally {
      if (runLoadGuard.isCurrent(trimmedRunId, requestToken)) {
        setRunLoading(false);
      }
    }
  }

  async function refreshRunList(cwd = input.cwd): Promise<void> {
    if (!cwd) {
      setRuns([]);
      return;
    }

    setRunsLoading(true);
    try {
      setError(undefined);
      const response = await listRuns(cwd);
      setRuns(response.runs);
      void input.refreshRuntimeState(cwd);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
    } finally {
      setRunsLoading(false);
    }
  }

  async function runWithRequest(
    requestBody: unknown,
    cwd: string,
    afterRunLoaded?: (runId: string) => Promise<void>,
  ): Promise<void> {
    await streamRunRequest(`${daemonBaseUrl}/runs`, requestBody, cwd, afterRunLoaded);
  }

  async function streamRunRequest<TResponse = never>(
    url: string,
    requestBody: unknown,
    cwd: string,
    afterRunLoaded?: (runId: string) => Promise<void>,
    parseJsonResponse?: StreamJsonResponseParser<TResponse>,
  ): Promise<TResponse | undefined> {
    const confirmedRequestBody = await input.confirmFullAccessRunIfNeeded(requestBody);
    if (!confirmedRequestBody) {
      return undefined;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    setEvents([]);
    setArtifacts([]);
    setRun(undefined);
    input.setSelectedWorkUnitDetail(undefined);
    setActiveRunId("");
    setIsRunning(true);

    try {
      let streamedRunId = "";
      const jsonResponse = await streamRun(
        url,
        confirmedRequestBody,
        (message) => {
          if (message.kind === "ready") {
            streamedRunId = message.runId;
            setActiveRunId(message.runId);
            setLookupRunId(message.runId);
            return;
          }
          if (message.event.type === "approval_requested" || message.event.type === "approval_expired") {
            void input.refreshApprovals(cwd, streamedRunId || undefined);
          }
          setEvents((current) => [...current, message.event]);
        },
        controller.signal,
        parseJsonResponse,
      );

      if (jsonResponse !== undefined) {
        return jsonResponse;
      }

      if (streamedRunId) {
        await loadRun(streamedRunId, cwd);
        await refreshRunList(cwd);
        await input.refreshApprovals(cwd, streamedRunId);
        await input.refreshUsedMemoryAudit(cwd);
        await afterRunLoaded?.(streamedRunId);
      }
      return undefined;
    } catch (caught) {
      const aborted = (caught as Error).name === "AbortError";
      if (!aborted && !parseJsonResponse) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError({ scope: "stream", message });
      }
      if (parseJsonResponse && !aborted) {
        throw caught;
      }
      return undefined;
    } finally {
      setIsRunning(false);
      await input.refreshHealth();
    }
  }

  const { cancellingRunId, cancellingRunIds, cancelRunOrWorkUnit } = useRunControl({
    defaultCwd: input.cwd,
    activeRunId,
    currentRun: run,
    runs,
    abortCurrentRun: () => abortRef.current?.abort(),
    setRun,
    setEvents,
    setIsRunning,
    clearError: () => setError(undefined),
    reportError: (message) => setError({ scope: "mutation", message }),
    refreshRuns: refreshRunList,
    refreshApprovals: input.refreshApprovals,
    refreshRuntimeState: input.refreshRuntimeState,
    refreshHealth: input.refreshHealth,
    readRunWorkspaceCwd: input.readRunWorkspaceCwd,
  });

  function resetForCwd(): void {
    abortRef.current?.abort();
    runLoadGuard.reset();
    setActiveRunId("");
    setLookupRunId("");
    setRun(undefined);
    setRuns([]);
    setEvents([]);
    setArtifacts([]);
    setIsRunning(false);
    setRunsLoading(false);
    setRunLoading(false);
    setError(undefined);
  }

  return {
    state: {
      runs,
      selectedRunId: activeRunId,
      lookupRunId,
      selectedRun: run,
      events,
      artifacts,
      assistantText,
      latestStatus,
      isRunning,
      isLoading: runsLoading,
      isRunLoading: runLoading,
      cancellingRunId,
      cancellingRunIds,
    },
    actions: {
      setLookupRunId,
      setIsRunning,
      loadRun,
      refreshRunList,
      runWithRequest,
      streamRunRequest,
      abortCurrentRun: () => abortRef.current?.abort(),
      cancelRunOrWorkUnit,
      resetForCwd,
    },
    refresh: refreshRunList,
    isLoading: runsLoading,
    error,
    clearError: () => setError(undefined),
  };
}

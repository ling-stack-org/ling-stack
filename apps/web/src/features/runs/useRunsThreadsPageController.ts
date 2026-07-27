import { LingDaemonError } from "@ling-stack/api-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listLingThreads, listLingThreadTurns } from "../../api.js";
import type {
  LingThread,
  LingThreadArchivedFilter,
  LingThreadSearchMatch,
  RunSession,
} from "../../types.js";
import {
  buildTurnContextByRunId,
  buildWorkHistoryGroupTree,
  buildWorkHistoryTurnGroups,
  buildWorkHistoryTurnLoadRequests,
  deriveThreadsFromRuns,
  normalizeWorkHistorySearchQuery,
  reconcileSelectedId,
  turnStateKey,
} from "./runs-thread-view-models.js";
import type { ThreadListLoadState, WorkHistoryTurnLoadState } from "./runs-thread-types.js";

export function useRunsThreadsPageController(input: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly selectedRunId?: string;
  readonly selectedRun?: RunSession;
  readonly initialThreadId?: string;
  readonly autoSelectThread: boolean;
  readonly loadTurns: boolean;
}) {
  const [threads, setThreads] = useState<readonly LingThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [archivedFilter, setArchivedFilter] = useState<LingThreadArchivedFilter>("exclude");
  const [search, setSearch] = useState("");
  const [searchMatches, setSearchMatches] = useState<readonly LingThreadSearchMatch[]>([]);
  const [listState, setListState] = useState<ThreadListLoadState>("idle");
  const [listError, setListError] = useState("");
  const [fallbackFromRuns, setFallbackFromRuns] = useState(false);
  const [turnStateByThreadKey, setTurnStateByThreadKey] = useState<Readonly<Record<string, WorkHistoryTurnLoadState>>>({});
  const cwdRef = useRef(input.cwd.trim());
  const threadsRef = useRef(threads);
  const selectedThreadIdRef = useRef(selectedThreadId);
  const listRevisionRef = useRef(0);
  const activeListRequestKeyRef = useRef("");
  const fallbackFromRunsRef = useRef(fallbackFromRuns);
  const activeTurnRequestsRef = useRef(new Map<string, string>());
  threadsRef.current = threads;
  selectedThreadIdRef.current = selectedThreadId;
  fallbackFromRunsRef.current = fallbackFromRuns;
  cwdRef.current = input.cwd.trim();

  const refreshThreads = useCallback(async (): Promise<void> => {
    const cwd = input.cwd.trim();
    const requestKey = `${cwd}::${archivedFilter}::${normalizeWorkHistorySearchQuery(search) ?? ""}`;
    if (activeListRequestKeyRef.current === requestKey) return;
    activeListRequestKeyRef.current = requestKey;
    const revision = ++listRevisionRef.current;
    if (!cwd) {
      setThreads([]);
      setSelectedThreadId("");
      setSearchMatches([]);
      setFallbackFromRuns(false);
      setListError("");
      setListState("idle");
      return;
    }
    const retained = threadsRef.current.length > 0 || fallbackFromRunsRef.current;
    setListState(retained ? "refreshing" : "loading-initial");
    setListError("");
    try {
      const q = normalizeWorkHistorySearchQuery(search);
      const response = await listLingThreads(cwd, { ...(q ? { q } : {}), archived: archivedFilter, limit: 100 });
      if (cwdRef.current !== cwd || listRevisionRef.current !== revision) return;
      const previousIds = threadsRef.current.map((thread) => thread.id);
      const nextIds = response.threads.map((thread) => thread.id);
      setThreads(response.threads);
      setSearchMatches(response.matches ?? []);
      setFallbackFromRuns(false);
      setListState("ready");
      setSelectedThreadId((current) => {
        if (!input.autoSelectThread) return current;
        const preferred = current || input.initialThreadId || "";
        return reconcileSelectedId(preferred, nextIds, previousIds);
      });
    } catch (error) {
      if (cwdRef.current !== cwd || listRevisionRef.current !== revision) return;
      if (error instanceof LingDaemonError && error.status === 404) {
        setThreads([]);
        setSearchMatches([]);
        setFallbackFromRuns(true);
        setListError("");
        setListState("legacy");
        return;
      }
      setListError(error instanceof Error ? error.message : String(error));
      setListState(retained ? "stale" : "failed");
    } finally {
      if (activeListRequestKeyRef.current === requestKey) activeListRequestKeyRef.current = "";
    }
  }, [archivedFilter, input.autoSelectThread, input.cwd, input.initialThreadId, search]);

  useEffect(() => {
    listRevisionRef.current += 1;
    activeListRequestKeyRef.current = "";
    activeTurnRequestsRef.current.clear();
    setTurnStateByThreadKey({});
    setThreads([]);
    setSelectedThreadId("");
    setSearchMatches([]);
    setFallbackFromRuns(false);
    setListError("");
    setListState("idle");
  }, [input.cwd]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  const visibleThreads = useMemo(() => {
    if (!fallbackFromRuns) return threads;
    return archivedFilter === "exclude" ? deriveThreadsFromRuns(input.runs) : [];
  }, [archivedFilter, fallbackFromRuns, input.runs, threads]);
  const visibleThreadIds = useMemo(() => new Set(visibleThreads.map((thread) => thread.id)), [visibleThreads]);
  const workHistoryRuns = useMemo(() =>
    visibleThreads.length > 0 || fallbackFromRuns
      ? input.runs.filter((run) => !run.threadId || visibleThreadIds.has(run.threadId))
      : input.runs.filter((run) => !run.threadId),
  [fallbackFromRuns, input.runs, visibleThreadIds, visibleThreads.length]);
  const selectedRunForHistory = input.selectedRun?.threadId && !visibleThreadIds.has(input.selectedRun.threadId) && !fallbackFromRuns
    ? undefined
    : input.selectedRun;
  const turnLoadRequests = useMemo(() => input.loadTurns
    ? buildWorkHistoryTurnLoadRequests(input.cwd, visibleThreads, workHistoryRuns, selectedRunForHistory)
    : [],
  [input.cwd, input.loadTurns, selectedRunForHistory, visibleThreads, workHistoryRuns]);
  const turnRequestSignature = turnLoadRequests.map((request) => `${request.threadId}:${request.signature}`).join("|");

  useEffect(() => {
    const cwd = input.cwd.trim();
    if (!cwd || !input.loadTurns) return;
    const requests = turnLoadRequests.filter((request) => {
      const key = turnStateKey(cwd, request.threadId);
      return turnStateByThreadKey[key]?.signature !== request.signature && !activeTurnRequestsRef.current.has(key);
    });
    if (requests.length === 0) return;
    setTurnStateByThreadKey((current) => {
      const next = { ...current };
      for (const request of requests) {
        const key = turnStateKey(cwd, request.threadId);
        const token = `${request.signature}:${Date.now()}:${Math.random()}`;
        activeTurnRequestsRef.current.set(key, token);
        next[key] = { status: "loading", signature: request.signature };
        void listLingThreadTurns(cwd, request.threadId, { limit: 100 })
          .then((response) => commitTurnResult(cwd, request.threadId, request.signature, token, {
            status: "loaded", turns: response.turns, runLinks: response.runLinks, signature: request.signature,
          }))
          .catch((error) => commitTurnResult(cwd, request.threadId, request.signature, token, {
            status: "failed", error: error instanceof Error ? error.message : String(error), signature: request.signature,
          }));
      }
      return next;
    });
  }, [input.cwd, input.loadTurns, turnRequestSignature, turnStateByThreadKey, turnLoadRequests]);

  function commitTurnResult(
    cwd: string,
    threadId: string,
    signature: string,
    token: string,
    result: WorkHistoryTurnLoadState,
  ): void {
    const key = turnStateKey(cwd, threadId);
    if (cwdRef.current !== cwd || activeTurnRequestsRef.current.get(key) !== token) return;
    activeTurnRequestsRef.current.delete(key);
    setTurnStateByThreadKey((current) => current[key]?.signature === signature ? { ...current, [key]: result } : current);
  }

  useEffect(() => {
    if (!input.initialThreadId || !visibleThreads.some((thread) => thread.id === input.initialThreadId)) return;
    setSelectedThreadId(input.initialThreadId);
  }, [input.initialThreadId, visibleThreads]);

  const groups = useMemo(() => buildWorkHistoryTurnGroups({
    cwd: input.cwd,
    runs: workHistoryRuns,
    visibleThreads,
    turnStateByThreadKey,
  }), [input.cwd, turnStateByThreadKey, visibleThreads, workHistoryRuns]);

  return {
    state: {
      threads: visibleThreads,
      selectedThreadId,
      selectedThread: visibleThreads.find((thread) => thread.id === selectedThreadId),
      archivedFilter,
      search,
      searchMatches,
      listState,
      listError,
      fallbackFromRuns,
      turnStateByThreadKey,
      groups,
      treeRows: buildWorkHistoryGroupTree(groups),
      standaloneRuns: input.runs.filter((run) => !run.threadId),
      selectedTurnContext: buildTurnContextByRunId(input.selectedRunId ?? "", groups, turnStateByThreadKey, input.cwd),
    },
    actions: {
      refreshThreads,
      setArchivedFilter,
      setSearch,
      setSelectedThreadId,
    },
  };
}

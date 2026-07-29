import { useEffect, useMemo, useRef, useState } from "react";
import {
  archiveLingThread,
  forkLingThread,
  forkRunLingThread,
  getLingThreadEvidence,
  listRunInterventions,
  pinLingThread,
  previewLingThreadResume,
  resumeLingThread,
  unarchiveLingThread,
  unpinLingThread,
} from "../../api.js";
import type {
  LingThread,
  LingThreadEvidenceResponse,
  LingThreadResumePreviewResponse,
  RunIntervention,
} from "../../types.js";
import {
  hasActiveThreadRun,
  isResumeSourceTurnTerminal,
  resolveDefaultResumeSourceTurn,
  resolveDefaultRunIdForTurn,
  resolveThreadSourceRun,
  resolveTurnRunIds,
  stableBrowserHash,
  uniqueInterventions,
} from "./thread-detail-view-models.js";
import type { WorkHistoryTurnLoadState } from "./runs-thread-types.js";

export type ThreadDetailAction = "refresh" | "preview" | "resume" | "fork" | "fork-run" | "pin" | "unpin" | "archive" | "unarchive";

export function useThreadDetailController(input: {
  readonly cwd: string;
  readonly thread: LingThread | undefined;
  readonly threadId: string;
  readonly turnState?: WorkHistoryTurnLoadState;
  readonly visibleThreads: readonly LingThread[];
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
  readonly onSelectThreadId: (threadId: string) => void;
}) {
  const [evidence, setEvidence] = useState<LingThreadEvidenceResponse>();
  const [evidenceState, setEvidenceState] = useState<"loading" | "ready" | "stale" | "failed">("loading");
  const [interventions, setInterventions] = useState<readonly RunIntervention[]>([]);
  const [interventionsLoading, setInterventionsLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<ThreadDetailAction | "evidence" | "interventions", string>>>({});
  const [busyActions, setBusyActions] = useState<ReadonlySet<ThreadDetailAction>>(new Set());
  const [selectedSourceTurnId, setSelectedSourceTurnId] = useState("");
  const [selectedSourceRunId, setSelectedSourceRunId] = useState("");
  const [resumeInstruction, setResumeInstruction] = useState("");
  const [forkRunInstruction, setForkRunInstruction] = useState("");
  const [resumePreview, setResumePreview] = useState<LingThreadResumePreviewResponse>();
  const [resumedRunId, setResumedRunId] = useState("");
  const [forkedThreadId, setForkedThreadId] = useState("");
  const [forkRunRunId, setForkRunRunId] = useState("");
  const identityRef = useRef(`${input.cwd.trim()}::${input.threadId}`);
  const evidenceRevisionRef = useRef(0);
  const interventionRevisionRef = useRef(0);
  const busyRef = useRef(new Set<ThreadDetailAction>());
  identityRef.current = `${input.cwd.trim()}::${input.threadId}`;

  const loadedTurns = input.turnState?.status === "loaded" ? input.turnState.turns : [];
  const loadedRunLinks = input.turnState?.status === "loaded" ? input.turnState.runLinks : [];
  const displayThread = evidence?.thread ?? input.thread;
  const evidenceRuns = evidence?.runs ?? [];
  const selectedSourceTurn = selectedSourceTurnId ? loadedTurns.find((turn) => turn.id === selectedSourceTurnId) : undefined;
  const selectedTurnRunIds = selectedSourceTurn ? resolveTurnRunIds(selectedSourceTurn, loadedRunLinks) : undefined;
  const turnDefaultRunId = selectedSourceTurn ? resolveDefaultRunIdForTurn(selectedSourceTurn, loadedRunLinks, evidenceRuns) : "";
  const sourceRun = resolveThreadSourceRun(displayThread, evidenceRuns, selectedSourceRunId || turnDefaultRunId);
  const sourceRunId = selectedSourceRunId || turnDefaultRunId || sourceRun?.id || displayThread?.lastRunId || "";
  const sourceRunOptions = selectedTurnRunIds?.size
    ? evidenceRuns.filter((item) => selectedTurnRunIds.has(item.run.id))
    : evidenceRuns;
  const isArchived = Boolean(displayThread?.archivedAt || displayThread?.status === "archived");
  const hasActiveNonTerminalRun = hasActiveThreadRun(displayThread, evidence);
  const hasActiveSelectedTurn = Boolean(selectedSourceTurn && !isResumeSourceTurnTerminal(selectedSourceTurn));
  const canPreview = Boolean(displayThread && sourceRunId && !isArchived);
  const canResume = Boolean(canPreview && !hasActiveNonTerminalRun && !hasActiveSelectedTurn && !input.isRunning);
  const canFork = Boolean(displayThread && !isArchived && !hasActiveNonTerminalRun);
  const canForkRun = Boolean(canFork && sourceRunId && forkRunInstruction.trim());
  const loadedTurnSignature = loadedTurns.map((turn) => `${turn.id}:${turn.status}:${turn.updatedAt}`).join("|");

  useEffect(() => {
    evidenceRevisionRef.current += 1;
    interventionRevisionRef.current += 1;
    busyRef.current.clear();
    setBusyActions(new Set());
    setEvidence(undefined);
    setEvidenceState("loading");
    setInterventions([]);
    setErrors({});
    setSelectedSourceTurnId("");
    setSelectedSourceRunId(input.thread?.lastRunId ?? "");
    setResumeInstruction("");
    setForkRunInstruction("");
    setResumePreview(undefined);
    setResumedRunId("");
    setForkedThreadId("");
    setForkRunRunId("");
    void loadEvidence(input.threadId, false);
    // identity reset intentionally owns the first request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.cwd, input.threadId]);

  useEffect(() => {
    if (loadedTurns.length === 0) {
      setSelectedSourceTurnId("");
      return;
    }
    if (selectedSourceTurnId && loadedTurns.some((turn) => turn.id === selectedSourceTurnId)) return;
    setSelectedSourceTurnId(resolveDefaultResumeSourceTurn(loadedTurns)?.id ?? "");
    setSelectedSourceRunId("");
  }, [loadedTurnSignature, loadedTurns, selectedSourceTurnId]);

  async function loadEvidence(threadId = input.threadId, retained = true): Promise<void> {
    if (!threadId || !input.cwd.trim()) return;
    const identity = `${input.cwd.trim()}::${threadId}`;
    const revision = ++evidenceRevisionRef.current;
    begin("refresh");
    setErrors((current) => ({ ...current, evidence: undefined, refresh: undefined }));
    if (!retained) setEvidenceState("loading");
    try {
      const response = await getLingThreadEvidence(input.cwd.trim(), threadId);
      if (identityRef.current !== identity || evidenceRevisionRef.current !== revision) return;
      setEvidence(response);
      setEvidenceState("ready");
      const nextSourceRunId = response.thread.lastRunId ?? response.runs.at(-1)?.run.id ?? "";
      setSelectedSourceRunId((current) => current && response.runs.some((item) => item.run.id === current) ? current : nextSourceRunId);
      void loadInterventions(response.runs.map((item) => item.run.id), identity);
    } catch (error) {
      if (identityRef.current !== identity || evidenceRevisionRef.current !== revision) return;
      const message = error instanceof Error ? error.message : String(error);
      setErrors((current) => ({ ...current, evidence: message, refresh: message }));
      setEvidenceState(evidence && retained ? "stale" : "failed");
    } finally {
      if (identityRef.current === identity && evidenceRevisionRef.current === revision) end("refresh");
    }
  }

  async function loadInterventions(runIds: readonly string[], identity = identityRef.current): Promise<void> {
    const revision = ++interventionRevisionRef.current;
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length === 0) {
      setInterventions([]);
      return;
    }
    setInterventionsLoading(true);
    setErrors((current) => ({ ...current, interventions: undefined }));
    const settled = await Promise.allSettled(uniqueRunIds.map((runId) => listRunInterventions(input.cwd.trim(), runId, 100)));
    if (identityRef.current !== identity || interventionRevisionRef.current !== revision) return;
    const loaded = settled.flatMap((result) => result.status === "fulfilled" ? result.value.interventions : []);
    const failedCount = settled.filter((result) => result.status === "rejected").length;
    setInterventions(uniqueInterventions(loaded));
    setErrors((current) => ({ ...current, interventions: failedCount ? `${failedCount} intervention audit request failed` : undefined }));
    setInterventionsLoading(false);
  }

  function begin(action: ThreadDetailAction): boolean {
    if (busyRef.current.has(action)) return false;
    busyRef.current.add(action);
    setBusyActions(new Set(busyRef.current));
    return true;
  }

  function end(action: ThreadDetailAction): void {
    busyRef.current.delete(action);
    setBusyActions(new Set(busyRef.current));
  }

  async function runAction(action: ThreadDetailAction, operation: () => Promise<void>): Promise<void> {
    if (!begin(action)) return;
    setErrors((current) => ({ ...current, [action]: undefined }));
    try {
      await operation();
    } catch (error) {
      if (identityRef.current === `${input.cwd.trim()}::${input.threadId}`) {
        setErrors((current) => ({ ...current, [action]: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      end(action);
    }
  }

  async function previewResume(): Promise<void> {
    if (!canPreview || !sourceRunId) return;
    await runAction("preview", async () => {
      const response = await previewLingThreadResume(input.cwd.trim(), input.threadId, {
        sourceRunId,
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
        instruction: resumeInstruction.trim() || "Resume this Ling thread from the thread detail.",
        includeArtifacts: true,
      });
      if (identityRef.current === `${input.cwd.trim()}::${input.threadId}`) setResumePreview(response);
    });
  }

  async function resume(): Promise<void> {
    if (!canResume || !sourceRunId) return;
    await runAction("resume", async () => {
      const response = await resumeLingThread(input.cwd.trim(), input.threadId, {
        sourceRunId,
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
        instruction: resumeInstruction.trim() || "Resume this Ling thread from the thread detail.",
      });
      setResumedRunId(response.runId ?? "");
      setResumeInstruction("");
      setResumePreview(undefined);
      input.onRefresh();
      void loadEvidence(input.threadId);
    });
  }

  async function fork(): Promise<void> {
    if (!canFork) return;
    await runAction("fork", async () => {
      const response = await forkLingThread(input.cwd.trim(), input.threadId, {
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
        ...(sourceRunId ? { sourceRunId } : {}),
        idempotencyKey: `work-history-fork:${input.threadId}:${selectedSourceTurn?.id ?? ""}:${sourceRunId}`,
      });
      setForkedThreadId(response.childThread.id);
      input.onRefresh();
      input.onSelectThreadId(response.childThread.id);
    });
  }

  async function forkRun(): Promise<void> {
    if (!canForkRun || !sourceRunId) return;
    const instruction = forkRunInstruction.trim();
    await runAction("fork-run", async () => {
      const response = await forkRunLingThread(input.cwd.trim(), input.threadId, {
        ...(selectedSourceTurn?.id ? { turnId: selectedSourceTurn.id } : {}),
        sourceRunId,
        instruction,
        idempotencyKey: `work-history-fork-run:${stableBrowserHash(`${input.threadId}:${selectedSourceTurn?.id ?? ""}:${sourceRunId}:${instruction}`)}`,
      });
      setForkedThreadId(response.childThread.id);
      setForkRunRunId(response.runId ?? response.childRun?.id ?? "");
      setForkRunInstruction("");
      input.onRefresh();
      input.onSelectThreadId(response.childThread.id);
    });
  }

  async function mutate(action: "archive" | "unarchive" | "pin" | "unpin"): Promise<void> {
    if (!displayThread) return;
    await runAction(action, async () => {
      const idempotencyKey = `work-history-${action}:${displayThread.id}`;
      const response = action === "archive"
        ? await archiveLingThread(input.cwd.trim(), displayThread.id, { idempotencyKey })
        : action === "unarchive"
          ? await unarchiveLingThread(input.cwd.trim(), displayThread.id, { idempotencyKey })
          : action === "pin"
            ? await pinLingThread(input.cwd.trim(), displayThread.id, { idempotencyKey })
            : await unpinLingThread(input.cwd.trim(), displayThread.id, { idempotencyKey });
      setEvidence((current) => current ? { ...current, thread: response.thread } : current);
      input.onRefresh();
      void loadEvidence(displayThread.id);
    });
  }

  return {
    state: {
      displayThread,
      parentThread: displayThread?.parentThreadId ? input.visibleThreads.find((thread) => thread.id === displayThread.parentThreadId) : undefined,
      childThreads: displayThread ? input.visibleThreads.filter((thread) => thread.parentThreadId === displayThread.id).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) : [],
      evidence,
      evidenceRuns,
      evidenceState,
      interventions,
      interventionsLoading,
      errors,
      busyActions,
      loadedTurns,
      selectedSourceTurn,
      sourceRunId,
      sourceRunOptions,
      isArchived,
      isPinned: Boolean(displayThread?.pinnedAt),
      hasActiveNonTerminalRun,
      hasActiveSelectedTurn,
      canPreview,
      canResume,
      canFork,
      canForkRun,
      resumeInstruction,
      forkRunInstruction,
      resumePreview,
      resumedRunId,
      forkedThreadId,
      forkRunRunId,
    },
    actions: {
      loadEvidence,
      setSelectedSourceTurnId: (turnId: string) => { setSelectedSourceTurnId(turnId); setSelectedSourceRunId(""); setResumePreview(undefined); },
      setSelectedSourceRunId: (runId: string) => { setSelectedSourceRunId(runId); setResumePreview(undefined); },
      setResumeInstruction,
      setForkRunInstruction,
      previewResume,
      resume,
      fork,
      forkRun,
      mutate,
    },
  };
}

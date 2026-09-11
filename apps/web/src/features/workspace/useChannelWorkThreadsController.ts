import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { LingDaemonError } from "@ling-stack/api-client";
import {
  archiveLingThread,
  createLingThread,
  forkLingThread,
  listLingThreads,
  pinLingThread,
  unpinLingThread,
  updateLingThreadMode,
} from "../../api.js";
import { readTaskPrompt, readTaskTitle } from "../../lib/run-evidence.js";
import type { ConversationModeKind, LingThread, RunSession } from "../../types.js";

interface ChannelWorkThreadTreeRow {
  readonly thread: LingThread;
  readonly depth: number;
  readonly parentHidden: boolean;
}

interface ChannelWorkThreadsControllerInput {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly channelRuns: readonly RunSession[];
}

export interface ChannelWorkThreadsController {
  readonly activeWorkThreadId: string;
  readonly setActiveWorkThreadId: Dispatch<SetStateAction<string>>;
  readonly visibleChannelWorkThreads: readonly LingThread[];
  readonly channelWorkThreadTreeRows: readonly ChannelWorkThreadTreeRow[];
  readonly channelWorkThreadsLoading: boolean;
  readonly channelWorkThreadError: string;
  readonly channelWorkThreadSearch: string;
  readonly setChannelWorkThreadSearch: Dispatch<SetStateAction<string>>;
  readonly channelWorkThreadSearchActive: boolean;
  readonly channelDiscussionRootThread: LingThread | undefined;
  readonly forkingWorkThreadId: string;
  readonly workThreadVisibilityId: string;
  readonly workThreadConversationModeId: string;
  readonly archiveConfirmWorkThreadId: string;
  readonly setArchiveConfirmWorkThreadId: Dispatch<SetStateAction<string>>;
  readonly forkChannelWorkThread: (thread: LingThread) => Promise<void>;
  readonly forkChannelMainBranch: () => Promise<void>;
  readonly ensureChannelDiscussionRootThread: () => Promise<LingThread | undefined>;
  readonly mutateChannelWorkThreadVisibility: (thread: LingThread, action: "archive" | "pin" | "unpin") => Promise<void>;
  readonly updateChannelWorkThreadConversationMode: (threadId: string, mode: ConversationModeKind) => Promise<void>;
}

export function useChannelWorkThreadsController({
  cwd,
  selectedChannelId,
  channelRuns,
}: ChannelWorkThreadsControllerInput): ChannelWorkThreadsController {
  const [activeWorkThreadId, setActiveWorkThreadId] = useState("");
  const [channelWorkThreads, setChannelWorkThreads] = useState<readonly LingThread[]>([]);
  const [channelWorkThreadsLoading, setChannelWorkThreadsLoading] = useState(false);
  const [channelWorkThreadsFallbackFromRuns, setChannelWorkThreadsFallbackFromRuns] = useState(false);
  const [channelWorkThreadError, setChannelWorkThreadError] = useState("");
  const [forkingWorkThreadId, setForkingWorkThreadId] = useState("");
  const [workThreadVisibilityId, setWorkThreadVisibilityId] = useState("");
  const [workThreadConversationModeId, setWorkThreadConversationModeId] = useState("");
  const [archiveConfirmWorkThreadId, setArchiveConfirmWorkThreadId] = useState("");
  const [archivedChannelWorkThreadIds, setArchivedChannelWorkThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [channelWorkThreadSearch, setChannelWorkThreadSearch] = useState("");

  const derivedChannelWorkThreads = useMemo(
    () => deriveWorkspaceThreadsFromRuns(channelRuns),
    [channelRuns],
  );
  const channelWorkThreadCandidates = useMemo(
    () => mergeLingThreads(channelWorkThreads, channelWorkThreadsFallbackFromRuns ? derivedChannelWorkThreads : [])
      .filter((thread) => !thread.channelId || thread.channelId === selectedChannelId)
      .filter((thread) => !archivedChannelWorkThreadIds.has(thread.id) && thread.status !== "archived" && !thread.archivedAt)
      .sort((left, right) =>
        Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) ||
        (right.pinnedAt ?? "").localeCompare(left.pinnedAt ?? "") ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id)
      ),
    [archivedChannelWorkThreadIds, channelWorkThreads, channelWorkThreadsFallbackFromRuns, derivedChannelWorkThreads, selectedChannelId],
  );
  const visibleChannelWorkThreads = useMemo(
    () => filterChannelBranchThreads(channelWorkThreadCandidates, activeWorkThreadId),
    [activeWorkThreadId, channelWorkThreadCandidates],
  );
  const searchedChannelWorkThreads = useMemo(() => {
    const query = channelWorkThreadSearch.trim().replace(/\s+/g, " ").toLowerCase();
    if (query.length < 2) {
      return visibleChannelWorkThreads;
    }
    return visibleChannelWorkThreads.filter((thread) =>
      [
        thread.title,
        thread.objective,
        thread.id,
        thread.taskId,
        thread.lastRunId,
        thread.parentThreadId,
      ].some((value) => value?.toLowerCase().includes(query))
    );
  }, [channelWorkThreadSearch, visibleChannelWorkThreads]);
  const channelWorkThreadTreeRows = useMemo(
    () => buildChannelWorkThreadTree(searchedChannelWorkThreads),
    [searchedChannelWorkThreads],
  );
  const channelWorkThreadSearchActive = channelWorkThreadSearch.trim().replace(/\s+/g, " ").length >= 2;
  const channelDiscussionRootThread = visibleChannelWorkThreads.find((thread) =>
    isChannelDiscussionRootThread(thread, selectedChannelId)
  );

  useEffect(() => {
    setActiveWorkThreadId("");
    setChannelWorkThreadSearch("");
  }, [selectedChannelId]);

  useEffect(() => {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      setChannelWorkThreads([]);
      setChannelWorkThreadsFallbackFromRuns(false);
      setChannelWorkThreadError("");
      return;
    }
    let cancelled = false;
    setChannelWorkThreadsLoading(true);
    setChannelWorkThreadError("");
    void listLingThreads(workspaceCwd, { channelId: selectedChannelId, limit: 100 })
      .then((response) => {
        if (!cancelled) {
          setChannelWorkThreads(response.threads);
          const responseThreadIds = new Set(response.threads.map((thread) => thread.id));
          setArchivedChannelWorkThreadIds((current) => new Set([...current].filter((threadId) => !responseThreadIds.has(threadId))));
          setChannelWorkThreadsFallbackFromRuns(false);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          if (caught instanceof LingDaemonError && caught.status === 404) {
            setChannelWorkThreads([]);
            setChannelWorkThreadsFallbackFromRuns(true);
            setChannelWorkThreadError("");
            return;
          }
          setChannelWorkThreadError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setChannelWorkThreadsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channelRuns, cwd, selectedChannelId]);

  useEffect(() => {
    if (activeWorkThreadId && !visibleChannelWorkThreads.some((thread) => thread.id === activeWorkThreadId)) {
      setActiveWorkThreadId("");
    }
  }, [activeWorkThreadId, visibleChannelWorkThreads]);

  async function forkChannelWorkThread(thread: LingThread): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || forkingWorkThreadId) {
      return;
    }
    setForkingWorkThreadId(thread.id);
    setChannelWorkThreadError("");
    try {
      const response = await forkLingThread(workspaceCwd, thread.id, {
        idempotencyKey: `channel-fork:${thread.id}:${thread.lastRunId ?? ""}:${thread.updatedAt}`,
      });
      setChannelWorkThreads((current) => mergeLingThreads([response.childThread, response.sourceThread], current));
      setActiveWorkThreadId(response.childThread.id);
    } catch (error) {
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setForkingWorkThreadId("");
    }
  }

  async function forkChannelMainBranch(): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId || forkingWorkThreadId) {
      return;
    }
    const pendingMainThreadId = `channel-main:${selectedChannelId}`;
    setForkingWorkThreadId(pendingMainThreadId);
    setChannelWorkThreadError("");
    try {
      const rootThread = channelDiscussionRootThread ?? (await createLingThread(workspaceCwd, {
        kind: "channel_discussion",
        channelId: selectedChannelId,
        idempotencyKey: pendingMainThreadId,
      })).thread;
      const response = await forkLingThread(workspaceCwd, rootThread.id, {
        idempotencyKey: `channel-fork:${rootThread.id}:${rootThread.updatedAt}`,
      });
      setChannelWorkThreads((current) => mergeLingThreads([response.childThread, response.sourceThread, rootThread], current));
      setActiveWorkThreadId(response.childThread.id);
    } catch (error) {
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setForkingWorkThreadId("");
    }
  }

  async function ensureChannelDiscussionRootThread(): Promise<LingThread | undefined> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId) {
      return undefined;
    }
    if (channelDiscussionRootThread) {
      return channelDiscussionRootThread;
    }
    setChannelWorkThreadError("");
    try {
      const response = await createLingThread(workspaceCwd, {
        kind: "channel_discussion",
        channelId: selectedChannelId,
        idempotencyKey: `channel-main:${selectedChannelId}`,
      });
      setChannelWorkThreads((current) => mergeLingThreads([response.thread], current));
      return response.thread;
    } catch (error) {
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function mutateChannelWorkThreadVisibility(thread: LingThread, action: "archive" | "pin" | "unpin"): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || workThreadVisibilityId) {
      return;
    }
    setWorkThreadVisibilityId(thread.id);
    setChannelWorkThreadError("");
    if (action === "archive") {
      setArchivedChannelWorkThreadIds((current) => new Set(current).add(thread.id));
      setChannelWorkThreads((current) => current.filter((item) => item.id !== thread.id));
      setArchiveConfirmWorkThreadId("");
    }
    try {
      const idempotencyKey = `channel-work-thread-${action}:${thread.id}`;
      const response = action === "archive"
        ? await archiveLingThread(workspaceCwd, thread.id, { idempotencyKey })
        : action === "pin"
          ? await pinLingThread(workspaceCwd, thread.id, { idempotencyKey })
          : await unpinLingThread(workspaceCwd, thread.id, { idempotencyKey });
      setChannelWorkThreads((current) =>
        action === "archive"
          ? current.filter((item) => item.id !== response.thread.id)
          : [response.thread, ...current.filter((item) => item.id !== response.thread.id)]
      );
      if (action === "archive") {
        setArchivedChannelWorkThreadIds((current) => new Set(current).add(response.thread.id));
      }
    } catch (error) {
      if (action === "archive") {
        setArchivedChannelWorkThreadIds((current) => {
          const next = new Set(current);
          next.delete(thread.id);
          return next;
        });
        setChannelWorkThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      }
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkThreadVisibilityId("");
    }
  }

  async function updateChannelWorkThreadConversationMode(threadId: string, mode: ConversationModeKind): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !threadId || workThreadConversationModeId) {
      return;
    }
    setWorkThreadConversationModeId(threadId);
    setChannelWorkThreadError("");
    try {
      const response = await updateLingThreadMode(workspaceCwd, threadId, { mode });
      setChannelWorkThreads((current) => current.map((thread) => thread.id === threadId
        ? { ...thread, conversationMode: response.mode, updatedAt: response.mode.updatedAt ?? thread.updatedAt }
        : thread));
    } catch (error) {
      setChannelWorkThreadError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setWorkThreadConversationModeId("");
    }
  }

  return {
    activeWorkThreadId,
    setActiveWorkThreadId,
    visibleChannelWorkThreads,
    channelWorkThreadTreeRows,
    channelWorkThreadsLoading,
    channelWorkThreadError,
    channelWorkThreadSearch,
    setChannelWorkThreadSearch,
    channelWorkThreadSearchActive,
    channelDiscussionRootThread,
    forkingWorkThreadId,
    workThreadVisibilityId,
    workThreadConversationModeId,
    archiveConfirmWorkThreadId,
    setArchiveConfirmWorkThreadId,
    forkChannelWorkThread,
    forkChannelMainBranch,
    ensureChannelDiscussionRootThread,
    mutateChannelWorkThreadVisibility,
    updateChannelWorkThreadConversationMode,
  };
}

function deriveWorkspaceThreadsFromRuns(runs: readonly RunSession[]): readonly LingThread[] {
  const runsByThreadId = new Map<string, RunSession[]>();
  for (const run of runs) {
    if (!run.threadId) {
      continue;
    }
    runsByThreadId.set(run.threadId, [...(runsByThreadId.get(run.threadId) ?? []), run]);
  }
  return [...runsByThreadId.entries()].map(([threadId, threadRuns]) => {
    const latestRun = [...threadRuns].sort((left, right) => compareRunActivity(right, left))[0];
    const oldestRun = [...threadRuns].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    return {
      id: threadId,
      workspaceId: "workspace_default",
      kind: "task",
      channelId: latestRun.channelId,
      taskId: latestRun.taskId,
      teammateId: latestRun.teammateId,
      title: readTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
      objective: readTaskPrompt(latestRun.taskSnapshot) || readTaskTitle(latestRun.taskSnapshot) || latestRun.taskId,
      status: lingThreadStatusFromWorkspaceRun(latestRun),
      activeRunId: runCanBeStopped(latestRun) ? latestRun.id : undefined,
      lastRunId: latestRun.id,
      conversationMode: { mode: "default" },
      createdAt: oldestRun.createdAt,
      updatedAt: latestRun.updatedAt || latestRun.createdAt,
    } satisfies LingThread;
  });
}

function mergeLingThreads(...groups: readonly (readonly LingThread[])[]): readonly LingThread[] {
  const byId = new Map<string, LingThread>();
  for (const group of groups) {
    for (const thread of group) {
      const existing = byId.get(thread.id);
      if (!existing || thread.updatedAt >= existing.updatedAt) {
        byId.set(thread.id, { ...existing, ...thread });
      }
    }
  }
  return [...byId.values()];
}

function isChannelDiscussionRootThread(thread: LingThread, channelId: string | undefined): boolean {
  return thread.kind === "channel_discussion" &&
    Boolean(channelId) &&
    thread.channelId === channelId &&
    !thread.parentThreadId &&
    !thread.taskId &&
    !thread.teammateId &&
    !thread.workflowId &&
    !thread.workflowStepId &&
    !thread.externalWorkId;
}

function filterChannelBranchThreads(threads: readonly LingThread[], activeThreadId: string): readonly LingThread[] {
  const lineageParentThreadIds = new Set<string>();
  for (const thread of threads) {
    if (thread.parentThreadId) {
      lineageParentThreadIds.add(thread.parentThreadId);
    }
  }
  return threads.filter((thread) =>
    thread.kind === "channel_discussion" ||
    thread.kind === "task" ||
    Boolean(thread.parentThreadId) ||
    lineageParentThreadIds.has(thread.id) ||
    Boolean(thread.pinnedAt) ||
    (Boolean(activeThreadId) && thread.id === activeThreadId)
  );
}

function buildChannelWorkThreadTree(threads: readonly LingThread[]): readonly ChannelWorkThreadTreeRow[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const childIdsByParent = new Map<string, string[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) {
      continue;
    }
    childIdsByParent.set(thread.parentThreadId, [...(childIdsByParent.get(thread.parentThreadId) ?? []), thread.id]);
  }
  const roots = threads
    .filter((thread) => !thread.parentThreadId || !threadById.has(thread.parentThreadId))
    .map((thread) => thread.id);
  const rows: ChannelWorkThreadTreeRow[] = [];
  const visited = new Set<string>();
  const sortIds = (ids: readonly string[]): string[] =>
    [...new Set(ids)].sort((leftId, rightId) =>
      Number(Boolean(threadById.get(rightId)?.pinnedAt)) - Number(Boolean(threadById.get(leftId)?.pinnedAt)) ||
      (threadById.get(rightId)?.pinnedAt ?? "").localeCompare(threadById.get(leftId)?.pinnedAt ?? "") ||
      (threadById.get(rightId)?.updatedAt ?? "").localeCompare(threadById.get(leftId)?.updatedAt ?? "") ||
      leftId.localeCompare(rightId));
  const visit = (threadId: string, depth: number, parentHidden: boolean): void => {
    if (visited.has(threadId)) {
      return;
    }
    const thread = threadById.get(threadId);
    if (!thread) {
      return;
    }
    visited.add(threadId);
    rows.push({ thread, depth, parentHidden });
    for (const childId of sortIds(childIdsByParent.get(threadId) ?? [])) {
      visit(childId, Math.min(depth + 1, 6), false);
    }
  };
  for (const rootId of sortIds(roots)) {
    const root = threadById.get(rootId);
    visit(rootId, 0, Boolean(root?.parentThreadId && !threadById.has(root.parentThreadId)));
  }
  for (const thread of threads) {
    if (!visited.has(thread.id)) {
      rows.push({ thread, depth: 0, parentHidden: Boolean(thread.parentThreadId) });
    }
  }
  return rows;
}

function compareRunActivity(left: RunSession, right: RunSession): number {
  const leftTime = left.updatedAt || left.endedAt || left.startedAt || left.createdAt;
  const rightTime = right.updatedAt || right.endedAt || right.startedAt || right.createdAt;
  return leftTime.localeCompare(rightTime);
}

function lingThreadStatusFromWorkspaceRun(run: RunSession): LingThread["status"] {
  // Only the Host thread projection can assert a durable input wait.
  if (run.status === "yielded") return "blocked";
  if (run.status === "queued") {
    return "open";
  }
  return run.status;
}

function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

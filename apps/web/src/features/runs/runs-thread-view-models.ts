import { readTaskPrompt, readTaskTitle } from "../../lib/run-evidence.js";
import type { LingThread, LingTurn, LingTurnRun, RunSession } from "../../types.js";
import type {
  WorkHistoryTreeRow,
  WorkHistoryTurnAttempt,
  WorkHistoryTurnContext,
  WorkHistoryTurnGroup,
  WorkHistoryTurnLoadState,
} from "./runs-thread-types.js";

export function turnStateKey(cwd: string, threadId: string): string {
  return `${cwd.trim()}::${threadId}`;
}

export function runCanBeStopped(run: RunSession): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

export function buildWorkHistoryTurnLoadRequests(
  cwd: string,
  visibleThreads: readonly LingThread[],
  runs: readonly RunSession[],
  selectedRun: RunSession | undefined,
): ReadonlyArray<{ readonly threadId: string; readonly signature: string }> {
  if (!cwd.trim()) return [];
  const threadById = new Map(visibleThreads.map((thread) => [thread.id, thread]));
  const threadIds = new Set(visibleThreads.map((thread) => thread.id));
  for (const run of runs) if (run.threadId) threadIds.add(run.threadId);
  if (selectedRun?.threadId) threadIds.add(selectedRun.threadId);
  return [...threadIds].slice(0, 100).map((threadId) => ({
    threadId,
    signature: buildWorkHistoryThreadSignature(threadById.get(threadId), runs.filter((run) => run.threadId === threadId)),
  }));
}

export function buildWorkHistoryThreadSignature(thread: LingThread | undefined, runs: readonly RunSession[]): string {
  const runSignature = [...runs]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((run) => `${run.id}:${run.status}:${run.updatedAt || ""}:${run.endedAt || ""}`)
    .join(",");
  const metadata = thread?.metadata;
  return [
    thread?.updatedAt ?? "",
    thread?.activeRunId ?? "",
    thread?.lastRunId ?? "",
    metadata?.lastActivityAt ?? "",
    metadata?.pendingApprovalCount ?? "",
    metadata?.blockedCount ?? "",
    metadata?.failedAttemptCount ?? "",
    metadata?.artifactCount ?? "",
    metadata?.rebuiltAt ?? "",
    runSignature,
  ].join("|");
}

export function buildWorkHistoryTurnGroups(input: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly visibleThreads: readonly LingThread[];
  readonly turnStateByThreadKey: Readonly<Record<string, WorkHistoryTurnLoadState>>;
}): readonly WorkHistoryTurnGroup[] {
  const workspaceCwd = input.cwd.trim();
  const threadById = new Map(input.visibleThreads.map((thread) => [thread.id, thread]));
  const runById = new Map(input.runs.map((run) => [run.id, run]));
  const threadIds = new Set(input.visibleThreads.map((thread) => thread.id));
  for (const run of input.runs) if (run.threadId) threadIds.add(run.threadId);

  const groups: WorkHistoryTurnGroup[] = [];
  for (const threadId of threadIds) {
    const threadRuns = input.runs.filter((run) => run.threadId === threadId);
    const thread = threadById.get(threadId) ?? deriveThreadFromThreadRuns(threadId, threadRuns);
    if (!thread) continue;
    const consumedRunIds = new Set<string>();
    const turnState = workspaceCwd ? input.turnStateByThreadKey[turnStateKey(workspaceCwd, threadId)] : undefined;
    if (turnState?.status === "loaded") {
      const linksByTurnId = groupVisibleTurnRunLinks(turnState.runLinks, runById, threadId);
      for (const turn of turnState.turns) {
        const attempts = buildDurableTurnAttempts(linksByTurnId.get(turn.id) ?? [], runById);
        if (attempts.length === 0) continue;
        for (const attempt of attempts) consumedRunIds.add(attempt.run.id);
        const latestRunId = resolveLatestTurnRunId(turn, attempts);
        groups.push({
          id: `turn:${turn.id}`,
          threadId,
          turnId: turn.id,
          title: turn.title || thread.title,
          status: turn.status,
          runIds: attempts.map((attempt) => attempt.run.id),
          latestRunId,
          attemptCount: attempts.length,
          updatedAt: turn.updatedAt || attempts.find((attempt) => attempt.run.id === latestRunId)?.run.updatedAt || thread.updatedAt,
          source: "durable_turn",
          attempts,
          thread,
        });
      }
    }
    const ungroupedRuns = threadRuns.filter((run) => !consumedRunIds.has(run.id));
    if (ungroupedRuns.length > 0 || !groups.some((group) => group.threadId === threadId)) {
      groups.push(buildLegacyThreadGroup(thread, ungroupedRuns.length > 0 ? ungroupedRuns : threadRuns));
    }
  }
  return groups.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

export function buildWorkHistoryGroupTree(groups: readonly WorkHistoryTurnGroup[]): readonly WorkHistoryTreeRow[] {
  const groupsByThreadId = new Map<string, WorkHistoryTurnGroup[]>();
  const threadById = new Map<string, LingThread>();
  for (const group of groups) {
    groupsByThreadId.set(group.threadId, [...(groupsByThreadId.get(group.threadId) ?? []), group]);
    if (group.thread) threadById.set(group.thread.id, group.thread);
  }
  const childThreadIdsByParentId = new Map<string, string[]>();
  for (const thread of threadById.values()) {
    if (!thread.parentThreadId) continue;
    childThreadIdsByParentId.set(thread.parentThreadId, [...(childThreadIdsByParentId.get(thread.parentThreadId) ?? []), thread.id]);
  }
  const roots = [...threadById.values()]
    .filter((thread) => !thread.parentThreadId || !threadById.has(thread.parentThreadId))
    .map((thread) => thread.id);
  const visited = new Set<string>();
  const rows: WorkHistoryTreeRow[] = [];
  const sortThreadIds = (ids: readonly string[]): string[] => [...new Set(ids)].sort((leftId, rightId) =>
    Number(Boolean(threadById.get(rightId)?.pinnedAt)) - Number(Boolean(threadById.get(leftId)?.pinnedAt)) ||
    (threadById.get(rightId)?.pinnedAt ?? "").localeCompare(threadById.get(leftId)?.pinnedAt ?? "") ||
    latestThreadGroupUpdatedAt(groupsByThreadId.get(rightId) ?? []).localeCompare(latestThreadGroupUpdatedAt(groupsByThreadId.get(leftId) ?? [])) ||
    leftId.localeCompare(rightId));
  const visit = (threadId: string, depth: number, parentHidden: boolean): void => {
    if (visited.has(threadId)) return;
    visited.add(threadId);
    for (const group of sortGroupsForThread(groupsByThreadId.get(threadId) ?? [])) rows.push({ group, depth, parentHidden });
    for (const childId of sortThreadIds(childThreadIdsByParentId.get(threadId) ?? [])) visit(childId, Math.min(depth + 1, 6), false);
  };
  for (const threadId of sortThreadIds(roots)) {
    const thread = threadById.get(threadId);
    visit(threadId, 0, Boolean(thread?.parentThreadId && !threadById.has(thread.parentThreadId)));
  }
  for (const group of groups) if (!visited.has(group.threadId)) rows.push({ group, depth: 0, parentHidden: Boolean(group.thread?.parentThreadId) });
  return rows;
}

export function buildTurnContextByRunId(
  runId: string,
  groups: readonly WorkHistoryTurnGroup[],
  turnStateByThreadKey: Readonly<Record<string, WorkHistoryTurnLoadState>>,
  cwd: string,
): WorkHistoryTurnContext | undefined {
  if (!runId || !cwd.trim()) return undefined;
  const group = groups.find((item) => item.source === "durable_turn" && item.turnId && item.runIds.includes(runId));
  if (!group?.turnId) return undefined;
  const state = turnStateByThreadKey[turnStateKey(cwd, group.threadId)];
  if (state?.status !== "loaded") return undefined;
  const turn = state.turns.find((item) => item.id === group.turnId);
  return turn ? { group, turn } : undefined;
}

export function deriveThreadsFromRuns(runs: readonly RunSession[]): readonly LingThread[] {
  const grouped = new Map<string, RunSession[]>();
  for (const run of runs) if (run.threadId) grouped.set(run.threadId, [...(grouped.get(run.threadId) ?? []), run]);
  return [...grouped.entries()].map(([threadId, threadRuns]) => {
    const orderedRuns = [...threadRuns].sort((left, right) => compareRunRecency(right, left));
    const latestRun = orderedRuns[0];
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
      // This fallback has no durable question checkpoint; do not invent a resumable wait.
      status: latestRun.status === "queued" ? "open" : latestRun.status === "yielded" ? "blocked" : latestRun.status,
      activeRunId: runCanBeStopped(latestRun) ? latestRun.id : undefined,
      lastRunId: latestRun.id,
      conversationMode: { mode: "default" },
      createdAt: oldestRun.createdAt,
      updatedAt: latestRun.updatedAt || latestRun.createdAt,
    } satisfies LingThread;
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function normalizeWorkHistorySearchQuery(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 2 ? normalized : undefined;
}

export function reconcileSelectedId(currentId: string, visibleIds: readonly string[], previousIds: readonly string[] = []): string {
  if (currentId && visibleIds.includes(currentId)) return currentId;
  if (visibleIds.length === 0) return "";
  const previousIndex = previousIds.indexOf(currentId);
  if (previousIndex < 0) return visibleIds[0] ?? "";
  return visibleIds[Math.min(previousIndex, visibleIds.length - 1)] ?? visibleIds.at(-1) ?? "";
}

function deriveThreadFromThreadRuns(threadId: string, runs: readonly RunSession[]): LingThread | undefined {
  return deriveThreadsFromRuns(runs).find((thread) => thread.id === threadId);
}

function groupVisibleTurnRunLinks(links: readonly LingTurnRun[], runById: ReadonlyMap<string, RunSession>, threadId: string): ReadonlyMap<string, readonly LingTurnRun[]> {
  const byTurnId = new Map<string, LingTurnRun[]>();
  const seen = new Set<string>();
  for (const link of [...links].sort((left, right) => left.attemptNumber - right.attemptNumber || left.createdAt.localeCompare(right.createdAt))) {
    const run = runById.get(link.runId);
    if (!run || run.threadId !== threadId || seen.has(link.runId)) continue;
    seen.add(link.runId);
    byTurnId.set(link.turnId, [...(byTurnId.get(link.turnId) ?? []), link]);
  }
  return byTurnId;
}

function buildDurableTurnAttempts(links: readonly LingTurnRun[], runById: ReadonlyMap<string, RunSession>): readonly WorkHistoryTurnAttempt[] {
  return links.flatMap((link) => {
    const run = runById.get(link.runId);
    return run ? [{ run, attemptNumber: link.attemptNumber, role: link.role, linkedAt: link.createdAt }] : [];
  }).sort((left, right) => left.attemptNumber - right.attemptNumber || left.linkedAt.localeCompare(right.linkedAt));
}

function resolveLatestTurnRunId(turn: LingTurn, attempts: readonly WorkHistoryTurnAttempt[]): string {
  const active = turn.activeRunId ? attempts.find((attempt) => attempt.run.id === turn.activeRunId) : undefined;
  if (active) return active.run.id;
  const last = turn.lastRunId ? attempts.find((attempt) => attempt.run.id === turn.lastRunId) : undefined;
  if (last) return last.run.id;
  return [...attempts].sort((left, right) => compareRunRecency(right.run, left.run) || right.attemptNumber - left.attemptNumber)[0]?.run.id ?? attempts.at(-1)?.run.id ?? "";
}

function buildLegacyThreadGroup(thread: LingThread, runs: readonly RunSession[]): WorkHistoryTurnGroup {
  const ordered = [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latest = [...runs].sort((left, right) => compareRunRecency(right, left))[0];
  const latestRunId = thread.activeRunId ?? thread.lastRunId ?? latest?.id ?? "";
  return {
    id: `thread:${thread.id}`,
    threadId: thread.id,
    title: thread.metadata?.summary || thread.title,
    status: thread.status,
    runIds: ordered.map((run) => run.id),
    latestRunId,
    attemptCount: Math.max(ordered.length, latestRunId ? 1 : 0),
    updatedAt: thread.metadata?.lastActivityAt || thread.updatedAt || latest?.updatedAt || latest?.createdAt || "",
    source: "legacy_thread",
    attempts: ordered.map((run, index) => ({ run, attemptNumber: index + 1, role: "legacy", linkedAt: run.createdAt })),
    thread,
  };
}

function compareRunRecency(left: RunSession, right: RunSession): number {
  return (left.updatedAt || left.endedAt || left.startedAt || left.createdAt)
    .localeCompare(right.updatedAt || right.endedAt || right.startedAt || right.createdAt);
}

function sortGroupsForThread(groups: readonly WorkHistoryTurnGroup[]): readonly WorkHistoryTurnGroup[] {
  return [...groups].sort((left, right) =>
    Number(left.source === "legacy_thread") - Number(right.source === "legacy_thread") ||
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

function latestThreadGroupUpdatedAt(groups: readonly WorkHistoryTurnGroup[]): string {
  return groups.reduce((latest, group) => group.updatedAt > latest ? group.updatedAt : latest, "");
}

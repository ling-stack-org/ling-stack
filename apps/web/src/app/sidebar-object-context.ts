import type {
  AiTeammate,
  Channel,
  LingThread,
  RunSession,
  WorkspaceChangesResponse,
} from "../types.js";

export type SidebarObjectKind = "channel" | "private_chat" | "conversation";

export interface SidebarObjectGitContext {
  readonly repositoryLabel: string;
  readonly branchName: string;
}

export interface SidebarObjectContextSeed {
  readonly key: string;
  readonly activityAt: string;
  readonly cwd?: string;
}

export interface SidebarObjectContext {
  readonly activityAt: string;
  readonly git?: SidebarObjectGitContext;
}

export function sidebarObjectContextKey(kind: SidebarObjectKind, id: string): string {
  return `${kind}:${id}`;
}

export function buildSidebarObjectContextSeeds(input: {
  readonly channels: readonly Channel[];
  readonly conversationThreads: readonly LingThread[];
  readonly runs: readonly RunSession[];
  readonly teammates: readonly AiTeammate[];
  readonly workspaceCwd: string;
  readonly recentConversationLimit?: number;
}): readonly SidebarObjectContextSeed[] {
  const latestRunByThreadId = latestRunMap(input.runs, (run) => run.threadId);
  const latestRunByChannelId = latestRunMap(input.runs, (run) => run.channelId);
  const latestDirectRunByTeammateId = latestRunMap(
    input.runs.filter((run) => !run.channelId && Boolean(run.threadId)),
    (run) => run.teammateId,
  );
  const recentConversationLimit = input.recentConversationLimit ?? 5;

  return [
    ...input.channels.map((channel): SidebarObjectContextSeed => {
      const latestRun = latestRunByChannelId.get(channel.id);
      const cwd = firstNonEmpty(
        distinctPath(channel.workspaceBinding?.worktreePath, input.workspaceCwd),
        distinctPath(channel.workspaceBinding?.executionPath, input.workspaceCwd),
        distinctPath(latestRun?.cwd, input.workspaceCwd),
        distinctPath(channel.boundPath, input.workspaceCwd),
      );
      return {
        key: sidebarObjectContextKey("channel", channel.id),
        activityAt: latestActivityAt(channel.updatedAt, latestRun?.updatedAt),
        ...(cwd ? { cwd } : {}),
      };
    }),
    ...input.teammates.map((teammate): SidebarObjectContextSeed => {
      const latestRun = latestDirectRunByTeammateId.get(teammate.id);
      const cwd = distinctPath(latestRun?.cwd, input.workspaceCwd);
      return {
        key: sidebarObjectContextKey("private_chat", teammate.id),
        activityAt: latestActivityAt(teammate.updatedAt, latestRun?.updatedAt),
        ...(cwd ? { cwd } : {}),
      };
    }),
    ...[...input.conversationThreads]
      .sort((left, right) => threadActivityAt(right).localeCompare(threadActivityAt(left)))
      .slice(0, recentConversationLimit)
      .map((thread): SidebarObjectContextSeed => {
        const latestRun = latestRunByThreadId.get(thread.id);
        const cwd = distinctPath(latestRun?.cwd, input.workspaceCwd);
        return {
          key: sidebarObjectContextKey("conversation", thread.id),
          activityAt: latestActivityAt(threadActivityAt(thread), latestRun?.updatedAt),
          ...(cwd ? { cwd } : {}),
        };
      }),
  ];
}

export function projectSidebarObjectGitContext(
  changes: WorkspaceChangesResponse,
): SidebarObjectGitContext | undefined {
  if (changes.state !== "clean" && changes.state !== "dirty") return undefined;
  const repositoryLabel = pathBaseName(changes.repoRoot?.trim() || changes.cwd.trim());
  const branchName = changes.branchName?.trim() || changes.headSha?.trim().slice(0, 8);
  if (!repositoryLabel || !branchName) return undefined;
  return { repositoryLabel, branchName };
}

function latestRunMap(
  runs: readonly RunSession[],
  readKey: (run: RunSession) => string | undefined,
): ReadonlyMap<string, RunSession> {
  const latest = new Map<string, RunSession>();
  for (const run of runs) {
    const key = readKey(run)?.trim();
    if (!key) continue;
    const current = latest.get(key);
    if (!current || run.updatedAt.localeCompare(current.updatedAt) > 0) {
      latest.set(key, run);
    }
  }
  return latest;
}

function latestActivityAt(fallback: string, candidate?: string): string {
  return candidate && candidate.localeCompare(fallback) > 0 ? candidate : fallback;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

function distinctPath(candidate: string | undefined, excluded: string): string | undefined {
  const normalizedCandidate = normalizePath(candidate);
  if (!normalizedCandidate || normalizedCandidate === normalizePath(excluded)) return undefined;
  return candidate?.trim();
}

function normalizePath(path: string | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (trimmed === "/" || /^[A-Za-z]:[\\/]$/u.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/u, "");
}

function threadActivityAt(thread: LingThread): string {
  return thread.metadata?.lastActivityAt ?? thread.updatedAt;
}

function pathBaseName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
}

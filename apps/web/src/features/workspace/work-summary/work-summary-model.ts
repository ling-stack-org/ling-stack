import type { WorkSummaryResponse, WorkSummaryGroupModel, WorkSummaryTarget, WorkSummaryWorkspace } from "./work-summary.types.js";

export function buildWorkSummaryGroups(summary: WorkSummaryResponse): WorkSummaryGroupModel[] {
  const groups = new Map<string, { id: string; sessions: WorkSummaryResponse["sessions"][number][]; workspace?: WorkSummaryResponse["workspaces"][number] }>();
  for (const session of summary.sessions) {
    const key = session.workspaceKey ?? `unbound:${session.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { id: key, sessions: [], workspace: summary.workspaces.find((workspace) => workspace.key === key) };
      groups.set(key, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()];
}

export function findCurrentSummaryWorkspace(
  summary: WorkSummaryResponse | undefined,
  target: WorkSummaryTarget | undefined,
): WorkSummaryWorkspace | undefined {
  if (!summary || !target) return undefined;
  if (target.kind === "workspace") {
    return summary.workspaces.find((workspace) => workspace.cwd === target.path || workspace.key === target.path);
  }
  const key = summary.sessions.find((session) => session.threadId === target.threadId)?.workspaceKey;
  return key ? summary.workspaces.find((workspace) => workspace.key === key) : undefined;
}

export function isCleanSummaryWorkspace(workspace: WorkSummaryWorkspace): boolean {
  return workspace.state === "ready" && !workspace.partial && !workspace.error && workspace.changedFiles === 0;
}

export function summaryFolderLabel(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/** Keep the last successful worktree/PR read during a partial service outage. */
export function retainSummaryEvidence(next: WorkSummaryResponse, previous?: WorkSummaryResponse): WorkSummaryResponse {
  if (!previous || previous.cwd !== next.cwd) return next;
  return { ...next,
    workspaces: next.workspaces.map((workspace) => {
      const old = previous.workspaces.find((item) => item.key === workspace.key);
      return workspace.state === "unavailable" && old?.state === "ready" ? { ...old, error: workspace.error } : workspace;
    }),
    pullRequests: next.pullRequests.map((pull) => {
      const old = previous.pullRequests.find((item) => item.url === pull.url);
      return pull.connection === "error" && old?.state !== "unknown" && old ? { ...old, connection: pull.connection, error: pull.error } : pull;
    }),
  };
}

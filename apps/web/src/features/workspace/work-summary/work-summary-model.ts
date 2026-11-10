import type { WorkSummaryResponse, WorkSummaryGroupModel } from "./work-summary.types.js";

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

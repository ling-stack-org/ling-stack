import { resolve } from "node:path";
import type { RunStore, SecretResolver, ChannelWorkspaceBinding, DirectWorkspaceBinding } from "@ling-stack/core";
import type { WorkSummaryResponse, WorkSummarySession, WorkSummaryWorkspace } from "@ling-stack/contracts";
import { getGitSummary, resolveSummaryWorkspace } from "./git-summary.js";
import { readSummaryPullRequest } from "./pull-requests.js";
import { mapSummaryItems } from "./cache.js";

type SummaryStore = Pick<RunStore, "paths" | "listLingThreads" | "listChannels" | "listTeammateDirectThreads" | "getRun" | "listWorkSummaryPullRequests">;

export async function readWorkSummary(store: SummaryStore, secrets: SecretResolver): Promise<WorkSummaryResponse> {
  const threads = store.listLingThreads({ limit: 500 });
  const channels = store.listChannels({ limit: 500 }).filter((channel) => channel.status === "active");
  const directThreads = store.listTeammateDirectThreads({ limit: 500 });
  const paths = new Map<string, string>();
  const rawSessions: (WorkSummarySession & { path?: string })[] = threads.map((thread) => {
    const channel = thread.channelId ? channels.find((item) => item.id === thread.channelId) : undefined;
    const direct = thread.kind === "teammate_direct"
      ? directThreads.find((item) => item.teammateId === thread.teammateId) : undefined;
    const missingOwner = Boolean(thread.channelId && !channel) || (thread.kind === "teammate_direct" && !direct);
    const run = thread.activeRunId || thread.lastRunId ? store.getRun((thread.activeRunId || thread.lastRunId)!) : undefined;
    const binding = channel?.workspaceBinding ?? direct?.workspaceBinding;
    const path = bindingPath(binding) ?? channel?.boundPath ?? run?.cwd ?? store.paths.cwd;
    return { id: thread.id, threadId: thread.id, title: thread.title, status: thread.status,
      surface: thread.kind === "conversation" ? "conversation" : thread.kind === "teammate_direct" ? "teammate"
        : thread.kind === "channel_discussion" ? "channel" : "thread",
      channelId: thread.channelId, teammateId: thread.teammateId,
      path: missingOwner || (binding && binding.status !== "ready") ? undefined : resolve(path) };
  });
  for (const channel of channels) {
    if (rawSessions.some((session) => session.channelId === channel.id)) continue;
    rawSessions.push({ id: `channel:${channel.id}`, channelId: channel.id, title: channel.name, status: "open", surface: "channel",
      path: channel.workspaceBinding && channel.workspaceBinding.status !== "ready" ? undefined
        : resolve(bindingPath(channel.workspaceBinding) ?? channel.boundPath ?? store.paths.cwd) });
  }
  for (const direct of directThreads) {
    if (rawSessions.some((session) => session.surface === "teammate" && session.teammateId === direct.teammateId)) continue;
    rawSessions.push({ id: direct.id, title: direct.title, surface: "teammate", teammateId: direct.teammateId, status: "open",
      path: direct.workspaceBinding && direct.workspaceBinding.status !== "ready" ? undefined
        : resolve(bindingPath(direct.workspaceBinding) ?? store.paths.cwd) });
  }
  for (const session of rawSessions) if (session.path) paths.set(session.path, session.path);
  const selectedPaths = [...paths.keys()].slice(0, 20);
  const resolvedPaths = await mapSummaryItems(selectedPaths, async (path) => {
    try { return [path, await resolveSummaryWorkspace(path)] as const; }
    catch { return [path, path] as const; }
  });
  const canonicalPaths = new Map(resolvedPaths);
  const sourcePaths = new Map<string, string>();
  for (const [source, canonical] of canonicalPaths) if (!sourcePaths.has(canonical)) sourcePaths.set(canonical, source);
  const workspaces = await mapSummaryItems([...sourcePaths], async ([canonical, source]) => ({
    ...await getGitSummary(canonical), cwd: source,
  }));
  const sessions = rawSessions.map(({ path, ...session }) => ({ ...session, workspaceKey: path ? canonicalPaths.get(path) : undefined }));
  const pullRequests = await mapSummaryItems(store.listWorkSummaryPullRequests(), (binding) => readSummaryPullRequest(binding, secrets));
  return { cwd: store.paths.cwd, sessions, workspaces, pullRequests, truncated: threads.length === 500 || channels.length === 500 || directThreads.length === 500 || paths.size > 20, checkedAt: new Date().toISOString() };
}

function bindingPath(binding?: ChannelWorkspaceBinding | DirectWorkspaceBinding): string | undefined {
  return binding?.mode === "managed_worktree" ? binding.worktreePath ?? binding.executionPath : binding?.executionPath;
}

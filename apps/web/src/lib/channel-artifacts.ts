import type { RunSession, Task } from "../types.js";

export function deriveChannelRuns(
  channelId: string,
  tasks: readonly Task[],
  runs: readonly RunSession[],
  extraRun?: RunSession,
): readonly RunSession[] {
  if (!channelId) {
    return [];
  }

  const taskIds = new Set(tasks.filter((task) => task.channelId === channelId).map((task) => task.id));
  const runById = new Map<string, RunSession>();
  for (const run of runs) {
    runById.set(run.id, run);
  }
  if (extraRun) {
    runById.set(extraRun.id, extraRun);
  }

  return [...runById.values()]
    .filter((run) => run.channelId === channelId || taskIds.has(run.taskId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

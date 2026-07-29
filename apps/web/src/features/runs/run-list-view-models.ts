import type { StatusTone } from "../../shared/ui/index.js";
import type { Translate } from "../../i18n.js";
import type { LingThread, LingThreadSearchMatch, RunSession } from "../../types.js";

export function runStatusTone(status: string): StatusTone {
  if (status === "failed" || status === "cancelled") return "danger";
  if (status === "waiting_for_approval" || status === "blocked" || status === "stopping") return "warning";
  if (status === "running" || status === "queued" || status === "open") return "info";
  if (status === "succeeded") return "success";
  return "neutral";
}

export function primaryRunStatus(run: RunSession | undefined): string {
  return run?.status ?? "unknown";
}

export function buildThreadSearchMatchMap(matches: readonly LingThreadSearchMatch[]): ReadonlyMap<string, LingThreadSearchMatch> {
  const result = new Map<string, LingThreadSearchMatch>();
  for (const match of matches) if (!result.has(match.threadId)) result.set(match.threadId, match);
  return result;
}

export function formatLingThreadSearchMatch(match: LingThreadSearchMatch, t: Translate): string {
  const labels: Readonly<Record<string, string>> = {
    thread_title: "Thread title",
    thread_objective: "Thread objective",
    turn_title: "Turn title",
    turn_instruction: "Turn instruction",
    task_title: "Task title",
    task_prompt: "Task prompt",
    metadata_summary: "Thread summary",
  };
  return t(labels[match.field] ?? "Task id");
}

export function formatWorkHistoryMetadataHint(thread: LingThread | undefined, t: Translate): string {
  const metadata = thread?.metadata;
  if (!metadata) return "";
  const items: string[] = [];
  if (metadata.pendingApprovalCount > 0) items.push(t("{count} pending approvals", { count: metadata.pendingApprovalCount }));
  if (metadata.failedAttemptCount > 0) items.push(t("{count} failed attempts", { count: metadata.failedAttemptCount }));
  if (metadata.artifactCount > 0) items.push(t("{count} artifacts", { count: metadata.artifactCount }));
  return items.slice(0, 2).join(" · ");
}

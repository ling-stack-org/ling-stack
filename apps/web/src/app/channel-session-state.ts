import type { ChannelSessionSummary } from "@ling-stack/contracts";

export const channelSessionSelection = (threadId: string): string => `session:${threadId}`;
export const channelSessionThreadId = (selection: string): string | undefined => selection.startsWith("session:") ? selection.slice(8) : undefined;
export const isChannelSessionDraft = (selection: string): boolean => selection.startsWith("session-draft:");

export function reconcileSessionReadWatermarks(
  current: Readonly<Record<string, number>>,
  watermarks: readonly { readonly id: string; readonly latestNotificationRevision: number }[],
): Record<string, number> {
  const next = { ...current };
  for (const entry of watermarks) if (next[entry.id] === undefined) next[entry.id] = entry.latestNotificationRevision;
  return next;
}

export function channelSessionUnread(
  watermarks: readonly { readonly id: string; readonly latestNotificationRevision: number }[],
  read: Readonly<Record<string, number>>,
): boolean {
  return watermarks.some((entry) => read[entry.id] !== undefined && entry.latestNotificationRevision > read[entry.id]!);
}

export function sessionStatus(session: ChannelSessionSummary): Exclude<ChannelSessionSummary["runtimeState"], "idle"> | undefined {
  return session.pendingApprovalCount > 0 ? "waiting" : session.runtimeState === "idle" ? undefined : session.runtimeState;
}

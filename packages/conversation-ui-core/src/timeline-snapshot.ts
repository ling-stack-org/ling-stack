import type { ConversationOperationSourceRef } from "./work-cell-view-model.js";
import type { ConversationTimelineItem } from "./transcript-item.js";
import type { ConversationTimelineScope } from "./surface-policy.js";

export interface ActiveRunSnapshot {
  readonly runId: string;
  readonly status: "pending" | "working" | "waiting" | "reconnecting";
  readonly workspaceLabel: string;
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly modelLabel: string | null;
  readonly sourceRefs: readonly ConversationOperationSourceRef[];
}

/** Read-only Host lifecycle, never inferred from mounted rows or model text. */
export interface TimelineRunLifecycle {
  readonly id: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

/**
 * Immutable renderer input. The adapter owns I/O and replay; Timeline only
 * renders these already-scoped items and never infers state from prose.
 */
export interface TimelineSnapshot {
  readonly scope: ConversationTimelineScope;
  readonly items: readonly ConversationTimelineItem[];
  readonly activeRun: ActiveRunSnapshot | null;
  readonly canonicalRevision: number;
  readonly sseCursor: string | null;
  readonly contextSegmentIdByItemId: ReadonlyMap<string, string>;
  readonly runLifecycles?: ReadonlyMap<string, TimelineRunLifecycle>;
}

export function createTimelineSnapshot(input: TimelineSnapshot): TimelineSnapshot {
  return {
    ...input,
    items: [...input.items],
    contextSegmentIdByItemId: new Map(input.contextSegmentIdByItemId),
    ...(input.runLifecycles ? { runLifecycles: new Map(input.runLifecycles) } : {}),
  };
}

import { visibleTerminalReportTimelineItem, type ConversationTimelineItem, type TimelineRunLifecycle } from "@ling-stack/conversation-ui-core";
import { terminalReportDisplayPolicy } from "./terminal-report-display-policy.js";
import { timelineProcessDisclosureKey, timelineProcessScopeKey } from "./conversation-timeline-view-retain-keys.js";
import { projectTimelineActivitySections } from "./timeline-activity-presentation.js";

export interface TimelineProcessGroup {
  readonly id: string;
  readonly presentation: "process" | "activity";
  readonly revisionKey: string;
  readonly items: readonly ConversationTimelineItem[];
  readonly status: "running" | "completed" | "attention" | "unknown";
  readonly mustExpand: boolean;
  readonly defaultExpanded: boolean;
  readonly durationMs?: number;
  readonly wrappedItemIds?: readonly string[];
}

export type TimelineProcessSection =
  | { readonly kind: "item"; readonly item: ConversationTimelineItem }
  | { readonly kind: "process"; readonly group: TimelineProcessGroup };

const live = new Set(["pending", "running", "waiting"]);
const attention = new Set(["blocked", "failed", "cancelled", "partially_succeeded"]);

/** Strict, view-only identity. Unknown attribution is never joined by proximity. */
const scopeKey = timelineProcessScopeKey;

function isProcess(item: ConversationTimelineItem): boolean {
  if (item.kind === "agentMessage") return item.phase === "commentary" && !item.waitingPlaceholder;
  return !["userMessage", "terminalReport", "subAgentActivity", "contextCompaction"].includes(item.kind);
}

/** Pending human input and exceptions must not disappear behind a touched fold. */
export function timelineItemNeedsVisibleAttention(item: ConversationTimelineItem): boolean {
  if (attention.has(item.status ?? "") || item.kind === "diagnostic") return true;
  if (item.kind === "approval") return !item.decision || item.decision !== "allowed";
  if (item.kind === "userInputRequest") return item.userInput.availability !== "available" || item.userInput.status === "pending";
  if (item.kind === "userInputAnswer") return item.userInput.availability !== "available" || ["pending", "claimed", "failed"].includes(item.userInput.delivery.status);
  if (item.kind === "plan") return item.steps.some(step => step.status !== "completed");
  if (item.kind === "commandBatch") return item.batch.commands.some(timelineItemNeedsVisibleAttention);
  if (item.kind === "explorationBatch") return item.batch.children.some(timelineItemNeedsVisibleAttention);
  if (item.kind === "subAgentActivity") return ["waiting", "blocked", "errored", "interrupted"].includes(item.lifecycle)
    || item.childItems.some(timelineItemNeedsVisibleAttention);
  if (item.kind === "terminalReport") return terminalReportDisplayPolicy(visibleTerminalReportTimelineItem(item), true).needsAttention;
  return false;
}

/** No sorting, persistence, completion inference from text or batch-count evidence. */
export function projectTimelineProcessSections(items: readonly ConversationTimelineItem[], parentId = "root", runLifecycles?: ReadonlyMap<string, TimelineRunLifecycle>, contextSegments?: ReadonlyMap<string, string>): readonly TimelineProcessSection[] {
  const scopeItems = new Map<string, ConversationTimelineItem[]>();
  const scopesByRun = new Map<string, Set<string>>();
  const reportsByTurn = new Map<string | undefined, ConversationTimelineItem[]>();
  for (const item of items) {
    if (item.kind === "terminalReport") {
      const reports = reportsByTurn.get(item.turnId) ?? [];
      reports.push(item);
      reportsByTurn.set(item.turnId, reports);
    }
    const key = scopeKey(item);
    if (!key) continue;
    const scoped = scopeItems.get(key) ?? [];
    scoped.push(item);
    scopeItems.set(key, scoped);
    const keys = scopesByRun.get(item.runId!) ?? new Set<string>();
    keys.add(key);
    scopesByRun.set(item.runId!, keys);
  }
  const sections: TimelineProcessSection[] = [];
  const stateByScope = new Map<string, Pick<TimelineProcessGroup, "status" | "mustExpand" | "defaultExpanded" | "durationMs" | "revisionKey">>();
  let pending: ConversationTimelineItem[] = [];
  let pendingKey: string | undefined;
  const flush = (): void => {
    if (!pending.length || !pendingKey) return;
    let state = stateByScope.get(pendingKey);
    if (!state) {
      const facts = scopeItems.get(pendingKey) ?? pending;
      // A report with absent attempt attribution can only describe a sole loaded
      // scope of its own Run, never another Run/Agent or competing retry.
      const reports = reportsByTurn.get(pending[0]!.turnId) ?? [];
      const ownRunReport = (item: ConversationTimelineItem): boolean => item.kind === "terminalReport" &&
        (item.runId === pending[0]!.runId || item.outcomeSourceRefs?.filter(ref => ref.kind === "run").length === 1
          && item.outcomeSourceRefs.some(ref => ref.kind === "run" && ref.id === pending[0]!.runId))
        && scopesByRun.get(pending[0]!.runId!)?.size === 1;
      const lifecycle = runLifecycles?.get(pending[0]!.runId!);
      const ownLifecycle = lifecycle && lifecycle.id === pending[0]!.runId && scopesByRun.get(lifecycle.id)?.size === 1 ? lifecycle : undefined;
      const mustExpand = [...facts, ...reports].some(timelineItemNeedsVisibleAttention) || attention.has(ownLifecycle?.status ?? "");
      const running = facts.some(item => live.has(item.status ?? "")) || live.has(ownLifecycle?.status ?? "");
      const completed = !running && (ownLifecycle?.status === "succeeded" || facts.some(item => item.kind === "agentMessage" && item.phase === "final" && item.status === "succeeded")
        || reports.some(item => ownRunReport(item) && item.status === "succeeded"));
      const status = mustExpand ? "attention" : running ? "running" : completed ? "completed" : "unknown";
      const start = ownLifecycle?.startedAt ? Date.parse(ownLifecycle.startedAt) : NaN;
      const end = ownLifecycle?.endedAt ? Date.parse(ownLifecycle.endedAt) : NaN;
      const durationMs = completed && Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
      state = { status, mustExpand, durationMs, defaultExpanded: status !== "completed", revisionKey: status };
      stateByScope.set(pendingKey, state);
    }
    if (state.status === "completed" || state.status === "attention") {
      const id = timelineProcessDisclosureKey(pending[0]!, parentId)!;
      sections.push({ kind: "process", group: { id, presentation: "process", items: pending, ...state } });
    } else sections.push(...projectTimelineActivitySections(pending, parentId, contextSegments));
    pending = [];
    pendingKey = undefined;
  };
  for (const item of items) {
    const key = isProcess(item) ? scopeKey(item) : undefined;
    if (!key || pendingKey && key !== pendingKey) flush();
    if (key) { pendingKey = key; pending.push(item); }
    else sections.push({ kind: "item", item });
  }
  flush();
  return sections;
}

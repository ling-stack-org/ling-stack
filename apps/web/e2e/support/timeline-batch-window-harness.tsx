import { createRoot } from "react-dom/client";
import type { ConversationTimelineCommandBatchItem, ConversationTimelineItem, ConversationTimelineScopeKind, TimelineSnapshot } from "@ling-stack/conversation-ui-core";
import { I18nProvider } from "../../src/i18n.js";
import { mountConversationTimeline } from "../../src/shared/conversation/timeline/mountConversationTimeline.js";
import type { ConversationTimelineItemLocator } from "../../src/shared/conversation/timeline/ConversationTimeline.js";
import type { ConversationReadingAnchor } from "../../src/shared/conversation/blocks/conversation-reading-anchor.js";

/** Isolated component probe. No Host, model, durable history or tool execution. */
export function mountBatchWindowFixture(scope: ConversationTimelineScopeKind, nested: boolean,
  { commandCount = 1_000, batchCommands = true }: { readonly commandCount?: number; readonly batchCommands?: boolean } = {}) {
  const container = document.createElement("div");
  container.id = "batch-window-simulation";
  container.style.cssText = "position:fixed;inset:40px 20px;z-index:10000;background:var(--ling-surface);overflow-y:auto";
  container.setAttribute("aria-label", "Simulation batch root viewport");
  document.body.append(container);
  const root = createRoot(container);
  const itemLocatorRef: { current: ConversationTimelineItemLocator | null } = { current: null };
  const scrollRef = { current: container };
  const base = { revision: 1, threadSequence: 1, partIndex: 0, runId: "simulation-run",
    attemptId: "simulation-attempt", participantId: "simulation-agent", workflowStepId: null,
    actionId: "simulation-action", sourceRefs: [] };
  const commands: ConversationTimelineCommandBatchItem["batch"]["commands"] = Array.from({ length: commandCount }, (_, index) => ({
    ...base, id: `command:${index + 1}`, partIndex: index + 1, actionId: `action:${index + 1}`,
    kind: "commandExecution", status: "succeeded", command: `node --version # ${index + 1}`,
    title: "Ran command", risk: "low", outputTail: [{ eventSeq: 2, stream: "stdout", text: "v24.0.0", redacted: false }],
    outputTruncated: false, exitCode: 0,
  }));
  const actionIds = commands.map((command) => command.actionId);
  const childItemIds = commands.map((command) => command.id);
  let revision = 1;
  function render(): void {
    const batch: ConversationTimelineCommandBatchItem = { ...base, revision, id: "simulation-batch",
      kind: "commandBatch", actionIds, childActionIds: actionIds, childItemIds,
      batch: { ...base, id: "simulation-batch", revision, revisionKey: String(revision), defaultExpanded: false,
        commandCount: commands.length, actionIds, childActionIds: actionIds, childItemIds, commands } };
    const items: readonly ConversationTimelineItem[] = nested
      ? [{ ...base, revision, id: "simulation-agent-span", kind: "subAgentActivity", label: "Engineer",
        lifecycle: "completed", childItems: batchCommands ? [batch] : commands }]
      : [batch];
    const snapshot: TimelineSnapshot = { scope: { kind: scope, threadId: "simulation-thread",
      parentThreadId: null, anchorItemId: null, depth: 0 }, items, activeRun: null,
      canonicalRevision: revision, sseCursor: String(revision), contextSegmentIdByItemId: new Map() };
    root.render(<I18nProvider>{mountConversationTimeline({ snapshot, depth: 0, virtualScrollRef: scrollRef, itemLocatorRef }).node}</I18nProvider>);
  }
  render();
  return {
    ready: () => itemLocatorRef.current !== null,
    reveal: (id: string) => itemLocatorRef.current?.revealFirstMatchingItem([id], (row) => row.focus({ preventScroll: true })),
    revealReading: (anchor: ConversationReadingAnchor) => itemLocatorRef.current?.revealReadingAnchor(anchor, row => row.focus({ preventScroll: true })),
    revise: () => { revision += 1; render(); },
    dispose: () => { root.unmount(); container.remove(); },
  };
}

export type BatchWindowHarness = ReturnType<typeof mountBatchWindowFixture>;
declare global { interface Window { batchWindowHarness: BatchWindowHarness; } }

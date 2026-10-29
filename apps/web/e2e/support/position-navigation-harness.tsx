import { createRoot } from "react-dom/client";
import type { ConversationTimelineMessageItem, TimelineSnapshot } from "@ling-stack/conversation-ui-core";
import { I18nProvider } from "../../src/i18n.js";
import { ConversationTimelineFeed } from "../../src/shared/conversation/blocks/ConversationTimelineFeed.js";
import { mountConversationTimeline } from "../../src/shared/conversation/timeline/mountConversationTimeline.js";
import type { ConversationTimelineItemLocator } from "../../src/shared/conversation/timeline/ConversationTimeline.js";

/** Real shared Timeline/locator, with an owned history and one injected lookup failure. */
export function mountPositionFixture() {
  const container = document.createElement("main");
  container.style.cssText = "position:fixed;inset:40px;display:flex;flex-direction:column;background:var(--ling-bg-panel)";
  document.body.append(container);
  const root = createRoot(container);
  const scrollRef = { current: null as HTMLDivElement | null };
  const locatorRef = { current: null as ConversationTimelineItemLocator | null };
  const finals: ConversationTimelineMessageItem[] = Array.from({ length: 120 }, (_, index) => ({
    id: `position-final-${index}`, kind: "agentMessage", phase: "final", status: "succeeded",
    markdown: `Final ${index}\n\n${"Read the transcript at your own pace. ".repeat(12)}`,
    revision: 1, threadSequence: index + 1, partIndex: 1, turnId: `turn-${index}`,
    runId: `run-${index}`, attemptId: `attempt-${index}`, participantId: "ling_agent",
    workflowStepId: null, actionId: null, sourceRefs: [],
  }));
  let items = [{ ...finals[0]!, id: "position-commentary", phase: "commentary" as const,
    markdown: "Earlier process message", partIndex: 0 }, ...finals];
  let revision = 1;
  function render() {
    const snapshot: TimelineSnapshot = { scope: { kind: "normal", threadId: "position-fixture", parentThreadId: null, anchorItemId: null, depth: 0 },
      items, activeRun: null, canonicalRevision: revision++, sseCursor: null, contextSegmentIdByItemId: new Map() };
    const timeline = mountConversationTimeline({ snapshot, depth: 0, virtualScrollRef: scrollRef, itemLocatorRef: locatorRef,
      onPositionNavigate: () => {}, positionIdentity: () => ({ name: "Ling Agent", avatar: <span>L</span> }) });
    root.render(<I18nProvider><ConversationTimelineFeed surfaceId="position-fixture" scrollRef={scrollRef}
      ariaLabel="Navigation test feed" timelineId="position-fixture" timelineNode={timeline.node}
      loadingLabel="Loading" emptyLabel="Empty" /></I18nProvider>);
  }
  render();
  return {
    cancelPending: async () => {
      let current = true;
      let revealed = false;
      const pending = locatorRef.current!.revealFirstMatchingItem(["position-commentary"], () => { revealed = true; }, () => current);
      current = false;
      return { result: await pending, revealed };
    },
    failNext: () => {
      const locator = locatorRef.current!;
      locatorRef.current = { ...locator, revealFirstMatchingItem: async () => {
        locatorRef.current = locator;
        return "not_found";
      } };
    },
    removeFirst: () => { items = items.slice(1); render(); },
    single: () => { items = finals.slice(0, 1); render(); },
    restore: () => { items = finals; render(); },
    dispose: () => { root.unmount(); container.remove(); },
  };
}

declare global { interface Window { positionHarness: ReturnType<typeof mountPositionFixture>; } }

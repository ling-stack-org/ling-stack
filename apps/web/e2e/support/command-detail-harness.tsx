import { createRoot } from "react-dom/client";
import type { ConversationTimelineCommandExecutionItem } from "@ling-stack/conversation-ui-core";
import { I18nProvider } from "../../src/i18n.js";
import { ConversationViewProvider } from "../../src/shared/conversation/view-store/conversation-view-provider.js";
import { ConversationTimelineCommandRenderer } from "../../src/shared/conversation/timeline/ConversationTimelineCommandRenderer.js";
import { ConversationTimelineResponseFiles } from "../../src/shared/conversation/timeline/ConversationTimelineResponseFiles.js";
import type { ConversationTimelineResponse } from "../../src/shared/conversation/timeline/timeline-response-presentation.js";

/** Production command renderer; callback receipt is a fixture, not a Host launch. */
export function mountCommandDetailFixture(input: Partial<ConversationTimelineCommandExecutionItem>) {
  const container = document.createElement("main");
  container.style.cssText = "padding:24px;max-width:700px";
  container.dataset.conversationTimeline = "true";
  document.body.append(container);
  const root = createRoot(container);
  let item: ConversationTimelineCommandExecutionItem = {
    id: "command-detail", kind: "commandExecution", title: "Run command", revision: 1,
    threadSequence: 1, partIndex: 0, status: "succeeded", turnId: "turn-detail",
    runId: "run-detail", actionId: "action-detail", participantId: "ling-agent",
    command: "node --test", risk: "low", sourceRefs: [], outputTail: [], outputTruncated: false,
    ...input,
  };
  const opened: string[] = [];
  const render = () => root.render(<I18nProvider><ConversationViewProvider surfaceId="command-detail-fixture" readingScopeKey="command-detail-reading">
    <ConversationTimelineCommandRenderer item={item} depth={0} onOpenSourceRef={(ref, owner) => {
      opened.push(JSON.stringify({ ref, actionId: owner?.actionId, runId: owner?.runId }));
    }} />
  </ConversationViewProvider></I18nProvider>);
  render();
  return { opened: () => opened,
    update: (patch: Partial<ConversationTimelineCommandExecutionItem>) => { item = { ...item, ...patch }; render(); },
    dispose: () => { root.unmount(); container.remove(); } };
}

declare global { interface Window { commandDetailHarness: ReturnType<typeof mountCommandDetailFixture>; } }

export function mountResponseFilesFixture() {
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  const response: ConversationTimelineResponse = {
    id: "response-files-fixture", messages: [], copyText: "", logicalMessageCount: 0, settled: true,
    items: [{ id: "files-change", kind: "fileChange", revision: 1, threadSequence: 1, partIndex: 0,
      status: "succeeded", actionId: "action-files", title: "Edit files", sourceRefs: [],
      files: Array.from({ length: 5 }, (_, index) => ({ kind: "modified", fileRef: {
        kind: "file", id: `file-${index}`, path: `src/changed-${index}.ts`, visibility: "conversation",
      } })),
    }],
  };
  const render = (visible: boolean) => root.render(<I18nProvider>
    <ConversationViewProvider surfaceId="files-fixture" readingScopeKey="response-files-reading">
      {visible ? <ConversationTimelineResponseFiles response={response} depth={0} /> : null}
    </ConversationViewProvider>
  </I18nProvider>);
  render(true);
  return { show: render, dispose: () => { root.unmount(); container.remove(); } };
}
declare global { interface Window { responseFilesHarness: ReturnType<typeof mountResponseFilesFixture>; } }

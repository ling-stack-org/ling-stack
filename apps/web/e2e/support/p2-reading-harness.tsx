import { createRoot } from "react-dom/client";
import { applyResolvedTheme, ThemeRegistry } from "@ling-stack/ui-react/theme";
import { I18nProvider } from "../../src/i18n.js";
import { ThemeProvider } from "../../src/theme.js";
import { LingUiProvider } from "../../src/shared/ui/index.js";
import { NormalConversationFeed } from "../../src/features/workspace/NormalConversationFeed.js";
import { ConversationTimelineFeed } from "../../src/shared/conversation/blocks/ConversationTimelineFeed.js";
import type { ConversationHomeMessage } from "../../src/features/workspace/normal-conversation-types.js";
import { readInitialThemeSelection } from "../../src/shared/ui/theme/web-theme-storage.js";

/** Real production feed with controlled inputs; no Daemon, model or execution. */
export function mountReadingFixture(messageCount = 36) {
  const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyResolvedTheme(document.documentElement, new ThemeRegistry().resolve(readInitialThemeSelection().selection, scheme));
  const container = document.createElement("main");
  container.id = "p2-reading-fixture";
  // Keep the synthetic reader above the app, but below shared portaled dialogs.
  container.style.cssText = "position:fixed;inset:48px 24px 24px;display:flex;flex-direction:column;background:var(--ling-bg-panel);z-index:calc(var(--ling-z-dialog) - 1)";
  document.body.append(container);
  const root = createRoot(container);
  let threadId = "p2-reading-thread";
  let searchActive = false;
  let messages: readonly ConversationHomeMessage[] = Array.from({ length: messageCount }, (_, index) => ({
    id: `reading-message-${index}`,
    threadId,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `History ${index}\n\n${"A stable reading position matters. ".repeat(8)}`,
    status: "succeeded",
    createdAt: new Date(Date.UTC(2026, 9, 13, 10, index)).toISOString(),
  }));
  const noop = () => {};
  function render() {
    root.render(<I18nProvider><ThemeProvider><LingUiProvider><NormalConversationFeed
      messages={messages} visibleMessages={messages} runById={new Map()}
      composerGateApprovals={[]} generatedMedia={[]} workspaceCwd="/p2-fixture"
      searchActive={searchActive} editSaving={false} replacementRetryError=""
      onCancelMessageEdit={noop} onEditMessage={noop} onSaveMessage={noop}
      onRetryReplacement={noop} onOpenFiles={noop} onOpenReportFile={noop} onOpenReview={noop}
    /></LingUiProvider></ThemeProvider></I18nProvider>);
  }
  render();
  return {
    grow: (index: number) => {
      messages = messages.map((message, position) => position === index
        ? { ...message, content: `${message.content}\n\n${"New content above the reader.\n\n".repeat(20)}`, revision: (message.revision ?? 1) + 1 }
        : message);
      render();
    },
    prepend: () => {
      messages = [{ ...messages[0]!, id: "reading-older", content: "Earlier history\n\n".repeat(12) }, ...messages];
      render();
    },
    stream: (content: string, settled = false) => {
      messages = messages.map((message, index) => index === messages.length - 1
        ? { ...message, content, status: settled ? "succeeded" : "running", revision: (message.revision ?? 1) + 1 }
        : message);
      render();
    },
    search: () => { searchActive = true; render(); },
    append: () => {
      messages = [...messages, { ...messages.at(-1)!, id: "reading-newest", content: "A new incoming message\n\n".repeat(30) }];
      render();
    },
    resize: () => { container.style.right = "60%"; },
    mediaResize: () => {
      const row = container.querySelector<HTMLElement>("[data-conversation-row-key]");
      if (row) row.style.paddingTop = "240px";
    },
    switchThread: () => {
      threadId = "p2-other-thread";
      messages = messages.map((message) => ({ ...message, id: `other-${message.id}`, threadId }));
      searchActive = false;
      render();
    },
    dispose: () => { root.unmount(); container.remove(); },
  };
}

export type ReadingHarness = ReturnType<typeof mountReadingFixture>;
declare global { interface Window { p2ReadingHarness: ReadingHarness; } }

export function mountScrollIntentFixture() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const scrollRef = { current: null };
  let intentCount = 0;
  let handlerCount = 0;
  root.render(<ConversationTimelineFeed surfaceId="p2-intent" scrollRef={scrollRef}
    ariaLabel="Keyboard reading viewport" timelineId="intent-timeline"
    loadingLabel="Loading" emptyLabel="Empty" onUserScrollIntent={() => { intentCount++; }}
    onKeyDown={() => { handlerCount++; }}
    timelineNode={<><textarea aria-label="Editable message" /><button type="button">Disclosure</button><p>{"History\n".repeat(80)}</p></>}
  />);
  return { counts: () => ({ intentCount, handlerCount }), dispose: () => { root.unmount(); container.remove(); } };
}
declare global { interface Window { p2ScrollIntentHarness: ReturnType<typeof mountScrollIntentFixture>; } }

import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChannelMessage, RunSession } from "@ling-stack/contracts";
import { applyResolvedTheme, ThemeRegistry } from "@ling-stack/ui-react/theme";
import { I18nProvider, useI18n } from "../../src/i18n.js";
import { ThemeProvider } from "../../src/theme.js";
import { LingUiProvider } from "../../src/shared/ui/index.js";
import { readInitialThemeSelection } from "../../src/shared/ui/theme/web-theme-storage.js";
import { NormalConversationFeed } from "../../src/features/workspace/NormalConversationFeed.js";
import { ChannelMessageFeed, useChannelMessageFeed, type ChannelMessageFeedItem } from "../../src/features/workspace/ChannelMessageFeed.js";
import { createChannelMessageRenderers } from "../../src/features/workspace/ChannelMessageRenderers.js";
import { ThreadReplyPanel } from "../../src/features/workspace/ThreadReplyPanel.js";
import type { ConversationTimelineItemLocator } from "../../src/shared/conversation/timeline/ConversationTimeline.js";

export type FeedbackSurface = "normal" | "channel_root" | "branch" | "topic";
const cwd = "/run-feedback-fixture";
const now = "2026-11-04T01:00:00.000Z";
const noop = (): void => {};

/** Production feeds with controlled facts; only the run-journal route performs I/O. */
export function mountRunFeedbackFixture(surface: FeedbackSurface): { dispose: () => void } {
  const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyResolvedTheme(document.documentElement, new ThemeRegistry().resolve(readInitialThemeSelection().selection, scheme));
  const container = document.createElement("main");
  container.style.cssText = "position:fixed;inset:24px;display:flex;flex-direction:column;background:var(--ling-bg-panel)";
  document.body.append(container);
  const root = createRoot(container);
  const run: RunSession = {
    id: `feedback-run-${surface}`, status: "running", cwd, threadId: `feedback-thread-${surface}`, taskId: "feedback-task",
    providerName: "fixture", providerModel: "fixture-model", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {},
    eventLogPath: "/fixture/run-events.jsonl", createdAt: now, updatedAt: now,
  };
  root.render(<I18nProvider><ThemeProvider><LingUiProvider>
    {surface === "normal" ? <NormalFixture run={run} />
      : surface === "topic" ? <TopicFixture run={run} /> : <ChannelFixture run={run} surface={surface} />}
  </LingUiProvider></ThemeProvider></I18nProvider>);
  return { dispose: () => { root.unmount(); container.remove(); } };
}

function NormalFixture({ run }: { readonly run: RunSession }): React.JSX.Element {
  const messages = [{ id: "feedback-user", threadId: run.threadId, role: "user" as const,
    content: "Check the current response.", status: "succeeded" as const, createdAt: now },
  { id: "feedback-assistant", threadId: run.threadId, turnId: "feedback-turn", runId: run.id,
    role: "assistant" as const, content: "", status: "running" as const, createdAt: now }];
  return <NormalConversationFeed messages={messages} visibleMessages={messages} runById={new Map([[run.id, run]])}
    composerGateApprovals={[]} generatedMedia={[]} workspaceCwd={cwd} searchActive={false} editSaving={false}
    replacementRetryError="" onCancelMessageEdit={noop} onEditMessage={noop} onSaveMessage={noop}
    onRetryReplacement={noop} onOpenFiles={noop} onOpenReportFile={noop} onOpenReview={noop} />;
}

function channelMessage(run: RunSession): ChannelMessage {
  return { id: "feedback-assistant", workspaceId: "feedback-workspace", channelId: "feedback-channel", threadId: run.threadId,
    turnId: "feedback-turn", kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", authorId: "fixture-agent",
    body: "", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], linkedRunId: run.id,
    status: "pending", createdAt: now, updatedAt: now };
}

function ChannelFixture({ run, surface }: { readonly run: RunSession; readonly surface: "channel_root" | "branch" }): React.JSX.Element {
  const { t } = useI18n();
  const locatorRef = useRef<ConversationTimelineItemLocator | null>(null);
  const restoreBlockedUntilRef = useRef(0);
  const items: readonly ChannelMessageFeedItem[] = [{ id: "feedback-activity", kind: "activity", item: {
    id: "feedback-message", kind: "message", record: channelMessage(run), createdAt: now,
    category: "message", attention: "none", searchText: "",
  } }];
  const feed = useChannelMessageFeed({
    itemLocatorRef: locatorRef, items, conversationWorkCellByWorkflowId: new Map(), conversationWorkCellByThreadId: new Map(),
    canLoadOlder: false, loading: false, loadingOlder: false, protocolLoading: false, tailDependencyKey: run.id,
    latestVisibleItemId: "feedback-activity", renderableItemCount: items.length, restoreBlockedUntilRef, onLoadOlder: noop,
  });
  const renderer = createChannelMessageRenderers({
    runLifecycles: new Map([[run.id, run]]), allLocalTeammateById: new Map(), allLocalTeammateByName: new Map(),
    attachmentContentUrl: () => "", auditActivityVisible: false, generatedMedia: [], channelAttachmentById: new Map(),
    channelLinkPreviewById: new Map(), channelMessageFeedbackById: {}, channelConversationItems: [], channelUserInputs: [],
    channelReasoningSummaries: [], channelWorkflows: [], terminalReports: [], conversationWorkCellByThreadId: new Map(),
    conversationWorkCellByWorkflowId: new Map(), composerGateApprovals: [], cwd, workspaceId: "feedback-workspace",
    executionProposalsByMessageId: new Map(), formatBytes: String, latestStatus: "running", localUserDisplayName: "Operator",
    loadPreview: async () => { throw new Error("The feedback fixture has no preview resources."); }, memoryById: new Map(),
    selectedChannelBranchRootThreadId: surface === "branch" ? run.threadId : undefined, isDefaultChannelSession: false,
    selectedChannelId: "feedback-channel", selectedChannelThreadId: run.threadId!, teammateOptions: [], t,
    timelineItemLocatorRef: locatorRef, onTimelineLocateIntent: feed.onLocateIntent, timelineScrollRef: feed.scrollRef,
    timelineViewRetainKeys: feed.viewRetainKeys, onTimelineDisclosureIntent: feed.onDisclosureIntent, usedMemoryEvents: [],
    workflowProgressByWorkflowId: new Map(), workflowErrors: {}, orchestratingWorkflowId: "", runningWorkflowStepId: "",
    onAcceptProposedPlan: noop, onConvertProposedPlan: noop, onOpenExecutionProposal: noop, onOpenFileReference: noop,
    onOpenTerminalReportFile: noop, onOpenReview: noop, onOpenThreadForMessage: noop, onInvokeProtocolAction: noop,
    onRefineProposedPlan: noop, onSaveProposedPlan: noop, onToggleChannelMessageFeedback: noop, onBeginMessageEdit: noop,
    onCancelMessageEdit: noop, onSaveMessageEdit: noop, onRetryMessageReplacement: noop,
    planActionBusyId: "", proposedPlanArtifactsById: new Map(),
  });
  return <ChannelMessageFeed surfaceId={`feedback-${surface}`} state={feed} ariaLabel="Channel feedback messages"
    loading={false} empty={false} loadingLabel="Loading" emptyLabel="Empty" unifiedTimelineNode={renderer.renderUnifiedTimeline(items)} />;
}

function TopicFixture({ run }: { readonly run: RunSession }): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const root: ChannelMessage = { ...channelMessage(run), id: "quoted-parent", body: "Quoted parent message",
    threadId: "parent-thread", linkedRunId: "parent-run", status: "ready" };
  return <ThreadReplyPanel cwd={cwd} rootMessage={root} threadId={run.threadId} replies={[channelMessage(run)]}
    conversationItems={[]} userInputs={[]} reasoningSummaries={[]} runLifecycles={new Map([[run.id, run]])}
    teammates={[]} memoryById={new Map()} usedMemoryEvents={[]} draft={draft} pending={false} error=""
    onDraftChange={setDraft} onSend={noop} onClose={noop} onBeginMessageEdit={noop} onCancelMessageEdit={noop}
    onSaveMessageEdit={noop} onRetryMessageReplacement={noop} onOpenFileReference={noop} messageAuthorLabel={() => "Fixture agent"} />;
}

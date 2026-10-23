import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listChannelConversationItems } from "../../api.js";
import type {
  ChannelMention,
  ChannelConversationSurface,
  ChannelMessage,
  ChannelMessageFileRef,
  ChannelReplyDisposition,
  ConversationActiveReplyTarget,
  ConversationItemV1,
  RunSession,
  WorkUnit,
} from "../../types.js";
import { mergeChannelUserInputPage, projectChannelConversationItemPage, type ChannelConversationMessagePage } from "../../lib/channel-conversation-items.js";
import type { ConversationReasoningSummaryRecord, UserInputTranscriptItemV1 } from "@ling-stack/contracts";
import { deriveChannelReplyGuidanceTargets } from "./channel-guidance-targets.js";
import { findMentionsInText } from "./channelMentionText.js";
import { RecoveredConversationSubmissionError, UnconfirmedConversationSubmissionError } from "../../shared/conversation/conversation-submission-recovery.js";

export interface ChannelThreadReplySnapshot {
  readonly activeThreadId: string;
  readonly draft: string;
  readonly error: string;
}

interface ChannelThreadReplyControllerInput {
  readonly refreshToken?: number;
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly channelMessages: readonly ChannelMessage[];
  readonly channelRuns: readonly RunSession[];
  readonly workUnits: readonly WorkUnit[];
  readonly transientReplies?: readonly ConversationActiveReplyTarget[];
  readonly teammateOptions: readonly ChannelMention[];
  readonly onSendMessage: (input: {
    readonly threadId?: string;
    readonly body: string;
    readonly mentions: readonly ChannelMention[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly fileRefs: readonly ChannelMessageFileRef[];
    readonly requestAiReply: boolean;
    readonly replyDisposition?: ChannelReplyDisposition;
    readonly onMessageAccepted?: (message: ChannelMessage) => void;
  }) => Promise<{ readonly errorMessage?: string }>;
}

export interface ChannelThreadReplyController {
  readonly activeThreadRoot: ChannelMessage | undefined;
  /** Canonical LingThread id returned by the topic/thread items API. */
  readonly resolvedThreadId: string;
  readonly activeThreadMessages: readonly ChannelMessage[];
  readonly conversationItems: readonly ConversationItemV1[];
  readonly userInputs: readonly UserInputTranscriptItemV1[];
  readonly reasoningSummaries: readonly ConversationReasoningSummaryRecord[];
  readonly contextCompactions: readonly import("../../types.js").ConversationContextCompactionRecord[];
  readonly draft: string;
  readonly pending: boolean;
  readonly error: string;
  readonly snapshot: ChannelThreadReplySnapshot;
  readonly openThreadForMessage: (message: ChannelMessage) => void;
  readonly changeDraft: (value: string) => void;
  readonly sendReply: () => Promise<void>;
  readonly refreshThread: () => Promise<void>;
  readonly closeThread: () => void;
  readonly restoreSnapshot: (snapshot: ChannelThreadReplySnapshot) => void;
}

export function useChannelThreadReplyController({
  refreshToken = 0,
  cwd,
  selectedChannelId,
  channelMessages,
  channelRuns,
  workUnits,
  transientReplies,
  teammateOptions,
  onSendMessage,
}: ChannelThreadReplyControllerInput): ChannelThreadReplyController {
  // activeThreadId is the durable parent-item anchor saved in composer snapshots.
  // resolvedThreadId is the canonical Topic LingThread returned by the Items API.
  const [activeThreadId, setActiveThreadId] = useState("");
  const [resolvedThreadId, setResolvedThreadId] = useState("");
  const [topicMessages, setTopicMessages] = useState<readonly ChannelMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const loadVersionRef = useRef(0);
  const sendVersionRef = useRef(0);
  const topicPageRef = useRef<ChannelConversationMessagePage | undefined>(undefined);
  const [topicPage, setTopicPage] = useState<ChannelConversationMessagePage | undefined>(undefined);
  const topicOwner = JSON.stringify([cwd.trim(), selectedChannelId, activeThreadId]);
  const [topicPageOwner, setTopicPageOwner] = useState("");
  const topicOwnerRef = useRef(topicOwner);
  if (topicOwnerRef.current !== topicOwner) {
    topicOwnerRef.current = topicOwner;
    ++loadVersionRef.current;
    ++sendVersionRef.current;
    topicPageRef.current = undefined;
  }

  const activeThreadRoot = useMemo(
    () => channelMessages.find((message) => message.id === activeThreadId),
    [activeThreadId, channelMessages],
  );
  const activeThreadMessages = useMemo(() => {
    const contextualParentReplies = activeThreadRoot
      ? channelMessages.filter((message) =>
          message.id !== activeThreadRoot.id && (
            activeThreadRoot.turnId
              ? message.turnId === activeThreadRoot.turnId
              : message.threadId === activeThreadRoot.id
          )
        )
      : [];
    return [...new Map(
      [...contextualParentReplies, ...topicMessages]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((message) => [message.id, message]),
    ).values()];
  }, [activeThreadRoot, channelMessages, topicMessages]);
  const loadTopicMessages = useCallback(async (surface: ChannelConversationSurface): Promise<void> => {
    if (topicOwnerRef.current !== topicOwner) return;
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId || surface.kind === "channel_root") {
      setResolvedThreadId("");
      setTopicMessages([]);
      return;
    }
    const version = ++loadVersionRef.current;
    const requestedOwner = topicOwner;
    setLoading(true);
    setError("");
    try {
      const response = await listChannelConversationItems(workspaceCwd, selectedChannelId, {
        limit: 200,
        surface,
      });
      if (loadVersionRef.current !== version) return;
      if (response.channelId !== selectedChannelId || response.thread.channelId !== selectedChannelId
        || (surface.kind === "thread" && response.thread.id !== surface.threadId)
        || (surface.kind === "topic" && response.thread.anchorItemId !== surface.anchorItemId)) throw new Error("Topic response scope mismatch.");
      const page = projectChannelConversationItemPage(response);
      const hydrated = mergeChannelUserInputPage(topicPageRef.current, page);
      topicPageRef.current = hydrated;
      const visibleIds = new Set(page.conversationItems.map(item => item.id));
      setTopicPage({ ...hydrated, conversationItems: hydrated.conversationItems.filter(item => visibleIds.has(item.id)) });
      setTopicPageOwner(requestedOwner);
      setResolvedThreadId(response.thread.id);
      setTopicMessages(page.messages);
    } catch (loadError) {
      if (loadVersionRef.current !== version) return;
      setResolvedThreadId("");
      setTopicMessages([]);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (loadVersionRef.current === version) setLoading(false);
    }
  }, [cwd, selectedChannelId, topicOwner]);

  useEffect(() => {
    setPending(false);
    topicPageRef.current = undefined;
    setTopicPage(undefined);
  }, [topicOwner]);

  useEffect(() => {
    if (!activeThreadId) {
      ++loadVersionRef.current;
      setResolvedThreadId("");
      setTopicMessages([]);
      setLoading(false);
      return;
    }
    void loadTopicMessages({ kind: "topic", anchorItemId: activeThreadId });
    return () => { ++loadVersionRef.current; };
  }, [activeThreadId, loadTopicMessages, refreshToken]);

  const activeReplyTarget = useMemo(
    () => resolvedThreadId
      ? deriveChannelReplyGuidanceTargets({
          channelId: selectedChannelId,
          conversationLineThreadId: resolvedThreadId,
          channelMessages: activeThreadMessages,
          runs: channelRuns,
          workUnits,
          transientReplies,
          teammateLabel: (teammateId) => teammateId ?? "",
        })[0]?.activeReply
      : undefined,
    [activeThreadMessages, channelRuns, resolvedThreadId, selectedChannelId, transientReplies, workUnits],
  );

  const openThreadForMessage = useCallback((message: ChannelMessage): void => {
    ++sendVersionRef.current;
    setPending(false);
    setActiveThreadId(message.threadAnchorItemId ?? message.id);
    setError("");
  }, []);

  const changeDraft = useCallback((value: string): void => {
    setDraft(value);
    setError("");
  }, []);

  const closeThread = useCallback((): void => {
    ++loadVersionRef.current;
    ++sendVersionRef.current;
    setPending(false);
    setActiveThreadId("");
    setResolvedThreadId("");
    setTopicMessages([]);
    setLoading(false);
    setDraft("");
    setError("");
  }, []);

  const restoreSnapshot = useCallback((snapshot: ChannelThreadReplySnapshot): void => {
    ++loadVersionRef.current;
    ++sendVersionRef.current;
    setPending(false);
    setActiveThreadId(snapshot.activeThreadId);
    setResolvedThreadId("");
    setTopicMessages([]);
    setLoading(Boolean(snapshot.activeThreadId));
    setDraft(snapshot.draft);
    setError(snapshot.error);
  }, []);

  const sendReply = useCallback(async (): Promise<void> => {
    const body = draft.trim();
    if (!activeThreadId || !resolvedThreadId || !body || pending || loading) {
      return;
    }
    const mentions = findMentionsInText(body, teammateOptions);
    const shouldRequestAi = Boolean(activeReplyTarget) || mentions.some((mention) => mention.kind === "ai-teammate");
    const version = ++sendVersionRef.current;
    const isCurrent = (): boolean => sendVersionRef.current === version && topicOwnerRef.current === topicOwner;
    let accepted = false;
    setPending(true);
    setError("");
    try {
      const result = await onSendMessage({
        threadId: resolvedThreadId,
        body,
        mentions,
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
        requestAiReply: shouldRequestAi,
        onMessageAccepted: () => {
          accepted = true;
          if (isCurrent()) setDraft((current) => current === draft ? "" : current);
        },
        ...(activeReplyTarget
          ? {
              replyDisposition: {
                mode: "queue_followup",
                activeRunId: activeReplyTarget.runId,
              },
            }
          : {}),
      });
      if (!isCurrent()) return;
      if (result.errorMessage) {
        if (accepted) await loadTopicMessages({ kind: "thread", threadId: resolvedThreadId });
        if (isCurrent()) setError(result.errorMessage);
        return;
      }
      setDraft((current) => current === draft ? "" : current);
      await loadTopicMessages({ kind: "thread", threadId: resolvedThreadId });
    } catch (sendError) {
      if (!isCurrent()) return;
      if (sendError instanceof RecoveredConversationSubmissionError) {
        setDraft(current => current.trim() === sendError.originalBody.trim() ? "" : current);
        await loadTopicMessages({ kind: "thread", threadId: resolvedThreadId });
        return;
      }
      if (accepted) await loadTopicMessages({ kind: "thread", threadId: resolvedThreadId });
      if (isCurrent()) setError(sendError instanceof UnconfirmedConversationSubmissionError ? "Pending confirmation" : sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      if (isCurrent()) setPending(false);
    }
  }, [activeReplyTarget, activeThreadId, draft, loadTopicMessages, loading, onSendMessage, pending, resolvedThreadId, teammateOptions, topicOwner]);

  const refreshThread = useCallback(async (): Promise<void> => {
    if (resolvedThreadId) {
      await loadTopicMessages({ kind: "thread", threadId: resolvedThreadId });
      return;
    }
    if (activeThreadId) await loadTopicMessages({ kind: "topic", anchorItemId: activeThreadId });
  }, [activeThreadId, loadTopicMessages, resolvedThreadId]);

  const snapshot = useMemo<ChannelThreadReplySnapshot>(
    () => ({ activeThreadId, draft, error }),
    [activeThreadId, draft, error],
  );

  return {
    activeThreadRoot,
    resolvedThreadId,
    activeThreadMessages,
    conversationItems: topicPageOwner === topicOwner && topicPage?.threadId === resolvedThreadId ? topicPage.conversationItems : [],
    userInputs: topicPageOwner === topicOwner && topicPage?.threadId === resolvedThreadId ? topicPage.userInputs ?? [] : [],
    reasoningSummaries: topicPageOwner === topicOwner && topicPage?.threadId === resolvedThreadId ? topicPage.reasoningSummaries : [],
    contextCompactions: topicPageOwner === topicOwner && topicPage?.threadId === resolvedThreadId ? topicPage.contextCompactions ?? [] : [],
    draft,
    pending: pending || loading,
    error,
    snapshot,
    openThreadForMessage,
    changeDraft,
    sendReply,
    refreshThread,
    closeThread,
    restoreSnapshot,
  };
}

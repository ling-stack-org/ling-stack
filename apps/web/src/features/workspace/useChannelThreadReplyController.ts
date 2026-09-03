import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listChannelConversationItems } from "../../api.js";
import type {
  ChannelMention,
  ChannelConversationSurface,
  ChannelMessage,
  ChannelMessageFileRef,
  ChannelReplyDisposition,
  ConversationActiveReplyTarget,
  RunSession,
  WorkUnit,
} from "../../types.js";
import { projectChannelConversationItemPage } from "../../lib/channel-conversation-items.js";
import { deriveChannelReplyGuidanceTargets } from "./channel-guidance-targets.js";
import { findMentionsInText } from "./channelMentionText.js";

export interface ChannelThreadReplySnapshot {
  readonly activeThreadId: string;
  readonly draft: string;
  readonly error: string;
}

interface ChannelThreadReplyControllerInput {
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
  }) => Promise<{ readonly errorMessage?: string }>;
}

export interface ChannelThreadReplyController {
  readonly activeThreadRoot: ChannelMessage | undefined;
  /** Canonical LingThread id returned by the topic/thread items API. */
  readonly resolvedThreadId: string;
  readonly activeThreadMessages: readonly ChannelMessage[];
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
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd || !selectedChannelId || surface.kind === "channel_root") {
      setResolvedThreadId("");
      setTopicMessages([]);
      return;
    }
    const version = ++loadVersionRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await listChannelConversationItems(workspaceCwd, selectedChannelId, {
        limit: 200,
        surface,
      });
      if (loadVersionRef.current !== version) return;
      const page = projectChannelConversationItemPage(response);
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
  }, [cwd, selectedChannelId]);

  useEffect(() => {
    if (!activeThreadId) {
      ++loadVersionRef.current;
      setResolvedThreadId("");
      setTopicMessages([]);
      setLoading(false);
      return;
    }
    void loadTopicMessages({ kind: "topic", anchorItemId: activeThreadId });
  }, [activeThreadId, loadTopicMessages]);

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
    setActiveThreadId(message.threadAnchorItemId ?? message.id);
    setError("");
  }, []);

  const changeDraft = useCallback((value: string): void => {
    setDraft(value);
    setError("");
  }, []);

  const closeThread = useCallback((): void => {
    ++loadVersionRef.current;
    setActiveThreadId("");
    setResolvedThreadId("");
    setTopicMessages([]);
    setLoading(false);
    setDraft("");
    setError("");
  }, []);

  const restoreSnapshot = useCallback((snapshot: ChannelThreadReplySnapshot): void => {
    ++loadVersionRef.current;
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
        ...(activeReplyTarget
          ? {
              replyDisposition: {
                mode: "queue_followup",
                activeRunId: activeReplyTarget.runId,
              },
            }
          : {}),
      });
      if (result.errorMessage) {
        setError(result.errorMessage);
        return;
      }
      setDraft("");
      await loadTopicMessages({ kind: "thread", threadId: resolvedThreadId });
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setPending(false);
    }
  }, [activeReplyTarget, activeThreadId, draft, loadTopicMessages, loading, onSendMessage, pending, resolvedThreadId, teammateOptions]);

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

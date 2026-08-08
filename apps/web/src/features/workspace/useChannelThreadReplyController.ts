import { useCallback, useMemo, useState } from "react";
import type {
  ChannelMention,
  ChannelMessage,
  ChannelMessageFileRef,
  ChannelReplyDisposition,
  ConversationActiveReplyTarget,
  RunSession,
  WorkUnit,
} from "../../types.js";
import { deriveChannelReplyGuidanceTargets } from "./channel-guidance-targets.js";
import { findMentionsInText } from "./channelMentionText.js";

export interface ChannelThreadReplySnapshot {
  readonly activeThreadId: string;
  readonly draft: string;
  readonly error: string;
}

interface ChannelThreadReplyControllerInput {
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
  readonly activeThreadMessages: readonly ChannelMessage[];
  readonly draft: string;
  readonly pending: boolean;
  readonly error: string;
  readonly snapshot: ChannelThreadReplySnapshot;
  readonly openThreadForMessage: (message: ChannelMessage) => void;
  readonly changeDraft: (value: string) => void;
  readonly sendReply: () => Promise<void>;
  readonly closeThread: () => void;
  readonly restoreSnapshot: (snapshot: ChannelThreadReplySnapshot) => void;
}

export function useChannelThreadReplyController({
  selectedChannelId,
  channelMessages,
  channelRuns,
  workUnits,
  transientReplies,
  teammateOptions,
  onSendMessage,
}: ChannelThreadReplyControllerInput): ChannelThreadReplyController {
  const [activeThreadId, setActiveThreadId] = useState("");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const activeThreadRoot = useMemo(
    () => channelMessages.find((message) => message.id === activeThreadId),
    [activeThreadId, channelMessages],
  );
  const activeThreadMessages = useMemo(
    () => activeThreadId ? channelMessages.filter((message) => message.threadId === activeThreadId) : [],
    [activeThreadId, channelMessages],
  );
  const activeReplyTarget = useMemo(
    () => activeThreadId
      ? deriveChannelReplyGuidanceTargets({
          channelId: selectedChannelId,
          conversationLineThreadId: activeThreadId,
          channelMessages,
          runs: channelRuns,
          workUnits,
          transientReplies,
          teammateLabel: (teammateId) => teammateId ?? "",
        })[0]?.activeReply
      : undefined,
    [activeThreadId, channelMessages, channelRuns, selectedChannelId, transientReplies, workUnits],
  );

  const openThreadForMessage = useCallback((message: ChannelMessage): void => {
    setActiveThreadId(message.threadId ?? message.id);
    setError("");
  }, []);

  const changeDraft = useCallback((value: string): void => {
    setDraft(value);
    setError("");
  }, []);

  const closeThread = useCallback((): void => {
    setActiveThreadId("");
    setDraft("");
    setError("");
  }, []);

  const restoreSnapshot = useCallback((snapshot: ChannelThreadReplySnapshot): void => {
    setActiveThreadId(snapshot.activeThreadId);
    setDraft(snapshot.draft);
    setError(snapshot.error);
  }, []);

  const sendReply = useCallback(async (): Promise<void> => {
    const body = draft.trim();
    if (!activeThreadId || !body || pending) {
      return;
    }
    const mentions = findMentionsInText(body, teammateOptions);
    const shouldRequestAi = Boolean(activeReplyTarget) || mentions.some((mention) => mention.kind === "ai-teammate");
    setPending(true);
    setError("");
    try {
      const result = await onSendMessage({
        threadId: activeThreadId,
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
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setPending(false);
    }
  }, [activeReplyTarget, activeThreadId, draft, onSendMessage, pending, teammateOptions]);

  const snapshot = useMemo<ChannelThreadReplySnapshot>(
    () => ({ activeThreadId, draft, error }),
    [activeThreadId, draft, error],
  );

  return {
    activeThreadRoot,
    activeThreadMessages,
    draft,
    pending,
    error,
    snapshot,
    openThreadForMessage,
    changeDraft,
    sendReply,
    closeThread,
    restoreSnapshot,
  };
}

import { useCallback, useMemo, useState } from "react";
import type { ChannelMention, ChannelMessage, ChannelMessageFileRef } from "../../types.js";
import { findMentionsInText } from "./channelMentionText.js";

export interface ChannelThreadReplySnapshot {
  readonly activeThreadId: string;
  readonly draft: string;
  readonly error: string;
}

interface ChannelThreadReplyControllerInput {
  readonly channelMessages: readonly ChannelMessage[];
  readonly teammateOptions: readonly ChannelMention[];
  readonly onSendMessage: (input: {
    readonly threadId?: string;
    readonly body: string;
    readonly mentions: readonly ChannelMention[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly fileRefs: readonly ChannelMessageFileRef[];
    readonly requestAiReply: boolean;
  }) => Promise<void>;
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
  channelMessages,
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
    const shouldRequestAi = mentions.some((mention) => mention.kind === "ai-teammate");
    setPending(true);
    setError("");
    try {
      await onSendMessage({
        threadId: activeThreadId,
        body,
        mentions,
        attachmentIds: [],
        linkPreviewIds: [],
        fileRefs: [],
        requestAiReply: shouldRequestAi,
      });
      setDraft("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setPending(false);
    }
  }, [activeThreadId, draft, onSendMessage, pending, teammateOptions]);

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

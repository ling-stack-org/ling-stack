import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PendingAttachmentItem } from "../../shared/components/index.js";
import type { ChannelAttachment, ChannelMention } from "../../types.js";
import type { ActiveMentionPicker, ChannelComposerSendState } from "./ChannelComposer.js";
import type { PendingLinkPreviewItem } from "./useChannelComposerDraftController.js";
import type { ChannelThreadReplySnapshot } from "./useChannelThreadReplyController.js";

interface ChannelComposerSnapshotControllerInput {
  readonly selectedChannelId: string;
  readonly messageDraft: string;
  readonly setMessageDraft: Dispatch<SetStateAction<string>>;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly setPendingAttachments: Dispatch<SetStateAction<readonly PendingAttachmentItem<ChannelAttachment>[]>>;
  readonly pendingLinkPreviews: readonly PendingLinkPreviewItem[];
  readonly setPendingLinkPreviews: Dispatch<SetStateAction<readonly PendingLinkPreviewItem[]>>;
  readonly messageMentions: readonly ChannelMention[];
  readonly setMessageMentions: Dispatch<SetStateAction<readonly ChannelMention[]>>;
  readonly sendState: ChannelComposerSendState;
  readonly setSendState: Dispatch<SetStateAction<ChannelComposerSendState>>;
  readonly sendError: string;
  readonly setSendError: Dispatch<SetStateAction<string>>;
  readonly setMentionPicker: Dispatch<SetStateAction<ActiveMentionPicker | undefined>>;
  readonly setMentionActiveIndex: Dispatch<SetStateAction<number>>;
  readonly threadReplySnapshot: ChannelThreadReplySnapshot;
  readonly restoreThreadReplySnapshot: (snapshot: ChannelThreadReplySnapshot) => void;
  readonly autoPreviewUrlsRef: MutableRefObject<Set<string>>;
  readonly onChannelSwitch: () => void;
}

interface ChannelComposerSnapshot {
  readonly messageDraft: string;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly pendingLinkPreviews: readonly PendingLinkPreviewItem[];
  readonly messageMentions: readonly ChannelMention[];
  readonly sendState: ChannelComposerSendState;
  readonly sendError: string;
  readonly threadReply: ChannelThreadReplySnapshot;
}

export interface DetachedChannelSendSnapshot {
  readonly messageDraft: string;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly pendingLinkPreviews: readonly PendingLinkPreviewItem[];
  readonly messageMentions: readonly ChannelMention[];
}

export interface ChannelComposerSnapshotController {
  readonly rememberDetachedSendFailure: (
    channelId: string,
    snapshot: DetachedChannelSendSnapshot,
    errorMessage: string,
  ) => void;
  readonly rememberDetachedSendSuccess: (channelId: string) => void;
}

export function useChannelComposerSnapshotController({
  autoPreviewUrlsRef,
  messageDraft,
  messageMentions,
  onChannelSwitch,
  pendingAttachments,
  pendingLinkPreviews,
  restoreThreadReplySnapshot,
  selectedChannelId,
  sendError,
  sendState,
  setMentionActiveIndex,
  setMentionPicker,
  setMessageDraft,
  setMessageMentions,
  setPendingAttachments,
  setPendingLinkPreviews,
  setSendError,
  setSendState,
  threadReplySnapshot,
}: ChannelComposerSnapshotControllerInput): ChannelComposerSnapshotController {
  const previousChannelIdRef = useRef(selectedChannelId);
  const composerSnapshotsRef = useRef<Record<string, ChannelComposerSnapshot>>({});
  const onChannelSwitchRef = useRef(onChannelSwitch);
  const latestSnapshotRef = useRef<ChannelComposerSnapshot | undefined>();

  useEffect(() => {
    onChannelSwitchRef.current = onChannelSwitch;
  }, [onChannelSwitch]);

  const readCurrentComposerSnapshot = useCallback((): ChannelComposerSnapshot => ({
    messageDraft,
    pendingAttachments,
    pendingLinkPreviews,
    messageMentions,
    sendState,
    sendError,
    threadReply: threadReplySnapshot,
  }), [
    messageDraft,
    messageMentions,
    pendingAttachments,
    pendingLinkPreviews,
    sendError,
    sendState,
    threadReplySnapshot,
  ]);

  const emptyComposerSnapshot = useCallback((): ChannelComposerSnapshot => ({
    messageDraft: "",
    pendingAttachments: [],
    pendingLinkPreviews: [],
    messageMentions: [],
    sendState: "idle",
    sendError: "",
    threadReply: {
      activeThreadId: "",
      draft: "",
      error: "",
    },
  }), []);

  const rememberDetachedSendFailure = useCallback((
    channelId: string,
    snapshot: DetachedChannelSendSnapshot,
    errorMessage: string,
  ): void => {
    const current = composerSnapshotsRef.current[channelId] ?? emptyComposerSnapshot();
    composerSnapshotsRef.current[channelId] = {
      ...current,
      ...snapshot,
      sendState: "failed",
      sendError: errorMessage,
    };
  }, [emptyComposerSnapshot]);

  const rememberDetachedSendSuccess = useCallback((channelId: string): void => {
    const current = composerSnapshotsRef.current[channelId];
    if (!current) return;
    composerSnapshotsRef.current[channelId] = {
      ...current,
      sendState: "idle",
      sendError: "",
    };
  }, []);

  const applyComposerSnapshot = useCallback((snapshot: ChannelComposerSnapshot): void => {
    setMessageDraft(snapshot.messageDraft);
    setPendingAttachments(snapshot.pendingAttachments);
    setPendingLinkPreviews(snapshot.pendingLinkPreviews);
    setMessageMentions(snapshot.messageMentions);
    setSendState(snapshot.sendState);
    setSendError(snapshot.sendError);
    restoreThreadReplySnapshot(snapshot.threadReply);
    setMentionPicker(undefined);
    setMentionActiveIndex(0);
    autoPreviewUrlsRef.current = new Set(snapshot.pendingLinkPreviews.map((item) => item.url));
  }, [
    autoPreviewUrlsRef,
    restoreThreadReplySnapshot,
    setMentionActiveIndex,
    setMentionPicker,
    setMessageDraft,
    setMessageMentions,
    setPendingAttachments,
    setPendingLinkPreviews,
    setSendError,
    setSendState,
  ]);

  useEffect(() => {
    latestSnapshotRef.current = readCurrentComposerSnapshot();
  }, [readCurrentComposerSnapshot]);

  useEffect(() => {
    const previousChannelId = previousChannelIdRef.current;
    previousChannelIdRef.current = selectedChannelId;
    if (!previousChannelId || previousChannelId === selectedChannelId) {
      return;
    }
    composerSnapshotsRef.current[previousChannelId] = latestSnapshotRef.current ?? readCurrentComposerSnapshot();
    applyComposerSnapshot(
      selectedChannelId
        ? composerSnapshotsRef.current[selectedChannelId] ?? emptyComposerSnapshot()
        : emptyComposerSnapshot(),
    );
    onChannelSwitchRef.current();
  }, [applyComposerSnapshot, emptyComposerSnapshot, readCurrentComposerSnapshot, selectedChannelId]);

  return {
    rememberDetachedSendFailure,
    rememberDetachedSendSuccess,
  };
}

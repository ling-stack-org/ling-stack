import { useCallback, useLayoutEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PendingAttachmentItem } from "../../shared/components/index.js";
import type { ChannelAttachment, ChannelMention } from "../../types.js";
import type { ActiveMentionPicker, ChannelComposerSendState } from "./ChannelComposer.js";
import type { PendingLinkPreviewItem } from "./useChannelComposerDraftController.js";
import type { ChannelThreadReplySnapshot } from "./useChannelThreadReplyController.js";

interface ChannelComposerSnapshotControllerInput {
  readonly ownerKey: string;
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
  readonly beginSend: (ownerKey: string, sendId: string) => void;
  readonly isLatestSend: (ownerKey: string, sendId: string) => boolean;
  readonly settleDetachedSend: (
    ownerKey: string,
    sendId: string,
    outcome?: {
      readonly restore?: DetachedChannelSendSnapshot;
      readonly errorMessage?: string;
    },
  ) => boolean;
}

export function useChannelComposerSnapshotController({
  autoPreviewUrlsRef,
  messageDraft,
  messageMentions,
  onChannelSwitch,
  pendingAttachments,
  pendingLinkPreviews,
  restoreThreadReplySnapshot,
  ownerKey,
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
  const previousOwnerKeyRef = useRef(ownerKey);
  const composerSnapshotsRef = useRef<Record<string, ChannelComposerSnapshot>>({});
  const latestSendIdsRef = useRef(new Map<string, string>());
  const onChannelSwitchRef = useRef(onChannelSwitch);
  const latestSnapshotRef = useRef<ChannelComposerSnapshot | undefined>(undefined);

  useLayoutEffect(() => {
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
      loadError: "",
      sendError: "",
      error: "",
    },
  }), []);

  const beginSend = useCallback((ownerKey: string, sendId: string): void => {
    latestSendIdsRef.current.set(ownerKey, sendId);
  }, []);

  const isLatestSend = useCallback((ownerKey: string, sendId: string): boolean => (
    latestSendIdsRef.current.get(ownerKey) === sendId
  ), []);

  const settleDetachedSend = useCallback((sendOwnerKey: string, sendId: string, outcome?: {
    readonly restore?: DetachedChannelSendSnapshot;
    readonly errorMessage?: string;
  }): boolean => {
    if (!isLatestSend(sendOwnerKey, sendId)) return false;
    latestSendIdsRef.current.delete(sendOwnerKey);
    const visible = previousOwnerKeyRef.current === sendOwnerKey;
    const current = (visible ? latestSnapshotRef.current : composerSnapshotsRef.current[sendOwnerKey])
      ?? emptyComposerSnapshot();
    const restore = outcome?.restore;
    const settled: ChannelComposerSnapshot = {
      ...current,
      messageDraft: current.messageDraft.trim() ? current.messageDraft : restore?.messageDraft ?? current.messageDraft,
      messageMentions: current.messageMentions.length ? current.messageMentions : restore?.messageMentions ?? current.messageMentions,
      pendingAttachments: current.pendingAttachments.length ? current.pendingAttachments : restore?.pendingAttachments ?? current.pendingAttachments,
      pendingLinkPreviews: current.pendingLinkPreviews.length ? current.pendingLinkPreviews : restore?.pendingLinkPreviews ?? current.pendingLinkPreviews,
      sendState: outcome?.errorMessage ? "failed" : "idle",
      sendError: outcome?.errorMessage ?? "",
    };
    composerSnapshotsRef.current[sendOwnerKey] = settled;
    // A -> B -> A may reopen the same owner while its old request is still pending.
    if (visible) {
      latestSnapshotRef.current = settled;
      if (restore) {
        setMessageDraft(current => current.trim() ? current : restore.messageDraft);
        setMessageMentions(current => current.length ? current : restore.messageMentions);
        setPendingAttachments(current => current.length ? current : restore.pendingAttachments);
        setPendingLinkPreviews(current => current.length ? current : restore.pendingLinkPreviews);
      }
      setSendState(settled.sendState);
      setSendError(settled.sendError);
    }
    return visible;
  }, [emptyComposerSnapshot, isLatestSend, setMessageDraft, setMessageMentions,
    setPendingAttachments, setPendingLinkPreviews, setSendError, setSendState]);

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

  useLayoutEffect(() => {
    latestSnapshotRef.current = readCurrentComposerSnapshot();
  }, [readCurrentComposerSnapshot]);

  useLayoutEffect(() => {
    const previousOwnerKey = previousOwnerKeyRef.current;
    previousOwnerKeyRef.current = ownerKey;
    if (previousOwnerKey === ownerKey) {
      return;
    }
    composerSnapshotsRef.current[previousOwnerKey] = latestSnapshotRef.current ?? readCurrentComposerSnapshot();
    applyComposerSnapshot(
      composerSnapshotsRef.current[ownerKey] ?? emptyComposerSnapshot(),
    );
    onChannelSwitchRef.current();
  }, [applyComposerSnapshot, emptyComposerSnapshot, readCurrentComposerSnapshot, ownerKey]);

  return {
    beginSend,
    isLatestSend,
    settleDetachedSend,
  };
}

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import type {
  ActiveSlashCommandPicker,
  PendingAttachmentItem,
  TokenizedComposerInputHandle,
} from "../../shared/components/index.js";
import type { ChannelAttachment, ChannelLinkPreview, ChannelMention } from "../../types.js";
import { useLingToast } from "../../shared/ui/index.js";
import type {
  ActiveMentionPicker,
  ChannelComposerInlineFeedback,
  ChannelComposerInlineFeedbackTone,
  ChannelComposerSendState,
} from "./ChannelComposer.js";
import type { PendingChannelSendPreview } from "./ChannelMessageFeed.js";

export interface PendingLinkPreviewItem {
  readonly localId: string;
  readonly url: string;
  readonly state: "uploading" | "ready" | "blocked" | "failed";
  readonly preview?: ChannelLinkPreview;
  readonly error?: string;
}

export interface ChannelComposerDraftController {
  readonly messageDraft: string;
  readonly setMessageDraft: Dispatch<SetStateAction<string>>;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly setPendingAttachments: Dispatch<SetStateAction<readonly PendingAttachmentItem<ChannelAttachment>[]>>;
  readonly pendingLinkPreviews: readonly PendingLinkPreviewItem[];
  readonly setPendingLinkPreviews: Dispatch<SetStateAction<readonly PendingLinkPreviewItem[]>>;
  readonly messageMentions: readonly ChannelMention[];
  readonly setMessageMentions: Dispatch<SetStateAction<readonly ChannelMention[]>>;
  readonly mentionPicker: ActiveMentionPicker | undefined;
  readonly setMentionPicker: Dispatch<SetStateAction<ActiveMentionPicker | undefined>>;
  readonly mentionActiveIndex: number;
  readonly setMentionActiveIndex: Dispatch<SetStateAction<number>>;
  readonly slashPicker: ActiveSlashCommandPicker | undefined;
  readonly setSlashPicker: Dispatch<SetStateAction<ActiveSlashCommandPicker | undefined>>;
  readonly slashActiveIndex: number;
  readonly setSlashActiveIndex: Dispatch<SetStateAction<number>>;
  readonly composerDragActive: boolean;
  readonly setComposerDragActive: Dispatch<SetStateAction<boolean>>;
  readonly composerBusy: boolean;
  readonly setComposerBusy: Dispatch<SetStateAction<boolean>>;
  readonly sendState: ChannelComposerSendState;
  readonly setSendState: Dispatch<SetStateAction<ChannelComposerSendState>>;
  readonly sendError: string;
  readonly setSendError: Dispatch<SetStateAction<string>>;
  readonly composerFeedback: ChannelComposerInlineFeedback | undefined;
  readonly setComposerFeedback: Dispatch<SetStateAction<ChannelComposerInlineFeedback | undefined>>;
  readonly composerInputMinHeight: number;
  readonly pendingChannelSendPreview: PendingChannelSendPreview | undefined;
  readonly setPendingChannelSendPreview: Dispatch<SetStateAction<PendingChannelSendPreview | undefined>>;
  readonly composerInputRef: MutableRefObject<TokenizedComposerInputHandle | null>;
  readonly autoPreviewUrlsRef: MutableRefObject<Set<string>>;
  readonly attachmentPreviewUrlsRef: MutableRefObject<Set<string>>;
  readonly handleComposerResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleComposerResizePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly handleComposerResizePointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly showComposerFeedback: (tone: ChannelComposerInlineFeedbackTone, message: string) => void;
}

export function useChannelComposerDraftController(channelId: string): ChannelComposerDraftController {
  const { showToast } = useLingToast();
  const [messageDraft, setMessageDraftState] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingAttachmentItem<ChannelAttachment>[]>([]);
  const [pendingLinkPreviews, setPendingLinkPreviews] = useState<readonly PendingLinkPreviewItem[]>([]);
  const [messageMentions, setMessageMentions] = useState<readonly ChannelMention[]>([]);
  const [mentionPicker, setMentionPicker] = useState<ActiveMentionPicker | undefined>();
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [slashPicker, setSlashPicker] = useState<ActiveSlashCommandPicker | undefined>();
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [composerDragActive, setComposerDragActive] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [sendState, setSendState] = useState<ChannelComposerSendState>("idle");
  const [sendError, setSendError] = useState("");
  const [composerFeedback, setComposerFeedback] = useState<ChannelComposerInlineFeedback | undefined>();
  const [composerInputMinHeight, setComposerInputMinHeight] = useState(76);
  const [pendingChannelSendPreview, setPendingChannelSendPreview] = useState<PendingChannelSendPreview | undefined>();
  const composerInputRef = useRef<TokenizedComposerInputHandle | null>(null);
  const composerResizeDragRef = useRef<{ readonly pointerId: number; readonly startY: number; readonly startHeight: number } | undefined>();
  const autoPreviewUrlsRef = useRef(new Set<string>());
  const attachmentPreviewUrlsRef = useRef(new Set<string>());

  const setMessageDraft = useCallback<Dispatch<SetStateAction<string>>>((nextDraft) => {
    setComposerFeedback(undefined);
    setMessageDraftState(nextDraft);
  }, []);

  const showComposerFeedback = useCallback((tone: ChannelComposerInlineFeedbackTone, message: string): void => {
    if (tone === "error") {
      setComposerFeedback({ id: Date.now(), tone, message });
      return;
    }
    setComposerFeedback(undefined);
    showToast({ message, scope: `channel:${channelId || "unknown"}:composer`, tone });
  }, [channelId, showToast]);

  useEffect(() => {
    setComposerFeedback(undefined);
  }, [channelId]);

  const handleComposerResizePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    composerResizeDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: composerInputMinHeight,
    };
  }, [composerInputMinHeight]);

  const handleComposerResizePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = composerResizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const nextHeight = Math.max(76, Math.min(180, Math.round(drag.startHeight + drag.startY - event.clientY)));
    setComposerInputMinHeight(nextHeight);
  }, []);

  const handleComposerResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = composerResizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    composerResizeDragRef.current = undefined;
  }, []);

  useEffect(() => () => {
    for (const previewUrl of attachmentPreviewUrlsRef.current) {
      URL.revokeObjectURL(previewUrl);
    }
    attachmentPreviewUrlsRef.current.clear();
  }, []);

  return {
    messageDraft,
    setMessageDraft,
    pendingAttachments,
    setPendingAttachments,
    pendingLinkPreviews,
    setPendingLinkPreviews,
    messageMentions,
    setMessageMentions,
    mentionPicker,
    setMentionPicker,
    mentionActiveIndex,
    setMentionActiveIndex,
    slashPicker,
    setSlashPicker,
    slashActiveIndex,
    setSlashActiveIndex,
    composerDragActive,
    setComposerDragActive,
    composerBusy,
    setComposerBusy,
    sendState,
    setSendState,
    sendError,
    setSendError,
    composerFeedback,
    setComposerFeedback,
    composerInputMinHeight,
    pendingChannelSendPreview,
    setPendingChannelSendPreview,
    composerInputRef,
    autoPreviewUrlsRef,
    attachmentPreviewUrlsRef,
    handleComposerResizePointerDown,
    handleComposerResizePointerMove,
    handleComposerResizePointerEnd,
    showComposerFeedback,
  };
}

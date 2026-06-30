import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type {
  ActiveSlashCommandPicker,
  PendingAttachmentItem,
  TokenizedComposerInputHandle,
} from "../../shared/components/index.js";
import type { ChannelAttachment, ChannelLinkPreview, ChannelMention } from "../../types.js";
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
  readonly setComposerInputMinHeight: Dispatch<SetStateAction<number>>;
  readonly pendingChannelSendPreview: PendingChannelSendPreview | undefined;
  readonly setPendingChannelSendPreview: Dispatch<SetStateAction<PendingChannelSendPreview | undefined>>;
  readonly composerInputRef: MutableRefObject<TokenizedComposerInputHandle | null>;
  readonly composerResizeDragRef: MutableRefObject<{ readonly pointerId: number; readonly startY: number; readonly startHeight: number } | undefined>;
  readonly autoPreviewUrlsRef: MutableRefObject<Set<string>>;
  readonly attachmentPreviewUrlsRef: MutableRefObject<Set<string>>;
  readonly showComposerFeedback: (tone: ChannelComposerInlineFeedbackTone, message: string) => void;
}

export function useChannelComposerDraftController(): ChannelComposerDraftController {
  const [messageDraft, setMessageDraft] = useState("");
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
  const composerFeedbackTimeoutRef = useRef<number | undefined>();
  const autoPreviewUrlsRef = useRef(new Set<string>());
  const attachmentPreviewUrlsRef = useRef(new Set<string>());

  const showComposerFeedback = useCallback((tone: ChannelComposerInlineFeedbackTone, message: string): void => {
    if (composerFeedbackTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(composerFeedbackTimeoutRef.current);
    }
    setComposerFeedback({ id: Date.now(), tone, message });
    composerFeedbackTimeoutRef.current = globalThis.setTimeout(() => {
      setComposerFeedback(undefined);
      composerFeedbackTimeoutRef.current = undefined;
    }, 2_200);
  }, []);

  useEffect(() => () => {
    if (composerFeedbackTimeoutRef.current !== undefined) {
      globalThis.clearTimeout(composerFeedbackTimeoutRef.current);
    }
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
    setComposerInputMinHeight,
    pendingChannelSendPreview,
    setPendingChannelSendPreview,
    composerInputRef,
    composerResizeDragRef,
    autoPreviewUrlsRef,
    attachmentPreviewUrlsRef,
    showComposerFeedback,
  };
}

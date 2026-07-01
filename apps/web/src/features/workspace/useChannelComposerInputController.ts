import { useCallback, useEffect, useMemo, type ClipboardEvent, type DragEvent, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type SetStateAction } from "react";
import type { ComposerSlashCommandOption } from "@ling-stack/core/composer-slash-intents";
import {
  composerWorkspaceFileParts,
  createAttachmentPreviewUrl,
  createLocalComposerAssetId,
  filterSlashCommandPickerOptions,
  findActiveSlashCommand,
  insertSlashCommandToken,
  parseComposerInputParts,
  parseComposerSlashIntent,
  revokePendingAttachmentPreview,
  type ActiveSlashCommandPicker,
  type ComposerInputPart,
  type PendingAttachmentItem,
  type TokenizedComposerInputHandle,
} from "../../shared/components/index.js";
import type { Translate } from "../../i18n.js";
import type {
  ChannelAttachment,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessageFileRef,
  RunSession,
} from "../../types.js";
import type { ActiveMentionPicker, ChannelComposerSendState } from "./ChannelComposer.js";
import type { PendingLinkPreviewItem } from "./useChannelComposerDraftController.js";
import { findMentionsInText, mentionTokenExistsInText, mergeMentions } from "./channelMentionText.js";

interface ChannelComposerInputControllerInput {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly activeConversationRun: RunSession | undefined;
  readonly messageDraft: string;
  readonly setMessageDraft: Dispatch<SetStateAction<string>>;
  readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly setPendingAttachments: Dispatch<SetStateAction<readonly PendingAttachmentItem<ChannelAttachment>[]>>;
  readonly pendingLinkPreviews: readonly PendingLinkPreviewItem[];
  readonly setPendingLinkPreviews: Dispatch<SetStateAction<readonly PendingLinkPreviewItem[]>>;
  readonly setMessageMentions: Dispatch<SetStateAction<readonly ChannelMention[]>>;
  readonly mentionPicker: ActiveMentionPicker | undefined;
  readonly setMentionPicker: Dispatch<SetStateAction<ActiveMentionPicker | undefined>>;
  readonly mentionActiveIndex: number;
  readonly setMentionActiveIndex: Dispatch<SetStateAction<number>>;
  readonly slashPicker: ActiveSlashCommandPicker | undefined;
  readonly setSlashPicker: Dispatch<SetStateAction<ActiveSlashCommandPicker | undefined>>;
  readonly slashActiveIndex: number;
  readonly setSlashActiveIndex: Dispatch<SetStateAction<number>>;
  readonly setComposerDragActive: Dispatch<SetStateAction<boolean>>;
  readonly setComposerBusy: Dispatch<SetStateAction<boolean>>;
  readonly setSendState: Dispatch<SetStateAction<ChannelComposerSendState>>;
  readonly setSendError: Dispatch<SetStateAction<string>>;
  readonly composerInputRef: MutableRefObject<TokenizedComposerInputHandle | null>;
  readonly autoPreviewUrlsRef: MutableRefObject<Set<string>>;
  readonly attachmentPreviewUrlsRef: MutableRefObject<Set<string>>;
  readonly teammateOptions: readonly ChannelMention[];
  readonly slashCommands: readonly ComposerSlashCommandOption[];
  readonly onUploadAttachments: (files: readonly File[]) => Promise<readonly ChannelAttachment[]>;
  readonly onCreateLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly t: Translate;
}

interface ComposerKeyDownSubmissionActions {
  readonly submitChannelRunGuidanceFromDraft: () => Promise<boolean>;
  readonly sendMessage: () => Promise<void>;
}

export interface ChannelComposerInputController {
  readonly mentionPickerOptions: readonly ChannelMention[];
  readonly slashCommandPickerOptions: readonly ComposerSlashCommandOption[];
  readonly readyAttachmentIds: readonly string[];
  readonly readyLinkPreviewIds: readonly string[];
  readonly composerInputParts: readonly ComposerInputPart[];
  readonly composerFileRefs: readonly ChannelMessageFileRef[];
  readonly composerSlashIntent: ComposerSlashIntentForInput;
  readonly composerSlashCommandActive: boolean;
  readonly composerSlashTargetLabel: string;
  readonly composerHasSendableContent: boolean;
  readonly assetOperationPending: boolean;
  readonly pendingMessageAssetsVisible: boolean;
  readonly focusComposerAt: (caret: number) => void;
  readonly updateMentionPicker: (value: string, caret: number) => void;
  readonly commitMention: (option: ChannelMention) => void;
  readonly commitSlashCommand: (option: ComposerSlashCommandOption) => void;
  readonly insertMentionTrigger: () => void;
  readonly handleComposerTextChange: (value: string, caret: number) => void;
  readonly handleComposerKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, actions: ComposerKeyDownSubmissionActions) => void;
  readonly handleComposerPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly handleComposerDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly handleComposerDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly handleComposerDrop: (event: DragEvent<HTMLElement>) => void;
  readonly attachFiles: (files: FileList | readonly File[]) => Promise<void>;
  readonly removePendingAttachment: (localId: string) => void;
}

type ComposerSlashIntentForInput = ReturnType<typeof parseComposerSlashIntent>;

export function useChannelComposerInputController({
  activeConversationRun,
  attachmentPreviewUrlsRef,
  autoPreviewUrlsRef,
  composerInputRef,
  cwd,
  mentionActiveIndex,
  mentionPicker,
  messageDraft,
  onCreateLinkPreview,
  onUploadAttachments,
  pendingAttachments,
  pendingLinkPreviews,
  selectedChannelId,
  setComposerBusy,
  setComposerDragActive,
  setMentionActiveIndex,
  setMentionPicker,
  setMessageDraft,
  setMessageMentions,
  setPendingAttachments,
  setPendingLinkPreviews,
  setSendError,
  setSendState,
  setSlashActiveIndex,
  setSlashPicker,
  slashActiveIndex,
  slashCommands,
  slashPicker,
  t,
  teammateOptions,
}: ChannelComposerInputControllerInput): ChannelComposerInputController {
  const updateMentionPicker = useCallback((value: string, caret: number): void => {
    const activeMention = findActiveMention(value, caret);
    setMentionPicker(activeMention);
    setMentionActiveIndex(0);
    setSlashPicker(activeMention ? undefined : findActiveSlashCommand(value, caret));
    setSlashActiveIndex(0);
  }, [setMentionActiveIndex, setMentionPicker, setSlashActiveIndex, setSlashPicker]);

  const focusComposerAt = useCallback((caret: number): void => {
    const focus = (): void => {
      composerInputRef.current?.focusAt(caret);
    };
    focus();
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(focus);
      return;
    }
    globalThis.setTimeout(focus, 0);
  }, [composerInputRef]);

  const mentionPickerOptions = useMemo(
    () => {
      if (!mentionPicker) {
        return [];
      }
      const query = mentionPicker.query.trim().toLowerCase();
      return teammateOptions
        .filter((option) => {
          if (!query) {
            return true;
          }
          return option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query);
        })
        .slice(0, 6);
    },
    [mentionPicker, teammateOptions],
  );
  const slashCommandPickerOptions = useMemo(
    () => filterSlashCommandPickerOptions(slashCommands, slashPicker),
    [slashCommands, slashPicker],
  );

  const commitMention = useCallback((option: ChannelMention): void => {
    const composer = composerInputRef.current;
    const liveValue = messageDraft;
    const liveCaret = Math.min(composer?.readSelectionStart() ?? liveValue.length, liveValue.length);
    const livePicker = findActiveMention(liveValue, liveCaret);
    const endOfDraftPicker = findActiveMention(liveValue, liveValue.length);
    const picker = chooseMostSpecificMentionPicker([mentionPicker, livePicker, endOfDraftPicker]);
    const inserted = insertMentionToken(liveValue, picker, option.label);
    setMessageDraft(inserted.value);
    setSendState("idle");
    setSendError("");
    setMessageMentions((current) => current.some((mention) => mention.id === option.id) ? current : [...current, option]);
    setMentionPicker(undefined);
    setMentionActiveIndex(0);
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }, [
    composerInputRef,
    focusComposerAt,
    mentionPicker,
    messageDraft,
    setMentionActiveIndex,
    setMentionPicker,
    setMessageDraft,
    setMessageMentions,
    setSendError,
    setSendState,
    setSlashActiveIndex,
    setSlashPicker,
  ]);

  const commitSlashCommand = useCallback((option: ComposerSlashCommandOption): void => {
    const composer = composerInputRef.current;
    const liveValue = messageDraft;
    const liveCaret = Math.min(composer?.readSelectionStart() ?? liveValue.length, liveValue.length);
    const picker = slashPicker ?? findActiveSlashCommand(liveValue, liveCaret) ?? findActiveSlashCommand(liveValue, liveValue.length);
    const inserted = insertSlashCommandToken(liveValue, picker, option.id);
    setMessageDraft(inserted.value);
    setSendState("idle");
    setSendError("");
    setSlashPicker(undefined);
    setSlashActiveIndex(0);
    focusComposerAt(inserted.caret);
  }, [
    composerInputRef,
    focusComposerAt,
    messageDraft,
    setMessageDraft,
    setSendError,
    setSendState,
    setSlashActiveIndex,
    setSlashPicker,
    slashPicker,
  ]);

  const insertMentionTrigger = useCallback((): void => {
    const composer = composerInputRef.current;
    const start = composer?.readSelectionStart() ?? messageDraft.length;
    const end = composer?.readSelectionEnd() ?? start;
    const before = messageDraft.slice(0, start);
    const after = messageDraft.slice(end);
    const insert = before.endsWith("@") ? "" : before.length === 0 || /\s$/.test(before) ? "@" : " @";
    const nextDraft = `${before}${insert}${after}`;
    const nextCursor = before.length + insert.length;
    setMessageDraft(nextDraft);
    updateMentionPicker(nextDraft, nextCursor);
    globalThis.requestAnimationFrame(() => {
      composerInputRef.current?.focusAt(nextCursor);
    });
  }, [composerInputRef, messageDraft, setMessageDraft, updateMentionPicker]);

  const handleComposerTextChange = useCallback((value: string, caret: number): void => {
    setMessageDraft(value);
    setMessageMentions((current) => mergeMentions(
      current.filter((mention) => mentionTokenExistsInText(value, mention)),
      findMentionsInText(value, teammateOptions),
    ));
    setSendState("idle");
    setSendError("");
    updateMentionPicker(value, caret);
  }, [setMessageDraft, setMessageMentions, setSendError, setSendState, teammateOptions, updateMentionPicker]);

  const attachFiles = useCallback(async (files: FileList | readonly File[]): Promise<void> => {
    const selectedFiles = Array.from(files).slice(0, 10);
    if (selectedFiles.length === 0) {
      return;
    }
    const uploadItems = selectedFiles.map((file) => {
      const previewUrl = createAttachmentPreviewUrl(file);
      if (previewUrl) {
        attachmentPreviewUrlsRef.current.add(previewUrl);
      }
      return {
        localId: createLocalComposerAssetId("attachment"),
        fileName: file.name,
        sizeBytes: file.size,
        state: "uploading" as const,
        previewUrl,
      };
    });
    setPendingAttachments((current) => [...current, ...uploadItems]);
    setComposerBusy(true);
    try {
      const uploaded = await onUploadAttachments(selectedFiles);
      const uploadedByLocalId = new Map(uploadItems.map((item, index) => [item.localId, uploaded[index]]));
      setPendingAttachments((current) => current.map((item) => {
        const attachment = uploadedByLocalId.get(item.localId);
        if (attachment) {
          return { ...item, state: "ready", attachment };
        }
        if (uploadedByLocalId.has(item.localId)) {
          return { ...item, state: "failed", error: t("Upload failed") };
        }
        return item;
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingAttachments((current) => current.map((item) =>
        uploadItems.some((upload) => upload.localId === item.localId)
          ? { ...item, state: "failed", error: message }
          : item,
      ));
    } finally {
      setComposerBusy(false);
    }
  }, [attachmentPreviewUrlsRef, onUploadAttachments, setComposerBusy, setPendingAttachments, t]);

  const handleComposerPaste = useCallback((event: ClipboardEvent<HTMLDivElement>): void => {
    if (event.clipboardData.files.length === 0) {
      return;
    }
    event.preventDefault();
    void attachFiles(event.clipboardData.files);
  }, [attachFiles]);

  const handleComposerDragOver = useCallback((event: DragEvent<HTMLElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setComposerDragActive(true);
  }, [setComposerDragActive]);

  const handleComposerDragLeave = useCallback((event: DragEvent<HTMLElement>): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setComposerDragActive(false);
  }, [setComposerDragActive]);

  const handleComposerDrop = useCallback((event: DragEvent<HTMLElement>): void => {
    if (event.dataTransfer.files.length === 0) {
      setComposerDragActive(false);
      return;
    }
    event.preventDefault();
    setComposerDragActive(false);
    void attachFiles(event.dataTransfer.files);
  }, [attachFiles, setComposerDragActive]);

  const addLinkPreview = useCallback(async (rawUrl: string): Promise<void> => {
    const url = rawUrl.trim();
    if (!url) {
      return;
    }
    const localId = createLocalComposerAssetId("link");
    setPendingLinkPreviews((current) => [
      ...current.filter((item) => item.url !== url && item.preview?.normalizedUrl !== url && item.preview?.url !== url),
      { localId, url, state: "uploading" },
    ]);
    setComposerBusy(true);
    try {
      const preview = await onCreateLinkPreview(url);
      if (preview) {
        setPendingLinkPreviews((current) => current.map((item) => item.localId === localId
          ? {
              ...item,
              state: preview.status === "ready" ? "ready" : preview.status === "blocked" ? "blocked" : "failed",
              preview,
              error: preview.errorMessage,
            }
          : item));
      } else {
        setPendingLinkPreviews((current) => current.map((item) => item.localId === localId
          ? { ...item, state: "failed", error: t("Preview failed") }
          : item));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingLinkPreviews((current) => current.map((item) => item.localId === localId
        ? { ...item, state: "failed", error: message }
        : item));
    } finally {
      setComposerBusy(false);
    }
  }, [onCreateLinkPreview, setComposerBusy, setPendingLinkPreviews, t]);

  const removePendingAttachment = useCallback((localId: string): void => {
    setPendingAttachments((current) => {
      const removed = current.find((item) => item.localId === localId);
      revokePendingAttachmentPreview(removed, (previewUrl) => attachmentPreviewUrlsRef.current.delete(previewUrl));
      return current.filter((item) => item.localId !== localId);
    });
  }, [attachmentPreviewUrlsRef, setPendingAttachments]);

  useEffect(() => {
    if (!selectedChannelId) {
      return undefined;
    }
    const knownPreviewUrls = new Set(
      pendingLinkPreviews.flatMap((item) => [
        item.url,
        item.preview?.url,
        item.preview?.normalizedUrl,
      ]).filter((item): item is string => Boolean(item)),
    );
    const nextUrl = extractUrls(messageDraft).find((url) => !knownPreviewUrls.has(url) && !autoPreviewUrlsRef.current.has(url));
    if (!nextUrl) {
      return undefined;
    }
    const timeoutId = globalThis.setTimeout(() => {
      autoPreviewUrlsRef.current.add(nextUrl);
      void addLinkPreview(nextUrl);
    }, 450);
    return () => globalThis.clearTimeout(timeoutId);
  }, [addLinkPreview, autoPreviewUrlsRef, messageDraft, pendingLinkPreviews, selectedChannelId]);

  const readyAttachmentIds = useMemo(
    () => pendingAttachments.flatMap((item) => item.attachment ? [item.attachment.id] : []),
    [pendingAttachments],
  );
  const readyLinkPreviewIds = useMemo(
    () => pendingLinkPreviews.flatMap((item) => item.preview ? [item.preview.id] : []),
    [pendingLinkPreviews],
  );
  const composerInputParts = useMemo(
    () => parseComposerInputParts(messageDraft, {
      cwd,
      attachments: readyAttachmentIds.map((attachmentId) => ({ attachmentId })),
      teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
      slashCommands,
      linkPreviews: pendingLinkPreviews.map((item) => ({
        url: item.url,
        normalizedUrl: item.preview?.normalizedUrl,
        title: item.preview?.title,
        state: item.state,
        error: item.error ?? item.preview?.errorMessage,
      })),
    }),
    [cwd, messageDraft, pendingLinkPreviews, readyAttachmentIds, slashCommands, teammateOptions],
  );
  const composerFileRefs = useMemo(
    () => composerWorkspaceFileParts(composerInputParts).map((part): ChannelMessageFileRef => ({
      path: part.path,
      label: part.path,
      source: "composer",
      ...(part.line !== undefined ? { line: part.line } : {}),
    })),
    [composerInputParts],
  );
  const composerSlashIntent = useMemo(
    () => activeConversationRun
      ? { kind: "none" as const }
      : parseComposerSlashIntent(messageDraft.trim(), {
        teammateMentions: teammateOptions.map((teammate) => ({ id: teammate.id, label: teammate.label })),
        commands: slashCommands,
      }),
    [activeConversationRun, messageDraft, slashCommands, teammateOptions],
  );
  const composerSlashCommandActive = composerSlashIntent.kind !== "none";
  const composerSlashTargetLabel = composerSlashCommandActive ? composerSlashCommandTargetLabel(composerSlashIntent, t) : "";
  const composerHasSendableContent = messageDraft.trim().length > 0 || readyAttachmentIds.length > 0 || readyLinkPreviewIds.length > 0 || composerFileRefs.length > 0;
  const assetOperationPending = pendingAttachments.some((item) => item.state === "uploading") || pendingLinkPreviews.some((item) => item.state === "uploading");
  const pendingMessageAssetsVisible = pendingAttachments.length > 0;

  const handleComposerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>, actions: ComposerKeyDownSubmissionActions): void => {
    if (mentionPicker && mentionPickerOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current + 1) % mentionPickerOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionActiveIndex((current) => (current - 1 + mentionPickerOptions.length) % mentionPickerOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        commitMention(mentionPickerOptions[Math.min(mentionActiveIndex, mentionPickerOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionPicker(undefined);
        setMentionActiveIndex(0);
      }
      return;
    }
    if (slashPicker && slashCommandPickerOptions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current + 1) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((current) => (current - 1 + slashCommandPickerOptions.length) % slashCommandPickerOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        commitSlashCommand(slashCommandPickerOptions[Math.min(slashActiveIndex, slashCommandPickerOptions.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashPicker(undefined);
        setSlashActiveIndex(0);
      }
      return;
    }
    if (!mentionPicker && !slashPicker) {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (activeConversationRun) {
          if (composerHasSendableContent) {
            void actions.submitChannelRunGuidanceFromDraft();
          }
          return;
        }
        void actions.sendMessage();
        return;
      }
      if (event.key === "Escape") {
        setMentionPicker(undefined);
        setSlashPicker(undefined);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMentionPicker(undefined);
      setMentionActiveIndex(0);
      setSlashPicker(undefined);
      setSlashActiveIndex(0);
    }
  }, [
    activeConversationRun,
    commitMention,
    commitSlashCommand,
    composerHasSendableContent,
    mentionActiveIndex,
    mentionPicker,
    mentionPickerOptions,
    setMentionActiveIndex,
    setMentionPicker,
    setSlashActiveIndex,
    setSlashPicker,
    slashActiveIndex,
    slashCommandPickerOptions,
    slashPicker,
  ]);

  return {
    mentionPickerOptions,
    slashCommandPickerOptions,
    readyAttachmentIds,
    readyLinkPreviewIds,
    composerInputParts,
    composerFileRefs,
    composerSlashIntent,
    composerSlashCommandActive,
    composerSlashTargetLabel,
    composerHasSendableContent,
    assetOperationPending,
    pendingMessageAssetsVisible,
    focusComposerAt,
    updateMentionPicker,
    commitMention,
    commitSlashCommand,
    insertMentionTrigger,
    handleComposerTextChange,
    handleComposerKeyDown,
    handleComposerPaste,
    handleComposerDragOver,
    handleComposerDragLeave,
    handleComposerDrop,
    attachFiles,
    removePendingAttachment,
  };
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s)]+/g) ?? [];
  return [...new Set(matches.map((item) => item.replace(/[.,;!?]+$/, "")))];
}

function findActiveMention(value: string, caret: number): ActiveMentionPicker | undefined {
  const beforeCaret = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(beforeCaret);
  if (!match) {
    return undefined;
  }
  const query = match[2] ?? "";
  return {
    query,
    start: caret - query.length - 1,
    end: caret,
  };
}

function insertMentionToken(value: string, picker: ActiveMentionPicker | undefined, label: string): { readonly value: string; readonly caret: number } {
  const start = Math.max(0, Math.min(picker?.start ?? value.length, value.length));
  const end = Math.max(start, Math.min(picker?.end ?? value.length, value.length));
  const prefix = value.slice(0, start);
  const suffix = value.slice(end).replace(/^\s+/, "");
  const mention = `@${label}`;
  return {
    value: `${prefix}${mention}${suffix ? ` ${suffix}` : " "}`,
    caret: prefix.length + mention.length + 1,
  };
}

function composerSlashCommandTargetLabel(intent: Exclude<ComposerSlashIntentForInput, { readonly kind: "none" }>, t: Translate): string {
  if (intent.kind === "session_command") {
    return t("Session");
  }
  if (intent.kind === "multi_agent_command") {
    return intent.teammates.map((teammate) => `@${teammate.label}`).join(" ");
  }
  if (intent.kind === "agent_command") {
    return `@${intent.teammateLabel}`;
  }
  return t("Channel");
}

function chooseMostSpecificMentionPicker(candidates: readonly (ActiveMentionPicker | undefined)[]): ActiveMentionPicker | undefined {
  return candidates
    .filter((candidate): candidate is ActiveMentionPicker => Boolean(candidate))
    .sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
}

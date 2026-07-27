import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deleteAttachment, uploadConversationAttachment } from "../../api.js";
import {
  createAttachmentPreviewUrl,
  createLocalComposerAssetId,
  revokeObjectUrl,
  type PendingAttachmentItem,
} from "../../shared/components/index.js";
import type { ConversationAttachment } from "../../types.js";
import type { NormalConversationIdentitySnapshot } from "./useNormalConversationIdentityController.js";

type PendingConversationAttachment = PendingAttachmentItem<ConversationAttachment>;

export function useNormalConversationAttachmentController(input: {
  readonly composerBusy: boolean;
  readonly identity: string;
  readonly workspaceCwd: string;
  readonly captureIdentity: () => NormalConversationIdentitySnapshot;
  readonly isCurrentIdentity: (snapshot: NormalConversationIdentitySnapshot) => boolean;
  readonly report: (message: string) => void;
  readonly clear: () => void;
  readonly translate: (key: string) => string;
}): {
  readonly pendingAttachments: readonly PendingConversationAttachment[];
  readonly readyAttachmentIds: readonly string[];
  readonly attachFiles: (files: FileList | readonly File[]) => Promise<void>;
  readonly removeAttachment: (localId: string) => void;
  readonly consumeForSend: () => readonly PendingConversationAttachment[];
  readonly restoreForIdentity: (
    items: readonly PendingConversationAttachment[],
    identity: NormalConversationIdentitySnapshot,
  ) => boolean;
  readonly releasePreviews: (items: readonly PendingConversationAttachment[]) => void;
} {
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingConversationAttachment[]>([]);
  const pendingRef = useRef<readonly PendingConversationAttachment[]>([]);
  const releasedPreviewUrlsRef = useRef(new Set<string>());

  const replacePending = useCallback((items: readonly PendingConversationAttachment[]): void => {
    pendingRef.current = items;
    setPendingAttachments(items);
  }, []);

  const updatePending = useCallback((
    update: (current: readonly PendingConversationAttachment[]) => readonly PendingConversationAttachment[],
  ): void => {
    replacePending(update(pendingRef.current));
  }, [replacePending]);

  const releasePreviews = useCallback((items: readonly PendingConversationAttachment[]): void => {
    for (const item of items) {
      const previewUrl = item.previewUrl;
      if (!previewUrl || releasedPreviewUrlsRef.current.has(previewUrl)) continue;
      releasedPreviewUrlsRef.current.add(previewUrl);
      revokeObjectUrl(previewUrl);
    }
  }, []);

  const deleteAbandonedAttachments = useCallback((items: readonly PendingConversationAttachment[]): void => {
    const cwd = input.workspaceCwd.trim();
    if (!cwd) return;
    for (const item of items) {
      if (item.attachment && item.deleteOnRemove) {
        void deleteAttachment(cwd, item.attachment.id).catch(() => undefined);
      }
    }
  }, [input.workspaceCwd]);

  const previousIdentityRef = useRef(input.identity);
  useEffect(() => {
    if (previousIdentityRef.current === input.identity) return;
    previousIdentityRef.current = input.identity;
    const abandoned = pendingRef.current;
    replacePending([]);
    releasePreviews(abandoned);
    deleteAbandonedAttachments(abandoned);
  }, [deleteAbandonedAttachments, input.identity, releasePreviews, replacePending]);

  useEffect(() => () => {
    releasePreviews(pendingRef.current);
  }, [releasePreviews]);

  const attachFiles = useCallback(async (files: FileList | readonly File[]): Promise<void> => {
    const fileList = Array.from(files);
    if (fileList.length === 0 || input.composerBusy) return;
    const cwd = input.workspaceCwd.trim();
    if (!cwd) {
      input.report(input.translate("Local workspace is not ready."));
      return;
    }
    if (pendingRef.current.length + fileList.length > 10) {
      input.report(input.translate("A conversation message can attach at most 10 files."));
      return;
    }

    const operationIdentity = input.captureIdentity();
    input.clear();
    await Promise.all(fileList.map(async (file) => {
      const pendingItem: PendingConversationAttachment = {
        localId: createLocalComposerAssetId("conversation-attachment"),
        fileName: file.name,
        sizeBytes: file.size,
        state: "uploading",
        previewUrl: createAttachmentPreviewUrl(file),
      };
      updatePending((current) => [...current, pendingItem]);
      try {
        const response = await uploadConversationAttachment(cwd, file, operationIdentity.threadId);
        const operationStillOwnsItem = input.isCurrentIdentity(operationIdentity)
          && pendingRef.current.some((item) => item.localId === pendingItem.localId);
        if (!operationStillOwnsItem) {
          releasePreviews([pendingItem]);
          void deleteAttachment(cwd, response.attachment.id).catch(() => undefined);
          return;
        }
        updatePending((current) => current.map((item) => item.localId === pendingItem.localId
          ? { ...item, state: "ready", attachment: response.attachment, deleteOnRemove: true }
          : item));
      } catch (error) {
        if (!input.isCurrentIdentity(operationIdentity)) {
          releasePreviews([pendingItem]);
          return;
        }
        updatePending((current) => current.map((item) => item.localId === pendingItem.localId
          ? { ...item, state: "failed", error: error instanceof Error ? error.message : String(error) }
          : item));
      }
    }));
  }, [input, releasePreviews, updatePending]);

  const removeAttachment = useCallback((localId: string): void => {
    const item = pendingRef.current.find((candidate) => candidate.localId === localId);
    updatePending((current) => current.filter((candidate) => candidate.localId !== localId));
    if (!item) return;
    releasePreviews([item]);
    deleteAbandonedAttachments([item]);
  }, [deleteAbandonedAttachments, releasePreviews, updatePending]);

  const consumeForSend = useCallback((): readonly PendingConversationAttachment[] => {
    const snapshot = pendingRef.current;
    replacePending([]);
    return snapshot;
  }, [replacePending]);

  const restoreForIdentity = useCallback((
    items: readonly PendingConversationAttachment[],
    operationIdentity: NormalConversationIdentitySnapshot,
  ): boolean => {
    if (!input.isCurrentIdentity(operationIdentity)) {
      releasePreviews(items);
      return false;
    }
    replacePending(items);
    return true;
  }, [input, releasePreviews, replacePending]);

  const readyAttachmentIds = useMemo(() => pendingAttachments
    .flatMap((item) => item.state === "ready" && item.attachment ? [item.attachment.id] : []), [pendingAttachments]);

  return {
    pendingAttachments,
    readyAttachmentIds,
    attachFiles,
    removeAttachment,
    consumeForSend,
    restoreForIdentity,
    releasePreviews,
  };
}

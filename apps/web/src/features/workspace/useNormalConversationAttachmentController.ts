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

export interface PendingConversationAttachment extends PendingAttachmentItem<ConversationAttachment> {
  readonly ownerKey: string;
  readonly sourceCwd: string;
}

export function useNormalConversationAttachmentController(input: {
  readonly composerBusy: boolean;
  readonly ownerKey: string;
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
  readonly markSendBound: (items: readonly PendingConversationAttachment[]) => void;
  readonly restoreForIdentity: (
    items: readonly PendingConversationAttachment[],
    identity: NormalConversationIdentitySnapshot,
  ) => boolean;
  readonly abandonSend: (items: readonly PendingConversationAttachment[]) => void;
  readonly releasePreviews: (items: readonly PendingConversationAttachment[]) => void;
} {
  const [pendingAttachments, setPendingAttachments] = useState<readonly PendingConversationAttachment[]>([]);
  const pendingRef = useRef<readonly PendingConversationAttachment[]>([]);
  const releasedPreviewUrlsRef = useRef(new Set<string>());
  const deletedAttachmentKeysRef = useRef(new Set<string>());

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

  const deleteUploadedAttachments = useCallback((items: readonly PendingConversationAttachment[]): void => {
    for (const item of items) {
      if (!item.attachment || !item.deleteOnRemove || !item.sourceCwd) continue;
      const deletionKey = `${item.sourceCwd}\u0000${item.attachment.id}`;
      if (deletedAttachmentKeysRef.current.has(deletionKey)) continue;
      deletedAttachmentKeysRef.current.add(deletionKey);
      void deleteAttachment(item.sourceCwd, item.attachment.id).catch(() => {
        deletedAttachmentKeysRef.current.delete(deletionKey);
      });
    }
  }, []);

  const abandonSend = useCallback((items: readonly PendingConversationAttachment[]): void => {
    releasePreviews(items);
    deleteUploadedAttachments(items);
  }, [deleteUploadedAttachments, releasePreviews]);

  const previousOwnerKeyRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerKeyRef.current === input.ownerKey) return;
    previousOwnerKeyRef.current = input.ownerKey;
    const abandoned = pendingRef.current;
    replacePending([]);
    abandonSend(abandoned);
  }, [abandonSend, input.ownerKey, replacePending]);

  useEffect(() => () => {
    const abandoned = pendingRef.current;
    pendingRef.current = [];
    abandonSend(abandoned);
  }, [abandonSend]);

  const attachFiles = useCallback(async (files: FileList | readonly File[]): Promise<void> => {
    const fileList = Array.from(files);
    if (fileList.length === 0 || input.composerBusy) return;
    const operationIdentity = input.captureIdentity();
    const sourceCwd = operationIdentity.workspaceCwd;
    if (!sourceCwd) {
      input.report(input.translate("Local workspace is not ready."));
      return;
    }
    if (pendingRef.current.length + fileList.length > 10) {
      input.report(input.translate("A conversation message can attach at most 10 files."));
      return;
    }

    input.clear();
    await Promise.all(fileList.map(async (file) => {
      const pendingItem: PendingConversationAttachment = {
        localId: createLocalComposerAssetId("conversation-attachment"),
        ownerKey: input.ownerKey,
        sourceCwd,
        fileName: file.name,
        sizeBytes: file.size,
        state: "uploading",
        previewUrl: createAttachmentPreviewUrl(file),
      };
      updatePending((current) => [...current, pendingItem]);
      try {
        const response = await uploadConversationAttachment(sourceCwd, file, operationIdentity.threadId);
        const operationStillOwnsItem = input.isCurrentIdentity(operationIdentity)
          && pendingRef.current.some((item) => item.localId === pendingItem.localId && item.ownerKey === pendingItem.ownerKey);
        if (!operationStillOwnsItem) {
          updatePending((current) => current.filter((item) => item.localId !== pendingItem.localId));
          abandonSend([{ ...pendingItem, attachment: response.attachment, deleteOnRemove: true }]);
          return;
        }
        updatePending((current) => current.map((item) => item.localId === pendingItem.localId
          ? { ...item, state: "ready", attachment: response.attachment, deleteOnRemove: true }
          : item));
      } catch (error) {
        if (!input.isCurrentIdentity(operationIdentity)) {
          updatePending((current) => current.filter((item) => item.localId !== pendingItem.localId));
          releasePreviews([pendingItem]);
          return;
        }
        updatePending((current) => current.map((item) => item.localId === pendingItem.localId
          ? { ...item, state: "failed", error: error instanceof Error ? error.message : String(error) }
          : item));
      }
    }));
  }, [abandonSend, input, releasePreviews, updatePending]);

  const removeAttachment = useCallback((localId: string): void => {
    const item = pendingRef.current.find((candidate) => candidate.localId === localId);
    updatePending((current) => current.filter((candidate) => candidate.localId !== localId));
    if (item) abandonSend([item]);
  }, [abandonSend, updatePending]);

  const consumeForSend = useCallback((): readonly PendingConversationAttachment[] => {
    const snapshot = pendingRef.current;
    replacePending([]);
    return snapshot;
  }, [replacePending]);

  const markSendBound = useCallback((items: readonly PendingConversationAttachment[]): void => {
    releasePreviews(items);
  }, [releasePreviews]);

  const restoreForIdentity = useCallback((
    items: readonly PendingConversationAttachment[],
    operationIdentity: NormalConversationIdentitySnapshot,
  ): boolean => {
    if (!input.isCurrentIdentity(operationIdentity)) {
      abandonSend(items);
      return false;
    }
    replacePending(items);
    return true;
  }, [abandonSend, input, replacePending]);

  const readyAttachmentIds = useMemo(() => pendingAttachments
    .flatMap((item) => item.state === "ready" && item.attachment ? [item.attachment.id] : []), [pendingAttachments]);

  return {
    pendingAttachments,
    readyAttachmentIds,
    attachFiles,
    removeAttachment,
    consumeForSend,
    markSendBound,
    restoreForIdentity,
    abandonSend,
    releasePreviews,
  };
}

import { useEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import {
  createAttachmentPreviewUrl,
  createLocalComposerAssetId,
  revokeObjectUrl,
  type PendingAttachmentItem,
} from "../components/composer-pending-assets.js";
import { attachmentCleanupRecovery } from "./attachment-cleanup-recovery-store.js";

interface UploadScope<TAttachment> {
  readonly upload: (file: File) => Promise<TAttachment>;
  readonly remove: (attachment: TAttachment) => Promise<void>;
  readonly onUploaded?: (attachment: TAttachment) => void;
  readonly onCleanupError?: (error: unknown) => void;
}

type CleanupScope<TAttachment> = Pick<UploadScope<TAttachment>, "remove" | "onCleanupError">;

// Files and operation tokens belong only to the local draft, never to a receipt.
export function useComposerAttachmentUploads<TAttachment extends { readonly id: string }>(input: {
  readonly ownerKey: string;
  readonly sourceCwd?: string;
  readonly pending: readonly PendingAttachmentItem<TAttachment>[];
  readonly setPending: Dispatch<SetStateAction<readonly PendingAttachmentItem<TAttachment>[]>>;
  readonly captureScope: () => UploadScope<TAttachment>;
  readonly previewUrls?: Set<string>;
  readonly preserveDetachedDrafts?: boolean;
  readonly interruptedUploadError?: string;
}) {
  const pendingRef = useRef(input.pending);
  pendingRef.current = input.pending;
  const ownerRef = useRef({ key: input.ownerKey, generation: 0 });
  if (ownerRef.current.key !== input.ownerKey) {
    ownerRef.current = { key: input.ownerKey, generation: ownerRef.current.generation + 1 };
  }
  const mountedRef = useRef(true);
  const scopesRef = useRef(new Map<string, UploadScope<TAttachment>>());
  const detachedDraftItemsRef = useRef(new Map<string, PendingAttachmentItem<TAttachment>>());
  const activeUploadsRef = useRef(new Map<string, { readonly attemptId: string; readonly owner: typeof ownerRef.current }>());
  const releasedPreviewsRef = useRef(new Set<string>());
  const cleanupJobsRef = useRef(new Map<string, Promise<void>>());
  const cleanupFailures = useSyncExternalStore(attachmentCleanupRecovery.subscribe, attachmentCleanupRecovery.getSnapshot,
    attachmentCleanupRecovery.getSnapshot);

  function replace(items: readonly PendingAttachmentItem<TAttachment>[]) {
    pendingRef.current = items;
    trackDetachedDraft(items);
    input.setPending(items);
  }

  function trackDetachedDraft(items: readonly PendingAttachmentItem<TAttachment>[]) {
    if (!input.preserveDetachedDrafts) return;
    const localIds = new Set(items.map(item => item.localId));
    for (const item of items) detachedDraftItemsRef.current.set(item.localId, item);
    for (const [localId, item] of detachedDraftItemsRef.current) {
      if (item.uploadOwnerKey === ownerRef.current.key && !localIds.has(localId)) {
        detachedDraftItemsRef.current.delete(localId);
        scopesRef.current.delete(localId);
      }
    }
  }

  function release(item: Pick<PendingAttachmentItem<TAttachment>, "previewUrl">) {
    if (!item.previewUrl || releasedPreviewsRef.current.has(item.previewUrl)) return;
    if (pendingRef.current.some(current => current.previewUrl === item.previewUrl)) return;
    releasedPreviewsRef.current.add(item.previewUrl);
    revokeObjectUrl(item.previewUrl);
    input.previewUrls?.delete(item.previewUrl);
  }

  function cleanup(item: PendingAttachmentItem<TAttachment>, scope: CleanupScope<TAttachment>, releasePreview = true): Promise<void> {
    if (releasePreview) release(item);
    if (!item.attachment || !item.deleteOnRemove) return Promise.resolve();
    const cleanupId = `${item.localId}:${item.attachment.id}`;
    const existing = cleanupJobsRef.current.get(cleanupId);
    if (existing) return existing;
    const job = runCleanup(item, scope, cleanupId).finally(() => cleanupJobsRef.current.delete(cleanupId));
    cleanupJobsRef.current.set(cleanupId, job);
    return job;
  }

  async function runCleanup(item: PendingAttachmentItem<TAttachment>, scope: CleanupScope<TAttachment>, cleanupId: string) {
    attachmentCleanupRecovery.begin(cleanupId);
    try {
      await scope.remove(item.attachment!);
    } catch (error) {
      if (!(error instanceof Error && "status" in error && error.status === 404)) {
        const retryItem = { ...item, sourceFile: undefined, previewUrl: undefined };
        attachmentCleanupRecovery.fail({
          localId: cleanupId, fileName: item.fileName, ownerKey: item.uploadOwnerKey ?? input.ownerKey,
          error: error instanceof Error ? error.message : String(error), retrying: false,
        }, async () => {
          await cleanupJobsRef.current.get(cleanupId);
          await cleanup(retryItem, scope, false);
        });
        scope.onCleanupError?.(error);
        return;
      }
    }
    attachmentCleanupRecovery.settle(cleanupId);
  }

  async function uploadItem(item: PendingAttachmentItem<TAttachment>, scope: UploadScope<TAttachment>) {
    if (!item.sourceFile) return;
    const owner = ownerRef.current;
    const attemptId = createLocalComposerAssetId("attachment-upload");
    const uploading = { ...item, state: "uploading" as const, error: undefined, uploadAttemptId: attemptId };
    activeUploadsRef.current.set(item.localId, { attemptId, owner });
    scopesRef.current.set(item.localId, scope);
    replace(pendingRef.current.map(current => current.localId === item.localId ? uploading : current));
    const ownsItem = () => mountedRef.current && ownerRef.current === owner
      && pendingRef.current.some(current => current.localId === item.localId && current.uploadAttemptId === attemptId);
    try {
      const attachment = await scope.upload(item.sourceFile);
      if (!ownsItem()) {
        await cleanup({ ...uploading, attachment, deleteOnRemove: true }, scope,
          !input.preserveDetachedDrafts || !scopesRef.current.has(item.localId));
        return;
      }
      replace(pendingRef.current.map(current => current.localId === item.localId
        ? { ...current, state: "ready", attachment, deleteOnRemove: true }
        : current));
      scope.onUploaded?.(attachment);
    } catch (error) {
      if (!ownsItem()) return;
      replace(pendingRef.current.map(current => current.localId === item.localId
        ? { ...current, state: "failed", error: error instanceof Error ? error.message : String(error) }
        : current));
    } finally {
      if (activeUploadsRef.current.get(item.localId)?.attemptId === attemptId) activeUploadsRef.current.delete(item.localId);
    }
  }

  async function attachFiles(files: FileList | readonly File[]) {
    const selected = Array.from(files).slice(0, Math.max(0, 10 - pendingRef.current.length));
    if (!selected.length) return;
    const scope = input.captureScope();
    const items = selected.map(file => {
      const previewUrl = createAttachmentPreviewUrl(file);
      if (previewUrl) input.previewUrls?.add(previewUrl);
      return { localId: createLocalComposerAssetId("attachment"), fileName: file.name,
        sizeBytes: file.size, state: "uploading" as const, previewUrl,
        sourceFile: file, uploadOwnerKey: input.ownerKey, sourceCwd: input.sourceCwd };
    });
    replace([...pendingRef.current, ...items]);
    await Promise.all(items.map(item => uploadItem(item, scope)));
  }

  async function retryAttachment(localId: string) {
    const item = pendingRef.current.find(current => current.localId === localId);
    if (!item || item.state !== "failed" || !item.sourceFile
      || item.uploadOwnerKey !== input.ownerKey) return;
    const scope = scopesRef.current.get(localId) ?? input.captureScope();
    await uploadItem(item, scope);
  }

  async function removeAttachment(localId: string) {
    const item = pendingRef.current.find(current => current.localId === localId);
    if (!item) return;
    replace(pendingRef.current.filter(current => current.localId !== localId));
    release(item);
    const scope = scopesRef.current.get(localId) ?? (item.deleteOnRemove ? input.captureScope() : undefined);
    scopesRef.current.delete(localId);
    if (scope) await cleanup(item, scope);
  }

  function protectForSubmission(items: readonly PendingAttachmentItem<TAttachment>[]) {
    const protectedItems = items.map(item => ({ ...item, deleteOnRemove: false }));
    const protectedById = new Map(protectedItems.map(item => [item.localId, item]));
    replace(pendingRef.current.map(item => protectedById.get(item.localId) ?? item));
    return protectedItems;
  }

  useEffect(() => {
    if (input.preserveDetachedDrafts) return;
    const abandoned = pendingRef.current.filter(item => item.uploadOwnerKey && item.uploadOwnerKey !== input.ownerKey);
    if (!abandoned.length) return;
    replace(pendingRef.current.filter(item => !abandoned.includes(item)));
    for (const item of abandoned) {
      const scope = scopesRef.current.get(item.localId);
      scopesRef.current.delete(item.localId);
      release(item);
      if (scope) void cleanup(item, scope);
    }
  }, [input.ownerKey]);

  useEffect(() => {
    if (input.preserveDetachedDrafts) {
      trackDetachedDraft(input.pending);
      const interrupted = input.pending.filter(item => item.uploadOwnerKey === input.ownerKey && item.state === "uploading"
        && activeUploadsRef.current.get(item.localId)?.owner !== ownerRef.current);
      if (interrupted.length) replace(pendingRef.current.map(item => interrupted.includes(item)
        ? { ...item, state: "failed", error: input.interruptedUploadError }
        : item));
      return;
    }
    const localIds = new Set(input.pending.map(item => item.localId));
    for (const localId of scopesRef.current.keys()) {
      if (!localIds.has(localId)) scopesRef.current.delete(localId);
    }
  }, [input.pending, input.ownerKey]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const abandoned = Array.from(new Map([
        ...detachedDraftItemsRef.current,
        ...pendingRef.current.map(item => [item.localId, item] as const),
      ]).values());
      pendingRef.current = [];
      detachedDraftItemsRef.current.clear();
      for (const item of abandoned) {
        const scope = scopesRef.current.get(item.localId);
        release(item);
        if (scope) void cleanup(item, scope);
      }
      // Submitted files can be outside the draft while their receipt is pending.
      for (const previewUrl of input.previewUrls ?? []) release({ previewUrl });
      scopesRef.current.clear();
    };
  }, []);

  return { attachFiles, retryAttachment, removeAttachment, protectForSubmission,
    replacePending: replace,
    takePending: () => { const items = pendingRef.current; replace([]); return items; },
    releasePreviews: (items: readonly PendingAttachmentItem<TAttachment>[]) => { for (const item of items) release(item); },
    discardAttachment: cleanup,
    cleanupFailures: cleanupFailures.filter(failure => failure.ownerKey === input.ownerKey),
    retryCleanup: async (localId: string) => { await attachmentCleanupRecovery.retry(localId, input.ownerKey); },
  };
}

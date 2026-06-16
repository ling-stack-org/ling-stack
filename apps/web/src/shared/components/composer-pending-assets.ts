export type PendingAssetState = "uploading" | "ready" | "blocked" | "failed";

export interface PendingAttachmentItem<TAttachment> {
  readonly localId: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly state: PendingAssetState;
  readonly previewUrl?: string;
  readonly attachment?: TAttachment;
  readonly error?: string;
  readonly deleteOnRemove?: boolean;
}

export function createLocalComposerAssetId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

export function createAttachmentPreviewUrl(file: File): string | undefined {
  if (!isPreviewableImageFile(file)) {
    return undefined;
  }
  return globalThis.URL.createObjectURL(file);
}

export function revokeObjectUrl(previewUrl: string): void {
  globalThis.URL.revokeObjectURL(previewUrl);
}

export function revokePendingAttachmentPreview<TAttachment>(
  item: PendingAttachmentItem<TAttachment> | undefined,
  onRevoke?: (previewUrl: string) => void,
): void {
  if (item?.previewUrl) {
    revokeObjectUrl(item.previewUrl);
    onRevoke?.(item.previewUrl);
  }
}

export function revokePendingAttachmentPreviews<TAttachment>(
  items: readonly PendingAttachmentItem<TAttachment>[],
  onRevoke?: (previewUrl: string) => void,
): void {
  for (const item of items) {
    revokePendingAttachmentPreview(item, onRevoke);
  }
}

export function pendingAssetLabel(state: PendingAssetState): string {
  if (state === "uploading") {
    return "Uploading";
  }
  if (state === "blocked") {
    return "Blocked";
  }
  if (state === "failed") {
    return "Failed";
  }
  return "Ready";
}

export function pendingPreviewLabel(state: PendingAssetState): string {
  if (state === "uploading") {
    return "Fetching link preview...";
  }
  return pendingAssetLabel(state);
}

function isPreviewableImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(gif|jpe?g|png|webp)$/i.test(file.name);
}

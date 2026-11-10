import type { PendingAttachmentItem } from "../../shared/components/composer-pending-assets.js";
import type { ChannelAttachment } from "../../types.js";

/** Upload references survive reload; File and blob URL handles remain memory-only. */
export function restorableChannelAttachments(items: readonly PendingAttachmentItem<ChannelAttachment>[]): readonly PendingAttachmentItem<ChannelAttachment>[] {
  return items.map(({ sourceFile: _file, previewUrl: _preview, ...item }) => item.attachment
    ? item
    : { ...item, state: "failed", error: "Select this file again after reloading." });
}

export function channelDraftStorageKey(ownerKey: string): string { return `ling:channel-composer-draft:v1:${ownerKey}`; }

export function readChannelComposerDraft<T>(ownerKey: string): T | undefined {
  try {
    const raw = localStorage.getItem(channelDraftStorageKey(ownerKey));
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("messageDraft" in value) || typeof value.messageDraft !== "string") return undefined;
    return value as T;
  } catch { return undefined; }
}

export function writeChannelComposerDraft(ownerKey: string, snapshot: {
  readonly messageDraft: string; readonly pendingAttachments: readonly PendingAttachmentItem<ChannelAttachment>[];
  readonly sendState: string; readonly [key: string]: unknown;
}): void {
  try {
    localStorage.setItem(channelDraftStorageKey(ownerKey), JSON.stringify({ ...snapshot,
      pendingAttachments: restorableChannelAttachments(snapshot.pendingAttachments),
      // A restored browser cannot assume its previous HTTP request is still attached.
      sendState: snapshot.sendState === "sending" ? "idle" : snapshot.sendState,
    }));
  } catch { /* Quota/private-mode failures do not discard the in-memory draft. */ }
}

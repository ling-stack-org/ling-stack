import type { AttachmentCleanupFailure } from "../components/composer-pending-assets.js";

type OwnedCleanupFailure = AttachmentCleanupFailure & { readonly ownerKey: string };

// A draft can unmount before its DELETE settles. Retain the original cleanup,
// not a new upload or any execution authority, until its owner retries it.
const failures = new Map<string, { readonly failure: OwnedCleanupFailure; readonly retry: () => Promise<void> }>();
const listeners = new Set<() => void>();
let snapshot: readonly OwnedCleanupFailure[] = [];

function publish() {
  snapshot = [...failures.values()].map(item => item.failure);
  for (const listener of listeners) listener();
}

export const attachmentCleanupRecovery = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot: () => snapshot,
  begin: (localId: string) => {
    const item = failures.get(localId);
    if (!item || item.failure.retrying) return;
    failures.set(localId, { ...item, failure: { ...item.failure, retrying: true } });
    publish();
  },
  fail: (failure: OwnedCleanupFailure, retry: () => Promise<void>) => {
    failures.set(failure.localId, { failure, retry });
    publish();
  },
  settle: (localId: string) => {
    if (failures.delete(localId)) publish();
  },
  retry: async (localId: string, ownerKey: string) => {
    const item = failures.get(localId);
    if (!item || item.failure.ownerKey !== ownerKey || item.failure.retrying) return;
    attachmentCleanupRecovery.begin(localId);
    await item.retry();
  },
};

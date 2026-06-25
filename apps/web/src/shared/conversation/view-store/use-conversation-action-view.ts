import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { selectActionActive, selectActionCopied } from "./conversation-view-selectors.js";
import { useOptionalConversationViewStore } from "./conversation-view-provider.js";

export interface ConversationActionViewState {
  readonly active: boolean;
  readonly copied: boolean;
  readonly copyText: (text: string) => Promise<boolean>;
  readonly setActive: (active: boolean) => void;
}

export function useConversationActionView(input: {
  readonly actionId: string;
  readonly copiedDurationMs?: number;
}): ConversationActionViewState {
  const store = useOptionalConversationViewStore();
  const copiedDurationMs = input.copiedDurationMs ?? 1400;
  const clearTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const localCopiedAtRef = useRef<number | undefined>(undefined);
  const [localActive, setLocalActive] = useState(false);
  const [localCopiedAt, setLocalCopiedAt] = useState<number | undefined>();
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => undefined), [store]);
  const getActiveSnapshot = useCallback(
    () => store ? selectActionActive(store.getSnapshot(), input.actionId) : localActive,
    [input.actionId, localActive, store],
  );
  const getCopiedSnapshot = useCallback(
    () => store ? selectActionCopied(store.getSnapshot(), input.actionId) : localCopiedAt !== undefined,
    [input.actionId, localCopiedAt, store],
  );

  const active = useSyncExternalStore(
    subscribe,
    getActiveSnapshot,
    () => false,
  );
  const copied = useSyncExternalStore(
    subscribe,
    getCopiedSnapshot,
    () => false,
  );

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== undefined) {
        globalThis.clearTimeout(clearTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (store) {
      return;
    }
    setLocalActive(false);
    localCopiedAtRef.current = undefined;
    setLocalCopiedAt(undefined);
  }, [input.actionId, store]);

  const setActive = useCallback((nextActive: boolean) => {
    if (!store) {
      setLocalActive(nextActive);
      return;
    }
    if (nextActive) {
      store.setActiveActionId(input.actionId);
      return;
    }
    store.clearActiveActionId(input.actionId);
  }, [input.actionId, store]);

  const copyText = useCallback(async (text: string): Promise<boolean> => {
    if (!globalThis.navigator?.clipboard?.writeText) {
      if (store) {
        store.clearCopyFeedback(input.actionId);
      } else {
        localCopiedAtRef.current = undefined;
        setLocalCopiedAt(undefined);
      }
      return false;
    }

    try {
      await globalThis.navigator.clipboard.writeText(text);
      const copiedAt = store ? store.markCopied(input.actionId) : Date.now();
      if (!store) {
        localCopiedAtRef.current = copiedAt;
        setLocalCopiedAt(copiedAt);
      }
      if (clearTimerRef.current !== undefined) {
        globalThis.clearTimeout(clearTimerRef.current);
      }
      clearTimerRef.current = globalThis.setTimeout(() => {
        if (store) {
          store.clearCopyFeedback(input.actionId, copiedAt);
        } else if (localCopiedAtRef.current === copiedAt) {
          localCopiedAtRef.current = undefined;
          setLocalCopiedAt(undefined);
        }
        clearTimerRef.current = undefined;
      }, copiedDurationMs);
      return true;
    } catch {
      if (store) {
        store.clearCopyFeedback(input.actionId);
      } else {
        localCopiedAtRef.current = undefined;
        setLocalCopiedAt(undefined);
      }
      return false;
    }
  }, [copiedDurationMs, input.actionId, store]);

  return { active, copied, copyText, setActive };
}

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface ConversationHeaderControllerInput {
  readonly identityKey: string;
  readonly onRefresh?: () => void | Promise<void>;
  readonly onSearchChange: (value: string) => void;
}

export interface ConversationHeaderController {
  readonly refreshing: boolean;
  readonly searchInputRef: RefObject<HTMLInputElement>;
  readonly searchOpen: boolean;
  readonly searchTriggerRef: RefObject<HTMLButtonElement>;
  readonly clearSearch: () => void;
  readonly closeSearch: (restoreFocus?: boolean) => void;
  readonly refresh: () => Promise<void>;
  readonly toggleSearch: () => void;
}

export function useConversationHeaderController({
  identityKey,
  onRefresh,
  onSearchChange,
}: ConversationHeaderControllerInput): ConversationHeaderController {
  const [searchOpen, setSearchOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const refreshOwnerRef = useRef<{
    active?: { readonly generation: number; readonly identityRevision: number };
    generation: number;
    identityKey: string;
    identityRevision: number;
  }>({ generation: 0, identityKey, identityRevision: 1 });
  if (refreshOwnerRef.current.identityKey !== identityKey) {
    refreshOwnerRef.current = {
      generation: 0,
      identityKey,
      identityRevision: refreshOwnerRef.current.identityRevision + 1,
    };
  }

  useEffect(() => {
    setSearchOpen(false);
    onSearchChange("");
    if (!refreshOwnerRef.current.active) setRefreshing(false);
  }, [identityKey, onSearchChange]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const clearSearch = useCallback((): void => {
    onSearchChange("");
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [onSearchChange]);

  const closeSearch = useCallback((restoreFocus = false): void => {
    setSearchOpen(false);
    onSearchChange("");
    if (restoreFocus) requestAnimationFrame(() => searchTriggerRef.current?.focus());
  }, [onSearchChange]);

  const toggleSearch = useCallback((): void => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
  }, [closeSearch, searchOpen]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!onRefresh || refreshing) return;
    const owner = refreshOwnerRef.current;
    if (owner.identityKey !== identityKey) return;
    const request = {
      generation: owner.generation + 1,
      identityRevision: owner.identityRevision,
    };
    owner.generation = request.generation;
    owner.active = request;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      const current = refreshOwnerRef.current;
      if (
        current.identityKey === identityKey
        && current.identityRevision === request.identityRevision
        && current.active?.generation === request.generation
      ) {
        current.active = undefined;
        setRefreshing(false);
      }
    }
  }, [identityKey, onRefresh, refreshing]);

  return {
    refreshing,
    searchInputRef,
    searchOpen,
    searchTriggerRef,
    clearSearch,
    closeSearch,
    refresh,
    toggleSearch,
  };
}

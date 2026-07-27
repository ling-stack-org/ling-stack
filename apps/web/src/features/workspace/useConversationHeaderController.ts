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

  useEffect(() => {
    setSearchOpen(false);
    onSearchChange("");
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
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

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

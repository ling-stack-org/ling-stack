import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface ChannelHeaderControllerInput {
  readonly channelId: string;
  readonly onRefresh: () => Promise<void>;
  readonly onSearchChange: (value: string) => void;
}

export interface ChannelHeaderController {
  readonly refreshing: boolean;
  readonly searchInputRef: RefObject<HTMLInputElement>;
  readonly searchOpen: boolean;
  readonly clearSearch: () => void;
  readonly closeSearch: () => void;
  readonly refresh: () => Promise<void>;
  readonly toggleSearch: () => void;
}

export function useChannelHeaderController({
  channelId,
  onRefresh,
  onSearchChange,
}: ChannelHeaderControllerInput): ChannelHeaderController {
  const [searchOpen, setSearchOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSearchOpen(false);
  }, [channelId]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const clearSearch = useCallback((): void => {
    onSearchChange("");
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [onSearchChange]);

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    onSearchChange("");
  }, [onSearchChange]);

  const toggleSearch = useCallback((): void => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
  }, [closeSearch, searchOpen]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!channelId || refreshing) {
      return;
    }
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [channelId, onRefresh, refreshing]);

  return {
    refreshing,
    searchInputRef,
    searchOpen,
    clearSearch,
    closeSearch,
    refresh,
    toggleSearch,
  };
}

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface ChannelHeaderControllerInput {
  readonly channelId: string;
  readonly onSearchChange: (value: string) => void;
}

export interface ChannelHeaderController {
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly searchOpen: boolean;
  readonly clearSearch: () => void;
  readonly closeSearch: () => void;
  readonly toggleSearch: () => void;
}

export function useChannelHeaderController({
  channelId,
  onSearchChange,
}: ChannelHeaderControllerInput): ChannelHeaderController {
  const [searchOpen, setSearchOpen] = useState(false);
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

  return {
    searchInputRef,
    searchOpen,
    clearSearch,
    closeSearch,
    toggleSearch,
  };
}

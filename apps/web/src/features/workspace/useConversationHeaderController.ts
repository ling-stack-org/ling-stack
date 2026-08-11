import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface ConversationHeaderControllerInput {
  readonly identityKey: string;
  readonly onSearchChange: (value: string) => void;
}

export interface ConversationHeaderController {
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly searchOpen: boolean;
  readonly searchTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly clearSearch: () => void;
  readonly closeSearch: (restoreFocus?: boolean) => void;
  readonly toggleSearch: () => void;
}

export function useConversationHeaderController({
  identityKey,
  onSearchChange,
}: ConversationHeaderControllerInput): ConversationHeaderController {
  const [searchOpen, setSearchOpen] = useState(false);
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

  return {
    searchInputRef,
    searchOpen,
    searchTriggerRef,
    clearSearch,
    closeSearch,
    toggleSearch,
  };
}

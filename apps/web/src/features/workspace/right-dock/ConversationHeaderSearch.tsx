import { Search, X } from "lucide-react";
import type { ChangeEvent, KeyboardEvent, Ref } from "react";
import { IconButton, Input } from "../../../shared/ui/index.js";

export interface ConversationHeaderSearchProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly clearLabel: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onClear: () => void;
  readonly onEscape: () => void;
}

export function ConversationHeaderSearch({
  ariaLabel,
  className,
  clearLabel,
  inputRef,
  placeholder,
  value,
  onChange,
  onClear,
  onEscape,
}: ConversationHeaderSearchProps): JSX.Element {
  const containerClassName = ["conversation-header-search", className].filter(Boolean).join(" ");
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => onChange(event.target.value);
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onEscape();
  };

  return (
    <div className={containerClassName} role="search" aria-label={ariaLabel}>
      <Input
        ref={inputRef}
        aria-label={ariaLabel}
        autoComplete="off"
        className="conversation-header-search-native"
        containerClassName="conversation-header-search-input"
        placeholder={placeholder}
        prefix={<Search aria-hidden="true" />}
        size="sm"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {value ? (
        <IconButton
          className="conversation-header-search-clear"
          icon={X}
          label={clearLabel}
          onClick={onClear}
          size="sm"
          type="button"
        />
      ) : null}
    </div>
  );
}

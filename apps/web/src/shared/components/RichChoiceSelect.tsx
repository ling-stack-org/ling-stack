import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

export interface RichChoiceOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

export function RichChoiceSelect<Value extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
}: {
  readonly ariaLabel: string;
  readonly value: Value;
  readonly options: readonly RichChoiceOption<Value>[];
  readonly onChange: (value: Value) => void;
  readonly disabled?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? options[0];
  const SelectedIcon = selected.icon;

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }
    const focusTimer = window.setTimeout(() => optionRefs.current[activeIndex]?.focus(), 0);
    return () => window.clearTimeout(focusTimer);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (!target || rootRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setActiveIndex(selectedIndex);
    }
  }, [open, selectedIndex]);

  function restoreTriggerFocus(): void {
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function close(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) {
      restoreTriggerFocus();
    }
  }

  function openAt(index: number): void {
    if (disabled || options.length === 0) {
      return;
    }
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)));
    setOpen(true);
  }

  function choose(index: number): void {
    const option = options[index];
    if (!option) {
      return;
    }
    if (option.value !== value) {
      onChange(option.value);
    }
    close(true);
  }

  function moveActive(delta: number): void {
    if (options.length === 0) {
      return;
    }
    setActiveIndex((current) => (current + delta + options.length) % options.length);
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (disabled) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(open ? activeIndex + 1 : selectedIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(open ? activeIndex - 1 : selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openAt(options.length - 1);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
    }
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, options.length - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="rich-choice-select" onBlur={handleBlur}>
      <button
        ref={triggerRef}
        className="rich-choice-select-trigger"
        type="button"
        aria-label={`${ariaLabel}: ${selected.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => open ? close() : openAt(selectedIndex)}
        onKeyDown={handleTriggerKeyDown}
      >
        <SelectedIcon size={14} aria-hidden="true" />
        <span>{selected.label}</span>
        <ChevronDown className={open ? "expanded" : ""} size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={listboxId}
          className="rich-choice-select-popover"
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          onKeyDown={handleListboxKeyDown}
        >
          {options.map((option, index) => {
            const selectedOption = option.value === value;
            const Icon = option.icon;
            return (
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                id={`${listboxId}-option-${index}`}
                key={option.value}
                className={selectedOption ? "rich-choice-select-option selected" : "rich-choice-select-option"}
                type="button"
                role="option"
                aria-selected={selectedOption}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => choose(index)}
              >
                <Icon size={15} aria-hidden="true" />
                <span className="rich-choice-select-option-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="rich-choice-select-option-check" aria-hidden="true">
                  {selectedOption ? <Check size={14} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

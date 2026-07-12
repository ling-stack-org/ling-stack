import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FocusEvent } from "react";

export interface SettingsChoiceOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

export function SettingsChoiceMenu<Value extends string>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly value: Value;
  readonly options: readonly SettingsChoiceOption<Value>[];
  readonly onChange: (value: Value) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  const SelectedIcon = selected.icon;

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
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="settings-choice-menu" onBlur={handleBlur}>
      <button
        className="settings-choice-trigger"
        type="button"
        aria-label={`${ariaLabel}: ${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <SelectedIcon size={14} aria-hidden="true" />
        <span>{selected.label}</span>
        <ChevronDown className={open ? "expanded" : ""} size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div id={menuId} className="settings-choice-popover" role="menu" aria-label={ariaLabel}>
          {options.map((option) => {
            const selectedOption = option.value === value;
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                className={selectedOption ? "settings-choice-option selected" : "settings-choice-option"}
                type="button"
                role="menuitemradio"
                aria-checked={selectedOption}
                onClick={() => {
                  if (!selectedOption) {
                    onChange(option.value);
                  }
                  setOpen(false);
                }}
              >
                <Icon size={15} aria-hidden="true" />
                <span className="settings-choice-option-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <span className="settings-choice-option-check" aria-hidden="true">
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

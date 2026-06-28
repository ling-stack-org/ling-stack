import { Check, ChevronDown, Eye, LockKeyhole, Shield, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import {
  conversationPermissionPresetRequiresConfirmation,
  defaultConversationPermissionPresetOptions,
  type ConversationPermissionPreset,
  type ConversationPermissionPresetOption,
} from "@ling-stack/conversation-ui-core";

const permissionPresetIcon = {
  read_only: Eye,
  workspace_collaboration: Shield,
  full_access: ShieldCheck,
  custom: SlidersHorizontal,
} as const satisfies Record<ConversationPermissionPreset, typeof ShieldCheck>;

export interface ComposerPermissionMenuProps {
  readonly preset: ConversationPermissionPreset;
  readonly options?: readonly ConversationPermissionPresetOption[];
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly confirmChange?: (preset: ConversationPermissionPreset) => boolean | Promise<boolean>;
  readonly selectedPermissionLabel?: string;
  readonly menuLabel?: string;
  readonly fullAccessConfirmationMessage?: string;
  readonly onPresetChange: (preset: ConversationPermissionPreset) => void;
}

export function ComposerPermissionMenu({
  confirmChange,
  disabled = false,
  disabledReason,
  fullAccessConfirmationMessage = "Full access can allow broad local file, network, and tool access for the next run. Continue?",
  menuLabel = "Permission preset",
  onPresetChange,
  options = defaultConversationPermissionPresetOptions,
  preset,
  selectedPermissionLabel = "Selected permission preset {label}",
}: ComposerPermissionMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const ActiveIcon = disabled ? LockKeyhole : permissionPresetIcon[preset];
  const activeOption = findPermissionPresetOption(options, preset);
  const activeLabel = activeOption.label;
  const activeDescription = disabled && disabledReason ? disabledReason : activeOption.description;

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) {
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

  async function selectPreset(nextPreset: ConversationPermissionPreset): Promise<void> {
    if (disabled) {
      return;
    }
    if (nextPreset === preset) {
      setOpen(false);
      return;
    }
    if (conversationPermissionPresetRequiresConfirmation(nextPreset, options)) {
      const confirmed = confirmChange
        ? await confirmChange(nextPreset)
        : typeof globalThis.confirm === "function"
          ? globalThis.confirm(fullAccessConfirmationMessage)
          : false;
      if (!confirmed) {
        setOpen(false);
        return;
      }
    }
    onPresetChange(nextPreset);
    setOpen(false);
  }

  return (
    <div
      ref={menuRef}
      className={disabled ? "conversation-authorization-menu disabled" : "conversation-authorization-menu"}
      onBlur={handleBlur}
    >
      <button
        className="conversation-tool-button conversation-authorization-trigger conversation-composer-tool-button"
        type="button"
        aria-label={selectedPermissionLabel.replace("{label}", activeLabel)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
        title={activeDescription}
        onClick={() => {
          if (!disabled) {
            setOpen((currentOpen) => !currentOpen);
          }
        }}
      >
        <ActiveIcon size={15} />
        <span>{activeLabel}</span>
        <ChevronDown className={open ? "expanded" : ""} size={13} />
      </button>
      {open ? (
        <div className="conversation-authorization-popover conversation-composer-popover" role="menu" aria-label={menuLabel}>
          {options.map((option) => {
            const selected = option.preset === preset;
            const Icon = permissionPresetIcon[option.preset];
            return (
              <button
                key={option.preset}
                className={selected ? "conversation-authorization-option selected" : "conversation-authorization-option"}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={option.description}
                onClick={() => void selectPreset(option.preset)}
              >
                <Icon size={14} />
                <span>{option.label}</span>
                {selected ? <Check size={14} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function findPermissionPresetOption(
  options: readonly ConversationPermissionPresetOption[],
  preset: ConversationPermissionPreset,
): ConversationPermissionPresetOption {
  return options.find((option) => option.preset === preset) ??
    defaultConversationPermissionPresetOptions.find((option) => option.preset === preset) ??
    {
      preset,
      label: preset,
      description: preset,
    };
}

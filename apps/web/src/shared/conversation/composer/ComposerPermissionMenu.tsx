import { Check, ChevronDown, Eye, LockKeyhole, Shield, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { useI18n } from "../../../i18n.js";
import {
  permissionPresetDescription,
  permissionPresetLabel,
  permissionPresetOptions,
  permissionPresetRequiresConfirmation,
} from "../../../lib/session-permissions.js";
import type { PermissionPreset } from "../../../types.js";

const permissionPresetIcon = {
  read_only: Eye,
  workspace_collaboration: Shield,
  full_access: ShieldCheck,
  custom: SlidersHorizontal,
} as const satisfies Record<PermissionPreset, typeof ShieldCheck>;

export interface ComposerPermissionMenuProps {
  readonly preset: PermissionPreset;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly onPresetChange: (preset: PermissionPreset) => void;
}

export function ComposerPermissionMenu({
  disabled = false,
  disabledReason,
  onPresetChange,
  preset,
}: ComposerPermissionMenuProps): JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const ActiveIcon = disabled ? LockKeyhole : permissionPresetIcon[preset];
  const activeLabel = permissionPresetLabel(preset, t);
  const activeDescription = disabled && disabledReason ? disabledReason : permissionPresetDescription(preset, t);

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

  function selectPreset(nextPreset: PermissionPreset): void {
    if (disabled) {
      return;
    }
    if (nextPreset === preset) {
      setOpen(false);
      return;
    }
    if (permissionPresetRequiresConfirmation(nextPreset)) {
      const confirmed = globalThis.confirm(t("Full access can allow broad local file, network, and tool access for the next run. Continue?"));
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
        aria-label={t("Selected permission preset {label}", { label: activeLabel })}
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
        <div className="conversation-authorization-popover conversation-composer-popover" role="menu" aria-label={t("Permission preset")}>
          {permissionPresetOptions.map((option) => {
            const selected = option === preset;
            const Icon = permissionPresetIcon[option];
            return (
              <button
                key={option}
                className={selected ? "conversation-authorization-option selected" : "conversation-authorization-option"}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={permissionPresetDescription(option, t)}
                onClick={() => selectPreset(option)}
              >
                <Icon size={14} />
                <span>{permissionPresetLabel(option, t)}</span>
                {selected ? <Check size={14} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

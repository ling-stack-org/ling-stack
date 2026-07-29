import { Check, ChevronDown, Eye, LockKeyhole, Shield, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import {
  defaultConversationPermissionPresetOptions,
  type ConversationPermissionPreset,
  type ConversationPermissionPresetOption,
} from "@ling-stack/conversation-ui-core";
import {
  Button,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ling-stack/ui-react";

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
  readonly selectedPermissionLabel?: string;
  readonly menuLabel?: string;
  readonly onPresetChange: (preset: ConversationPermissionPreset) => void;
}

export function ComposerPermissionMenu({
  disabled = false,
  disabledReason,
  menuLabel = "Permission preset",
  onPresetChange,
  options = defaultConversationPermissionPresetOptions,
  preset,
  selectedPermissionLabel = "Selected permission preset {label}",
}: ComposerPermissionMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ActiveIcon = disabled ? LockKeyhole : permissionPresetIcon[preset];
  const activeOption = findPermissionPresetOption(options, preset);
  const activeLabel = activeOption.label;
  const activeDescription = disabled && disabledReason ? disabledReason : activeOption.description;

  function selectPreset(nextPreset: ConversationPermissionPreset): void {
    if (disabled) {
      return;
    }
    if (nextPreset === preset) {
      setOpen(false);
      return;
    }
    onPresetChange(nextPreset);
    setOpen(false);
  }

  return (
    <div className={disabled ? "conversation-authorization-menu disabled" : "conversation-authorization-menu"}>
      <Menu
        open={disabled ? false : open}
        onOpenChange={(nextOpen) => setOpen(disabled ? false : nextOpen)}
      >
        <MenuTrigger asChild>
          <Button
            className="conversation-tool-button conversation-authorization-trigger conversation-composer-tool-button"
            variant="ghost"
            size="sm"
            leadingIcon={<ActiveIcon size={15} />}
            trailingIcon={<ChevronDown className={open ? "expanded" : ""} size={13} />}
            aria-label={selectedPermissionLabel.replace("{label}", activeLabel)}
            aria-disabled={disabled}
            disabled={disabled}
            title={activeDescription}
          >
            {activeLabel}
          </Button>
        </MenuTrigger>
        <MenuContent
          className="conversation-authorization-popover conversation-composer-popover"
          side="top"
          align="start"
          sideOffset={8}
          aria-label={menuLabel}
        >
          <MenuRadioGroup value={preset}>
          {options.map((option) => {
            const selected = option.preset === preset;
            const Icon = permissionPresetIcon[option.preset];
            return (
              <MenuRadioItem
                key={option.preset}
                className={selected ? "conversation-authorization-option selected" : "conversation-authorization-option"}
                value={option.preset}
                title={option.description}
                onSelect={(event) => {
                  event.preventDefault();
                  selectPreset(option.preset);
                }}
              >
                <Icon size={14} />
                <span>{option.label}</span>
                {selected ? <Check size={14} /> : null}
              </MenuRadioItem>
            );
          })}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
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

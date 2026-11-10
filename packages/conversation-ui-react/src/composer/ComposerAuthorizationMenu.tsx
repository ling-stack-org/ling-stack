import { Check, ChevronDown, Hand, LockKeyhole, Shield, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  defaultConversationAuthorizationModeOptions,
  type ConversationAuthorizationMode,
  type ConversationAuthorizationModeOption,
} from "@ling-stack/conversation-ui-core";
import {
  Button,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ling-stack/ui-react";

const authorizationModeIcon = {
  ask: Hand,
  smart: Shield,
  always: ShieldCheck,
} as const satisfies Record<ConversationAuthorizationMode, typeof ShieldCheck>;

export interface ComposerAuthorizationMenuProps {
  readonly mode: ConversationAuthorizationMode;
  readonly options?: readonly ConversationAuthorizationModeOption[];
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly selectedModeLabel?: string;
  readonly menuLabel?: string;
  readonly onModeChange: (mode: ConversationAuthorizationMode) => void;
}

export function ComposerAuthorizationMenu({
  disabled = false,
  disabledReason,
  menuLabel = "Authorization mode",
  mode,
  onModeChange,
  options = defaultConversationAuthorizationModeOptions,
  selectedModeLabel = "Selected authorization mode {label}",
}: ComposerAuthorizationMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ActiveIcon = disabled ? LockKeyhole : authorizationModeIcon[mode];
  const activeOption = findAuthorizationModeOption(options, mode);
  const activeDescription = disabled && disabledReason ? disabledReason : activeOption.description;

  function selectMode(nextMode: ConversationAuthorizationMode): void {
    if (disabled) return;
    if (nextMode !== mode) onModeChange(nextMode);
    setOpen(false);
  }

  return (
    <div className={disabled
      ? "conversation-authorization-menu conversation-approval-mode-menu disabled"
      : "conversation-authorization-menu conversation-approval-mode-menu"}
    >
      <Menu open={disabled ? false : open} onOpenChange={(nextOpen) => setOpen(disabled ? false : nextOpen)}>
        <MenuTrigger asChild>
          <Button
            className="conversation-tool-button conversation-authorization-trigger conversation-composer-tool-button"
            variant="ghost"
            size="sm"
            leadingIcon={<ActiveIcon size={15} />}
            trailingIcon={<ChevronDown className={open ? "expanded" : ""} size={13} />}
            aria-label={selectedModeLabel.replace("{label}", activeOption.label)}
            aria-disabled={disabled}
            disabled={disabled}
            title={activeDescription}
          >
            {activeOption.label}
          </Button>
        </MenuTrigger>
        <MenuContent
          className="conversation-authorization-popover conversation-composer-popover"
          side="top"
          align="start"
          sideOffset={8}
          aria-label={menuLabel}
        >
          <MenuRadioGroup value={mode}>
            {options.map((option) => {
              const selected = option.mode === mode;
              const Icon = authorizationModeIcon[option.mode];
              return (
                <MenuRadioItem
                  key={option.mode}
                  className={selected ? "conversation-authorization-option selected" : "conversation-authorization-option"}
                  value={option.mode}
                  title={option.description}
                  onSelect={(event) => {
                    event.preventDefault();
                    selectMode(option.mode);
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

function findAuthorizationModeOption(
  options: readonly ConversationAuthorizationModeOption[],
  mode: ConversationAuthorizationMode,
): ConversationAuthorizationModeOption {
  return options.find((option) => option.mode === mode)
    ?? defaultConversationAuthorizationModeOptions.find((option) => option.mode === mode)
    ?? { mode, label: mode, description: mode };
}

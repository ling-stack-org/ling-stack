import { useEffect, useState } from "react";
import { Check, ChevronDown, Hand, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { conversationAuthorizationModeMenuOptions, permissionPresetLabel } from "../../lib/session-permissions.js";
import { Button, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../../shared/ui/index.js";
import type { AuthorizationMode, PermissionPreset } from "../../types.js";

const authorizationIcons = { ask: Hand, smart: Shield, always: ShieldAlert };

export function ConversationPermissionControl({
  authorizationMode, permissionPreset, fullAccessConfirmed, disabled, disabledReason, onAuthorizationModeChange,
}: {
  readonly authorizationMode: AuthorizationMode;
  readonly permissionPreset: PermissionPreset;
  readonly fullAccessConfirmed: boolean;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly onAuthorizationModeChange: (mode: AuthorizationMode) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const authorizationModes = conversationAuthorizationModeMenuOptions(t);
  const options = authorizationModes.map((option) => option.mode === "always" ? {
    ...option,
    label: t("Full access permissions"),
    description: t("After confirmation, this conversation uses automatic approvals and Full Access. System permissions and Host deny rules still apply."),
  } : option);
  const fullAccess = authorizationMode === "always" && permissionPreset === "full_access";
  // An inherited always + restricted sandbox is not the Full access shortcut.
  const selectedMode = authorizationMode === "always" && !fullAccess ? "custom" : authorizationMode;
  const selectedAuthorization = options.find((option) => option.mode === selectedMode)
    ?? authorizationModes.find((option) => option.mode === authorizationMode)!;
  const triggerLabel = fullAccess ? t("Full access") : selectedAuthorization.label;
  const confirmationLabel = fullAccess && fullAccessConfirmed
    ? t("Full access · Confirmed for this conversation") : triggerLabel;
  const Icon = selectedMode === "custom" ? ShieldCheck : authorizationIcons[authorizationMode];

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <Menu open={open && !disabled} onOpenChange={(value) => setOpen(value && !disabled)}>
      <MenuTrigger asChild>
        <Button
          className="conversation-authorization-trigger conversation-permission-trigger"
          variant="ghost"
          size="sm"
          leadingIcon={<Icon size={15} />}
          trailingIcon={<ChevronDown size={13} />}
          disabled={disabled}
          data-full-access={fullAccess}
          aria-label={t("Selected permission preset {label}", { label: confirmationLabel })}
          title={disabled ? disabledReason ?? t("Permission is locked while the current message is running.") : `${confirmationLabel}. ${selectedAuthorization.description} ${t("Sandbox settings")}: ${permissionPresetLabel(permissionPreset, t)}`}
        >
          {triggerLabel}
        </Button>
      </MenuTrigger>
      <MenuContent className="conversation-permission-menu" side="top" align="start" sideOffset={12} aria-label={t("Authorization mode")}>
        <span className="conversation-permission-menu-heading">{t("Authorization mode")}</span>
        <MenuRadioGroup value={selectedMode} aria-label={t("Authorization mode")}>
          {options.map((option) => {
            const OptionIcon = authorizationIcons[option.mode];
            return <MenuRadioItem key={option.mode} value={option.mode} aria-label={option.label} aria-description={option.description} data-full-access={option.mode === "always"} onSelect={(event) => {
              event.preventDefault();
              if (disabled) return;
              onAuthorizationModeChange(option.mode);
              setOpen(false);
            }}><OptionIcon size={18} /><span className="conversation-permission-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>{option.mode === selectedMode ? <Check size={16} /> : null}</MenuRadioItem>;
          })}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

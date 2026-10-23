import { useEffect, useState } from "react";
import { Check, ChevronDown, Eye, Shield, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { conversationAuthorizationModeMenuOptions, conversationPermissionPresetMenuOptions } from "../../lib/session-permissions.js";
import { Button, Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../../shared/ui/index.js";
import type { AuthorizationMode, PermissionPreset } from "../../types.js";

const permissionIcons = { read_only: Eye, workspace_collaboration: Shield, full_access: ShieldCheck, custom: SlidersHorizontal };

export function ConversationPermissionControl({
  authorizationMode, permissionPreset, fullAccessConfirmed, disabled, onAuthorizationModeChange, onPermissionPresetChange,
}: {
  readonly authorizationMode: AuthorizationMode;
  readonly permissionPreset: PermissionPreset;
  readonly fullAccessConfirmed: boolean;
  readonly disabled: boolean;
  readonly onAuthorizationModeChange: (mode: AuthorizationMode) => void;
  readonly onPermissionPresetChange: (preset: PermissionPreset) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const permissions = conversationPermissionPresetMenuOptions(t, fullAccessConfirmed);
  const authorizationModes = conversationAuthorizationModeMenuOptions(t);
  const selectedPermission = permissions.find((option) => option.preset === permissionPreset);
  const selectedAuthorization = authorizationModes.find((option) => option.mode === authorizationMode);
  const Icon = permissionIcons[permissionPreset];

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
          aria-label={t("Selected permission preset {label}", { label: selectedPermission?.label ?? t("Custom") })}
          title={disabled ? t("Permission is locked while the current message is running.") : `${selectedPermission?.description ?? ""} ${selectedAuthorization?.label ?? ""}`}
        >
          {selectedPermission?.label ?? t("Custom")}
        </Button>
      </MenuTrigger>
      <MenuContent className="conversation-permission-menu" side="top" align="start" sideOffset={12} aria-label={t("Permission preset")}>
        <MenuRadioGroup value={permissionPreset} aria-label={t("Sandbox settings")}>
          {permissions.map((option) => {
            const OptionIcon = permissionIcons[option.preset];
            return <MenuRadioItem key={option.preset} value={option.preset} title={option.description} onSelect={(event) => {
              event.preventDefault();
              if (disabled) return;
              if (permissionPreset !== option.preset) onPermissionPresetChange(option.preset);
              setOpen(false);
            }}><OptionIcon size={16} /><span>{option.label}</span>{option.preset === permissionPreset ? <Check size={15} /> : null}</MenuRadioItem>;
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <span className="conversation-permission-menu-heading">{t("Authorization mode")}</span>
        <MenuRadioGroup value={authorizationMode} aria-label={t("Authorization mode")}>
          {authorizationModes.map((option) => <MenuRadioItem key={option.mode} value={option.mode} title={option.description} onSelect={(event) => {
            event.preventDefault();
            if (disabled) return;
            onAuthorizationModeChange(option.mode);
            setOpen(false);
          }}><span>{option.label}</span>{option.mode === authorizationMode ? <Check size={15} /> : null}</MenuRadioItem>)}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

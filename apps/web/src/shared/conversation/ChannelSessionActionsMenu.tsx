import { Archive, MoreHorizontal, PencilLine, RotateCcw } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Icon, IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/index.js";

export function ChannelSessionActionsMenu({ title, isDefault, archived, disabled, onRename, onToggleArchived, onOpenChange }: {
  readonly title: string;
  readonly isDefault: boolean;
  readonly archived: boolean;
  readonly disabled?: boolean;
  readonly onRename: () => void;
  readonly onToggleArchived: () => void;
  readonly onOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return <Menu modal={false} onOpenChange={onOpenChange}>
    <MenuTrigger asChild>
      <IconButton className="sidebar-mini-action" icon={MoreHorizontal} disabled={disabled}
        label={t("Conversation actions: {title}", { title })} />
    </MenuTrigger>
    <MenuContent align="end" onCloseAutoFocus={event => {
      // The inline rename input takes focus after the menu closes.
      if (document.activeElement?.matches("input[data-session-rename]")) event.preventDefault();
    }}>
      <MenuItem onSelect={onRename} aria-label={t("Rename conversation: {title}", { title })}>
        <Icon icon={PencilLine} size="xs" />{t("Rename conversation")}
      </MenuItem>
      {!isDefault ? <MenuItem onSelect={onToggleArchived}
        aria-label={t(archived ? "Restore conversation: {title}" : "Archive conversation: {title}", { title })}>
        <Icon icon={archived ? RotateCcw : Archive} size="xs" />{t(archived ? "Restore conversation" : "Archive conversation")}
      </MenuItem> : null}
    </MenuContent>
  </Menu>;
}

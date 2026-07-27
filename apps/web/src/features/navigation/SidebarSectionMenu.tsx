import { MoreHorizontal, type LucideIcon } from "lucide-react";
import type { Ref } from "react";
import {
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "../../shared/ui/index.js";

export interface SidebarSectionMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly disabledLabel?: string;
  readonly danger?: boolean;
  readonly onSelect: () => void;
}

export function SidebarSectionMenu({
  items,
  label,
  onOpenChange,
  open,
  triggerRef,
}: {
  readonly items: readonly SidebarSectionMenuItem[];
  readonly label: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly triggerRef?: Ref<HTMLButtonElement>;
}): JSX.Element {
  return (
    <Menu modal={false} open={open} onOpenChange={onOpenChange}>
      <MenuTrigger asChild>
        <IconButton
          ref={triggerRef}
          className="sidebar-section-action"
          icon={MoreHorizontal}
          label={label}
          tooltip=""
        />
      </MenuTrigger>
      <MenuContent className="sidebar-section-menu-content" align="end" side="bottom">
        {items.map((item) => (
          <MenuItem
            key={item.id}
            className={item.description ? "sidebar-section-menu-item has-description" : "sidebar-section-menu-item"}
            disabled={item.disabled}
            title={item.disabled ? item.disabledLabel ?? item.label : item.label}
            tone={item.danger ? "danger" : "default"}
            onSelect={item.onSelect}
          >
            <span className="ling-ui-menu-item-icon" aria-hidden="true"><Icon icon={item.icon} size="xs" /></span>
            <span className="sidebar-section-menu-item-copy">
              <span className="sidebar-section-menu-item-label">{item.label}</span>
              {item.description ? <small>{item.description}</small> : null}
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

import type { ReactNode } from "react";

export function ActionMenuItem({
  icon,
  label,
  description,
  danger = false,
  disabled = false,
  disabledLabel,
  onSelect,
}: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly disabledLabel?: string;
  readonly onSelect: () => void;
}): JSX.Element {
  return (
    <button
      className={["action-menu-item", danger ? "danger" : "", description ? "has-description" : ""].filter(Boolean).join(" ")}
      type="button"
      role="menuitem"
      disabled={disabled}
      title={disabled ? disabledLabel ?? label : label}
      onClick={() => {
        if (!disabled) {
          onSelect();
        }
      }}
    >
      <span className="action-menu-item-title sidebar-section-menu-rich-title">
        <i className="action-menu-item-icon" aria-hidden="true">{icon}</i>
        <span>{label}</span>
      </span>
      <span className="action-menu-item-copy sidebar-section-menu-rich-copy">
        {description ? <small>{description}</small> : null}
      </span>
    </button>
  );
}

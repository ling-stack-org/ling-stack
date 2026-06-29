import type { ReactNode } from "react";
import type { DockLauncherItem, DockPageKind } from "@ling-stack/conversation-ui-core";

export interface DockLauncherPageItem extends DockLauncherItem {
  readonly icon?: ReactNode;
}

export interface DockLauncherProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly items: readonly DockLauncherPageItem[];
  readonly onOpenPage: (page: DockPageKind) => void;
}

export function DockLauncher({
  title,
  subtitle,
  items,
  onOpenPage,
}: DockLauncherProps): JSX.Element {
  return (
    <div className="right-dock-launcher">
      <div className="right-dock-launcher-head">
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
      <div className="right-dock-launcher-list">
        {items.map((item) => (
          <button
            key={item.id}
            className={[
              "right-dock-launcher-row",
              item.severity ? `severity-${item.severity}` : "",
            ].filter(Boolean).join(" ")}
            type="button"
            onClick={() => onOpenPage(item.id)}
            disabled={item.disabled}
            aria-label={item.disabledReason ? `${item.label}: ${item.disabledReason}` : item.label}
            title={item.disabledReason ?? item.description ?? item.label}
          >
            {item.icon ? <span className="right-dock-launcher-icon">{item.icon}</span> : null}
            <span className="right-dock-launcher-copy">
              <strong>{item.label}</strong>
              {item.description ? <small>{item.description}</small> : null}
            </span>
            <span className="right-dock-launcher-status">
              {typeof item.count === "number" && item.count > 0 ? <strong>{item.count}</strong> : null}
              {item.statusLabel ? <small>{item.statusLabel}</small> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

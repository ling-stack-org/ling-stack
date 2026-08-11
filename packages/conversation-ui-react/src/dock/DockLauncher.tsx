import type { ReactNode } from "react";
import type { DockLauncherItem, DockPageKind } from "@ling-stack/conversation-ui-core";
import { Button } from "@ling-stack/ui-react";

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
  items,
  onOpenPage,
}: DockLauncherProps): React.JSX.Element {
  return (
    <div className="right-dock-launcher">
      <div className="right-dock-launcher-list">
        {items.map((item) => (
          <Button
            key={item.id}
            className={[
              "right-dock-launcher-row",
              item.severity ? `severity-${item.severity}` : "",
            ].filter(Boolean).join(" ")}
            data-ui2-dock-launcher-action={item.id}
            leadingIcon={item.icon}
            size="md"
            variant="ghost"
            onClick={() => onOpenPage(item.id)}
            disabled={item.disabled}
            aria-label={item.disabledReason ? `${item.label}: ${item.disabledReason}` : item.label}
            title={item.disabledReason ?? item.description ?? item.label}
          >
            <span className="right-dock-launcher-copy">
              <strong>{item.label}</strong>
              {item.description ? <small>{item.description}</small> : null}
            </span>
            <span className="right-dock-launcher-status">
              {item.statusLabel ? <small>{item.statusLabel}</small> : null}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

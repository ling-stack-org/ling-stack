import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";
import { Badge, Button } from "../../shared/ui/index.js";

export interface TeammateSettingsSection<TabId extends string> {
  readonly id: TabId;
  readonly label: string;
  readonly count?: number;
  readonly danger?: boolean;
  readonly icon: LucideIcon;
}

export function TeammateSettingsNavigation<TabId extends string>({
  activeTab,
  sections,
  label,
  onChange,
}: {
  readonly activeTab: TabId;
  readonly sections: readonly TeammateSettingsSection<TabId>[];
  readonly label: string;
  readonly onChange: (tab: TabId) => void;
}): JSX.Element {
  const minimumTabWidth = 120;
  const tabListStyle = {
    gridTemplateColumns: `repeat(${sections.length}, minmax(${minimumTabWidth}px, 1fr))`,
    minWidth: `${sections.length * minimumTabWidth}px`,
  } satisfies CSSProperties;

  return (
    <nav className="channel-settings-tabs-scroll teammate-settings-nav" aria-label={label}>
      <div className="channel-settings-tabs teammate-settings-tabs" style={tabListStyle}>
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <Button
              key={section.id}
              aria-current={activeTab === section.id ? "page" : undefined}
              className="channel-settings-tab teammate-settings-nav-item"
              data-active={activeTab === section.id || undefined}
              data-danger={section.danger || undefined}
              leadingIcon={<Icon size={16} aria-hidden="true" />}
              size="sm"
              variant="ghost"
              onClick={() => onChange(section.id)}
            >
              <span className="teammate-settings-tab-label">
                <span>{section.label}</span>
                {section.count !== undefined ? (
                  <Badge className="teammate-settings-nav-count" variant="outline">{section.count}</Badge>
                ) : null}
              </span>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}

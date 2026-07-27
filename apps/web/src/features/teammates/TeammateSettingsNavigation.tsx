import { Badge, Button } from "../../shared/ui/index.js";

export interface TeammateSettingsSection<TabId extends string> {
  readonly id: TabId;
  readonly label: string;
  readonly count?: number;
  readonly danger?: boolean;
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
  return (
    <nav className="teammate-settings-nav" aria-label={label}>
      {sections.map((section) => (
        <Button
          key={section.id}
          aria-current={activeTab === section.id ? "page" : undefined}
          className="teammate-settings-nav-item"
          data-active={activeTab === section.id || undefined}
          data-danger={section.danger || undefined}
          size="sm"
          variant="ghost"
          onClick={() => onChange(section.id)}
        >
          <span>{section.label}</span>
          {section.count !== undefined ? (
            <Badge className="teammate-settings-nav-count" variant="outline">{section.count}</Badge>
          ) : null}
        </Button>
      ))}
    </nav>
  );
}

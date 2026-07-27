import { ArrowLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../shared/ui/index.js";
import type { SettingsSectionId } from "./settings-shell-model.js";

export interface SettingsShellItem {
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly title: string;
  readonly icon: LucideIcon;
}

export interface SettingsShellGroup {
  readonly heading: string;
  readonly items: readonly SettingsShellItem[];
}

export type SettingsContentState = "section" | "workspace-tool" | "run-diagnostics";

export function SettingsShell({
  activeSection,
  backLabel,
  children,
  contentClassName,
  contentLabel,
  contentState,
  groups,
  navigationLabel,
  onBack,
  onSelectSection,
}: {
  readonly activeSection: SettingsSectionId;
  readonly backLabel: string;
  readonly children: ReactNode;
  readonly contentClassName: string;
  readonly contentLabel: string;
  readonly contentState: SettingsContentState;
  readonly groups: readonly SettingsShellGroup[];
  readonly navigationLabel: string;
  readonly onBack?: () => void;
  readonly onSelectSection: (sectionId: SettingsSectionId) => void;
}): JSX.Element {
  return (
    <div
      className="settings-layout"
      data-ui2-settings-shell="true"
      data-settings-active-section={activeSection}
    >
      <nav className="settings-section-nav" data-settings-shell-navigation="true" aria-label={navigationLabel}>
        {onBack ? (
          <Button
            className="settings-app-return-button"
            leadingIcon={<ArrowLeft />}
            size="sm"
            variant="ghost"
            onClick={onBack}
          >
            {backLabel}
          </Button>
        ) : null}
        {groups.map((group) => (
          <div
            key={group.heading}
            className="settings-section-group"
            data-settings-shell-group="true"
            role="group"
            aria-label={group.heading}
          >
            <span className="settings-section-group-label" data-settings-shell-group-label="true" aria-hidden="true">
              {group.heading}
            </span>
            {group.items.map((item) => {
              const SectionIcon = item.icon;
              const active = activeSection === item.id;
              return (
                <Button
                  key={item.id}
                  className={active ? "settings-section-item active" : "settings-section-item"}
                  data-settings-section={item.id}
                  leadingIcon={<SectionIcon className="settings-section-icon" data-settings-section-icon="true" aria-hidden="true" />}
                  size="sm"
                  title={item.title}
                  variant="ghost"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelectSection(item.id)}
                >
                  {item.label}
                </Button>
              );
            })}
          </div>
        ))}
      </nav>
      <section
        className={contentClassName}
        data-settings-content-state={contentState}
        aria-label={contentLabel}
      >
        {children}
      </section>
    </div>
  );
}

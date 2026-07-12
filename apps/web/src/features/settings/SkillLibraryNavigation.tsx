import { Plus, RefreshCw, Upload } from "lucide-react";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { SkillLibrarySectionId } from "./skill-library-view-models.js";
import { SettingsSubnav } from "./SettingsSubnav.js";

export function SkillLibraryNavigation({
  activeSection,
  currentUserCount,
  builtinCount,
  reviewCount,
  sourceAttentionCount,
  loading,
  onSectionChange,
  onImport,
  onNewDraft,
  onRefresh,
  t,
}: {
  readonly activeSection: SkillLibrarySectionId;
  readonly currentUserCount: number;
  readonly builtinCount: number;
  readonly reviewCount: number;
  readonly sourceAttentionCount: number;
  readonly loading: boolean;
  readonly onSectionChange: (section: SkillLibrarySectionId) => void;
  readonly onImport: () => void;
  readonly onNewDraft: () => void;
  readonly onRefresh: () => void;
  readonly t: SettingsTranslator;
}): JSX.Element {
  return (
    <>
      <header className="settings-skill-library-head">
        <div>
          <h2 id="settings-skill-library-title">{t("Skill library")}</h2>
        </div>
        <div className="settings-skill-library-actions">
          {activeSection === "mine" ? (
            <>
              <button className="primary-button compact-button" type="button" onClick={onImport}>
                <Upload size={15} />
                {t("Import skill")}
              </button>
              <button className="secondary-button compact-button" type="button" onClick={onNewDraft}>
                <Plus size={15} />
                {t("New draft")}
              </button>
            </>
          ) : null}
          <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label={t("Refresh")}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </header>

      <SettingsSubnav
        label="Skill library sections"
        activeId={activeSection}
        onChange={(id) => onSectionChange(id as SkillLibrarySectionId)}
        options={[
          {
            id: "mine",
            label: "My skills",
            description: "Manage skills created, imported, or synced into this workspace.",
            badge: `${currentUserCount}`,
          },
          {
            id: "builtin",
            label: "Built-in skills",
            description: "Inspect Ling built-in skills and their current teammate bindings.",
            badge: `${builtinCount}`,
          },
          {
            id: "review",
            label: "Review queue",
            description: "Resolve health findings, skill candidates, candidate clusters, and playbook proposals.",
            badge: `${reviewCount}`,
          },
          {
            id: "source",
            label: "Source sync",
            description: "Check source snapshots, preview gstack updates, and publish selected source records.",
            badge: `${sourceAttentionCount}`,
          },
        ]}
      />
    </>
  );
}

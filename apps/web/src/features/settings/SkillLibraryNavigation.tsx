import type { SkillLibrarySectionId } from "./skill-library-view-models.js";
import { SettingsSubnav } from "./SettingsSubnav.js";

export function SkillLibraryNavigation({
  activeSection,
  currentUserCount,
  evolutionCount,
  builtinCount,
  onSectionChange,
}: {
  readonly activeSection: SkillLibrarySectionId;
  readonly currentUserCount: number;
  readonly evolutionCount: number;
  readonly builtinCount: number;
  readonly onSectionChange: (section: SkillLibrarySectionId) => void;
}): JSX.Element {
  return (
    <SettingsSubnav
      label="Skill library sections"
      activeId={activeSection}
      onChange={(id) => onSectionChange(id as SkillLibrarySectionId)}
      options={[
        {
          id: "mine",
          label: "My skills",
          badge: `${currentUserCount}`,
        },
        {
          id: "evolution",
          label: "AI evolution",
          badge: `${evolutionCount}`,
        },
        {
          id: "builtin",
          label: "Built-in skills",
          badge: `${builtinCount}`,
        },
      ]}
    />
  );
}

import type { SkillLibrarySectionId } from "./skill-library-view-models.js";
import { SettingsSubnav } from "./SettingsSubnav.js";

export function SkillLibraryNavigation({
  activeSection,
  currentUserCount,
  localCount,
  evolutionCount,
  builtinCount,
  onSectionChange,
}: {
  readonly activeSection: SkillLibrarySectionId;
  readonly currentUserCount: number;
  readonly localCount: number | undefined;
  readonly evolutionCount: number;
  readonly builtinCount: number;
  readonly onSectionChange: (section: SkillLibrarySectionId) => void;
}): React.JSX.Element {
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
          id: "local",
          label: "Local skill folders",
          ...(localCount !== undefined ? { badge: `${localCount}` } : {}),
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

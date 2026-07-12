import type { SkillLibrarySectionId } from "./skill-library-view-models.js";
import { SettingsSubnav } from "./SettingsSubnav.js";

export function SkillLibraryNavigation({
  activeSection,
  currentUserCount,
  builtinCount,
  reviewCount,
  sourceAttentionCount,
  onSectionChange,
}: {
  readonly activeSection: SkillLibrarySectionId;
  readonly currentUserCount: number;
  readonly builtinCount: number;
  readonly reviewCount: number;
  readonly sourceAttentionCount: number;
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
  );
}

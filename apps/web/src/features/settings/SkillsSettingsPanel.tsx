import { useState } from "react";
import { SkillGovernanceSettingsSection } from "./SkillGovernanceSettingsSection.js";
import { SkillLibrarySettingsPanel } from "./SkillLibrarySettingsPanel.js";
import { SettingsSubnav } from "./SettingsSubnav.js";

type SkillsSubsectionId = "governance" | "library";

export function SkillsSettingsPanel({
  cwd,
  skillLibraryRefreshToken,
}: {
  readonly cwd: string;
  readonly skillLibraryRefreshToken: number;
}): JSX.Element {
  const [activeSubsection, setActiveSubsection] = useState<SkillsSubsectionId>("governance");

  return (
    <div className="settings-section-stack">
      <SettingsSubnav
        label="Skill sections"
        activeId={activeSubsection}
        onChange={(id) => setActiveSubsection(id as SkillsSubsectionId)}
        options={[
          {
            id: "governance",
            label: "Skill Governance",
            description: "Control when Ling can generate, record, and publish reusable skills.",
          },
          {
            id: "library",
            label: "Skill Library",
            description: "Inspect skill definitions, source health, and reusable workspace skills.",
          },
        ]}
      />
      {activeSubsection === "governance" ? <SkillGovernanceSettingsSection cwd={cwd} /> : null}
      {activeSubsection === "library" ? <SkillLibrarySettingsPanel cwd={cwd} refreshToken={skillLibraryRefreshToken} /> : null}
    </div>
  );
}

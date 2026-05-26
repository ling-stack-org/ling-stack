import {
  Bot,
  Workflow,
} from "lucide-react";
import type { SkillPack } from "@ling-stack/core/skill-types";
import { useI18n } from "../../i18n.js";
import { MetaRow } from "../../shared/components/index.js";
import {
  approvalProfileText,
  workflowPhaseLabel,
} from "./helpers.js";
import type { LocalTeammateDraft } from "./types.js";

export function AiTeammateInspector({
  skillPack,
  localTeammates,
}: {
  readonly skillPack: SkillPack | undefined;
  readonly localTeammates: readonly LocalTeammateDraft[];
}): JSX.Element {
  const { t } = useI18n();
  if (!skillPack) {
    return (
      <div className="workspace-context-stack">
        <section className="context-panel-card inspector">
          <div className="empty-state compact-empty">
            <Bot />
            <span>{t("No teammate templates available")}</span>
          </div>
        </section>
      </div>
    );
  }
  const strictSkills = skillPack.skills.filter((skill) => skill.approvalProfile.mode === "strict");
  const workflow = skillPack.workflowTemplates[0];
  return (
    <div className="workspace-context-stack">
      <section className="context-panel-card inspector teammate-pack-card">
        <div className="panel-title">
          <Bot size={16} />
          <h2>{t("Skill pack")}</h2>
        </div>
        <div className="meta-list">
          <MetaRow label={t("Pack")} value={skillPack.id} compact />
          <MetaRow label={t("Source")} value={skillPack.source} />
          <MetaRow label={t("Version")} value={skillPack.version} />
          <MetaRow label={t("Templates")} value={String(skillPack.teammateTemplates.length)} />
          <MetaRow label={t("Skills")} value={String(skillPack.skills.length)} />
          <MetaRow label={t("Local teammates")} value={String(localTeammates.length)} />
        </div>
        <div className="inspector-block">
          <h3>{t("Strict approval")}</h3>
          {strictSkills.map((skill) => (
            <div key={skill.id} className="tool-row">
              <span>{t(skill.name)}</span>
              <code>{approvalProfileText(skill.approvalProfile, t)}</code>
            </div>
          ))}
        </div>
      </section>

      {workflow ? (
        <section className="context-panel-card inspector teammate-pack-card">
          <div className="panel-title">
            <Workflow size={16} />
            <h2>{workflow.name}</h2>
          </div>
          <div className="inspector-block">
            {workflow.steps.map((step, index) => (
              <div key={step.id} className="tool-row">
                <span>{index + 1}. {t(step.name)}</span>
                <code>{workflowPhaseLabel(step.phase, t)}</code>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

import type { SkillEditableDefinition } from "../../../types.js";
import { useI18n } from "../../../i18n.js";
import "./learning-review.css";

export function SkillDefinitionDiff({ before, after }: {
  readonly before?: SkillEditableDefinition; readonly after: SkillEditableDefinition;
}): React.JSX.Element {
  const { t } = useI18n();
  const fields = [
    ["name", t("Skill name")], ["summary", t("Summary")], ["promptFragments", t("Procedure steps")],
    ["requiredTools", t("Required tools")], ["requiredProviderCapabilities", t("Provider capability")],
    ["approvalProfile", t("Approval profile")],
  ] as const;
  const changed = fields.filter(([field]) => JSON.stringify(before?.[field]) !== JSON.stringify(after[field]));
  return <div className="skill-definition-diff" aria-label={t("Definition changes")}>
    {changed.length === 0 ? <small>{t("No definition changes")}</small> : changed.map(([field, label]) => <section key={field}>
      <strong>{label}</strong>
      <div className="skill-definition-diff-columns">
        <div><small>{t("Before")}</small><pre>{displayValue(before?.[field])}</pre></div>
        <div><small>{t("After")}</small><pre>{displayValue(after[field])}</pre></div>
      </div>
    </section>)}
  </div>;
}
function displayValue(value: unknown): string {
  return value === undefined ? "—" : typeof value === "string" ? value : Array.isArray(value) ? value.join("\n\n") : JSON.stringify(value, null, 2);
}

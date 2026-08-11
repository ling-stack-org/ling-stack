import { Check, Layers } from "lucide-react";
import { Button, DataRow, EmptyState, StatusIndicator } from "../../shared/ui/index.js";
import type { BuiltinAutomationTemplate } from "../../types.js";
import { automationScheduleLabel, type AutomationTranslate } from "./automation-view-models.js";

export function AutomationTemplateStep({
  selectedTemplateId,
  t,
  templates,
  onReview,
  onSelect,
}: {
  readonly selectedTemplateId: string;
  readonly t: AutomationTranslate;
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly onReview: (template: BuiltinAutomationTemplate) => void;
  readonly onSelect: (templateId: string) => void;
}): React.JSX.Element {
  const selected = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  if (!selected) {
    return <EmptyState compact icon={<Layers size={18} />} title={t("No templates available")} />;
  }
  return (
    <div className="automation-ui2-template-step">
      <div className="automation-ui2-template-list" role="listbox" aria-label={t("Automation templates")}>
        {templates.map((template) => (
          <DataRow
            key={template.id}
            compact
            identity={(
              <span className="automation-ui2-template-identity">
                <strong>{t(template.title)}</strong>
                <span>{t(template.description)}</span>
              </span>
            )}
            selected={selected.id === template.id}
            status={<StatusIndicator compact label={automationScheduleLabel(template.defaultTrigger, t)} tone="neutral" />}
            onClick={() => onSelect(template.id)}
          />
        ))}
      </div>
      <aside className="automation-ui2-template-review">
        <span className="automation-ui2-template-icon" aria-hidden="true"><Layers size={18} /></span>
        <strong>{t(selected.title)}</strong>
        <p>{t(selected.description)}</p>
        <dl>
          <div><dt>{t("Schedule")}</dt><dd>{automationScheduleLabel(selected.defaultTrigger, t)}</dd></div>
          <div><dt>{t("Prompt")}</dt><dd>{selected.defaultPromptTemplate.promptMarkdown}</dd></div>
        </dl>
        <Button leadingIcon={<Check size={15} />} onClick={() => onReview(selected)} variant="primary">
          {t("Use this template")}
        </Button>
      </aside>
    </div>
  );
}

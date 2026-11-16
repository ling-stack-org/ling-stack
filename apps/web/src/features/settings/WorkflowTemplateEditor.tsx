import type { AiTeammate, Channel, CustomWorkflowTemplate } from "@ling-stack/contracts";
import { ArrowLeft, Download, Plus, RotateCcw, Save } from "lucide-react";
import { Badge, Button, Checkbox, Field, IconButton, InlineFeedback, Input, Select, Textarea } from "../../shared/ui/index.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import type { WorkflowTemplateAuthoringController } from "./workflow-template-authoring-controller.js";
import { newWorkflowTemplateStep, removeWorkflowTemplateStep, replaceWorkflowTemplateStep } from "./workflow-template-authoring-model.js";
import { workflowTemplateStatusLabel } from "./WorkflowTemplateList.js";
import { WorkflowTemplatePreview } from "./WorkflowTemplatePreview.js";
import { WorkflowTemplateStepEditor } from "./WorkflowTemplateStepEditor.js";

export function WorkflowTemplateEditor({ controller, channels, teammates, t }: {
  readonly controller: WorkflowTemplateAuthoringController;
  readonly channels: readonly Channel[];
  readonly teammates: readonly AiTeammate[];
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const { session, busy, dirty } = controller;
  if (!session) return <></>;
  const { template, version } = session.draft;
  const readOnly = Boolean(session.entry && session.entry.source !== "workspace");
  const disabled = Boolean(busy) || readOnly;
  const status = session.entry?.reviewStatus ?? "draft";
  const setTemplate = (next: CustomWorkflowTemplate) => controller.setDraft({ ...session.draft, template: next });
  function moveStep(index: number, offset: number): void {
    const steps = [...template.steps];
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    setTemplate({ ...template, steps });
  }
  return (
    <div className="workflow-template-editor workflow-template-stack" data-ui2-workflow-template-editor="" aria-busy={Boolean(busy)}>
      <header className="workflow-template-section-head">
        <div className="workflow-template-actions">
          <IconButton icon={ArrowLeft} label={t("Back to workflow templates")} disabled={Boolean(busy)} onClick={controller.closeEditor} />
          <h4>{template.name || t("New workflow template")}</h4>
          <Badge>{t(workflowTemplateStatusLabel(status))}</Badge>
          <span className="workflow-template-dirty" role="status">{dirty ? t("Unsaved changes") : session.savedVersion ? t("Saved") : ""}</span>
        </div>
        <div className="workflow-template-actions">
          <IconButton icon={Download} label={t("Export template JSON")} disabled={Boolean(busy) || !controller.validation.template} onClick={controller.exportJson} />
          {session.entry || session.conflict ? <IconButton icon={RotateCcw} label={t("Reload latest template")} disabled={Boolean(busy)} onClick={controller.reloadLatest} /> : null}
          <Button size="sm" leadingIcon={<Save size={14} />} loading={busy === "saving"}
            disabled={disabled || !dirty || session.conflict || !controller.validation.template} onClick={() => void controller.save()}>{t("Save draft")}</Button>
        </div>
      </header>
      {session.conflict ? <InlineFeedback tone="warning" title={t("Template revision conflict")}>
        <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={controller.reloadLatest}>{t("Reload latest template")}</Button>
      </InlineFeedback> : null}
      <div className="workflow-template-fields workflow-template-fields--pair">
        <Field label={t("Template ID")} required><Input value={template.id} maxLength={128} disabled={disabled || Boolean(session.entry)} onChange={(event) => setTemplate({ ...template, id: event.currentTarget.value })} /></Field>
        <Field label={t("Next version")} required><Input value={version} maxLength={128} disabled={disabled} onChange={(event) => controller.setDraft({ ...session.draft, version: event.currentTarget.value })} /></Field>
        <Field label={t("Template name")} required><Input value={template.name} maxLength={256} disabled={disabled} onChange={(event) => setTemplate({ ...template, name: event.currentTarget.value })} /></Field>
        <Field label={t("Review status")}><Select value={status} disabled={disabled || !session.entry || dirty || session.conflict} onChange={(event) => void controller.review(event.currentTarget.value as "draft" | "published" | "disabled" | "archived")}>
          {status === "builtin" ? <option value="builtin">{t("Built-in")}</option> : null}
          {(["draft", "published", "disabled", "archived"] as const).map((value) => <option value={value} key={value}>{t(workflowTemplateStatusLabel(value))}</option>)}
        </Select></Field>
      </div>
      <Field label={t("Description")}><Textarea rows={2} value={template.description ?? ""} maxLength={8192} disabled={disabled} onChange={(event) => setTemplate({ ...template, description: event.currentTarget.value })} /></Field>
      <div className="workflow-template-fields workflow-template-fields--pair">
        <Field label={t("Maximum parallel steps")}><Input type="number" min={1} max={128} step={1} value={template.maxParallelSteps ?? ""} disabled={disabled} onChange={(event) => {
          const { maxParallelSteps: _limit, ...rest } = template;
          setTemplate({ ...rest, ...(event.currentTarget.value === "" ? {} : { maxParallelSteps: Number(event.currentTarget.value) }) });
        }} /></Field>
        <Checkbox label={t("Auto-start by default")} checked={template.autoStartDefault ?? false} disabled={disabled} onChange={(event) => setTemplate({ ...template, autoStartDefault: event.currentTarget.checked })} />
      </div>
      <section className="workflow-template-stack" aria-label={t("Steps")}>
        <header className="workflow-template-section-head">
          <h4>{t("Steps")}</h4>
          <Button size="sm" variant="secondary" leadingIcon={<Plus size={14} />} disabled={disabled || template.steps.length >= 128} onClick={() => setTemplate({ ...template, steps: [...template.steps, newWorkflowTemplateStep(template.steps)] })}>{t("Add step")}</Button>
        </header>
        {template.steps.map((step, index) => <WorkflowTemplateStepEditor key={step.id} step={step} steps={template.steps} index={index} teammates={teammates} disabled={disabled}
          onChange={(next) => setTemplate(replaceWorkflowTemplateStep(template, step.id, next))} onRemove={() => setTemplate(removeWorkflowTemplateStep(template, step.id))} onMove={(offset) => moveStep(index, offset)} t={t} />)}
      </section>
      {dirty && controller.validation.error ? <InlineFeedback tone="warning">{controller.validation.error}</InlineFeedback> : null}
      <WorkflowTemplatePreview controller={controller} channels={channels} t={t} />
    </div>
  );
}

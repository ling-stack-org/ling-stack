import type { AiTeammate, CustomWorkflowTemplateStep, WorkflowStepParallelPolicy } from "@ling-stack/contracts";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button, Checkbox, Field, IconButton, Input, Select, Textarea } from "../../shared/ui/index.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import { WorkflowTemplateGateEditor } from "./WorkflowTemplateGateEditor.js";
import { setWorkflowTemplateMember, setWorkflowTemplateParallelPolicy, toggleWorkflowTemplateValue, workflowTemplateDependencyWouldCycle, workflowTemplateMemberValue } from "./workflow-template-authoring-model.js";

const sideEffects = [
  ["analysis_readonly", "Read-only analysis"], ["test_artifact_only", "Test artifacts only"],
  ["workspace_write", "Workspace write"], ["external_mutation", "External mutation"], ["release", "Release"],
] as const;

export function WorkflowTemplateStepEditor({ step, steps, index, teammates, disabled, onChange, onRemove, onMove, t }: {
  readonly step: CustomWorkflowTemplateStep;
  readonly steps: readonly CustomWorkflowTemplateStep[];
  readonly index: number;
  readonly teammates: readonly AiTeammate[];
  readonly disabled: boolean;
  readonly onChange: (step: CustomWorkflowTemplateStep) => void;
  readonly onRemove: () => void;
  readonly onMove: (offset: number) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  const member = workflowTemplateMemberValue(step);
  const knownMember = teammates.some((teammate) => `teammate:${teammate.id}` === member);
  const resources = step.parallelPolicy?.resourceKeys ?? [];
  const automaticParallelAllowed = step.sideEffectClass !== "external_mutation" && step.sideEffectClass !== "release";
  function parallel(patch: Partial<WorkflowStepParallelPolicy>): void {
    onChange(setWorkflowTemplateParallelPolicy(step, patch));
  }
  return (
    <article className="workflow-template-step" aria-label={t("Step {index}", { index: index + 1 })}>
      <header className="workflow-template-section-head">
        <strong>{t("Step {index}", { index: index + 1 })} <code>{step.id}</code></strong>
        <div className="workflow-template-actions">
          <IconButton icon={ArrowUp} label={t("Move step up")} disabled={disabled || index === 0} onClick={() => onMove(-1)} />
          <IconButton icon={ArrowDown} label={t("Move step down")} disabled={disabled || index === steps.length - 1} onClick={() => onMove(1)} />
          <IconButton icon={Trash2} label={t("Remove step")} variant="danger" disabled={disabled || steps.length === 1} onClick={onRemove} />
        </div>
      </header>
      <div className="workflow-template-fields workflow-template-fields--pair">
        <Field label={t("Step name")} required>
          <Input value={step.name} maxLength={256} disabled={disabled} onChange={(event) => onChange({ ...step, name: event.currentTarget.value })} />
        </Field>
        <Field label={t("Member")} required>
          <Select value={member} disabled={disabled} onChange={(event) => onChange(setWorkflowTemplateMember(step, event.currentTarget.value))}>
            <option value="" disabled>{t("Select teammate")}</option>
            {member && !knownMember ? <option value={member}>{step.teammateTemplateId ?? step.councilSlotKey ?? t("Unavailable member: {id}", { id: step.teammateId ?? "" })}</option> : null}
            {teammates.map((teammate) => <option key={teammate.id} value={`teammate:${teammate.id}`} disabled={teammate.status !== "active" || teammate.hidden}>{teammate.displayName}</option>)}
          </Select>
        </Field>
      </div>
      <Field label={t("Prompt")} required>
        <Textarea rows={4} value={step.prompt} maxLength={65_536} disabled={disabled} onChange={(event) => onChange({ ...step, prompt: event.currentTarget.value })} />
      </Field>
      {steps.length > 1 ? (
        <fieldset className="workflow-template-checklist">
          <legend>{t("Depends on")}</legend>
          {steps.filter((candidate) => candidate.id !== step.id).map((candidate) => {
            const selected = step.dependsOn?.includes(candidate.id) ?? false;
            return <Checkbox key={candidate.id} label={candidate.name || candidate.id} checked={selected}
              disabled={disabled || !selected && workflowTemplateDependencyWouldCycle(steps, step.id, candidate.id)}
              onChange={() => onChange({ ...step, dependsOn: toggleWorkflowTemplateValue(step.dependsOn ?? [], candidate.id) })} />;
          })}
        </fieldset>
      ) : null}
      <div className="workflow-template-fields workflow-template-fields--pair">
        <Field label={t("Side-effect class")}>
          <Select value={step.sideEffectClass ?? ""} disabled={disabled} onChange={(event) => {
            const { sideEffectClass: _class, parallelPolicy: policy, ...rest } = step;
            const value = event.currentTarget.value as CustomWorkflowTemplateStep["sideEffectClass"];
            onChange({ ...rest, ...(value ? { sideEffectClass: value } : {}), ...(policy && value ? { parallelPolicy: {
              ...policy, autoParallel: value === "external_mutation" || value === "release" ? false : policy.autoParallel,
              ...(value === "test_artifact_only" && policy.autoParallel ? { requiresArtifactOnly: true } : {}),
            } } : {}) });
          }}>
            <option value="">{t("Unclassified")}</option>
            {sideEffects.map(([value, label]) => <option value={value} key={value}>{t(label)}</option>)}
          </Select>
        </Field>
        <Field label={t("Parallel sibling limit")}>
          <Input type="number" min={1} max={128} step={1} value={step.parallelPolicy?.maxParallelSiblings ?? step.maxParallelSiblings ?? ""} disabled={disabled}
            onChange={(event) => parallel({ maxParallelSiblings: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} />
        </Field>
      </div>
      <div className="workflow-template-checks">
        <Checkbox label={t("Automatic parallel execution")} checked={step.parallelPolicy?.autoParallel ?? false} disabled={disabled || !automaticParallelAllowed}
          onChange={(event) => parallel({ autoParallel: event.currentTarget.checked, ...(event.currentTarget.checked && step.sideEffectClass === "test_artifact_only" ? { requiresArtifactOnly: true } : {}) })} />
        <Checkbox label={t("Artifact-only execution")} checked={step.parallelPolicy?.requiresArtifactOnly ?? false} disabled={disabled}
          onChange={(event) => parallel({ requiresArtifactOnly: event.currentTarget.checked, ...(!event.currentTarget.checked && step.sideEffectClass === "test_artifact_only" ? { autoParallel: false } : {}) })} />
        <Checkbox label={t("Cancel siblings on failure")} checked={step.parallelPolicy?.cancelSiblingsOnFailure ?? false} disabled={disabled}
          onChange={(event) => parallel({ cancelSiblingsOnFailure: event.currentTarget.checked })} />
        <Checkbox label={t("Auto-start step")} checked={step.autoStart ?? false} disabled={disabled} onChange={(event) => onChange({ ...step, autoStart: event.currentTarget.checked })} />
      </div>
      <details className="workflow-template-details">
        <summary>{t("Resource keys")}</summary>
        <div className="workflow-template-resources">
          {resources.map((resource, resourceIndex) => (
            <div className="workflow-template-resource" key={resourceIndex}>
              <Input aria-label={t("Resource key {index}", { index: resourceIndex + 1 })} value={resource} maxLength={256} disabled={disabled}
                onChange={(event) => parallel({ resourceKeys: resources.map((value, itemIndex) => itemIndex === resourceIndex ? event.currentTarget.value : value) })} />
              <IconButton icon={Trash2} label={t("Remove resource key")} variant="danger" disabled={disabled} onClick={() => parallel({ resourceKeys: resources.filter((_, itemIndex) => itemIndex !== resourceIndex) })} />
            </div>
          ))}
          <Button size="sm" leadingIcon={<Plus size={14} />} disabled={disabled || resources.length >= 32} onClick={() => parallel({ resourceKeys: [...resources, ""] })}>{t("Add resource key")}</Button>
        </div>
      </details>
      <WorkflowTemplateGateEditor gates={step.gates ?? []} disabled={disabled} onChange={(gates) => onChange({ ...step, gates })} t={t} />
    </article>
  );
}

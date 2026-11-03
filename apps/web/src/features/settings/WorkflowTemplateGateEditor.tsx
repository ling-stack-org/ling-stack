import type { WorkflowStepGate } from "@ling-stack/contracts";
import { Plus, Trash2 } from "lucide-react";
import { Checkbox, Field, IconButton, Input, Select, Textarea } from "../../shared/ui/index.js";
import { approvalActionLabel, toolLabel } from "./skill-editor-labels.js";
import { skillEditorApprovalActionOptions, skillEditorToolOptions } from "./skill-editor-utils.js";
import type { SettingsTranslator } from "./skill-library-utils.js";
import { newWorkflowTemplateGate, toggleWorkflowTemplateValue } from "./workflow-template-authoring-model.js";

const gateStatuses = ["queued", "claimed", "running", "waiting_for_approval", "waiting_for_input", "blocked", "succeeded", "failed", "skipped", "cancelled"] as const;

export function WorkflowTemplateGateEditor({ gates, disabled, onChange, t }: {
  readonly gates: readonly WorkflowStepGate[];
  readonly disabled: boolean;
  readonly onChange: (gates: readonly WorkflowStepGate[]) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  function replace(index: number, gate: WorkflowStepGate): void {
    onChange(gates.map((current, itemIndex) => itemIndex === index ? gate : current));
  }
  return (
    <div className="workflow-template-gates">
      {(["pre", "post"] as const).map((stage) => (
        <section className="workflow-template-gate-stage" key={stage} aria-label={t(stage === "pre" ? "Pre-approval" : "Post-approval")}>
          <header className="workflow-template-section-head">
            <Checkbox
              label={t(stage === "pre" ? "Pre-approval" : "Post-approval")}
              checked={gates.some((gate) => gate.stage === stage)}
              disabled={disabled}
              onChange={(event) => onChange(event.currentTarget.checked ? [...gates, newWorkflowTemplateGate(stage)] : gates.filter((gate) => gate.stage !== stage))}
            />
            {gates.some((gate) => gate.stage === stage) ? (
              <IconButton icon={Plus} label={t("Add approval gate")} size="sm" disabled={disabled || gates.length >= 16} onClick={() => onChange([...gates, newWorkflowTemplateGate(stage)])} />
            ) : null}
          </header>
          {gates.map((gate, index) => gate.stage !== stage ? null : (
            <div className="workflow-template-gate-fields" key={`${stage}-${index}`}>
              <div className="workflow-template-fields workflow-template-fields--gate">
                <Field label={t("Approval title")} required>
                  <Input value={gate.title} maxLength={256} disabled={disabled} onChange={(event) => replace(index, { ...gate, title: event.currentTarget.value })} />
                </Field>
                <Field label={t("Approval mode")}>
                  <Select value={gate.approvalProfile.mode} disabled={disabled} onChange={(event) => replace(index, { ...gate, approvalProfile: { ...gate.approvalProfile, mode: event.currentTarget.value as WorkflowStepGate["approvalProfile"]["mode"] } })}>
                    <option value="none">{t("None")}</option>
                    <option value="standard">{t("Standard")}</option>
                    <option value="strict">{t("Strict")}</option>
                  </Select>
                </Field>
                <IconButton icon={Trash2} label={t("Remove approval gate")} variant="danger" disabled={disabled} onClick={() => onChange(gates.filter((_, itemIndex) => itemIndex !== index))} />
              </div>
              <Field label={t("Approval reason")} required>
                <Textarea rows={2} value={gate.reason} maxLength={8192} disabled={disabled} onChange={(event) => replace(index, { ...gate, reason: event.currentTarget.value })} />
              </Field>
              <details className="workflow-template-details">
                <summary>{t("Approval conditions")}</summary>
                <div className="workflow-template-fields">
                  <Field label={t("Risk level")}>
                    <Select value={gate.approvalProfile.risk ?? ""} disabled={disabled} onChange={(event) => {
                      const { risk: _risk, ...profile } = gate.approvalProfile;
                      replace(index, { ...gate, approvalProfile: { ...profile, ...(event.currentTarget.value ? { risk: event.currentTarget.value as NonNullable<WorkflowStepGate["approvalProfile"]["risk"]> } : {}) } });
                    }}>
                      <option value="">{t("Use action risk")}</option>
                      <option value="low">{t("Low")}</option>
                      <option value="medium">{t("Medium")}</option>
                      <option value="high">{t("High")}</option>
                      <option value="critical">{t("Critical")}</option>
                    </Select>
                  </Field>
                  <fieldset className="workflow-template-checklist">
                    <legend>{t("Tools that require approval")}</legend>
                    {skillEditorToolOptions.map((tool) => (
                      <Checkbox key={tool} label={t(toolLabel(tool))} checked={gate.approvalProfile.requiredForTools?.includes(tool) ?? false} disabled={disabled}
                        onChange={() => replace(index, { ...gate, approvalProfile: { ...gate.approvalProfile, requiredForTools: toggleWorkflowTemplateValue(gate.approvalProfile.requiredForTools ?? [], tool) } })} />
                    ))}
                  </fieldset>
                  <fieldset className="workflow-template-checklist">
                    <legend>{t("Actions that require approval")}</legend>
                    {skillEditorApprovalActionOptions.map((action) => (
                      <Checkbox key={action} label={t(approvalActionLabel(action))} checked={gate.approvalProfile.requiredForActions?.includes(action) ?? false} disabled={disabled}
                        onChange={() => replace(index, { ...gate, approvalProfile: { ...gate.approvalProfile, requiredForActions: toggleWorkflowTemplateValue(gate.approvalProfile.requiredForActions ?? [], action) } })} />
                    ))}
                  </fieldset>
                  <fieldset className="workflow-template-checklist">
                    <legend>{t("Required statuses")}</legend>
                    {gateStatuses.map((status) => (
                      <Checkbox key={status} label={status} checked={gate.requiredForStatuses?.includes(status) ?? false} disabled={disabled}
                        onChange={() => replace(index, { ...gate, requiredForStatuses: toggleWorkflowTemplateValue(gate.requiredForStatuses ?? [], status) })} />
                    ))}
                  </fieldset>
                </div>
              </details>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

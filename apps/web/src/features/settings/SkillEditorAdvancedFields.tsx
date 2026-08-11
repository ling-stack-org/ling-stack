import type { ApprovalRisk } from "../../types.js";
import {
  Field,
  InspectorSection,
  SegmentedControl,
  SegmentedControlItem,
  Select,
} from "../../shared/ui/index.js";
import {
  approvalActionLabel,
  approvalModeLabel,
  providerCapabilityLabel,
  toolLabel,
} from "./skill-editor-labels.js";
import {
  skillEditorApprovalActionOptions,
  skillEditorProviderCapabilityOptions,
  skillEditorToolOptions,
  type SkillEditorForm,
} from "./skill-editor-utils.js";
import type { SettingsTranslator } from "./skill-library-utils.js";

export function SkillEditorAdvancedFields({
  form,
  busy,
  onFormChange,
  t,
}: {
  readonly form: SkillEditorForm;
  readonly busy: boolean;
  readonly onFormChange: (form: SkillEditorForm) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  return (
    <InspectorSection
      className="settings-skill-editor-advanced"
      title={t("Advanced configuration")}
      summary={t("Tools, model capabilities, and approvals")}
    >
      <div className="settings-skill-editor-advanced-body">
        <OptionChecklist
          title={t("Required tools")}
          values={skillEditorToolOptions}
          selected={form.requiredTools}
          disabled={busy}
          label={(value) => t(toolLabel(value))}
          onToggle={(value) => onFormChange({ ...form, requiredTools: toggleValue(form.requiredTools, value) })}
        />
        <OptionChecklist
          title={t("Model capabilities")}
          values={skillEditorProviderCapabilityOptions}
          selected={form.requiredProviderCapabilities}
          disabled={busy}
          label={(value) => t(providerCapabilityLabel(value))}
          onToggle={(value) => onFormChange({
            ...form,
            requiredProviderCapabilities: toggleValue(form.requiredProviderCapabilities, value),
          })}
        />
        <ApprovalEditor form={form} busy={busy} onFormChange={onFormChange} t={t} />
      </div>
    </InspectorSection>
  );
}

function ApprovalEditor({
  form,
  busy,
  onFormChange,
  t,
}: {
  readonly form: SkillEditorForm;
  readonly busy: boolean;
  readonly onFormChange: (form: SkillEditorForm) => void;
  readonly t: SettingsTranslator;
}): React.JSX.Element {
  return (
    <section className="settings-skill-editor-option-section">
      <strong>{t("Approval policy")}</strong>
      <SegmentedControl
        className="settings-skill-approval-mode"
        value={form.approvalMode}
        onValueChange={(mode) => onFormChange({
          ...form,
          approvalMode: mode as SkillEditorForm["approvalMode"],
          ...(mode === "none" ? {
            approvalRisk: "",
            approvalRequiredForTools: [],
            approvalRequiredForActions: [],
          } : {}),
        })}
        size="sm"
        aria-label={t("Approval mode")}
        disabled={busy}
      >
        {(["none", "standard", "strict"] as const).map((mode) => (
          <SegmentedControlItem key={mode} value={mode} disabled={busy}>
            {t(approvalModeLabel(mode))}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      {form.approvalMode !== "none" ? (
        <div className="settings-skill-approval-details">
          <Field label={t("Risk level")}>
            <Select
              value={form.approvalRisk}
              onChange={(event) => onFormChange({ ...form, approvalRisk: event.currentTarget.value as ApprovalRisk | "" })}
              disabled={busy}
            >
              <option value="">{t("Use action risk")}</option>
              <option value="low">{t("Low")}</option>
              <option value="medium">{t("Medium")}</option>
              <option value="high">{t("High")}</option>
              <option value="critical">{t("Critical")}</option>
            </Select>
          </Field>
          <OptionChecklist
            title={t("Tools that require approval")}
            values={skillEditorToolOptions}
            selected={form.approvalRequiredForTools}
            disabled={busy}
            label={(value) => t(toolLabel(value))}
            onToggle={(value) => onFormChange({
              ...form,
              approvalRequiredForTools: toggleValue(form.approvalRequiredForTools, value),
            })}
          />
          <OptionChecklist
            title={t("Actions that require approval")}
            values={skillEditorApprovalActionOptions}
            selected={form.approvalRequiredForActions}
            disabled={busy}
            label={(value) => t(approvalActionLabel(value))}
            onToggle={(value) => onFormChange({
              ...form,
              approvalRequiredForActions: toggleValue(form.approvalRequiredForActions, value),
            })}
          />
        </div>
      ) : null}
    </section>
  );
}

function OptionChecklist<T extends string>({
  title,
  values,
  selected,
  disabled,
  label,
  onToggle,
}: {
  readonly title: string;
  readonly values: readonly T[];
  readonly selected: readonly T[];
  readonly disabled: boolean;
  readonly label: (value: T) => string;
  readonly onToggle: (value: T) => void;
}): React.JSX.Element {
  return (
    <section className="settings-skill-editor-option-section">
      <strong>{title}</strong>
      <div className="settings-skill-editor-options">
        {values.map((value) => (
          <label key={value}>
            <input data-ling-control-native="true" type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} disabled={disabled} />
            <span>{label(value)}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

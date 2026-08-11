import type { MediaWorkflowInputField, RunArtifact } from "../../../types.js";
import { useI18n } from "../../../i18n.js";
import { Checkbox, Field, Input, Select } from "../../../shared/ui/index.js";

export function WorkflowFieldRenderer({
  fields,
  values,
  imageArtifacts = [],
  disabled = false,
  hiddenSemantics = [],
  onChange,
}: {
  readonly fields: readonly MediaWorkflowInputField[];
  readonly values: Record<string, unknown>;
  readonly imageArtifacts?: readonly RunArtifact[];
  readonly disabled?: boolean;
  readonly hiddenSemantics?: readonly MediaWorkflowInputField["semantic"][];
  readonly onChange: (fieldId: string, value: unknown) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const visibleFields = fields.filter((field) => !hiddenSemantics.includes(field.semantic));
  if (visibleFields.length === 0) return <p className="media-workflow-muted">{t("No additional parameters")}</p>;

  return (
    <div className="media-workflow-field-grid">
      {visibleFields.map((field) => {
        const value = values[field.id] ?? field.defaultValue ?? "";
        if (field.kind === "boolean") {
          return (
            <Checkbox
              key={field.id}
              checked={value === true}
              disabled={disabled}
              label={field.label}
              required={field.required}
              onChange={(event) => onChange(field.id, event.target.checked)}
            />
          );
        }
        if (field.kind === "select") {
          return (
            <Field key={field.id} label={field.label} required={field.required}>
              <Select value={String(value)} disabled={disabled} onChange={(event) => onChange(field.id, event.target.value)}>
                {!field.required ? <option value="">{t("Not set")}</option> : null}
                {(field.options ?? []).map((option) => <option value={option} key={option}>{option}</option>)}
              </Select>
            </Field>
          );
        }
        if (field.kind === "image_artifact") {
          return (
            <Field key={field.id} label={field.label} required={field.required}>
              <Select value={String(value)} disabled={disabled} onChange={(event) => onChange(field.id, event.target.value)}>
                <option value="">{t("No reference image")}</option>
                {imageArtifacts.map((artifact) => (
                  <option value={artifact.id} key={artifact.id}>{artifact.title || t("Image result")}</option>
                ))}
              </Select>
            </Field>
          );
        }
        return (
          <Field key={field.id} label={field.label} required={field.required}>
            <Input
              type={field.kind === "number" ? "number" : "text"}
              value={String(value)}
              disabled={disabled}
              onChange={(event) => onChange(
                field.id,
                field.kind === "number" ? numberValue(event.target.value) : event.target.value,
              )}
            />
          </Field>
        );
      })}
    </div>
  );
}

function numberValue(value: string): number | "" {
  if (!value.trim()) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "";
}

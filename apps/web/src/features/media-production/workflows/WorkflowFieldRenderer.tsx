import type { MediaWorkflowInputField, RunArtifact } from "../../../types.js";
import { SelectControl } from "../../../shared/components/SelectControl.js";

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
}): JSX.Element {
  const visibleFields = fields.filter((field) => !hiddenSemantics.includes(field.semantic));
  if (visibleFields.length === 0) {
    return <p className="media-workflow-muted">这个流程没有额外参数。</p>;
  }
  return (
    <div className="media-workflow-field-grid">
      {visibleFields.map((field) => {
        const value = values[field.id] ?? field.defaultValue ?? "";
        if (field.kind === "boolean") {
          return (
            <label className="media-workflow-toggle-row" key={field.id}>
              <span>{field.label}{field.required ? " *" : ""}</span>
              <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(field.id, event.target.checked)} />
            </label>
          );
        }
        if (field.kind === "select") {
          return (
            <label className="field" key={field.id}>
              <span>{field.label}{field.required ? " *" : ""}</span>
              <SelectControl value={String(value)} disabled={disabled} onChange={(event) => onChange(field.id, event.target.value)}>
                {!field.required ? <option value="">不设置</option> : null}
                {(field.options ?? []).map((option) => <option value={option} key={option}>{option}</option>)}
              </SelectControl>
            </label>
          );
        }
        if (field.kind === "image_artifact") {
          return (
            <label className="field" key={field.id}>
              <span>{field.label}{field.required ? " *" : ""}</span>
              <SelectControl value={String(value)} disabled={disabled} onChange={(event) => onChange(field.id, event.target.value)}>
                <option value="">不使用参考图片</option>
                {imageArtifacts.map((artifact) => <option value={artifact.id} key={artifact.id}>{artifact.title || "图片结果"}</option>)}
              </SelectControl>
            </label>
          );
        }
        return (
          <label className="field" key={field.id}>
            <span>{field.label}{field.required ? " *" : ""}</span>
            <input
              type={field.kind === "number" ? "number" : "text"}
              value={String(value)}
              disabled={disabled}
              onChange={(event) => onChange(field.id, field.kind === "number" ? numberValue(event.target.value) : event.target.value)}
            />
          </label>
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

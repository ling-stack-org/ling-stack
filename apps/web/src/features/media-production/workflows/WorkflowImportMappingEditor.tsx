import type { MediaWorkflowInputField, MediaWorkflowOutputRule } from "../../../types.js";
import { useI18n } from "../../../i18n.js";
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DataRow,
  Field,
  InlineFeedback,
  Input,
  Select,
  StatusIndicator,
} from "../../../shared/ui/index.js";
import type { MediaWorkflowImportDraft, MediaWorkflowTranslationDescriptor } from "./media-workflow-types.js";
import { deriveMediaWorkflowImportValidation } from "./media-workflow-view-models.js";

const semantics: readonly { readonly value: MediaWorkflowInputField["semantic"]; readonly labelKey: string }[] = [
  { value: "prompt", labelKey: "Prompt" },
  { value: "negative_prompt", labelKey: "Negative prompt" },
  { value: "ratio", labelKey: "Aspect ratio" },
  { value: "duration", labelKey: "Duration" },
  { value: "seed", labelKey: "Seed" },
  { value: "reference_image", labelKey: "Reference image" },
  { value: "custom", labelKey: "Custom parameter" },
];

export function WorkflowImportMappingEditor({
  draft,
  disabled,
  onChange,
}: {
  readonly draft: MediaWorkflowImportDraft;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<Pick<MediaWorkflowImportDraft, "name" | "description" | "inputFields" | "outputRules">>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const validation = deriveMediaWorkflowImportValidation(draft);
  return (
    <div className="media-workflow-import-editor">
      <InlineFeedback
        className="media-workflow-validation"
        title={t(validation.canImport ? "Workflow mapping is ready" : "Workflow mapping needs attention")}
        tone={validation.canImport ? "success" : "warning"}
      >
        <div className="media-workflow-validation-summary">
          <StatusIndicator label={t("{count} node types", { count: draft.analysis.nodeClasses.length })} tone="neutral" />
          <StatusIndicator label={t("{count} inputs", { count: draft.inputFields.length })} tone="info" />
          <StatusIndicator label={t("{count} outputs", { count: draft.outputRules.length })} tone="info" />
        </div>
        {validation.issues.length || validation.technicalMessages.length || draft.analysis.validation.warnings.length ? (
          <DiagnosticDetails issues={validation.issues} technicalMessages={[...validation.technicalMessages, ...draft.analysis.validation.warnings]} />
        ) : null}
      </InlineFeedback>

      <div className="media-workflow-form-row two-columns">
        <Field label={t("Workflow name")} required>
          <Input value={draft.name} disabled={disabled} onChange={(event) => onChange({ name: event.target.value })} />
        </Field>
        <Field label={t("Description")}>
          <Input value={draft.description} disabled={disabled} onChange={(event) => onChange({ description: event.target.value })} />
        </Field>
      </div>

      <section className="media-workflow-mapping-section" aria-labelledby="workflow-input-mapping-title">
        <div className="media-workflow-section-head">
          <div><strong id="workflow-input-mapping-title">{t("Input mapping")}</strong><span>{t("Only fields needed for scene production are exposed.")}</span></div>
        </div>
        <div className="media-workflow-mapping-list" role="list">
          {draft.inputFields.map((inputField, index) => (
            <DataRow
              className="media-workflow-mapping-row"
              compact
              key={inputField.id}
              identity={(
                <Field label={t("Input {number} name", { number: index + 1 })}>
                  <Input
                    value={inputField.label}
                    disabled={disabled}
                    onChange={(event) => onChange({
                      inputFields: replaceAt(draft.inputFields, index, { ...inputField, label: event.target.value }),
                    })}
                  />
                </Field>
              )}
              summary={(
                <Field label={t("Input {number} purpose", { number: index + 1 })}>
                  <Select
                    value={inputField.semantic}
                    disabled={disabled}
                    onChange={(event) => onChange({
                      inputFields: replaceAt(draft.inputFields, index, {
                        ...inputField,
                        semantic: event.target.value as MediaWorkflowInputField["semantic"],
                      }),
                    })}
                  >
                    {semantics.map((item) => <option value={item.value} key={item.value}>{t(item.labelKey)}</option>)}
                  </Select>
                </Field>
              )}
              status={(
                <Checkbox
                  checked={inputField.required}
                  disabled={disabled}
                  label={t("Required")}
                  onChange={(event) => onChange({
                    inputFields: replaceAt(draft.inputFields, index, { ...inputField, required: event.target.checked }),
                  })}
                />
              )}
              actions={<NodeDetails label={t("Node field")} value={`${inputField.nodeId} / ${inputField.inputName}`} />}
            />
          ))}
        </div>
      </section>

      <section className="media-workflow-mapping-section" aria-labelledby="workflow-output-mapping-title">
        <div className="media-workflow-section-head">
          <div><strong id="workflow-output-mapping-title">{t("Output results")}</strong><span>{t("Choose the media Ling should collect from this workflow.")}</span></div>
        </div>
        <div className="media-workflow-mapping-list" role="list">
          {draft.outputRules.map((rule, index) => (
            <DataRow
              className="media-workflow-mapping-row output"
              compact
              key={`${rule.nodeId}:${index}`}
              identity={<strong>{t("Output {number}", { number: index + 1 })}</strong>}
              summary={(
                <>
                  <Select
                    aria-label={t("Output {number} type", { number: index + 1 })}
                    value={rule.artifactType}
                    disabled={disabled}
                    onChange={(event) => onChange({
                      outputRules: replaceAt(draft.outputRules, index, {
                        ...rule,
                        artifactType: event.target.value as MediaWorkflowOutputRule["artifactType"],
                      }),
                    })}
                  >
                    <option value="video">{t("Video")}</option>
                    <option value="image">{t("Image")}</option>
                  </Select>
                  <Select
                    aria-label={t("Output {number} collection", { number: index + 1 })}
                    value={rule.collect}
                    disabled={disabled}
                    onChange={(event) => onChange({
                      outputRules: replaceAt(draft.outputRules, index, {
                        ...rule,
                        collect: event.target.value as MediaWorkflowOutputRule["collect"],
                      }),
                    })}
                  >
                    <option value="all">{t("Collect all")}</option>
                    <option value="first">{t("First only")}</option>
                  </Select>
                </>
              )}
              actions={<NodeDetails label={t("Output node")} value={rule.nodeId} />}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function DiagnosticDetails({ issues, technicalMessages }: { readonly issues: readonly MediaWorkflowTranslationDescriptor[]; readonly technicalMessages: readonly string[] }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Collapsible>
      <CollapsibleTrigger asChild><Button size="sm" variant="ghost">{t("Technical details")}</Button></CollapsibleTrigger>
      <CollapsibleContent>
        {issues.map((issue) => <p key={`issue:${issue.key}`}>{t(issue.key, issue.values)}</p>)}
        {technicalMessages.map((message) => <p key={`technical:${message}`}>{message}</p>)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function NodeDetails({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild><Button size="sm" variant="ghost">{label}</Button></CollapsibleTrigger>
      <CollapsibleContent><code>{value}</code></CollapsibleContent>
    </Collapsible>
  );
}

function replaceAt<T>(items: readonly T[], index: number, value: T): readonly T[] {
  return items.map((item, itemIndex) => itemIndex === index ? value : item);
}

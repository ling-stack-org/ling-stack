import { forwardRef, useEffect, useRef, useState } from "react";
import { Archive, FileJson, Play, Plus, Workflow, X } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DataRow,
  EmptyState,
  IconButton,
  InlineFeedback,
  StatusIndicator,
} from "../../../shared/ui/index.js";
import type { MediaJob, MediaWorkflowDefinitionDetail, RunArtifact } from "../../../types.js";
import type { MediaWorkflowControllerActions, MediaWorkflowControllerState, MediaWorkflowFailure } from "./media-workflow-types.js";
import {
  deriveMediaWorkflowImportValidation,
  isMediaWorkflowImportBusy,
  isMediaWorkflowBusy,
  isMediaWorkflowSubjectBusy,
  selectMediaWorkflowFailure,
  workflowStatusView,
  workflowTestStatusView,
} from "./media-workflow-view-models.js";
import { WorkflowFieldRenderer } from "./WorkflowFieldRenderer.js";
import { WorkflowImportMappingEditor } from "./WorkflowImportMappingEditor.js";

export function WorkflowLibraryWorkspace({ state, actions, mediaJobs, imageArtifacts, onOpenConnections }: {
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
  readonly mediaJobs: readonly MediaJob[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly onOpenConnections: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selected = state.workflows.find((item) => item.definition.id === state.selectedWorkflowId);
  const selectedConnectionId = state.selectedConnectionId || state.connections.find((item) => item.status !== "disabled")?.id || "";
  const analyzeFailure = selectMediaWorkflowFailure(state.failures, "import-analyze", selectedConnectionId || "unselected");
  const analyzing = isMediaWorkflowBusy(state, "import-analyze", selectedConnectionId || "unselected");
  const importBusy = isMediaWorkflowImportBusy(state);

  function chooseFile(): void {
    if (state.connections.length === 0) { onOpenConnections(); return; }
    if (!importBusy) fileInputRef.current?.click();
  }

  if (state.workflows.length === 0 && !state.importDraft) {
    return (
      <div className="media-workflow-onboarding">
        <WorkflowFileInput ref={fileInputRef} disabled={importBusy} onFile={(file) => void actions.inspectImportFile(file, selectedConnectionId)} />
        <EmptyState
          icon={<FileJson size={28} />}
          title={t("Import your first production workflow")}
          description={t("Ling checks the workflow and output mapping before anything runs.")}
          action={<Button leadingIcon={<FileJson size={15} />} loading={analyzing} variant="primary" onClick={chooseFile}>{t("Import workflow")}</Button>}
          secondaryAction={state.connections.length === 0 ? <Button onClick={onOpenConnections}>{t("Create connection")}</Button> : undefined}
        />
        {analyzeFailure ? <WorkflowFailure failure={analyzeFailure} onClear={() => actions.clearFailure("import-analyze", analyzeFailure.subjectId)} /> : null}
      </div>
    );
  }

  return (
    <div className="media-workflow-split-view workflow-library-workspace">
      <WorkflowFileInput ref={fileInputRef} disabled={importBusy} onFile={(file) => void actions.inspectImportFile(file, selectedConnectionId)} />
      <div className="media-workflow-list-pane">
        <div className="media-workflow-list-head">
          <div><strong>{t("Production workflows")}</strong><span>{t("{count} available", { count: state.workflows.filter((item) => item.definition.status !== "archived").length })}</span></div>
          <div className="media-workflow-list-actions">
            {state.importDraft && state.libraryDetail !== "import" ? <Button size="sm" variant="ghost" onClick={actions.showImportDraft}>{t("Resume import")}</Button> : null}
            <IconButton disabled={importBusy} icon={Plus} label={t("Import workflow")} onClick={chooseFile} />
          </div>
        </div>
        {analyzeFailure ? <WorkflowFailure failure={analyzeFailure} onClear={() => actions.clearFailure("import-analyze", analyzeFailure.subjectId)} /> : null}
        <div className="media-workflow-list-scroll" role="listbox" aria-label={t("Production workflows")}>
          {state.workflows.map((item) => {
            const status = workflowStatusView(item);
            return (
              <DataRow
                compact
                className="media-workflow-list-row"
                data-archived={item.definition.status === "archived" || undefined}
                identity={<><Workflow size={16} /><strong>{item.definition.name}</strong></>}
                key={item.definition.id}
                selected={state.libraryDetail === "workflow" && item.definition.id === selected?.definition.id}
                status={<StatusIndicator compact label={t(status.label.key, status.label.values)} tone={status.tone} />}
                summary={item.definition.description}
                onClick={() => actions.selectWorkflow(item.definition.id)}
              />
            );
          })}
        </div>
      </div>
      <div className="media-workflow-detail-pane">
        {state.importDraft && state.libraryDetail === "import" ? (
          <ImportDetail state={state} actions={actions} />
        ) : selected ? (
          <WorkflowDetail workflow={selected} mediaJobs={mediaJobs} imageArtifacts={imageArtifacts} state={state} actions={actions} />
        ) : (
          <EmptyState compact icon={<Workflow size={28} />} title={t("Select a production workflow")} description={t("Review its inputs, test status, and active version.")} />
        )}
      </div>
    </div>
  );
}

const WorkflowFileInput = forwardRef<HTMLInputElement, { readonly disabled: boolean; readonly onFile: (file: File) => void }>(function WorkflowFileInput({ disabled, onFile }, ref) {
  return <input ref={ref} className="media-workflow-file-input" data-ling-control-native="true" type="file" accept="application/json,.json" hidden disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.currentTarget.value = ""; }} />;
});

function ImportDetail({ state, actions }: { readonly state: MediaWorkflowControllerState; readonly actions: MediaWorkflowControllerActions }): React.JSX.Element {
  const { t } = useI18n();
  const draft = state.importDraft!;
  const validation = deriveMediaWorkflowImportValidation(draft);
  const busy = isMediaWorkflowBusy(state, "import-save", draft.connectionId) || isMediaWorkflowBusy(state, "import-analyze", draft.connectionId);
  const failure = selectMediaWorkflowFailure(state.failures, "import-save", draft.connectionId);
  return (
    <>
      <div className="media-workflow-detail-head"><div><span className="media-workflow-eyebrow">{t("Import production workflow")}</span><h3>{draft.fileName}</h3></div></div>
      <div className="media-workflow-detail-scroll"><WorkflowImportMappingEditor draft={draft} disabled={busy} onChange={actions.updateImportDraft} />{failure ? <WorkflowFailure failure={failure} onClear={() => actions.clearFailure("import-save", draft.connectionId)} /> : null}</div>
      <div className="media-workflow-detail-actions"><Button disabled={busy} onClick={actions.cancelImport}>{t("Cancel")}</Button><Button loading={busy} disabled={!validation.canImport} variant="primary" onClick={() => void actions.saveImport()}>{t("Import workflow")}</Button></div>
    </>
  );
}

function WorkflowDetail({ workflow, mediaJobs, imageArtifacts, state, actions }: {
  readonly workflow: MediaWorkflowDefinitionDetail;
  readonly mediaJobs: readonly MediaJob[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
}): React.JSX.Element {
  const { t } = useI18n();
  const version = workflow.versions[0];
  const testJob = version?.testMediaJobId ? mediaJobs.find((job) => job.id === version.testMediaJobId) : undefined;
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() => defaultInputValues(version?.inputFields ?? []));
  useEffect(() => { setInputValues(defaultInputValues(version?.inputFields ?? [])); }, [workflow.definition.id, version?.id]);
  const testBusy = isMediaWorkflowBusy(state, "workflow-test", workflow.definition.id);
  const activateBusy = isMediaWorkflowBusy(state, "workflow-activate", workflow.definition.id);
  const archiveBusy = isMediaWorkflowBusy(state, "workflow-archive", workflow.definition.id);
  const subjectBusy = isMediaWorkflowSubjectBusy(state, "workflow", workflow.definition.id);
  const status = workflowStatusView(workflow);
  const testStatus = workflowTestStatusView(testJob);
  const canTest = Boolean(version?.validation.ok && requiredFieldsReady(version.inputFields, inputValues));
  const canActivate = Boolean(version && testJob?.status === "succeeded" && workflow.definition.currentVersionId !== version.id);
  const failure = state.failures.find((item) => item.subjectId === workflow.definition.id && item.owner.startsWith("workflow-"));
  return (
    <>
      <div className="media-workflow-detail-head"><div><span className="media-workflow-eyebrow">{t("Production workflow")}</span><h3>{workflow.definition.name}</h3><p>{workflow.definition.description}</p></div><StatusIndicator label={t(status.label.key, status.label.values)} tone={status.tone} /></div>
      <div className="media-workflow-detail-scroll">
        {version ? <>
          <section className="media-workflow-detail-section"><div className="media-workflow-section-head"><div><strong>{t("Test inputs")}</strong><span>{t("Runs one real generation using the mapped workflow.")}</span></div><span>{t("Version {number}", { number: version.version })}</span></div><WorkflowFieldRenderer fields={version.inputFields} values={inputValues} imageArtifacts={imageArtifacts} disabled={subjectBusy} onChange={(fieldId, value) => setInputValues((current) => ({ ...current, [fieldId]: value }))} /><div className="media-workflow-test-row"><StatusIndicator label={t(testStatus.label.key, testStatus.label.values)} tone={testStatus.tone} /><Button leadingIcon={<Play size={15} />} loading={testBusy} disabled={!canTest || subjectBusy} onClick={() => void actions.testWorkflow(workflow.definition.id, version.id, inputValues)}>{t("Run test")}</Button></div>{testJob?.status === "failed" && testJob.errorMessage ? <DiagnosticDetails value={testJob.errorMessage} /> : null}</section>
          <section className="media-workflow-detail-section"><div className="media-workflow-section-head"><div><strong>{t("Scene fields")}</strong><span>{t("{count} mapped inputs", { count: version.inputFields.length })}</span></div></div><div className="media-workflow-field-summary">{version.inputFields.map((field) => <span key={field.id}>{field.label}{field.required ? " *" : ""}</span>)}{version.inputFields.length === 0 ? <span>{t("No additional inputs")}</span> : null}</div></section>
          {version.validation.errors.length || version.validation.warnings.length ? <DiagnosticDetails value={[...version.validation.errors, ...version.validation.warnings].join("\n")} /> : null}
        </> : <EmptyState compact title={t("No workflow version")} description={t("Import a valid workflow version before testing.")} />}
        {failure ? <WorkflowFailure failure={failure} onClear={() => actions.clearFailure(failure.owner, failure.subjectId)} /> : null}
      </div>
      <div className="media-workflow-detail-actions"><Button leadingIcon={<Archive size={15} />} loading={archiveBusy} disabled={subjectBusy} onClick={() => void actions.archiveWorkflow(workflow.definition.id)}>{t("Archive")}</Button><Button loading={activateBusy} disabled={!canActivate || subjectBusy} variant="primary" onClick={() => version && void actions.activateWorkflow(workflow.definition.id, version.id)}>{t(workflow.definition.currentVersionId === version?.id ? "Active version" : "Activate version")}</Button></div>
    </>
  );
}

function WorkflowFailure({ failure, onClear }: { readonly failure: MediaWorkflowFailure; readonly onClear: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return <InlineFeedback role="alert" title={t(failure.productMessageKey, failure.productMessageValues)} tone="danger"><Button leadingIcon={<X size={14} />} size="sm" variant="ghost" onClick={onClear}>{t("Clear")}</Button>{failure.technicalMessage ? <DiagnosticDetails value={failure.technicalMessage} /> : null}</InlineFeedback>;
}

function DiagnosticDetails({ value }: { readonly value: string }): React.JSX.Element {
  const { t } = useI18n();
  return <Collapsible><CollapsibleTrigger asChild><Button size="sm" variant="ghost">{t("Technical details")}</Button></CollapsibleTrigger><CollapsibleContent><pre>{value}</pre></CollapsibleContent></Collapsible>;
}

function defaultInputValues(fields: MediaWorkflowDefinitionDetail["versions"][number]["inputFields"]): Record<string, unknown> { return Object.fromEntries(fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue])); }
function requiredFieldsReady(fields: MediaWorkflowDefinitionDetail["versions"][number]["inputFields"], values: Record<string, unknown>): boolean { return fields.every((field) => !field.required || !isEmpty(values[field.id] ?? field.defaultValue)); }
function isEmpty(value: unknown): boolean { return value === undefined || value === null || value === ""; }

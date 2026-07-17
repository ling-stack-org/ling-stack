import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { Archive, FileJson, Play, Plus, Workflow } from "lucide-react";
import type { MediaJob, MediaWorkflowDefinitionDetail, RunArtifact } from "../../../types.js";
import type { MediaWorkflowControllerActions, MediaWorkflowControllerState } from "./media-workflow-types.js";
import { WorkflowFieldRenderer } from "./WorkflowFieldRenderer.js";
import { WorkflowImportMappingEditor } from "./WorkflowImportMappingEditor.js";

export function WorkflowLibraryWorkspace({
  state,
  actions,
  mediaJobs,
  imageArtifacts,
  onOpenConnections,
}: {
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
  readonly mediaJobs: readonly MediaJob[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly onOpenConnections: () => void;
}): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeWorkflows = state.workflows.filter((item) => item.definition.status !== "archived");
  const selected = state.workflows.find((item) => item.definition.id === state.selectedWorkflowId);
  const selectedConnectionId = state.selectedConnectionId || state.connections[0]?.id || "";

  function chooseFile(): void {
    if (state.connections.length === 0) {
      onOpenConnections();
      return;
    }
    fileInputRef.current?.click();
  }

  if (activeWorkflows.length === 0 && !state.importDraft) {
    return (
      <div className="media-workflow-onboarding">
        <WorkflowFileInput ref={fileInputRef} onFile={(file) => void actions.inspectImportFile(file, selectedConnectionId)} />
        <FileJson size={28} strokeWidth={1.6} />
        <strong>导入第一个生产流程</strong>
        <span>从 ComfyUI 导出 API Format JSON，Ling 会先检查节点和输出映射。</span>
        <button className="primary-button" type="button" onClick={chooseFile} disabled={Boolean(state.busyAction)}>导入流程</button>
      </div>
    );
  }

  return (
    <div className="media-workflow-split-view workflow-library-workspace">
      <WorkflowFileInput ref={fileInputRef} onFile={(file) => void actions.inspectImportFile(file, selectedConnectionId)} />
      <div className="media-workflow-list-pane">
        <div className="media-workflow-list-head">
          <div><strong>生产流程</strong><span>{activeWorkflows.length} 个可管理</span></div>
          <button className="icon-button" type="button" title="导入流程" aria-label="导入流程" onClick={chooseFile} disabled={Boolean(state.busyAction)}>
            <Plus size={16} />
          </button>
        </div>
        <div className="media-workflow-list-scroll">
          {activeWorkflows.map((item) => (
            <button
              className={`media-workflow-list-row${!state.importDraft && item.definition.id === selected?.definition.id ? " selected" : ""}`}
              type="button"
              key={item.definition.id}
              onClick={() => { actions.cancelImport(); actions.selectWorkflow(item.definition.id); }}
            >
              <Workflow size={16} />
              <span><strong>{item.definition.name}</strong><small>{workflowStatus(item)}</small></span>
              <i className={`media-workflow-status-dot ${item.definition.status}`} />
            </button>
          ))}
        </div>
      </div>

      <div className="media-workflow-detail-pane">
        {state.importDraft ? (
          <ImportDetail state={state} actions={actions} />
        ) : selected ? (
          <WorkflowDetail
            workflow={selected}
            mediaJobs={mediaJobs}
            imageArtifacts={imageArtifacts}
            busyAction={state.busyAction}
            actions={actions}
          />
        ) : (
          <div className="media-workflow-detail-empty">
            <Workflow size={28} />
            <strong>选择一个生产流程</strong>
            <span>查看输入字段、试运行状态和启用版本。</span>
          </div>
        )}
      </div>
    </div>
  );
}

const WorkflowFileInput = forwardRef<HTMLInputElement, { readonly onFile: (file: File) => void }>(function WorkflowFileInput({ onFile }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      accept="application/json,.json"
      hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) onFile(file);
        event.currentTarget.value = "";
      }}
    />
  );
});

function ImportDetail({
  state,
  actions,
}: {
  readonly state: MediaWorkflowControllerState;
  readonly actions: MediaWorkflowControllerActions;
}): JSX.Element {
  const draft = state.importDraft!;
  const disabled = Boolean(state.busyAction);
  return (
    <>
      <div className="media-workflow-detail-head">
        <div>
          <span className="media-workflow-eyebrow">导入生产流程</span>
          <h3>{draft.fileName}</h3>
          <p>节点检查和映射不会触发生成，也不会产生媒体费用。</p>
        </div>
      </div>
      <div className="media-workflow-detail-scroll">
        <WorkflowImportMappingEditor draft={draft} disabled={disabled} onChange={actions.updateImportDraft} />
      </div>
      <div className="media-workflow-detail-actions">
        <button className="secondary-button" type="button" disabled={disabled} onClick={actions.cancelImport}>取消</button>
        <button
          className="primary-button"
          type="button"
          disabled={disabled || !draft.analysis.validation.ok || !draft.name.trim() || draft.outputRules.length === 0}
          onClick={() => void actions.saveImport()}
        >
          {state.busyAction === "import-workflow" ? "导入中" : "导入流程"}
        </button>
      </div>
    </>
  );
}

function WorkflowDetail({
  workflow,
  mediaJobs,
  imageArtifacts,
  busyAction,
  actions,
}: {
  readonly workflow: MediaWorkflowDefinitionDetail;
  readonly mediaJobs: readonly MediaJob[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly busyAction: string;
  readonly actions: MediaWorkflowControllerActions;
}): JSX.Element {
  const version = workflow.versions[0];
  const testJob = version?.testMediaJobId ? mediaJobs.find((job) => job.id === version.testMediaJobId) : undefined;
  const [inputValues, setInputValues] = useState<Record<string, unknown>>(() => defaultInputValues(version?.inputFields ?? []));
  useEffect(() => {
    setInputValues(defaultInputValues(version?.inputFields ?? []));
  }, [workflow.definition.id, version?.id]);
  const canTest = Boolean(version?.validation.ok && requiredFieldsReady(version.inputFields, inputValues));
  const canActivate = Boolean(version && testJob?.status === "succeeded" && workflow.definition.currentVersionId !== version.id);
  const isBusy = Boolean(busyAction);
  return (
    <>
      <div className="media-workflow-detail-head">
        <div>
          <span className="media-workflow-eyebrow">{workflow.definition.status === "ready" ? "已启用" : "待验证"}</span>
          <h3>{workflow.definition.name}</h3>
          <p>{workflow.definition.description || "这个流程还没有用途说明。"}</p>
        </div>
        <span className={`media-workflow-state-pill ${workflow.definition.status}`}>{workflowLabel(workflow.definition.status)}</span>
      </div>
      <div className="media-workflow-detail-scroll">
        {version ? (
          <>
            <section className="media-workflow-detail-section">
              <div className="media-workflow-section-head">
                <div><strong>试运行输入</strong><span>真实生成一次，确认流程能返回映射的媒体结果。</span></div>
                <span>版本 {version.version}</span>
              </div>
              <WorkflowFieldRenderer
                fields={version.inputFields}
                values={inputValues}
                imageArtifacts={imageArtifacts}
                disabled={isBusy}
                onChange={(fieldId, value) => setInputValues((current) => ({ ...current, [fieldId]: value }))}
              />
              <div className="media-workflow-test-row">
                <TestStatus job={testJob} />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!canTest || isBusy}
                  onClick={() => void actions.testWorkflow(workflow.definition.id, version.id, inputValues)}
                >
                  <Play size={15} /> {busyAction === `test-workflow:${workflow.definition.id}` ? "提交中" : "试运行"}
                </button>
              </div>
            </section>
            <section className="media-workflow-detail-section">
              <div className="media-workflow-section-head">
                <div><strong>场景表单</strong><span>启用后，场景检查器将显示这些字段。</span></div>
              </div>
              <div className="media-workflow-field-summary">
                {version.inputFields.map((field) => <span key={field.id}>{field.label}{field.required ? " *" : ""}</span>)}
                {version.inputFields.length === 0 ? <span>无需额外输入</span> : null}
              </div>
            </section>
            {version.validation.errors.length || version.validation.warnings.length ? (
              <details className="media-workflow-technical-details">
                <summary>检查详情</summary>
                {version.validation.errors.map((message) => <p className="inline-error" key={message}>{message}</p>)}
                {version.validation.warnings.map((message) => <p key={message}>{message}</p>)}
              </details>
            ) : null}
          </>
        ) : <div className="media-workflow-detail-empty">这个流程还没有可用版本。</div>}
      </div>
      <div className="media-workflow-detail-actions">
        <button className="secondary-button" type="button" disabled={isBusy} onClick={() => void actions.archiveWorkflow(workflow.definition.id)}>
          <Archive size={15} /> 归档
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!canActivate || isBusy}
          onClick={() => version && void actions.activateWorkflow(workflow.definition.id, version.id)}
        >
          {workflow.definition.currentVersionId === version?.id ? "当前已启用" : "启用此版本"}
        </button>
      </div>
    </>
  );
}

function TestStatus({ job }: { readonly job?: MediaJob }): JSX.Element {
  if (!job) return <span className="media-workflow-test-status">尚未试运行</span>;
  if (job.status === "succeeded") return <span className="media-workflow-test-status success">试运行成功，可以启用</span>;
  if (job.status === "failed") return <span className="media-workflow-test-status danger">试运行失败：{job.errorMessage || "请检查流程和连接"}</span>;
  if (job.status === "waiting_for_approval") return <span className="media-workflow-test-status">等待费用审批</span>;
  return <span className="media-workflow-test-status">试运行中</span>;
}

function defaultInputValues(fields: MediaWorkflowDefinitionDetail["versions"][number]["inputFields"]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue]));
}

function requiredFieldsReady(fields: MediaWorkflowDefinitionDetail["versions"][number]["inputFields"], values: Record<string, unknown>): boolean {
  return fields.every((field) => !field.required || !isEmpty(values[field.id] ?? field.defaultValue));
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function workflowStatus(item: MediaWorkflowDefinitionDetail): string {
  if (item.definition.status === "ready") return `已启用 · 版本 ${item.currentVersion?.version ?? "-"}`;
  if (item.definition.status === "blocked") return "检查未通过";
  return item.versions[0]?.testMediaJobId ? "等待启用" : "需要试运行";
}

function workflowLabel(status: MediaWorkflowDefinitionDetail["definition"]["status"]): string {
  if (status === "ready") return "可用于场景";
  if (status === "blocked") return "已阻断";
  if (status === "archived") return "已归档";
  return "待试运行";
}

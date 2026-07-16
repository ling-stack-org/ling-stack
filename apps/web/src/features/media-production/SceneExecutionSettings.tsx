import { useMemo } from "react";
import { ImageIcon, Settings2, Workflow } from "lucide-react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import { artifactContentUrl } from "../../api.js";
import { SelectControl } from "../../shared/components/SelectControl.js";
import type {
  MediaProject,
  MediaScene,
  MediaWorkflowDefinitionDetail,
  ProviderPreset,
  RunArtifact,
} from "../../types.js";
import type { MediaProductionActions } from "./media-production-types.js";
import { WorkflowFieldRenderer } from "./workflows/WorkflowFieldRenderer.js";

export function SceneExecutionSettings({
  cwd,
  scene,
  project,
  providers,
  workflows,
  imageArtifacts,
  isSaving,
  actions,
  onConfigureVideoModel,
  onOpenWorkflowLibrary,
}: {
  readonly cwd: string;
  readonly scene: MediaScene;
  readonly project: MediaProject;
  readonly providers: readonly ProviderPreset[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly isSaving: boolean;
  readonly actions: MediaProductionActions;
  readonly onConfigureVideoModel: () => void;
  readonly onOpenWorkflowLibrary: () => void;
}): JSX.Element {
  const videoProviders = useMemo(() => providers.filter((provider) => {
    const state = resolveMediaProviderRuntimeState(provider, "video_generate");
    return state.canRun && Boolean(state.videoGeneration);
  }), [providers]);
  const readyWorkflows = workflows.filter((item) => item.definition.status === "ready" && item.currentVersion);
  const resolvedMode = scene.executionMode === "inherit" ? project.defaultExecutionMode : scene.executionMode;

  return (
    <section className="scene-inspector-section scene-execution-settings">
      <span className="field-label">生产设置</span>
      <label className="field">
        <span>生产方式</span>
        <SelectControl
          value={scene.executionMode}
          disabled={isSaving}
          onChange={(event) => void actions.updateScene(scene.id, { executionMode: event.target.value as MediaScene["executionMode"] })}
        >
          <option value="inherit">跟随项目默认（{project.defaultExecutionMode === "direct" ? "模型直接生成" : "生产流程"}）</option>
          <option value="direct">模型直接生成</option>
          <option value="workflow">ComfyUI 生产流程</option>
        </SelectControl>
      </label>
      {resolvedMode === "workflow" ? (
        <WorkflowSceneSettings
          scene={scene}
          project={project}
          workflows={readyWorkflows}
          imageArtifacts={imageArtifacts}
          isSaving={isSaving}
          actions={actions}
          onOpenWorkflowLibrary={onOpenWorkflowLibrary}
        />
      ) : (
        <DirectSceneSettings
          cwd={cwd}
          scene={scene}
          project={project}
          providers={videoProviders}
          imageArtifacts={imageArtifacts}
          isSaving={isSaving}
          actions={actions}
          onConfigureVideoModel={onConfigureVideoModel}
        />
      )}
    </section>
  );
}

function DirectSceneSettings({
  cwd,
  scene,
  project,
  providers,
  imageArtifacts,
  isSaving,
  actions,
  onConfigureVideoModel,
}: {
  readonly cwd: string;
  readonly scene: MediaScene;
  readonly project: MediaProject;
  readonly providers: readonly ProviderPreset[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly isSaving: boolean;
  readonly actions: MediaProductionActions;
  readonly onConfigureVideoModel: () => void;
}): JSX.Element {
  const selectedProviderId = scene.providerPresetId ?? project.defaultProviderPresetId ?? "";
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const capability = selectedProvider ? resolveMediaProviderRuntimeState(selectedProvider, "video_generate").videoGeneration : undefined;
  return (
    <>
      <label className="field">
        <span>视频模型</span>
        {providers.length ? (
          <SelectControl
            value={scene.providerPresetId ?? ""}
            onChange={(event) => void actions.updateScene(scene.id, { providerPresetId: event.target.value || null })}
            disabled={isSaving}
          >
            <option value="">使用项目默认模型</option>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.model}</option>)}
          </SelectControl>
        ) : (
          <button className="secondary-button compact-button" type="button" onClick={onConfigureVideoModel}><Settings2 size={15} /> 配置视频模型</button>
        )}
      </label>
      {selectedProvider && capability ? (
        <div className="scene-parameter-grid">
          <label className="field">
            <span>比例</span>
            <SelectControl value={scene.ratio} onChange={(event) => void actions.updateScene(scene.id, { ratio: event.target.value })}>
              {(capability.aspectRatios ?? [scene.ratio]).map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </SelectControl>
          </label>
          <label className="field">
            <span>时长</span>
            <SelectControl value={String(scene.durationSeconds)} onChange={(event) => void actions.updateScene(scene.id, { durationSeconds: Number(event.target.value) })}>
              {(capability.durationsSeconds ?? [scene.durationSeconds]).map((duration) => <option key={duration} value={duration}>{duration} 秒</option>)}
            </SelectControl>
          </label>
        </div>
      ) : <p className="scene-inspector-hint">请先选择可运行的视频模型。</p>}
      {capability?.inputModes.includes("image_reference") ? (
        <ReferenceAssetPicker
          cwd={cwd}
          artifacts={imageArtifacts}
          selectedIds={scene.referenceArtifactIds}
          disabled={isSaving}
          onChange={(referenceArtifactIds) => void actions.updateScene(scene.id, { referenceArtifactIds })}
        />
      ) : null}
    </>
  );
}

function WorkflowSceneSettings({
  scene,
  project,
  workflows,
  imageArtifacts,
  isSaving,
  actions,
  onOpenWorkflowLibrary,
}: {
  readonly scene: MediaScene;
  readonly project: MediaProject;
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly imageArtifacts: readonly RunArtifact[];
  readonly isSaving: boolean;
  readonly actions: MediaProductionActions;
  readonly onOpenWorkflowLibrary: () => void;
}): JSX.Element {
  const selectedWorkflowId = scene.workflowDefinitionId ?? project.defaultWorkflowDefinitionId ?? "";
  const selectedWorkflow = workflows.find((item) => item.definition.id === selectedWorkflowId);
  const fields = selectedWorkflow?.currentVersion?.inputFields ?? [];
  const values = Object.fromEntries(fields.map((field) => [field.id, workflowFieldValue(field, scene)]));
  return (
    <>
      <label className="field">
        <span>生产流程</span>
        {workflows.length ? (
          <SelectControl
            value={scene.workflowDefinitionId ?? ""}
            disabled={isSaving}
            onChange={(event) => void actions.updateScene(scene.id, { workflowDefinitionId: event.target.value || null })}
          >
            <option value="">使用项目默认流程</option>
            {workflows.map((item) => <option value={item.definition.id} key={item.definition.id}>{item.definition.name}</option>)}
          </SelectControl>
        ) : (
          <button className="secondary-button compact-button" type="button" onClick={onOpenWorkflowLibrary}><Workflow size={15} /> 配置生产流程</button>
        )}
      </label>
      {selectedWorkflow?.currentVersion ? (
        <WorkflowFieldRenderer
          fields={fields}
          values={values}
          imageArtifacts={imageArtifacts}
          disabled={isSaving}
          hiddenSemantics={["prompt"]}
          onChange={(fieldId, value) => {
            const field = fields.find((item) => item.id === fieldId);
            if (!field) return;
            if (field.semantic === "ratio") void actions.updateScene(scene.id, { ratio: String(value) });
            else if (field.semantic === "duration") void actions.updateScene(scene.id, { durationSeconds: Number(value) });
            else if (field.semantic === "reference_image") void actions.updateScene(scene.id, { referenceArtifactIds: value ? [String(value)] : [] });
            else void actions.updateScene(scene.id, { workflowInputValues: { ...scene.workflowInputValues, [fieldId]: value } });
          }}
        />
      ) : <p className="scene-inspector-hint">请选择已试运行并启用的生产流程。</p>}
    </>
  );
}

function workflowFieldValue(field: MediaWorkflowDefinitionDetail["currentVersion"] extends infer Version
  ? Version extends { readonly inputFields: readonly (infer Field)[] } ? Field : never
  : never, scene: MediaScene): unknown {
  if (field.semantic === "prompt") return scene.prompt;
  if (field.semantic === "ratio") return scene.ratio;
  if (field.semantic === "duration") return scene.durationSeconds;
  if (field.semantic === "reference_image") return scene.referenceArtifactIds[0] ?? "";
  return scene.workflowInputValues[field.id] ?? field.defaultValue ?? "";
}

function ReferenceAssetPicker({
  cwd,
  artifacts,
  selectedIds,
  disabled,
  onChange,
}: {
  readonly cwd: string;
  readonly artifacts: readonly RunArtifact[];
  readonly selectedIds: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (artifactIds: readonly string[]) => void;
}): JSX.Element {
  return (
    <div className="reference-asset-picker compact">
      <div className="scene-inspector-section-head"><span className="field-label">参考素材</span><small>当前工作区图片结果</small></div>
      {artifacts.length ? (
        <div className="reference-asset-grid">
          {artifacts.map((artifact) => {
            const selected = selectedIds.includes(artifact.id);
            return (
              <button
                key={artifact.id}
                type="button"
                className={`reference-asset${selected ? " selected" : ""}`}
                disabled={disabled}
                onClick={() => onChange(selected ? selectedIds.filter((id) => id !== artifact.id) : [...selectedIds, artifact.id])}
                title={artifact.title ?? "图片结果"}
              >
                <img src={artifactContentUrl(artifact.id, cwd)} alt="" />
                <span>{selected ? "已选" : "选择"}</span>
              </button>
            );
          })}
        </div>
      ) : <p className="scene-inspector-hint"><ImageIcon size={14} /> 当前还没有可用图片结果。</p>}
    </div>
  );
}

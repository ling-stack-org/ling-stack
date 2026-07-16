import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Clapperboard, FolderCog, FolderPlus, Plus, Settings2, Trash2, Workflow, X } from "lucide-react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import { SelectControl } from "../../shared/components/SelectControl.js";
import type { MediaScene, MediaWorkflowDefinitionDetail, ProviderPreset } from "../../types.js";
import type { MediaProductionActions, MediaProductionProjectDetail } from "./media-production-types.js";
import type { SceneReadiness } from "./media-production-view-models.js";

export function ProjectSceneOutline({
  projects,
  project,
  selectedProjectId,
  selectedSceneId,
  providers,
  workflows,
  readiness,
  busyAction,
  actions,
  onConfigureVideoModel,
  onOpenWorkflowLibrary,
  onClose,
  onSceneSelect,
  onRequestDelete,
}: {
  readonly projects: readonly MediaProductionProjectDetail["mediaProject"][];
  readonly project: MediaProductionProjectDetail;
  readonly selectedProjectId: string;
  readonly selectedSceneId: string;
  readonly providers: readonly ProviderPreset[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly readiness: readonly SceneReadiness[];
  readonly busyAction: string;
  readonly actions: MediaProductionActions;
  readonly onConfigureVideoModel: () => void;
  readonly onOpenWorkflowLibrary: () => void;
  readonly onClose: () => void;
  readonly onSceneSelect: (sceneId: string) => void;
  readonly onRequestDelete: (scene: MediaScene) => void;
}): JSX.Element {
  const [name, setName] = useState(project.mediaProject.name);
  const readinessByScene = useMemo(() => new Map(readiness.map((item) => [item.sceneId, item])), [readiness]);
  const videoProviders = useMemo(() => providers.filter((provider) => resolveMediaProviderRuntimeState(provider, "video_generate").canRun), [providers]);
  const defaultProvider = videoProviders.find((provider) => provider.id === project.mediaProject.defaultProviderPresetId);
  const readyWorkflows = workflows.filter((item) => item.definition.status === "ready" && item.currentVersion);
  const defaultWorkflow = readyWorkflows.find((item) => item.definition.id === project.mediaProject.defaultWorkflowDefinitionId);

  useEffect(() => {
    setName(project.mediaProject.name);
  }, [project.mediaProject.id, project.mediaProject.name]);

  function moveScene(sceneId: string, direction: -1 | 1): void {
    const ids = project.scenes.map((scene) => scene.id);
    const from = ids.indexOf(sceneId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) {
      return;
    }
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    void actions.reorderScenes(ids);
  }

  return (
    <>
      <aside className="project-scene-outline" aria-label="项目与分镜">
      <div className="project-outline-project">
        <div className="project-outline-label">
          <span><FolderCog size={15} /> 项目</span>
          <span className="project-outline-header-actions">
            <button className="icon-button" type="button" onClick={() => void actions.createProject()} disabled={Boolean(busyAction)} title="新建项目" aria-label="新建项目"><FolderPlus size={15} /></button>
            <button className="icon-button" type="button" onClick={onClose} title="关闭项目与分镜" aria-label="关闭项目与分镜"><X size={15} /></button>
          </span>
        </div>
        <SelectControl value={selectedProjectId} onChange={(event) => actions.selectProject(event.target.value)} disabled={Boolean(busyAction)} aria-label="媒体项目">
          {projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
        </SelectControl>
        <button className="project-outline-workflow-entry" type="button" onClick={onOpenWorkflowLibrary}>
          <Workflow size={15} />
          <span><strong>生产流程</strong><small>{readyWorkflows.length ? `${readyWorkflows.length} 个可用流程` : "连接或导入 ComfyUI 流程"}</small></span>
        </button>
        <details className="project-outline-settings">
          <summary>
            <span>项目设置</span>
            <small>{project.mediaProject.defaultExecutionMode === "workflow" ? defaultWorkflow?.definition.name ?? "选择生产流程" : defaultProvider ? `${defaultProvider.displayName} · ${defaultProvider.model}` : "每个场景单独选择"}</small>
          </summary>
          <div className="project-outline-settings-body">
            <label className="field project-outline-name">
              <span>项目名称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => {
                  const next = name.trim();
                  if (next && next !== project.mediaProject.name) {
                    void actions.updateProject({ name: next });
                  } else if (!next) {
                    setName(project.mediaProject.name);
                  }
                }}
                disabled={busyAction === "update-project"}
              />
            </label>
            <label className="field">
              <span>默认生产方式</span>
              <SelectControl
                value={project.mediaProject.defaultExecutionMode}
                onChange={(event) => void actions.updateProject({ defaultExecutionMode: event.target.value as "direct" | "workflow" })}
                disabled={Boolean(busyAction)}
              >
                <option value="direct">模型直接生成</option>
                <option value="workflow">ComfyUI 生产流程</option>
              </SelectControl>
            </label>
            {project.mediaProject.defaultExecutionMode === "direct" ? (
              <label className="field project-outline-model">
                <span>默认视频模型</span>
                {videoProviders.length ? (
                <SelectControl
                  value={project.mediaProject.defaultProviderPresetId ?? ""}
                  onChange={(event) => void actions.updateProject({ defaultProviderPresetId: event.target.value || null })}
                  disabled={Boolean(busyAction)}
                >
                  <option value="">每个场景单独选择</option>
                  {videoProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName} · {provider.model}</option>)}
                </SelectControl>
              ) : (
                <button className="secondary-button compact-button project-outline-configure" type="button" onClick={onConfigureVideoModel} disabled={Boolean(busyAction)}>
                  <Settings2 size={15} /> 配置视频模型
                </button>
                )}
              </label>
            ) : (
              <label className="field project-outline-model">
                <span>默认生产流程</span>
                {readyWorkflows.length ? (
                  <SelectControl
                    value={project.mediaProject.defaultWorkflowDefinitionId ?? ""}
                    onChange={(event) => void actions.updateProject({ defaultWorkflowDefinitionId: event.target.value || null })}
                    disabled={Boolean(busyAction)}
                  >
                    <option value="">每个场景单独选择</option>
                    {readyWorkflows.map((item) => <option key={item.definition.id} value={item.definition.id}>{item.definition.name}</option>)}
                  </SelectControl>
                ) : (
                  <button className="secondary-button compact-button project-outline-configure" type="button" onClick={onOpenWorkflowLibrary} disabled={Boolean(busyAction)}>
                    <Workflow size={15} /> 配置生产流程
                  </button>
                )}
              </label>
            )}
          </div>
        </details>
      </div>

      <div className="project-outline-scenes-head">
        <span><Clapperboard size={15} /> 场景 <small>{project.scenes.length}</small></span>
        {project.scenes.length ? <button className="icon-button" type="button" onClick={() => void actions.createScene()} disabled={Boolean(busyAction)} title="添加场景" aria-label="添加场景"><Plus size={16} /></button> : null}
      </div>
      <div className="project-outline-scene-list">
        {project.scenes.length ? project.scenes.map((scene, index) => {
          const item = readinessByScene.get(scene.id);
          return (
            <div className={`project-outline-scene${scene.id === selectedSceneId ? " selected" : ""}`} key={scene.id}>
              <button className="project-outline-scene-main" type="button" onClick={() => onSceneSelect(scene.id)}>
                <span className="project-outline-scene-order">{String(index + 1).padStart(2, "0")}</span>
                <span className="project-outline-scene-copy">
                  <strong>{scene.title}</strong>
                  <small>{item?.reason ?? "正在读取场景状态。"}</small>
                </span>
                <span className={`scene-readiness-badge ${item?.state ?? "needs_model"}`}>{item?.label ?? "待完善"}</span>
              </button>
              <span className="project-outline-scene-order-actions" aria-label={`调整${scene.title}顺序`}>
                <button className="project-outline-sort-button" type="button" onClick={() => moveScene(scene.id, -1)} disabled={Boolean(busyAction) || index === 0} title="上移场景" aria-label="上移场景"><ChevronUp size={14} /></button>
                <button className="project-outline-sort-button" type="button" onClick={() => moveScene(scene.id, 1)} disabled={Boolean(busyAction) || index === project.scenes.length - 1} title="下移场景" aria-label="下移场景"><ChevronDown size={14} /></button>
                <button className="project-outline-scene-delete" type="button" onClick={() => onRequestDelete(scene)} disabled={Boolean(busyAction)} title="删除场景" aria-label="删除场景"><Trash2 size={13} /></button>
              </span>
            </div>
          );
        }) : (
          <div className="project-outline-empty">
            <Clapperboard size={20} strokeWidth={1.6} />
            <strong>从第一个场景开始</strong>
            <span>先添加场景，再填写画面和模型。</span>
          </div>
        )}
      </div>
      </aside>
    </>
  );
}

import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Copy, Play, RotateCw, Trash2, X } from "lucide-react";
import type { MediaJob, MediaProject, MediaScene, MediaSceneRun, MediaWorkflowDefinitionDetail, ProviderPreset, RunArtifact } from "../../types.js";
import { MediaArtifactPreview } from "../media/MediaArtifactPreview.js";
import type { MediaProductionActions } from "./media-production-types.js";
import type { SceneReadiness } from "./media-production-view-models.js";
import { SceneExecutionSettings } from "./SceneExecutionSettings.js";

interface SceneInspectorProps {
  readonly cwd: string;
  readonly scene?: MediaScene;
  readonly project: MediaProject;
  readonly sceneRuns: readonly MediaSceneRun[];
  readonly providers: readonly ProviderPreset[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly imageArtifacts: readonly RunArtifact[];
  readonly readiness?: SceneReadiness;
  readonly busyAction: string;
  readonly actions: MediaProductionActions;
  readonly onClose?: () => void;
  readonly onRequestDelete: (scene: MediaScene) => void;
  readonly onConfigureVideoModel: () => void;
  readonly onOpenWorkflowLibrary: () => void;
}

export function SceneInspector({
  cwd,
  scene,
  project,
  sceneRuns,
  providers,
  workflows,
  jobs,
  artifactsByJob,
  imageArtifacts,
  readiness,
  busyAction,
  actions,
  onClose,
  onRequestDelete,
  onConfigureVideoModel,
  onOpenWorkflowLibrary,
}: SceneInspectorProps): JSX.Element {
  const [title, setTitle] = useState(scene?.title ?? "");
  const [prompt, setPrompt] = useState(scene?.prompt ?? "");
  const orderedRuns = useMemo(() => scene
    ? sceneRuns.filter((run) => run.sceneId === scene.id)
    : [], [scene, sceneRuns]);

  useEffect(() => {
    setTitle(scene?.title ?? "");
    setPrompt(scene?.prompt ?? "");
  }, [scene?.id, scene?.title, scene?.prompt]);

  if (!scene) {
    return (
      <aside className="scene-inspector scene-inspector-empty">
        <Play size={22} strokeWidth={1.6} />
        <strong>选择一个场景</strong>
        <span>在画布中选择分镜，编辑画面、模型和生成结果。</span>
      </aside>
    );
  }

  const isSaving = busyAction.startsWith("update-scene:");
  const canRun = Boolean(readiness?.canRun);
  const hasCurrentResult = Boolean(readiness?.currentRun && readiness.currentJob?.status === "succeeded");
  const isSubmitting = busyAction === `run-scene:${scene.id}`;
  const generationLabel = isSubmitting
    ? "提交中"
    : readiness?.isRegenerating ? "重新生成中"
      : readiness?.state === "generating" ? "生成中"
        : hasCurrentResult ? "重新生成" : "生成此场景";

  return (
    <aside className="scene-inspector" aria-label="场景检查器">
      <div className="scene-inspector-head">
          <div>
            <span className="scene-inspector-eyebrow">场景 {scene.sortOrder + 1}</span>
            <h2>{scene.title}</h2>
            <span className={`scene-readiness-badge ${readiness?.state ?? "needs_model"}`}>{readiness?.label ?? "待完善"}</span>
        </div>
        <div className="scene-inspector-actions">
          {onClose ? <button type="button" className="icon-button" title="关闭场景检查器" aria-label="关闭场景检查器" onClick={onClose}><X size={16} /></button> : null}
          <button type="button" className="icon-button" title="复制场景" aria-label="复制场景" onClick={() => void actions.duplicateScene(scene.id)} disabled={Boolean(busyAction)}>
            <Copy size={16} />
          </button>
          <button type="button" className="icon-button danger" title="删除场景" aria-label="删除场景" onClick={() => onRequestDelete(scene)} disabled={Boolean(busyAction)}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="scene-inspector-scroll">
        <label className="field">
          <span>场景名称</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => title.trim() !== scene.title && void actions.updateScene(scene.id, { title: title.trim() || scene.title })}
          />
        </label>

        <label className="field scene-prompt-field">
          <span>画面提示</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onBlur={() => prompt !== scene.prompt && void actions.updateScene(scene.id, { prompt })}
            placeholder="描述主体、动作、镜头和氛围"
            rows={6}
          />
        </label>

        <SceneExecutionSettings
          cwd={cwd}
          scene={scene}
          project={project}
          providers={providers}
          workflows={workflows}
          imageArtifacts={imageArtifacts}
          isSaving={isSaving}
          actions={actions}
          onConfigureVideoModel={onConfigureVideoModel}
          onOpenWorkflowLibrary={onOpenWorkflowLibrary}
        />

        {readiness?.currentArtifact ? (
          <section className="scene-inspector-section scene-current-result">
            <div className="scene-inspector-section-head"><span className="field-label">当前结果</span><small>当前选用</small></div>
            <MediaArtifactPreview artifact={readiness.currentArtifact} cwd={cwd} variant="scene" />
          </section>
        ) : null}

        {readiness?.currentArtifact && readiness.latestIssue ? (
          <div className="scene-latest-run-issue" role="status">
            <CircleAlert size={15} aria-hidden="true" />
            <span><strong>上次重新生成失败</strong>{readiness.latestIssue}</span>
          </div>
        ) : null}

        <SceneRunHistory
          scene={scene}
          runs={orderedRuns}
          jobs={jobs}
          artifactsByJob={artifactsByJob}
          busyAction={busyAction}
          onSelectRun={(sceneRunId) => void actions.selectSceneRun(scene.id, sceneRunId)}
          onCancelRun={(sceneRunId) => void actions.cancelSceneRun(sceneRunId)}
        />
      </div>

      <div className="scene-inspector-footer">
        <button className="primary-button" type="button" onClick={() => void actions.runScene(scene.id)} disabled={!canRun || Boolean(busyAction)}>
          {hasCurrentResult ? <RotateCw size={16} /> : <Play size={16} />}
          {generationLabel}
        </button>
      </div>
    </aside>
  );
}

function SceneRunHistory({
  scene,
  runs,
  jobs,
  artifactsByJob,
  busyAction,
  onSelectRun,
  onCancelRun,
}: {
  readonly scene: MediaScene;
  readonly runs: readonly MediaSceneRun[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly busyAction: string;
  readonly onSelectRun: (sceneRunId: string) => void;
  readonly onCancelRun: (sceneRunId: string) => void;
}): JSX.Element {
  if (!runs.length) {
    return <section className="scene-inspector-section"><span className="field-label">生成记录</span><p className="scene-inspector-hint">生成后可在这里选择要使用的片段。</p></section>;
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  return (
    <section className="scene-inspector-section scene-run-history">
      <span className="field-label">生成记录</span>
      <div className="scene-run-list">
        {runs.map((run) => {
          const job = jobsById.get(run.mediaJobId);
          const selected = scene.selectedMediaSceneRunId === run.id;
          const result = job ? artifactsByJob[job.id]?.find((artifact) => artifact.type === "video" || artifact.type === "image") : undefined;
          return (
            <div className={`scene-run-row${selected ? " selected" : ""}`} key={run.id}>
              <span>
                <strong>{sceneRunStatusLabel(job?.status)}</strong>
                <small>{sceneRunSourceLabel(run)} · {new Date(run.createdAt).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", month: "numeric", day: "numeric" })}</small>
              </span>
              {result ? <span className="scene-run-row-result">已有结果</span> : null}
              {job?.status === "succeeded" ? (
                <button type="button" className="secondary-button compact-button" disabled={selected || Boolean(busyAction)} onClick={() => onSelectRun(run.id)}>
                  {selected ? "当前结果" : "设为当前"}
                </button>
              ) : job?.status === "queued" || job?.status === "running" || job?.status === "waiting_for_approval" ? (
                <button type="button" className="secondary-button compact-button" disabled={Boolean(busyAction)} onClick={() => onCancelRun(run.id)}>取消</button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function sceneRunStatusLabel(status: MediaJob["status"] | undefined): string {
  if (status === "succeeded") return "生成完成";
  if (status === "failed") return "生成失败";
  if (status === "cancelled") return "已取消";
  if (status === "waiting_for_approval") return "待确认";
  if (status === "queued") return "排队中";
  if (status === "running") return "生成中";
  return "状态未知";
}

function sceneRunSourceLabel(run: MediaSceneRun): string {
  const snapshot = run.executionSnapshot ?? run.providerSnapshot;
  if (typeof snapshot.workflowName === "string" && snapshot.workflowName) return snapshot.workflowName;
  if (typeof snapshot.displayName === "string" && snapshot.displayName) return snapshot.displayName;
  return snapshot.kind === "workflow" ? "生产流程" : "视频模型";
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import { Clapperboard, FolderPlus } from "lucide-react";
import type { MediaProductionPageProps, MediaProductionView, StoryboardFocusRequest } from "./media-production-types.js";
import { useMediaProductionController } from "./use-media-production-controller.js";
import { StoryboardCanvas } from "./StoryboardCanvas.js";
import { SceneInspector } from "./SceneInspector.js";
import { ProjectSceneOutline } from "./ProjectSceneOutline.js";
import { ProjectRunReviewDialog } from "./ProjectRunReviewDialog.js";
import { MediaProductionCanvasToolbar } from "./MediaProductionCanvasToolbar.js";
import { MediaProductionDockRail } from "./MediaProductionDockRail.js";
import { SceneDeleteDialog } from "./SceneDeleteDialog.js";
import { SceneResultPreviewDialog } from "./SceneResultPreviewDialog.js";
import { deriveProjectRunReview, deriveSceneReadiness } from "./media-production-view-models.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/feedback/LingToastProvider.js";
import { useMediaWorkflowController } from "./workflows/use-media-workflow-controller.js";
import { MediaWorkflowLibraryOverlay } from "./workflows/MediaWorkflowLibraryOverlay.js";
import type { MediaWorkflowLibraryTab } from "./workflows/media-workflow-types.js";

const leftDockPreferenceKey = "ling-stack.media-production.left-dock-open";

export function MediaProductionWorkspace({
  cwd,
  providers,
  mediaJobs,
  mediaArtifactsByJob,
  onJobsChanged,
  onConfigureVideoModel,
  jobsPanel,
}: MediaProductionPageProps): JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [view, setView] = useState<MediaProductionView>("studio");
  const [leftDockOpen, setLeftDockOpen] = useState(readLeftDockPreference);
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const [storyboardFocusRequest, setStoryboardFocusRequest] = useState<StoryboardFocusRequest>({ sceneId: "", sequence: 0 });
  const [workflowLibraryOpen, setWorkflowLibraryOpen] = useState(false);
  const [workflowLibraryTab, setWorkflowLibraryTab] = useState<MediaWorkflowLibraryTab>("workflows");
  const [isProjectRunReviewOpen, setProjectRunReviewOpen] = useState(false);
  const [scenePendingDelete, setScenePendingDelete] = useState<import("../../types.js").MediaScene | undefined>();
  const [previewSceneId, setPreviewSceneId] = useState("");
  const lastProjectJobSignature = useRef<{ readonly projectId: string; readonly signature: string }>();
  const { state, actions } = useMediaProductionController({ cwd, onJobsChanged });
  const workflowController = useMediaWorkflowController({ cwd, onJobsChanged });
  const project = state.project;
  const videoProviders = useMemo(() => providers.filter((provider) => {
    const runtime = resolveMediaProviderRuntimeState(provider, "video_generate");
    return runtime.canRun && Boolean(runtime.videoGeneration);
  }), [providers]);
  const imageArtifacts = useMemo(() => uniqueImageArtifacts(Object.values(mediaArtifactsByJob).flat()), [mediaArtifactsByJob]);
  const selectedScene = project?.scenes.find((scene) => scene.id === state.selectedSceneId);
  const sceneReadiness = useMemo(() => project
    ? project.scenes.map((scene) => deriveSceneReadiness({
      scene,
      project: project.mediaProject,
      providers,
      sceneRuns: project.sceneRuns,
      jobs: mediaJobs,
      artifactsByJob: mediaArtifactsByJob,
      workflows: workflowController.state.workflows,
    }))
    : [], [mediaArtifactsByJob, mediaJobs, project, providers, workflowController.state.workflows]);
  const projectRunReview = useMemo(() => deriveProjectRunReview(sceneReadiness), [sceneReadiness]);
  const previewReadiness = sceneReadiness.find((item) => item.sceneId === previewSceneId);
  const previewScene = project?.scenes.find((scene) => scene.id === previewSceneId);
  const projectJobSignature = useMemo(() => {
    if (!project) {
      return "";
    }
    const jobsById = new Map(mediaJobs.map((job) => [job.id, job]));
    return project.sceneRuns.map((run) => {
      const job = jobsById.get(run.mediaJobId);
      const artifacts = mediaArtifactsByJob[run.mediaJobId] ?? [];
      return `${run.mediaJobId}:${job?.status ?? "missing"}:${job?.artifactIds.join(",") ?? ""}:${artifacts.map((artifact) => artifact.id).join(",")}`;
    }).join("|");
  }, [mediaArtifactsByJob, mediaJobs, project]);

  useEffect(() => {
    if (!state.noticeMessage) {
      return;
    }
    showToast({ message: t(state.noticeMessage), tone: "success", durationMs: 2_000, scope: "media-production-save" });
  }, [showToast, state.noticeMessage, t]);

  useEffect(() => {
    try {
      window.localStorage.setItem(leftDockPreferenceKey, String(leftDockOpen));
    } catch {
      // The layout still works when browser storage is unavailable.
    }
  }, [leftDockOpen]);

  useEffect(() => {
    const projectId = project?.mediaProject.id;
    if (!projectId) {
      lastProjectJobSignature.current = undefined;
      return;
    }
    const previous = lastProjectJobSignature.current;
    lastProjectJobSignature.current = { projectId, signature: projectJobSignature };
    if (previous?.projectId === projectId && previous.signature !== projectJobSignature) {
      void actions.refreshCurrentProject();
    }
  }, [actions.refreshCurrentProject, project?.mediaProject.id, projectJobSignature]);

  useEffect(() => {
    if (previewSceneId && (!previewScene || !previewReadiness?.currentArtifact)) {
      setPreviewSceneId("");
    }
  }, [previewReadiness?.currentArtifact, previewScene, previewSceneId]);

  useEffect(() => {
    if (selectedScene) {
      setRightDockOpen(true);
      setStoryboardFocusRequest((current) => current.sceneId === selectedScene.id
        ? current
        : { sceneId: selectedScene.id, sequence: current.sequence + 1 });
    }
  }, [selectedScene?.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (workflowLibraryOpen) {
        return;
      }
      if (rightDockOpen) {
        event.preventDefault();
        setRightDockOpen(false);
      } else if (leftDockOpen) {
        event.preventDefault();
        setLeftDockOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [leftDockOpen, rightDockOpen, workflowLibraryOpen]);

  const selectScene = useCallback((sceneId: string): void => {
    actions.selectScene(sceneId);
    setRightDockOpen(true);
    setStoryboardFocusRequest((current) => ({ sceneId, sequence: current.sequence + 1 }));
  }, [actions]);

  const previewSceneResult = useCallback((sceneId: string): void => {
    const target = sceneReadiness.find((item) => item.sceneId === sceneId);
    if (target?.currentArtifact) {
      setPreviewSceneId(sceneId);
    }
  }, [sceneReadiness]);

  function createScene(): void {
    setRightDockOpen(true);
    void actions.createScene();
  }

  return (
    <div className={`media-production-page canvas-first ${view === "jobs" ? "showing-jobs" : "showing-studio"}`}>
      <MediaProductionCanvasToolbar
        projectName={project?.mediaProject.name}
        sceneCount={project?.scenes.length ?? 0}
        view={view}
        canRun={projectRunReview.ready.length > 0}
        hasVideoModel={videoProviders.length > 0}
        busy={Boolean(state.busyAction)}
        onViewChange={setView}
        onOpenProjectDock={() => setLeftDockOpen(true)}
        onRunProject={() => setProjectRunReviewOpen(true)}
        onConfigureVideoModel={onConfigureVideoModel}
      />

      {view === "jobs" ? <div className="media-production-jobs-view">{jobsPanel}</div> : (
        <div className="media-production-studio">
          {state.errorMessage ? <div className="inline-error media-production-error">{state.errorMessage}</div> : null}
          {project ? (
            <div className="media-production-canvas-stage">
              <StoryboardCanvas
                key={project.mediaProject.id}
                scenes={project.scenes}
                readiness={sceneReadiness}
                selectedSceneId={state.selectedSceneId}
                focusRequest={storyboardFocusRequest}
                leftDockOpen={leftDockOpen}
                rightDockOpen={rightDockOpen}
                isBusy={Boolean(state.busyAction)}
                onSelectScene={selectScene}
                onPreviewResult={previewSceneResult}
                onMoveScene={(sceneId, canvasPosition) => void actions.updateScene(sceneId, { canvasPosition })}
                onCreateScene={createScene}
              />
              <MediaProductionDockRail
                leftOpen={leftDockOpen}
                rightOpen={rightDockOpen}
                rightAvailable={Boolean(selectedScene)}
                onToggleLeft={() => setLeftDockOpen((current) => !current)}
                onToggleRight={() => setRightDockOpen((current) => selectedScene ? !current : current)}
              />
              <div className={`media-production-dock-panel left${leftDockOpen ? " is-open" : ""}`} aria-hidden={!leftDockOpen}>
                <ProjectSceneOutline
                  projects={state.projects}
                  project={project}
                  selectedProjectId={state.selectedProjectId}
                  selectedSceneId={state.selectedSceneId}
                  providers={providers}
                  workflows={workflowController.state.workflows}
                  readiness={sceneReadiness}
                  busyAction={state.busyAction}
                  actions={actions}
                  onConfigureVideoModel={onConfigureVideoModel}
                  onOpenWorkflowLibrary={() => { setWorkflowLibraryTab("workflows"); setWorkflowLibraryOpen(true); }}
                  onClose={() => setLeftDockOpen(false)}
                  onSceneSelect={selectScene}
                  onRequestDelete={setScenePendingDelete}
                />
              </div>
              {selectedScene ? (
                <div className={`media-production-dock-panel right${rightDockOpen ? " is-open" : ""}`} aria-hidden={!rightDockOpen}>
                  <SceneInspector
                    cwd={cwd}
                    scene={selectedScene}
                    project={project.mediaProject}
                    sceneRuns={project.sceneRuns}
                    providers={providers}
                    workflows={workflowController.state.workflows}
                    jobs={mediaJobs}
                    artifactsByJob={mediaArtifactsByJob}
                    imageArtifacts={imageArtifacts}
                    readiness={sceneReadiness.find((item) => item.sceneId === selectedScene.id)}
                    busyAction={state.busyAction}
                    actions={actions}
                    onClose={() => setRightDockOpen(false)}
                    onRequestDelete={setScenePendingDelete}
                    onConfigureVideoModel={onConfigureVideoModel}
                    onOpenWorkflowLibrary={() => { setWorkflowLibraryTab("workflows"); setWorkflowLibraryOpen(true); }}
                  />
                </div>
              ) : null}
            </div>
          ) : <EmptyStudio onCreate={() => void actions.createProject()} />}
        </div>
      )}
      {project && isProjectRunReviewOpen ? (
        <ProjectRunReviewDialog
          review={projectRunReview}
          isSubmitting={state.busyAction === "run-project"}
          onClose={() => setProjectRunReviewOpen(false)}
          onConfirm={() => {
            void actions.runProject(projectRunReview.ready.map((item) => item.sceneId));
            setProjectRunReviewOpen(false);
          }}
        />
      ) : null}
      {scenePendingDelete ? (
        <SceneDeleteDialog
          scene={scenePendingDelete}
          isDeleting={state.busyAction === `delete-scene:${scenePendingDelete.id}`}
          onClose={() => setScenePendingDelete(undefined)}
          onConfirm={() => {
            void actions.deleteScene(scenePendingDelete.id);
            setScenePendingDelete(undefined);
          }}
        />
      ) : null}
      {previewScene && previewReadiness?.currentArtifact ? (
        <SceneResultPreviewDialog
          cwd={cwd}
          scene={previewScene}
          artifact={previewReadiness.currentArtifact}
          onClose={() => setPreviewSceneId("")}
        />
      ) : null}
      <MediaWorkflowLibraryOverlay
        open={workflowLibraryOpen}
        tab={workflowLibraryTab}
        state={workflowController.state}
        actions={workflowController.actions}
        mediaJobs={mediaJobs}
        imageArtifacts={imageArtifacts}
        onTabChange={setWorkflowLibraryTab}
        onClose={() => setWorkflowLibraryOpen(false)}
      />
    </div>
  );
}

function EmptyStudio({ onCreate }: { readonly onCreate: () => void }): JSX.Element {
  return (
    <div className="media-production-empty-state">
      <Clapperboard size={30} strokeWidth={1.6} />
      <h2>先创建一个媒体项目</h2>
      <p>将视频拆成有序分镜，分别生成和挑选片段结果。</p>
      <button className="primary-button" type="button" onClick={onCreate}><FolderPlus size={16} /> 新建项目</button>
    </div>
  );
}

function readLeftDockPreference(): boolean {
  try {
    return window.localStorage.getItem(leftDockPreferenceKey) !== "false";
  } catch {
    return true;
  }
}

function uniqueImageArtifacts(artifacts: readonly import("../../types.js").RunArtifact[]): import("../../types.js").RunArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => artifact.type === "image" && !seen.has(artifact.id) && Boolean(seen.add(artifact.id)));
}

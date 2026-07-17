import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import { Clapperboard, FolderPlus } from "lucide-react";
import type { MediaProductionPageProps, MediaProductionView, StoryboardFocusRequest } from "./media-production-types.js";
import type { MediaJobDisplayContextMap } from "../media/media-job-display-context.js";
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
import { mediaProductionDocksAreExclusive } from "./media-production-layout.js";

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
  const [canvasStageWidth, setCanvasStageWidth] = useState(0);
  const lastProjectJobSignature = useRef<{ readonly projectId: string; readonly signature: string }>();
  const canvasStageRef = useRef<HTMLDivElement>(null);
  const selectionContextRef = useRef({ projectId: "", sceneId: "" });
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
  const jobContext = useMemo<MediaJobDisplayContextMap>(() => {
    if (!project) {
      return {};
    }
    const scenesById = new Map(project.scenes.map((scene) => [scene.id, scene]));
    return Object.fromEntries(project.sceneRuns.flatMap((run) => {
      const scene = scenesById.get(run.sceneId);
      return scene ? [[run.mediaJobId, { projectName: project.mediaProject.name, sceneName: scene.title }]] : [];
    }));
  }, [project]);
  const docksAreExclusive = mediaProductionDocksAreExclusive(canvasStageWidth);
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
    const projectId = project?.mediaProject.id ?? "";
    const sceneId = selectedScene?.id ?? "";
    const previous = selectionContextRef.current;
    selectionContextRef.current = { projectId, sceneId };
    if (!projectId || previous.projectId !== projectId) {
      setRightDockOpen(false);
      return;
    }
    if (sceneId && previous.sceneId !== sceneId) {
      if (docksAreExclusive) {
        setLeftDockOpen(false);
      }
      setRightDockOpen(true);
      setStoryboardFocusRequest((current) => ({ sceneId, sequence: current.sequence + 1 }));
    }
  }, [docksAreExclusive, project?.mediaProject.id, selectedScene?.id]);

  useEffect(() => {
    if (docksAreExclusive && leftDockOpen && rightDockOpen) {
      setLeftDockOpen(false);
    }
  }, [docksAreExclusive, leftDockOpen, rightDockOpen]);

  useEffect(() => {
    const stage = canvasStageRef.current;
    if (!stage || view !== "studio") {
      return;
    }
    const updateWidth = (): void => setCanvasStageWidth(stage.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [project?.mediaProject.id, view]);

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
        writeLeftDockPreference(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [leftDockOpen, rightDockOpen, workflowLibraryOpen]);

  const selectScene = useCallback((sceneId: string): void => {
    selectionContextRef.current = { projectId: project?.mediaProject.id ?? "", sceneId };
    actions.selectScene(sceneId);
    if (docksAreExclusive) {
      setLeftDockOpen(false);
    }
    setRightDockOpen(true);
    setStoryboardFocusRequest((current) => ({ sceneId, sequence: current.sequence + 1 }));
  }, [actions, docksAreExclusive, project?.mediaProject.id]);

  const previewSceneResult = useCallback((sceneId: string): void => {
    const target = sceneReadiness.find((item) => item.sceneId === sceneId);
    if (target?.currentArtifact) {
      setPreviewSceneId(sceneId);
    }
  }, [sceneReadiness]);

  function createScene(): void {
    void actions.createScene();
  }

  function openLeftDock(): void {
    if (docksAreExclusive) {
      setRightDockOpen(false);
    }
    setLeftDockOpen(true);
    writeLeftDockPreference(true);
  }

  function toggleLeftDock(): void {
    if (leftDockOpen) {
      setLeftDockOpen(false);
      writeLeftDockPreference(false);
      return;
    }
    openLeftDock();
  }

  function closeLeftDock(): void {
    setLeftDockOpen(false);
    writeLeftDockPreference(false);
  }

  function toggleRightDock(): void {
    if (!selectedScene) {
      return;
    }
    if (rightDockOpen) {
      setRightDockOpen(false);
      return;
    }
    if (docksAreExclusive) {
      setLeftDockOpen(false);
    }
    setRightDockOpen(true);
    setStoryboardFocusRequest((current) => ({ sceneId: selectedScene.id, sequence: current.sequence + 1 }));
  }

  return (
    <div className={`media-production-page canvas-first ${view === "jobs" ? "showing-jobs" : "showing-studio"}`}>
      <MediaProductionCanvasToolbar
        projectName={project?.mediaProject.name}
        sceneCount={project?.scenes.length ?? 0}
        view={view}
        readyCount={projectRunReview.ready.length}
        hasGenerationSource={videoProviders.length > 0 || workflowController.state.workflows.some((item) => item.definition.status === "ready" && item.currentVersion)}
        busy={Boolean(state.busyAction)}
        onViewChange={setView}
        onOpenProjectDock={openLeftDock}
        onRunProject={() => setProjectRunReviewOpen(true)}
        onConfigureVideoModel={onConfigureVideoModel}
      />

      {view === "jobs" ? <div className="media-production-jobs-view">{jobsPanel(jobContext)}</div> : (
        <div className="media-production-studio">
          {state.errorMessage ? <div className="inline-error media-production-error">{state.errorMessage}</div> : null}
          {project ? (
            <div ref={canvasStageRef} className="media-production-canvas-stage" data-exclusive-docks={docksAreExclusive ? "true" : "false"}>
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
                onToggleLeft={toggleLeftDock}
                onToggleRight={toggleRightDock}
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
                  onClose={closeLeftDock}
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

function writeLeftDockPreference(open: boolean): void {
  try {
    window.localStorage.setItem(leftDockPreferenceKey, String(open));
  } catch {
    // The layout still works when browser storage is unavailable.
  }
}

function uniqueImageArtifacts(artifacts: readonly import("../../types.js").RunArtifact[]): import("../../types.js").RunArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => artifact.type === "image" && !seen.has(artifact.id) && Boolean(seen.add(artifact.id)));
}

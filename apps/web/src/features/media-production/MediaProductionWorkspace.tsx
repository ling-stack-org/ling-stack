import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import type {
  MediaProductionOverlay,
  MediaProductionPageProps,
  MediaProductionToastIntent,
  MediaProductionView,
  StoryboardFocusRequest,
} from "./media-production-types.js";
import { useMediaProductionController } from "./use-media-production-controller.js";
import { StoryboardCanvas } from "./StoryboardCanvas.js";
import { SceneInspector } from "./SceneInspector.js";
import { ProjectSceneOutline } from "./ProjectSceneOutline.js";
import { ProjectRunReviewDialog } from "./ProjectRunReviewDialog.js";
import { MediaProductionCanvasToolbar } from "./MediaProductionCanvasToolbar.js";
import { MediaProductionDockRail } from "./MediaProductionDockRail.js";
import { MediaProductionLoadState } from "./MediaProductionLoadState.js";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog.js";
import { SceneDeleteDialog } from "./SceneDeleteDialog.js";
import { SceneResultPreviewDialog } from "./SceneResultPreviewDialog.js";
import { deriveProjectRunReview, deriveSceneReadiness } from "./media-production-view-models.js";
import { useI18n } from "../../i18n.js";
import { useLingToast } from "../../shared/ui/index.js";
import { useMediaWorkflowController } from "./workflows/use-media-workflow-controller.js";
import { MediaWorkflowLibraryDialog } from "./workflows/MediaWorkflowLibraryDialog.js";
import type { MediaWorkflowLibraryTab } from "./workflows/media-workflow-types.js";
import { mediaProductionDocksAreExclusive } from "./media-production-layout.js";
import {
  mediaProductionLegacyBusyAction,
  selectMediaProductionFailure,
} from "./media-production-project-view-models.js";
import { buildMediaJobHostBridge, buildMediaProductionJobSignature, uniqueMediaImageArtifacts } from "./media-job-host-bridge.js";

const leftDockPreferenceKey = "ling-stack.media-production.left-dock-open";

export function MediaProductionWorkspace({
  cwd,
  providers,
  mediaJobs,
  mediaArtifactsByJob,
  onJobsChanged,
  onOpenMediaJob,
  onConfigureVideoModel,
  jobsPanel,
}: MediaProductionPageProps): JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [view, setView] = useState<MediaProductionView>("studio");
  const [leftDockOpen, setLeftDockOpen] = useState(readLeftDockPreference);
  const [rightDockOpen, setRightDockOpen] = useState(false);
  const [storyboardFocusRequest, setStoryboardFocusRequest] = useState<StoryboardFocusRequest>({ sceneId: "", sequence: 0 });
  const [overlay, setOverlay] = useState<MediaProductionOverlay>({ kind: "none" });
  const [canvasStageWidth, setCanvasStageWidth] = useState(0);
  const lastProjectJobSignature = useRef<{ readonly projectId: string; readonly signature: string }>();
  const canvasStageRef = useRef<HTMLDivElement>(null);
  const selectionContextRef = useRef({ projectId: "", sceneId: "" });
  const projectDeleteSnapshotRef = useRef<import("../../types.js").MediaProject>();
  const sceneDeleteSnapshotRef = useRef<import("../../types.js").MediaScene>();
  const onToast = useCallback((intent: MediaProductionToastIntent): void => {
    showToast({ message: t(intent.messageKey, intent.values), tone: "success", scope: intent.scope });
  }, [showToast, t]);
  const sceneTitleForIndex = useCallback((index: number): string => t("Scene {number}", { number: index }), [t]);
  const { state, actions } = useMediaProductionController({
    cwd,
    defaultProjectName: t("Untitled media project"),
    sceneTitleForIndex,
    onJobsChanged,
    onToast,
  });
  const workflowController = useMediaWorkflowController({ cwd, onJobsChanged });
  const project = state.project;
  const busyAction = mediaProductionLegacyBusyAction(state.busy);
  const videoProviders = useMemo(() => providers.filter((provider) => {
    const runtime = resolveMediaProviderRuntimeState(provider, "video_generate");
    return runtime.canRun && Boolean(runtime.videoGeneration);
  }), [providers]);
  const imageArtifacts = useMemo(() => uniqueMediaImageArtifacts(Object.values(mediaArtifactsByJob).flat()), [mediaArtifactsByJob]);
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
  const workflowLibraryOpen = overlay.kind === "workflow";
  const workflowLibraryTab = workflowLibraryOpen ? overlay.tab : "workflows";
  const setWorkflowLibraryTab = useCallback((tab: MediaWorkflowLibraryTab): void => {
    setOverlay((current) => current.kind === "workflow"
      ? { ...current, tab }
      : { kind: "workflow", tab, trigger: null });
  }, []);
  const setWorkflowLibraryOpen = useCallback((open: boolean): void => {
    setOverlay((current) => open
      ? current.kind === "workflow" ? current : { kind: "workflow", tab: "workflows", trigger: null }
      : current.kind === "workflow" ? { kind: "none" } : current);
  }, []);
  const jobHostBridge = useMemo(() => buildMediaJobHostBridge({
    project,
    jobs: mediaJobs,
    workflows: workflowController.state.workflows,
    connections: workflowController.state.connections,
    selectWorkflow: workflowController.actions.selectWorkflow,
    selectConnection: workflowController.actions.selectConnection,
    setLibraryTab: setWorkflowLibraryTab,
    setLibraryOpen: setWorkflowLibraryOpen,
  }), [mediaJobs, project, setWorkflowLibraryOpen, setWorkflowLibraryTab, workflowController.actions.selectConnection,
    workflowController.actions.selectWorkflow, workflowController.state.connections, workflowController.state.workflows]);
  const docksAreExclusive = mediaProductionDocksAreExclusive(canvasStageWidth);
  const previewSceneId = overlay.kind === "preview" ? overlay.sceneId : "";
  const previewReadiness = sceneReadiness.find((item) => item.sceneId === previewSceneId);
  const previewScene = project?.scenes.find((scene) => scene.id === previewSceneId);
  const projectJobSignature = useMemo(
    () => buildMediaProductionJobSignature(project, mediaJobs, mediaArtifactsByJob),
    [mediaArtifactsByJob, mediaJobs, project],
  );
  const projectPendingDelete = overlay.kind === "delete-project"
    ? state.projects.find((item) => item.id === overlay.projectId) ?? projectDeleteSnapshotRef.current
    : undefined;
  const scenePendingDelete = overlay.kind === "delete-scene"
    ? project?.scenes.find((scene) => scene.id === overlay.sceneId) ?? sceneDeleteSnapshotRef.current
    : undefined;

  useEffect(() => {
    setOverlay({ kind: "none" });
    projectDeleteSnapshotRef.current = undefined;
    sceneDeleteSnapshotRef.current = undefined;
  }, [cwd]);

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
    if (overlay.kind === "preview" && (!previewScene || !previewReadiness?.currentArtifact)) {
      setOverlay({ kind: "none" });
    }
  }, [overlay.kind, previewReadiness?.currentArtifact, previewScene]);

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
      if (docksAreExclusive) setLeftDockOpen(false);
      setRightDockOpen(true);
      setStoryboardFocusRequest((current) => ({ sceneId, sequence: current.sequence + 1 }));
    }
  }, [docksAreExclusive, project?.mediaProject.id, selectedScene?.id]);

  useEffect(() => {
    if (docksAreExclusive && leftDockOpen && rightDockOpen) setLeftDockOpen(false);
  }, [docksAreExclusive, leftDockOpen, rightDockOpen]);

  useEffect(() => {
    const stage = canvasStageRef.current;
    if (!stage || view !== "studio") return;
    const updateWidth = (): void => setCanvasStageWidth(stage.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [project?.mediaProject.id, view]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (overlay.kind !== "none") return;
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
  }, [leftDockOpen, overlay.kind, rightDockOpen]);

  const selectScene = useCallback((sceneId: string): void => {
    selectionContextRef.current = { projectId: project?.mediaProject.id ?? "", sceneId };
    actions.selectScene(sceneId);
    if (docksAreExclusive) setLeftDockOpen(false);
    setRightDockOpen(true);
    setStoryboardFocusRequest((current) => ({ sceneId, sequence: current.sequence + 1 }));
  }, [actions, docksAreExclusive, project?.mediaProject.id]);

  const previewSceneResult = useCallback((sceneId: string): void => {
    const target = sceneReadiness.find((item) => item.sceneId === sceneId);
    if (target?.currentArtifact) {
      setOverlay({ kind: "preview", sceneId, artifactId: target.currentArtifact.id, trigger: activeElement() });
    }
  }, [sceneReadiness]);

  function openLeftDock(): void {
    if (docksAreExclusive) setRightDockOpen(false);
    setLeftDockOpen(true);
    writeLeftDockPreference(true);
  }

  function toggleLeftDock(): void {
    if (leftDockOpen) {
      setLeftDockOpen(false);
      writeLeftDockPreference(false);
    } else {
      openLeftDock();
    }
  }

  function closeLeftDock(): void {
    setLeftDockOpen(false);
    writeLeftDockPreference(false);
  }

  function toggleRightDock(): void {
    if (!selectedScene) return;
    if (rightDockOpen) {
      setRightDockOpen(false);
      return;
    }
    if (docksAreExclusive) setLeftDockOpen(false);
    setRightDockOpen(true);
    setStoryboardFocusRequest((current) => ({ sceneId: selectedScene.id, sequence: current.sequence + 1 }));
  }

  function closeOverlay(): void {
    if (isOverlayBusy(overlay, state.busy, workflowController.state.busyAction)) return;
    const closingOverlay = overlay;
    setOverlay({ kind: "none" });
    if (closingOverlay.kind === "run-project") {
      restoreOverlayTriggerFocus(closingOverlay.trigger, ".media-production-primary-action");
    } else if (closingOverlay.kind === "preview") {
      restoreOverlayTriggerFocus(closingOverlay.trigger, ".storyboard-scene-preview");
    }
  }

  return (
    <div className={`media-production-page canvas-first ${view === "jobs" ? "showing-jobs" : "showing-studio"}`}>
      <MediaProductionCanvasToolbar
        projectName={project?.mediaProject.name}
        sceneCount={project?.scenes.length ?? 0}
        view={view}
        readyCount={projectRunReview.ready.length}
        hasGenerationSource={videoProviders.length > 0 || workflowController.state.workflows.some((item) => item.definition.status === "ready" && item.currentVersion)}
        busy={Boolean(state.busy.projectRunId)}
        onViewChange={setView}
        onOpenProjectDock={openLeftDock}
        onRunProject={() => project && setOverlay({ kind: "run-project", projectId: project.mediaProject.id, trigger: activeElement() })}
        onConfigureVideoModel={onConfigureVideoModel}
      />

      {view === "jobs" ? <div className="media-production-jobs-view">{jobsPanel({
        jobContext: jobHostBridge.context,
        hostActions: jobHostBridge.actions,
      })}</div> : (
        <div className="media-production-studio">
          <MediaProductionLoadState actions={actions} state={state} />
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
                isBusy={state.busy.sceneMoveIds.length > 0}
                onSelectScene={selectScene}
                onPreviewResult={previewSceneResult}
                onMoveScene={(sceneId, canvasPosition) => void actions.updateScene(sceneId, { canvasPosition })}
                onCreateScene={() => void actions.createScene()}
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
                  actions={actions}
                  busy={state.busy}
                  failures={state.failures}
                  onClose={closeLeftDock}
                  onConfigureVideoModel={onConfigureVideoModel}
                  onOpenWorkflowLibrary={() => setOverlay({ kind: "workflow", tab: "workflows", trigger: null })}
                  onRequestProjectDelete={(target, trigger) => {
                    projectDeleteSnapshotRef.current = target;
                    setOverlay({ kind: "delete-project", projectId: target.id, trigger });
                  }}
                  onRequestSceneDelete={(target, trigger) => {
                    sceneDeleteSnapshotRef.current = target;
                    setOverlay({ kind: "delete-scene", sceneId: target.id, trigger });
                  }}
                  onSceneSelect={selectScene}
                  pendingProjectId={state.pendingProjectId}
                  project={project}
                  projects={state.projects}
                  providers={providers}
                  readiness={sceneReadiness}
                  selectedProjectId={state.selectedProjectId}
                  selectedSceneId={state.selectedSceneId}
                  workflows={workflowController.state.workflows}
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
                    busyAction={busyAction}
                    sceneUpdateBusy={state.busy.sceneUpdateIds.includes(selectedScene.id)}
                    actions={actions}
                    onClose={() => setRightDockOpen(false)}
                    onRequestDelete={(target) => {
                      sceneDeleteSnapshotRef.current = target;
                      setOverlay({ kind: "delete-scene", sceneId: target.id, trigger: null });
                    }}
                    onConfigureVideoModel={onConfigureVideoModel}
                    onOpenWorkflowLibrary={() => setOverlay({ kind: "workflow", tab: "workflows", trigger: null })}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {project && overlay.kind === "run-project" && overlay.projectId === project.mediaProject.id ? (
        <ProjectRunReviewDialog
          review={projectRunReview}
          failure={selectMediaProductionFailure(state.failures, ["project-run"], project.mediaProject.id)}
          isSubmitting={state.busy.projectRunId === project.mediaProject.id}
          onClose={closeOverlay}
          onConfirm={async () => {
            const outcome = await actions.runProject(projectRunReview.ready.map((item) => item.sceneId));
            if (outcome.ok) {
              setOverlay({ kind: "none" });
              restoreOverlayTriggerFocus(overlay.trigger, ".media-production-primary-action");
            }
          }}
        />
      ) : null}
      {projectPendingDelete && overlay.kind === "delete-project" ? (
        <ProjectDeleteDialog
          project={projectPendingDelete}
          sceneCount={project?.mediaProject.id === projectPendingDelete.id ? project.scenes.length : 0}
          failure={selectMediaProductionFailure(state.failures, ["project-delete"], projectPendingDelete.id)}
          isDeleting={state.busy.projectDeleteId === projectPendingDelete.id}
          onClearFailure={() => actions.clearFailure("project-delete", projectPendingDelete.id)}
          onClose={closeOverlay}
          onConfirm={() => actions.deleteProject(projectPendingDelete.id)}
          onDeleted={() => {
            setOverlay({ kind: "none" });
            projectDeleteSnapshotRef.current = undefined;
            focusFallback(".media-production-project-trigger");
          }}
          onRestoreFocus={() => restoreTriggerFocus(overlay.trigger, ".media-production-project-trigger")}
        />
      ) : null}
      {scenePendingDelete && overlay.kind === "delete-scene" ? (
        <SceneDeleteDialog
          scene={scenePendingDelete}
          failure={selectMediaProductionFailure(state.failures, ["scene-delete"], scenePendingDelete.id)}
          isDeleting={state.busy.sceneDeleteIds.includes(scenePendingDelete.id)}
          onClearFailure={() => actions.clearFailure("scene-delete", scenePendingDelete.id)}
          onClose={closeOverlay}
          onConfirm={() => actions.deleteScene(scenePendingDelete.id)}
          onDeleted={() => {
            setOverlay({ kind: "none" });
            sceneDeleteSnapshotRef.current = undefined;
            focusFallback(".project-outline-scene.selected .project-outline-scene-main, .project-outline-scenes-head button");
          }}
          onRestoreFocus={() => restoreTriggerFocus(overlay.trigger, ".project-outline-scene.selected .project-outline-scene-main, .project-outline-scenes-head button")}
        />
      ) : null}
      {previewScene && previewReadiness?.currentArtifact && overlay.kind === "preview" ? (
        <SceneResultPreviewDialog
          cwd={cwd}
          scene={previewScene}
          artifact={previewReadiness.currentArtifact}
          currentMediaJobId={previewReadiness.currentJob?.id}
          onClose={closeOverlay}
          onOpenTask={(mediaJobId) => {
            setOverlay({ kind: "none" });
            setView("jobs");
            onOpenMediaJob(mediaJobId);
          }}
        />
      ) : null}
      <MediaWorkflowLibraryDialog
        open={workflowLibraryOpen}
        tab={workflowLibraryTab}
        state={workflowController.state}
        actions={workflowController.actions}
        mediaJobs={mediaJobs}
        imageArtifacts={imageArtifacts}
        onTabChange={setWorkflowLibraryTab}
        onClose={closeOverlay}
      />
    </div>
  );
}

function isOverlayBusy(
  overlay: MediaProductionOverlay,
  busy: import("./media-production-types.js").MediaProductionBusyState,
  workflowBusyAction: string,
): boolean {
  if (overlay.kind === "delete-project") return busy.projectDeleteId === overlay.projectId;
  if (overlay.kind === "delete-scene") return busy.sceneDeleteIds.includes(overlay.sceneId);
  if (overlay.kind === "run-project") return busy.projectRunId === overlay.projectId;
  if (overlay.kind === "workflow" || overlay.kind === "workflow-danger") return Boolean(workflowBusyAction);
  return false;
}

function restoreTriggerFocus(trigger: HTMLElement | null, fallbackSelector: string): void {
  queueMicrotask(() => {
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    else focusFallback(fallbackSelector);
  });
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restoreOverlayTriggerFocus(trigger: HTMLElement | null, fallbackSelector: string): void {
  window.requestAnimationFrame(() => {
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    else focusFallback(fallbackSelector);
  });
}

function focusFallback(selector: string): void {
  queueMicrotask(() => {
    const fallback = document.querySelector<HTMLElement>(selector);
    fallback?.focus({ preventScroll: true });
  });
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

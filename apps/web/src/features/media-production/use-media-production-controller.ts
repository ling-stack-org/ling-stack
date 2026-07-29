import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelMediaSceneRun,
  createMediaProject,
  createMediaScene,
  deleteMediaProject,
  deleteMediaScene,
  duplicateMediaScene,
  getMediaProject,
  listMediaProjects,
  reorderMediaScenes,
  runMediaProject,
  runMediaScene,
  selectMediaSceneRun,
  updateMediaProject,
  updateMediaScene,
} from "../../api.js";
import type { UpdateMediaProjectRequest } from "../../types.js";
import {
  addBusySubject,
  createInitialMediaProductionState,
  projectIdAfterDelete,
  projectIdAfterListRefresh,
  removeBusySubject,
  removeMediaProductionFailure,
  replaceMediaProductionFailure,
  sceneIdAfterDelete,
  selectedSceneAfterDetail,
} from "./media-production-project-view-models.js";
import type {
  MediaProductionActions,
  MediaProductionFailure,
  MediaProductionFailureOwner,
  MediaProductionMutationOutcome,
  MediaProductionRetryIntent,
  MediaProductionState,
  MediaProductionToastIntent,
  MediaScenePatch,
} from "./media-production-types.js";

type ProjectRequestOwner = "project-list" | "project-detail";

interface RequestToken {
  readonly cwd: string;
  readonly epoch: number;
  readonly owner: ProjectRequestOwner;
  readonly requestId: number;
  readonly subjectId?: string;
}

interface MutationToken {
  readonly cwd: string;
  readonly epoch: number;
  readonly key: string;
  readonly requestId: number;
}

interface ControllerInput {
  readonly cwd: string;
  readonly defaultProjectName: string;
  readonly sceneTitleForIndex: (index: number) => string;
  readonly onJobsChanged: () => void;
  readonly onToast: (intent: MediaProductionToastIntent) => void;
}

interface LoadProjectOptions {
  readonly preferredSceneId?: string;
}

interface RefreshProjectOptions {
  readonly preferredProjectId?: string;
  readonly preferredSceneId?: string;
}

export function useMediaProductionController(input: ControllerInput): {
  readonly state: MediaProductionState;
  readonly actions: MediaProductionActions;
} {
  const [state, setState] = useState<MediaProductionState>(() => createInitialMediaProductionState());
  const stateRef = useRef(state);
  const activeCwdRef = useRef("");
  const epochRef = useRef(0);
  const requestRef = useRef<Record<ProjectRequestOwner, number>>({ "project-list": 0, "project-detail": 0 });
  const mutationRequestRef = useRef<Record<string, number>>({});
  const mountedRef = useRef(true);
  const inputRef = useRef(input);
  inputRef.current = input;

  const commit = useCallback((update: (current: MediaProductionState) => MediaProductionState): void => {
    if (!mountedRef.current) return;
    const next = update(stateRef.current);
    stateRef.current = next;
    setState(next);
  }, []);

  const clearFailure = useCallback((owner: MediaProductionFailureOwner, subjectId?: string): void => {
    commit((current) => ({
      ...current,
      failures: removeMediaProductionFailure(current.failures, owner, subjectId),
    }));
  }, [commit]);

  const beginRequest = useCallback((owner: ProjectRequestOwner, subjectId?: string): RequestToken => ({
    cwd: activeCwdRef.current,
    epoch: epochRef.current,
    owner,
    requestId: ++requestRef.current[owner],
    subjectId,
  }), []);

  const isCurrentRequest = useCallback((token: RequestToken): boolean => (
    mountedRef.current
    && token.cwd === activeCwdRef.current
    && token.epoch === epochRef.current
    && token.requestId === requestRef.current[token.owner]
  ), []);

  const beginMutation = useCallback((key: string): MutationToken => {
    const requestId = (mutationRequestRef.current[key] ?? 0) + 1;
    mutationRequestRef.current[key] = requestId;
    return { cwd: activeCwdRef.current, epoch: epochRef.current, key, requestId };
  }, []);

  const isCurrentMutation = useCallback((token: MutationToken): boolean => (
    mountedRef.current
    && token.cwd === activeCwdRef.current
    && token.epoch === epochRef.current
    && mutationRequestRef.current[token.key] === token.requestId
  ), []);

  const loadProjectDetail = useCallback(async (
    projectId: string,
    options: LoadProjectOptions = {},
  ): Promise<MediaProductionMutationOutcome> => {
    const cwd = activeCwdRef.current;
    const retryIntent: MediaProductionRetryIntent = { kind: "project-detail", projectId };
    if (!cwd || !projectId) return failedOutcome("project-detail", "Could not load this media project.", retryIntent, projectId);
    const token = beginRequest("project-detail", projectId);
    const retained = Boolean(stateRef.current.project);
    commit((current) => ({
      ...current,
      detailPhase: retained ? "refreshing" : "loading",
      pendingProjectId: projectId,
      failures: removeMediaProductionFailure(current.failures, "project-detail"),
    }));
    try {
      const response = await getMediaProject(cwd, projectId);
      if (!isCurrentRequest(token)) return staleOutcome("project-detail", retryIntent, projectId);
      if (response.mediaProject.id !== projectId) throw new Error("media_project_identity_mismatch");
      const preferredSceneId = options.preferredSceneId
        ?? (stateRef.current.selectedProjectId === projectId ? stateRef.current.selectedSceneId : "");
      commit((current) => ({
        ...current,
        detailPhase: "ready",
        project: response,
        projects: current.projects.map((item) => item.id === projectId ? response.mediaProject : item),
        selectedProjectId: projectId,
        pendingProjectId: "",
        selectedSceneId: selectedSceneAfterDetail(response, preferredSceneId),
        failures: removeMediaProductionFailure(current.failures, "project-detail"),
      }));
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentRequest(token)) return staleOutcome("project-detail", retryIntent, projectId);
      const failure = createFailure({
        error,
        owner: "project-detail",
        productMessageKey: retained
          ? "Could not switch projects. Showing the last loaded project."
          : "Could not load this media project.",
        retryIntent,
        subjectId: projectId,
      });
      commit((current) => ({
        ...current,
        detailPhase: retained ? "ready" : "error",
        pendingProjectId: "",
        failures: replaceMediaProductionFailure(current.failures, failure),
      }));
      return { ok: false, failure };
    }
  }, [beginRequest, commit, isCurrentRequest]);

  const refreshProjectList = useCallback(async (
    options: RefreshProjectOptions = {},
  ): Promise<MediaProductionMutationOutcome> => {
    const cwd = activeCwdRef.current;
    const retryIntent: MediaProductionRetryIntent = { kind: "project-list" };
    if (!cwd) return failedOutcome("project-list", "Choose a workspace before loading media projects.", retryIntent);
    const token = beginRequest("project-list");
    const retained = stateRef.current.projects.length > 0 || Boolean(stateRef.current.project);
    commit((current) => ({
      ...current,
      listPhase: retained ? "refreshing" : "loading",
      failures: removeMediaProductionFailure(current.failures, "project-list"),
      busy: { ...current.busy, projectList: true },
    }));
    try {
      const response = await listMediaProjects(cwd);
      if (!isCurrentRequest(token)) return staleOutcome("project-list", retryIntent);
      const preferredProjectId = projectIdAfterListRefresh(
        response.mediaProjects,
        options.preferredProjectId ?? "",
        stateRef.current.selectedProjectId,
      );
      const committedStillPresent = Boolean(
        stateRef.current.project
        && response.mediaProjects.some((item) => item.id === stateRef.current.selectedProjectId),
      );
      commit((current) => ({
        ...current,
        listPhase: "ready",
        projects: response.mediaProjects,
        project: committedStillPresent ? current.project : undefined,
        selectedProjectId: committedStillPresent ? current.selectedProjectId : "",
        selectedSceneId: committedStillPresent ? current.selectedSceneId : "",
        pendingProjectId: preferredProjectId,
        detailPhase: preferredProjectId ? (committedStillPresent ? "refreshing" : "loading") : "ready",
        failures: removeMediaProductionFailure(current.failures, "project-list"),
        busy: { ...current.busy, projectList: false },
      }));
      if (!preferredProjectId) return succeededOutcome();
      return await loadProjectDetail(preferredProjectId, { preferredSceneId: options.preferredSceneId });
    } catch (error) {
      if (!isCurrentRequest(token)) return staleOutcome("project-list", retryIntent);
      const hasRetainedContent = stateRef.current.projects.length > 0 || Boolean(stateRef.current.project);
      const failure = createFailure({
        error,
        owner: "project-list",
        productMessageKey: hasRetainedContent
          ? "Could not refresh media projects. Showing the last loaded projects."
          : "Could not load media projects.",
        retryIntent,
      });
      commit((current) => ({
        ...current,
        listPhase: hasRetainedContent ? "ready" : "error",
        failures: replaceMediaProductionFailure(current.failures, failure),
        busy: { ...current.busy, projectList: false },
      }));
      return { ok: false, failure };
    }
  }, [beginRequest, commit, isCurrentRequest, loadProjectDetail]);

  const selectProject = useCallback((projectId: string): void => {
    if (!projectId || projectId === stateRef.current.pendingProjectId || projectId === stateRef.current.selectedProjectId) return;
    void loadProjectDetail(projectId);
  }, [loadProjectDetail]);

  const refreshCurrentProject = useCallback(async (): Promise<MediaProductionMutationOutcome> => {
    const { selectedProjectId, selectedSceneId } = stateRef.current;
    return selectedProjectId
      ? await loadProjectDetail(selectedProjectId, { preferredSceneId: selectedSceneId })
      : await refreshProjectList();
  }, [loadProjectDetail, refreshProjectList]);

  const createProjectAction = useCallback(async (): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const retryIntent: MediaProductionRetryIntent = { kind: "project-create" };
    if (snapshot.busy.projectCreate) return busyOutcome("project-create", retryIntent);
    const cwd = activeCwdRef.current;
    if (!cwd) return failedOutcome("project-create", "Choose a workspace before creating a media project.", retryIntent);
    const token = beginMutation("project-create");
    commit((current) => ({
      ...current,
      failures: removeMediaProductionFailure(current.failures, "project-create"),
      busy: { ...current.busy, projectCreate: true },
    }));
    try {
      const response = await createMediaProject(cwd, { name: inputRef.current.defaultProjectName });
      if (!isCurrentMutation(token)) return staleOutcome("project-create", retryIntent);
      commit((current) => ({
        ...current,
        listPhase: "ready",
        detailPhase: "ready",
        projects: [response.mediaProject, ...current.projects.filter((item) => item.id !== response.mediaProject.id)],
        project: response,
        selectedProjectId: response.mediaProject.id,
        pendingProjectId: "",
        selectedSceneId: selectedSceneAfterDetail(response, ""),
        failures: removeMediaProductionFailure(current.failures, "project-create"),
      }));
      inputRef.current.onToast({
        messageKey: "Media project created",
        scope: `media-production:project:${response.mediaProject.id}:created`,
      });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token)) return staleOutcome("project-create", retryIntent);
      return commitMutationFailure(commit, createFailure({
        error,
        owner: "project-create",
        productMessageKey: "Could not create a media project.",
        retryIntent,
      }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, projectCreate: false } }));
    }
  }, [beginMutation, commit, isCurrentMutation]);

  const updateProjectAction = useCallback(async (patch: UpdateMediaProjectRequest): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const target = snapshot.project;
    const projectId = target?.mediaProject.id ?? "";
    const normalizedPatch = { ...patch, name: patch.name?.trim() };
    const retryIntent: MediaProductionRetryIntent = { kind: "project-update", projectId, patch: normalizedPatch };
    if (!target || (normalizedPatch.name !== undefined && !normalizedPatch.name)) {
      return failedOutcome("project-update", "Enter a project name before saving.", retryIntent, projectId);
    }
    if (snapshot.busy.projectUpdateId === projectId || snapshot.busy.projectDeleteId === projectId) {
      return busyOutcome("project-update", retryIntent, projectId);
    }
    const cwd = activeCwdRef.current;
    const token = beginMutation(`project-update:${projectId}`);
    commit((current) => ({
      ...current,
      failures: removeMediaProductionFailure(current.failures, "project-update", projectId),
      busy: { ...current.busy, projectUpdateId: projectId },
    }));
    try {
      const response = await updateMediaProject(cwd, projectId, normalizedPatch);
      if (!isCurrentMutation(token)) return staleOutcome("project-update", retryIntent, projectId);
      const stillSelected = stateRef.current.selectedProjectId === projectId;
      commit((current) => ({
        ...current,
        project: stillSelected ? response : current.project,
        projects: current.projects.map((item) => item.id === projectId ? response.mediaProject : item),
        selectedSceneId: stillSelected ? selectedSceneAfterDetail(response, current.selectedSceneId) : current.selectedSceneId,
        failures: removeMediaProductionFailure(current.failures, "project-update", projectId),
      }));
      if (stillSelected) inputRef.current.onToast({ messageKey: "Media project saved", scope: `media-production:project:${projectId}:saved` });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("project-update", retryIntent, projectId);
      return commitMutationFailure(commit, createFailure({
        error,
        owner: "project-update",
        productMessageKey: "Could not save this media project.",
        retryIntent,
        subjectId: projectId,
      }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({
        ...current,
        busy: { ...current.busy, projectUpdateId: current.busy.projectUpdateId === projectId ? "" : current.busy.projectUpdateId },
      }));
    }
  }, [beginMutation, commit, isCurrentMutation]);

  const deleteProjectAction = useCallback(async (projectId: string): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const retryIntent: MediaProductionRetryIntent = { kind: "project-delete", projectId };
    if (!snapshot.project || snapshot.selectedProjectId !== projectId || snapshot.project.mediaProject.id !== projectId) {
      return failedOutcome("project-delete", "This media project is no longer selected.", retryIntent, projectId);
    }
    if (snapshot.busy.projectDeleteId === projectId || snapshot.busy.projectUpdateId === projectId) {
      return busyOutcome("project-delete", retryIntent, projectId);
    }
    const cwd = activeCwdRef.current;
    const preferredProjectId = projectIdAfterDelete(snapshot.projects, projectId);
    const token = beginMutation(`project-delete:${projectId}`);
    commit((current) => ({
      ...current,
      failures: removeMediaProductionFailure(current.failures, "project-delete", projectId),
      busy: { ...current.busy, projectDeleteId: projectId },
    }));
    try {
      await deleteMediaProject(cwd, projectId);
      if (!isCurrentMutation(token)) return staleOutcome("project-delete", retryIntent, projectId);
      commit((current) => ({
        ...current,
        projects: current.projects.filter((item) => item.id !== projectId),
        project: undefined,
        selectedProjectId: "",
        pendingProjectId: "",
        selectedSceneId: "",
        detailPhase: "initial",
        failures: removeMediaProductionFailure(current.failures, "project-delete", projectId),
      }));
      inputRef.current.onToast({ messageKey: "Media project deleted", scope: `media-production:project:${projectId}:deleted` });
      if (preferredProjectId) {
        void loadProjectDetail(preferredProjectId).then(() => {
          if (isCurrentMutation(token)) void refreshProjectList({ preferredProjectId });
        });
      } else {
        void refreshProjectList();
      }
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token)) return staleOutcome("project-delete", retryIntent, projectId);
      return commitMutationFailure(commit, createFailure({
        error,
        owner: "project-delete",
        productMessageKey: "Could not delete this media project.",
        retryIntent,
        subjectId: projectId,
      }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({
        ...current,
        busy: { ...current.busy, projectDeleteId: current.busy.projectDeleteId === projectId ? "" : current.busy.projectDeleteId },
      }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail, refreshProjectList]);

  const createSceneAction = useCallback(async (): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const projectId = snapshot.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "scene-create", projectId };
    if (!snapshot.project || snapshot.busy.sceneCreateProjectId === projectId) return busyOutcome("scene-create", retryIntent, projectId);
    const cwd = activeCwdRef.current;
    const token = beginMutation(`scene-create:${projectId}`);
    commit((current) => ({
      ...current,
      failures: removeMediaProductionFailure(current.failures, "scene-create", projectId),
      busy: { ...current.busy, sceneCreateProjectId: projectId },
    }));
    try {
      const sceneNumber = snapshot.project.scenes.length + 1;
      const response = await createMediaScene(cwd, projectId, {
        title: inputRef.current.sceneTitleForIndex(sceneNumber),
        prompt: "",
        canvasPosition: { x: 80 + snapshot.project.scenes.length * 40, y: 96 + snapshot.project.scenes.length * 32 },
      });
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-create", retryIntent, projectId);
      commit((current) => ({
        ...current,
        project: current.project && current.project.mediaProject.id === projectId ? {
          ...current.project,
          scenes: [...current.project.scenes.filter((scene) => scene.id !== response.mediaScene.id), response.mediaScene],
        } : current.project,
        selectedSceneId: response.mediaScene.id,
        failures: removeMediaProductionFailure(current.failures, "scene-create", projectId),
      }));
      inputRef.current.onToast({ messageKey: "Scene created", scope: `media-production:scene:${response.mediaScene.id}:created` });
      await loadProjectDetail(projectId, { preferredSceneId: response.mediaScene.id });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-create", retryIntent, projectId);
      return commitMutationFailure(commit, createFailure({ error, owner: "scene-create", productMessageKey: "Could not create a scene.", retryIntent, subjectId: projectId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({
        ...current,
        busy: { ...current.busy, sceneCreateProjectId: current.busy.sceneCreateProjectId === projectId ? "" : current.busy.sceneCreateProjectId },
      }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail]);

  const updateSceneAction = useCallback(async (sceneId: string, patch: MediaScenePatch): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const projectId = snapshot.selectedProjectId;
    const moving = Object.keys(patch).length > 0 && Object.keys(patch).every((key) => key === "canvasPosition");
    const owner: MediaProductionFailureOwner = moving ? "scene-move" : "scene-update";
    const retryIntent: MediaProductionRetryIntent = { kind: "scene-update", sceneId, patch };
    if (!snapshot.project || snapshot.busy.sceneUpdateIds.includes(sceneId) || snapshot.busy.sceneMoveIds.includes(sceneId)) {
      return busyOutcome(owner, retryIntent, sceneId);
    }
    const token = beginMutation(`${owner}:${sceneId}`);
    commit((current) => ({
      ...current,
      failures: removeMediaProductionFailure(current.failures, owner, sceneId),
      busy: {
        ...current.busy,
        sceneUpdateIds: moving ? current.busy.sceneUpdateIds : addBusySubject(current.busy.sceneUpdateIds, sceneId),
        sceneMoveIds: moving ? addBusySubject(current.busy.sceneMoveIds, sceneId) : current.busy.sceneMoveIds,
      },
    }));
    try {
      const response = await updateMediaScene(activeCwdRef.current, sceneId, patch);
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome(owner, retryIntent, sceneId);
      commit((current) => ({
        ...current,
        project: current.project && current.project.mediaProject.id === projectId ? {
          ...current.project,
          scenes: current.project.scenes.map((scene) => scene.id === response.mediaScene.id ? response.mediaScene : scene),
        } : current.project,
        failures: removeMediaProductionFailure(current.failures, owner, sceneId),
      }));
      if (!moving) inputRef.current.onToast({ messageKey: "Scene saved", scope: `media-production:scene:${sceneId}:saved` });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome(owner, retryIntent, sceneId);
      return commitMutationFailure(commit, createFailure({
        error,
        owner,
        productMessageKey: moving ? "Could not save this scene position." : "Could not save this scene.",
        retryIntent,
        subjectId: sceneId,
      }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({
        ...current,
        busy: {
          ...current.busy,
          sceneUpdateIds: removeBusySubject(current.busy.sceneUpdateIds, sceneId),
          sceneMoveIds: removeBusySubject(current.busy.sceneMoveIds, sceneId),
        },
      }));
    }
  }, [beginMutation, commit, isCurrentMutation]);

  const reorderScenesAction = useCallback(async (sceneIds: readonly string[]): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const projectId = snapshot.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "scene-reorder", projectId, sceneIds };
    if (!snapshot.project || snapshot.busy.sceneReorderProjectId === projectId) return busyOutcome("scene-reorder", retryIntent, projectId);
    const token = beginMutation(`scene-reorder:${projectId}`);
    commit((current) => ({ ...current, failures: removeMediaProductionFailure(current.failures, "scene-reorder", projectId), busy: { ...current.busy, sceneReorderProjectId: projectId } }));
    try {
      const response = await reorderMediaScenes(activeCwdRef.current, projectId, sceneIds);
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-reorder", retryIntent, projectId);
      commit((current) => ({
        ...current,
        project: current.project && current.project.mediaProject.id === projectId ? { ...current.project, scenes: response.scenes } : current.project,
        failures: removeMediaProductionFailure(current.failures, "scene-reorder", projectId),
      }));
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-reorder", retryIntent, projectId);
      return commitMutationFailure(commit, createFailure({ error, owner: "scene-reorder", productMessageKey: "Could not reorder these scenes.", retryIntent, subjectId: projectId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, sceneReorderProjectId: current.busy.sceneReorderProjectId === projectId ? "" : current.busy.sceneReorderProjectId } }));
    }
  }, [beginMutation, commit, isCurrentMutation]);

  const duplicateSceneAction = useCallback(async (sceneId: string): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const projectId = snapshot.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "scene-duplicate", sceneId };
    if (!snapshot.project || snapshot.busy.sceneDuplicateIds.includes(sceneId)) return busyOutcome("scene-duplicate", retryIntent, sceneId);
    const token = beginMutation(`scene-duplicate:${sceneId}`);
    commit((current) => ({ ...current, failures: removeMediaProductionFailure(current.failures, "scene-duplicate", sceneId), busy: { ...current.busy, sceneDuplicateIds: addBusySubject(current.busy.sceneDuplicateIds, sceneId) } }));
    try {
      const response = await duplicateMediaScene(activeCwdRef.current, sceneId);
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-duplicate", retryIntent, sceneId);
      commit((current) => ({
        ...current,
        project: current.project && current.project.mediaProject.id === projectId ? { ...current.project, scenes: [...current.project.scenes, response.mediaScene] } : current.project,
        selectedSceneId: response.mediaScene.id,
        failures: removeMediaProductionFailure(current.failures, "scene-duplicate", sceneId),
      }));
      inputRef.current.onToast({ messageKey: "Scene duplicated", scope: `media-production:scene:${response.mediaScene.id}:duplicated` });
      await loadProjectDetail(projectId, { preferredSceneId: response.mediaScene.id });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-duplicate", retryIntent, sceneId);
      return commitMutationFailure(commit, createFailure({ error, owner: "scene-duplicate", productMessageKey: "Could not duplicate this scene.", retryIntent, subjectId: sceneId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, sceneDuplicateIds: removeBusySubject(current.busy.sceneDuplicateIds, sceneId) } }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail]);

  const deleteSceneAction = useCallback(async (sceneId: string): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const projectId = snapshot.selectedProjectId;
    const target = snapshot.project?.scenes.find((scene) => scene.id === sceneId);
    const retryIntent: MediaProductionRetryIntent = { kind: "scene-delete", sceneId };
    if (!snapshot.project || !target) return failedOutcome("scene-delete", "This scene is no longer available.", retryIntent, sceneId);
    if (snapshot.busy.sceneDeleteIds.includes(sceneId)) return busyOutcome("scene-delete", retryIntent, sceneId);
    const nextSceneId = sceneIdAfterDelete(snapshot.project.scenes, sceneId);
    const token = beginMutation(`scene-delete:${sceneId}`);
    commit((current) => ({ ...current, failures: removeMediaProductionFailure(current.failures, "scene-delete", sceneId), busy: { ...current.busy, sceneDeleteIds: addBusySubject(current.busy.sceneDeleteIds, sceneId) } }));
    try {
      await deleteMediaScene(activeCwdRef.current, sceneId);
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-delete", retryIntent, sceneId);
      commit((current) => ({
        ...current,
        project: current.project && current.project.mediaProject.id === projectId ? { ...current.project, scenes: current.project.scenes.filter((scene) => scene.id !== sceneId) } : current.project,
        selectedSceneId: nextSceneId,
        failures: removeMediaProductionFailure(current.failures, "scene-delete", sceneId),
      }));
      inputRef.current.onToast({ messageKey: "Scene deleted", scope: `media-production:scene:${sceneId}:deleted` });
      void loadProjectDetail(projectId, { preferredSceneId: nextSceneId });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-delete", retryIntent, sceneId);
      return commitMutationFailure(commit, createFailure({ error, owner: "scene-delete", productMessageKey: "Could not delete this scene.", retryIntent, subjectId: sceneId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, sceneDeleteIds: removeBusySubject(current.busy.sceneDeleteIds, sceneId) } }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail]);

  const runSceneAction = useCallback(async (sceneId: string): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const projectId = snapshot.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "scene-run", sceneId };
    if (!snapshot.project || snapshot.busy.sceneRunIds.includes(sceneId)) return busyOutcome("scene-run", retryIntent, sceneId);
    const token = beginMutation(`scene-run:${sceneId}`);
    commit((current) => ({ ...current, failures: removeMediaProductionFailure(current.failures, "scene-run", sceneId), busy: { ...current.busy, sceneRunIds: addBusySubject(current.busy.sceneRunIds, sceneId) } }));
    try {
      await runMediaScene(activeCwdRef.current, sceneId);
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-run", retryIntent, sceneId);
      await loadProjectDetail(projectId, { preferredSceneId: sceneId });
      inputRef.current.onJobsChanged();
      inputRef.current.onToast({ messageKey: "Scene generation submitted", scope: `media-production:run:${sceneId}:submitted` });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("scene-run", retryIntent, sceneId);
      return commitMutationFailure(commit, createFailure({ error, owner: "scene-run", productMessageKey: "Could not start this scene.", retryIntent, subjectId: sceneId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, sceneRunIds: removeBusySubject(current.busy.sceneRunIds, sceneId) } }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail]);

  const runProjectAction = useCallback(async (sceneIds: readonly string[]): Promise<MediaProductionMutationOutcome> => {
    const snapshot = stateRef.current;
    const projectId = snapshot.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "project-run", projectId, sceneIds };
    if (!snapshot.project || snapshot.busy.projectRunId === projectId) return busyOutcome("project-run", retryIntent, projectId);
    const token = beginMutation(`project-run:${projectId}`);
    commit((current) => ({ ...current, failures: removeMediaProductionFailure(current.failures, "project-run", projectId), busy: { ...current.busy, projectRunId: projectId } }));
    try {
      await runMediaProject(activeCwdRef.current, projectId, { sceneIds });
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("project-run", retryIntent, projectId);
      await loadProjectDetail(projectId, { preferredSceneId: stateRef.current.selectedSceneId });
      inputRef.current.onJobsChanged();
      inputRef.current.onToast({ messageKey: "Project generation submitted", scope: `media-production:run:${projectId}:submitted` });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("project-run", retryIntent, projectId);
      return commitMutationFailure(commit, createFailure({ error, owner: "project-run", productMessageKey: "Could not start this media project.", retryIntent, subjectId: projectId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, projectRunId: current.busy.projectRunId === projectId ? "" : current.busy.projectRunId } }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail]);

  const selectSceneRunAction = useCallback(async (sceneId: string, sceneRunId: string): Promise<MediaProductionMutationOutcome> => {
    const projectId = stateRef.current.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "run-select", sceneId, sceneRunId };
    if (stateRef.current.busy.selectRunIds.includes(sceneRunId)) return busyOutcome("run-select", retryIntent, sceneRunId);
    const token = beginMutation(`run-select:${sceneRunId}`);
    commit((current) => ({ ...current, failures: removeMediaProductionFailure(current.failures, "run-select", sceneRunId), busy: { ...current.busy, selectRunIds: addBusySubject(current.busy.selectRunIds, sceneRunId) } }));
    try {
      await selectMediaSceneRun(activeCwdRef.current, sceneId, sceneRunId);
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("run-select", retryIntent, sceneRunId);
      await loadProjectDetail(projectId, { preferredSceneId: sceneId });
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("run-select", retryIntent, sceneRunId);
      return commitMutationFailure(commit, createFailure({ error, owner: "run-select", productMessageKey: "Could not select this result.", retryIntent, subjectId: sceneRunId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, selectRunIds: removeBusySubject(current.busy.selectRunIds, sceneRunId) } }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail]);

  const cancelSceneRunAction = useCallback(async (sceneRunId: string): Promise<MediaProductionMutationOutcome> => {
    const projectId = stateRef.current.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "run-cancel", sceneRunId };
    if (stateRef.current.busy.cancelRunIds.includes(sceneRunId)) return busyOutcome("run-cancel", retryIntent, sceneRunId);
    const token = beginMutation(`run-cancel:${sceneRunId}`);
    commit((current) => ({ ...current, failures: removeMediaProductionFailure(current.failures, "run-cancel", sceneRunId), busy: { ...current.busy, cancelRunIds: addBusySubject(current.busy.cancelRunIds, sceneRunId) } }));
    try {
      await cancelMediaSceneRun(activeCwdRef.current, sceneRunId);
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("run-cancel", retryIntent, sceneRunId);
      await loadProjectDetail(projectId, { preferredSceneId: stateRef.current.selectedSceneId });
      inputRef.current.onJobsChanged();
      return succeededOutcome();
    } catch (error) {
      if (!isCurrentMutation(token) || stateRef.current.selectedProjectId !== projectId) return staleOutcome("run-cancel", retryIntent, sceneRunId);
      return commitMutationFailure(commit, createFailure({ error, owner: "run-cancel", productMessageKey: "Could not cancel this generation.", retryIntent, subjectId: sceneRunId }));
    } finally {
      if (isCurrentMutation(token)) commit((current) => ({ ...current, busy: { ...current.busy, cancelRunIds: removeBusySubject(current.busy.cancelRunIds, sceneRunId) } }));
    }
  }, [beginMutation, commit, isCurrentMutation, loadProjectDetail]);

  const retryFailure = useCallback(async (failure: MediaProductionFailure): Promise<MediaProductionMutationOutcome> => {
    const intent = failure.retryIntent;
    switch (intent.kind) {
      case "project-list": return await refreshProjectList();
      case "project-detail": return await loadProjectDetail(intent.projectId);
      case "project-create": return await createProjectAction();
      case "project-update": return await updateProjectAction(intent.patch);
      case "project-delete": return await deleteProjectAction(intent.projectId);
      case "scene-create": return await createSceneAction();
      case "scene-update": return await updateSceneAction(intent.sceneId, intent.patch);
      case "scene-duplicate": return await duplicateSceneAction(intent.sceneId);
      case "scene-reorder": return await reorderScenesAction(intent.sceneIds);
      case "scene-delete": return await deleteSceneAction(intent.sceneId);
      case "scene-run": return await runSceneAction(intent.sceneId);
      case "project-run": return await runProjectAction(intent.sceneIds);
      case "run-cancel": return await cancelSceneRunAction(intent.sceneRunId);
      case "run-select": return await selectSceneRunAction(intent.sceneId, intent.sceneRunId);
      default: return failedOutcome(failure.owner, "Retry is not available from this surface.", intent, failure.subjectId);
    }
  }, [cancelSceneRunAction, createProjectAction, createSceneAction, deleteProjectAction, deleteSceneAction,
    duplicateSceneAction, loadProjectDetail, refreshProjectList, reorderScenesAction, runProjectAction,
    runSceneAction, selectSceneRunAction, updateProjectAction, updateSceneAction]);

  useEffect(() => {
    const cwd = input.cwd.trim();
    epochRef.current += 1;
    requestRef.current["project-list"] += 1;
    requestRef.current["project-detail"] += 1;
    mutationRequestRef.current = {};
    activeCwdRef.current = cwd;
    commit(() => createInitialMediaProductionState(epochRef.current));
    if (cwd) void refreshProjectList();
  }, [commit, input.cwd, refreshProjectList]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  return {
    state,
    actions: {
      selectProject,
      selectScene: (sceneId) => commit((current) => ({ ...current, selectedSceneId: sceneId })),
      refresh: refreshProjectList,
      refreshCurrentProject,
      retryFailure,
      clearFailure,
      createProject: createProjectAction,
      updateProject: updateProjectAction,
      deleteProject: deleteProjectAction,
      createScene: createSceneAction,
      updateScene: updateSceneAction,
      reorderScenes: reorderScenesAction,
      duplicateScene: duplicateSceneAction,
      deleteScene: deleteSceneAction,
      runScene: runSceneAction,
      runProject: runProjectAction,
      selectSceneRun: selectSceneRunAction,
      cancelSceneRun: cancelSceneRunAction,
    },
  };
}

function createFailure(input: {
  readonly error: unknown;
  readonly owner: MediaProductionFailureOwner;
  readonly productMessageKey: string;
  readonly retryIntent: MediaProductionRetryIntent;
  readonly subjectId?: string;
}): MediaProductionFailure {
  return {
    owner: input.owner,
    subjectId: input.subjectId,
    productMessageKey: input.productMessageKey,
    technicalMessage: input.error instanceof Error ? input.error.message : String(input.error),
    retryIntent: input.retryIntent,
  };
}

function succeededOutcome(): MediaProductionMutationOutcome {
  return { ok: true, value: undefined };
}

function failedOutcome(
  owner: MediaProductionFailureOwner,
  productMessageKey: string,
  retryIntent: MediaProductionRetryIntent,
  subjectId?: string,
): MediaProductionMutationOutcome {
  return { ok: false, failure: { owner, productMessageKey, retryIntent, subjectId } };
}

function staleOutcome(
  owner: MediaProductionFailureOwner,
  retryIntent: MediaProductionRetryIntent,
  subjectId?: string,
): MediaProductionMutationOutcome {
  return failedOutcome(owner, "This request no longer applies to the current workspace.", retryIntent, subjectId);
}

function busyOutcome(
  owner: MediaProductionFailureOwner,
  retryIntent: MediaProductionRetryIntent,
  subjectId?: string,
): MediaProductionMutationOutcome {
  return failedOutcome(owner, "This action is already in progress.", retryIntent, subjectId);
}

function commitMutationFailure(
  commit: (update: (current: MediaProductionState) => MediaProductionState) => void,
  failure: MediaProductionFailure,
): MediaProductionMutationOutcome {
  commit((current) => ({
    ...current,
    failures: replaceMediaProductionFailure(current.failures, failure),
  }));
  return { ok: false, failure };
}

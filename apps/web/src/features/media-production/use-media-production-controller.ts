import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelMediaSceneRun,
  createMediaProject,
  createMediaScene,
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
import type { MediaScene, UpdateMediaProjectRequest } from "../../types.js";
import type { MediaProductionActions, MediaProductionProjectDetail, MediaProductionState, MediaScenePatch } from "./media-production-types.js";

export function useMediaProductionController(input: {
  readonly cwd: string;
  readonly onJobsChanged: () => void;
}): { readonly state: MediaProductionState; readonly actions: MediaProductionActions } {
  const [projects, setProjects] = useState<MediaProductionState["projects"]>([]);
  const [project, setProject] = useState<MediaProductionProjectDetail | undefined>();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [isLoading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const noticeTimer = useRef<number | undefined>();

  const showNotice = useCallback((message: string): void => {
    if (noticeTimer.current !== undefined) {
      window.clearTimeout(noticeTimer.current);
    }
    setNoticeMessage(message);
    noticeTimer.current = window.setTimeout(() => setNoticeMessage(""), 2_000);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current !== undefined) {
      window.clearTimeout(noticeTimer.current);
    }
  }, []);

  const loadProject = useCallback(async (
    projectId: string,
    options: { readonly quiet?: boolean; readonly silent?: boolean } = {},
  ): Promise<void> => {
    const cwd = input.cwd.trim();
    if (!cwd || !projectId) {
      setProject(undefined);
      return;
    }
    if (!options.quiet) {
      setLoading(true);
    }
    try {
      const response = await getMediaProject(cwd, projectId);
      setProject(response);
      setSelectedSceneId((current) => current && response.scenes.some((scene) => scene.id === current)
        ? current
        : response.scenes[0]?.id ?? "");
    } catch (error) {
      if (!options.silent) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!options.quiet) {
        setLoading(false);
      }
    }
  }, [input.cwd]);

  const refresh = useCallback(async (): Promise<void> => {
    const cwd = input.cwd.trim();
    if (!cwd) {
      setProjects([]);
      setProject(undefined);
      return;
    }
    setLoading(true);
    try {
      setErrorMessage("");
      const response = await listMediaProjects(cwd);
      setProjects(response.mediaProjects);
      const nextProjectId = selectedProjectId && response.mediaProjects.some((item) => item.id === selectedProjectId)
        ? selectedProjectId
        : response.mediaProjects[0]?.id ?? "";
      setSelectedProjectId(nextProjectId);
      if (nextProjectId) {
        await loadProject(nextProjectId, { quiet: true });
      } else {
        setProject(undefined);
        setSelectedSceneId("");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [input.cwd, loadProject, selectedProjectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshCurrentProject = useCallback(async (): Promise<void> => {
    if (selectedProjectId) {
      await loadProject(selectedProjectId, { quiet: true, silent: true });
    }
  }, [loadProject, selectedProjectId]);

  const selectProject = useCallback((projectId: string): void => {
    setSelectedProjectId(projectId);
    setErrorMessage("");
    void loadProject(projectId);
  }, [loadProject]);

  async function createProject(): Promise<void> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      return;
    }
    setBusyAction("create-project");
    try {
      setErrorMessage("");
      const response = await createMediaProject(cwd, { name: "未命名媒体项目" });
      setProjects((current) => [response.mediaProject, ...current]);
      setSelectedProjectId(response.mediaProject.id);
      setProject(response);
      setSelectedSceneId("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function updateProject(patch: UpdateMediaProjectRequest): Promise<void> {
    if (!project || (patch.name !== undefined && !patch.name.trim())) {
      return;
    }
    setBusyAction("update-project");
    try {
      const response = await updateMediaProject(input.cwd.trim(), project.mediaProject.id, {
        ...patch,
        name: patch.name?.trim(),
      });
      setProject(response);
      setProjects((current) => current.map((item) => item.id === response.mediaProject.id ? response.mediaProject : item));
      showNotice("Saved");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function createScene(): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction("create-scene");
    try {
      const sceneNumber = project.scenes.length + 1;
      const response = await createMediaScene(input.cwd.trim(), project.mediaProject.id, {
        title: `场景 ${sceneNumber}`,
        prompt: "",
        canvasPosition: { x: 80 + project.scenes.length * 40, y: 96 + project.scenes.length * 32 },
      });
      await loadProject(project.mediaProject.id, { quiet: true });
      setSelectedSceneId(response.mediaScene.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function updateScene(
    sceneId: string,
    patch: MediaScenePatch,
  ): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction(`update-scene:${sceneId}`);
    try {
      const response = await updateMediaScene(input.cwd.trim(), sceneId, patch);
      setProject((current) => {
        if (!current || current.mediaProject.id !== project.mediaProject.id) {
          return current;
        }
        return {
          ...current,
          scenes: current.scenes.map((scene) => scene.id === response.mediaScene.id ? response.mediaScene : scene),
        };
      });
      if (!Object.keys(patch).every((key) => key === "canvasPosition")) {
        showNotice("Saved");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function reorderScenes(sceneIds: readonly string[]): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction("reorder-scenes");
    try {
      await reorderMediaScenes(input.cwd.trim(), project.mediaProject.id, sceneIds);
      await loadProject(project.mediaProject.id, { quiet: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function duplicateScene(sceneId: string): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction(`duplicate-scene:${sceneId}`);
    try {
      const response = await duplicateMediaScene(input.cwd.trim(), sceneId);
      await loadProject(project.mediaProject.id, { quiet: true });
      setSelectedSceneId(response.mediaScene.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function removeScene(sceneId: string): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction(`delete-scene:${sceneId}`);
    try {
      await deleteMediaScene(input.cwd.trim(), sceneId);
      setSelectedSceneId("");
      await loadProject(project.mediaProject.id, { quiet: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function runScene(sceneId: string): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction(`run-scene:${sceneId}`);
    try {
      await runMediaScene(input.cwd.trim(), sceneId);
      await loadProject(project.mediaProject.id, { quiet: true });
      input.onJobsChanged();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function runProject(sceneIds: readonly string[]): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction("run-project");
    try {
      await runMediaProject(input.cwd.trim(), project.mediaProject.id, { sceneIds });
      await loadProject(project.mediaProject.id, { quiet: true });
      input.onJobsChanged();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function chooseSceneRun(sceneId: string, sceneRunId: string): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction(`select-run:${sceneRunId}`);
    try {
      await selectMediaSceneRun(input.cwd.trim(), sceneId, sceneRunId);
      await loadProject(project.mediaProject.id, { quiet: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  async function cancelSceneRun(sceneRunId: string): Promise<void> {
    if (!project) {
      return;
    }
    setBusyAction(`cancel-run:${sceneRunId}`);
    try {
      await cancelMediaSceneRun(input.cwd.trim(), sceneRunId);
      await loadProject(project.mediaProject.id, { quiet: true });
      input.onJobsChanged();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  }

  return {
    state: { projects, project, selectedProjectId, selectedSceneId, isLoading, busyAction, errorMessage, noticeMessage },
    actions: {
      selectProject,
      selectScene: setSelectedSceneId,
      refresh,
      refreshCurrentProject,
      createProject,
      updateProject,
      createScene,
      updateScene,
      reorderScenes,
      duplicateScene,
      deleteScene: removeScene,
      runScene,
      runProject,
      selectSceneRun: chooseSceneRun,
      cancelSceneRun,
    },
  };
}

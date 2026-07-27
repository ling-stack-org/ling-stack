import type { MediaProject, MediaScene } from "../../types.js";
import type {
  MediaProductionBusyState,
  MediaProductionFailure,
  MediaProductionFailureOwner,
  MediaProductionProjectDetail,
  MediaProductionState,
} from "./media-production-types.js";

export const emptyMediaProductionBusyState: MediaProductionBusyState = {
  projectList: false,
  projectCreate: false,
  projectUpdateId: "",
  projectDeleteId: "",
  sceneCreateProjectId: "",
  sceneUpdateIds: [],
  sceneDuplicateIds: [],
  sceneMoveIds: [],
  sceneReorderProjectId: "",
  sceneDeleteIds: [],
  sceneRunIds: [],
  projectRunId: "",
  cancelRunIds: [],
  selectRunIds: [],
};

export function createInitialMediaProductionState(workspaceEpoch = 0): MediaProductionState {
  return {
    workspaceEpoch,
    listPhase: "initial",
    detailPhase: "initial",
    projects: [],
    project: undefined,
    selectedProjectId: "",
    pendingProjectId: "",
    selectedSceneId: "",
    failures: [],
    busy: emptyMediaProductionBusyState,
  };
}

export function replaceMediaProductionFailure(
  failures: readonly MediaProductionFailure[],
  failure: MediaProductionFailure,
): readonly MediaProductionFailure[] {
  return [
    ...failures.filter((item) => item.owner !== failure.owner || item.subjectId !== failure.subjectId),
    failure,
  ];
}

export function removeMediaProductionFailure(
  failures: readonly MediaProductionFailure[],
  owner: MediaProductionFailureOwner,
  subjectId?: string,
): readonly MediaProductionFailure[] {
  return failures.filter((item) => item.owner !== owner || (subjectId !== undefined && item.subjectId !== subjectId));
}

export function selectMediaProductionFailure(
  failures: readonly MediaProductionFailure[],
  owners: readonly MediaProductionFailureOwner[],
  subjectId?: string,
): MediaProductionFailure | undefined {
  return failures.find((failure) => owners.includes(failure.owner) && (subjectId === undefined || failure.subjectId === subjectId));
}

export function addBusySubject(subjects: readonly string[], subjectId: string): readonly string[] {
  return subjects.includes(subjectId) ? subjects : [...subjects, subjectId];
}

export function removeBusySubject(subjects: readonly string[], subjectId: string): readonly string[] {
  return subjects.filter((item) => item !== subjectId);
}

export function selectedSceneAfterDetail(
  detail: MediaProductionProjectDetail,
  preferredSceneId: string,
): string {
  if (preferredSceneId && detail.scenes.some((scene) => scene.id === preferredSceneId)) {
    return preferredSceneId;
  }
  return detail.scenes[0]?.id ?? "";
}

export function projectIdAfterListRefresh(
  projects: readonly MediaProject[],
  preferredProjectId: string,
  committedProjectId: string,
): string {
  if (preferredProjectId && projects.some((project) => project.id === preferredProjectId)) {
    return preferredProjectId;
  }
  if (committedProjectId && projects.some((project) => project.id === committedProjectId)) {
    return committedProjectId;
  }
  return projects[0]?.id ?? "";
}

export function projectIdAfterDelete(projects: readonly MediaProject[], deletedProjectId: string): string {
  return projects.find((project) => project.id !== deletedProjectId)?.id ?? "";
}

export function sceneIdAfterDelete(scenes: readonly MediaScene[], deletedSceneId: string): string {
  const index = scenes.findIndex((scene) => scene.id === deletedSceneId);
  if (index < 0) return scenes[0]?.id ?? "";
  return scenes[index + 1]?.id ?? scenes[index - 1]?.id ?? "";
}

export function mediaProductionLegacyBusyAction(busy: MediaProductionBusyState): string {
  if (busy.projectCreate) return "create-project";
  if (busy.projectUpdateId) return "update-project";
  if (busy.projectDeleteId) return `delete-project:${busy.projectDeleteId}`;
  if (busy.sceneCreateProjectId) return "create-scene";
  if (busy.sceneReorderProjectId) return "reorder-scenes";
  if (busy.projectRunId) return "run-project";
  const subjectActions: ReadonlyArray<readonly [readonly string[], string]> = [
    [busy.sceneUpdateIds, "update-scene"],
    [busy.sceneDuplicateIds, "duplicate-scene"],
    [busy.sceneMoveIds, "update-scene"],
    [busy.sceneDeleteIds, "delete-scene"],
    [busy.sceneRunIds, "run-scene"],
    [busy.cancelRunIds, "cancel-run"],
    [busy.selectRunIds, "select-run"],
  ];
  for (const [subjects, prefix] of subjectActions) {
    if (subjects[0]) return `${prefix}:${subjects[0]}`;
  }
  return "";
}

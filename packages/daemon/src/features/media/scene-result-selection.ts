import type { MediaStoreFacet } from "@ling-stack/core";

export function selectInitialMediaSceneResult(
  store: MediaStoreFacet,
  mediaJobId: string,
  selectedAt: string,
): void {
  const sceneRun = store.getMediaSceneRunByMediaJobId(mediaJobId);
  if (!sceneRun) {
    return;
  }
  const scene = store.getMediaScene(sceneRun.sceneId);
  if (!scene || scene.selectedMediaSceneRunId) {
    return;
  }
  store.updateMediaScene(scene.id, { selectedMediaSceneRunId: sceneRun.id }, selectedAt);
}

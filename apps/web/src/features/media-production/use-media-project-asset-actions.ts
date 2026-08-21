import { useCallback, useRef } from "react";
import { createMediaProjectAsset, deleteMediaProjectAsset } from "../../api.js";
import type { CreateMediaProjectAssetRequest, MediaProjectAsset } from "../../types.js";
import type {
  MediaProductionActions,
  MediaProductionFailure,
  MediaProductionFailureOwner,
  MediaProductionMutationOutcome,
  MediaProductionMutationToken,
  MediaProductionRetryIntent,
  MediaProductionState,
} from "./media-production-types.js";

interface MediaProjectAssetActionInput {
  readonly stateRef: { readonly current: MediaProductionState };
  readonly activeCwdRef: { readonly current: string };
  readonly commit: (update: (current: MediaProductionState) => MediaProductionState) => void;
  readonly beginMutation: (key: string) => MediaProductionMutationToken;
  readonly isCurrentMutation: (token: MediaProductionMutationToken) => boolean;
  readonly releaseMutation: (token: MediaProductionMutationToken) => void;
}

export function useMediaProjectAssetActions(
  {
    stateRef,
    activeCwdRef,
    commit,
    beginMutation,
    isCurrentMutation,
    releaseMutation,
  }: MediaProjectAssetActionInput,
): Pick<MediaProductionActions, "createProjectAsset" | "deleteProjectAsset"> {
  const concurrentSequenceRef = useRef(0);

  const createProjectAsset = useCallback(async (
    projectId: string,
    assetInput: CreateMediaProjectAssetRequest,
  ): Promise<MediaProductionMutationOutcome<MediaProjectAsset>> => {
    const retryIntent: MediaProductionRetryIntent = { kind: "asset-create", projectId };
    if (!projectId || !projectIsCurrent(stateRef.current, projectId)) {
      return failedOutcome<MediaProjectAsset>("asset-create", "This media project is no longer selected.", retryIntent, projectId);
    }
    const token = beginMutation(`asset-create:${projectId}:${++concurrentSequenceRef.current}`);
    try {
      const response = await createMediaProjectAsset(activeCwdRef.current, projectId, assetInput);
      if (!isCurrentMutation(token) || !projectIsCurrent(stateRef.current, projectId)) {
        return staleOutcome<MediaProjectAsset>("asset-create", retryIntent, projectId);
      }
      commit((current) => ({
        ...current,
        project: current.project?.mediaProject.id === projectId ? {
          ...current.project,
          assets: [response.asset, ...current.project.assets.filter((asset) => asset.id !== response.asset.id)],
        } : current.project,
      }));
      return { ok: true, value: response.asset };
    } catch (error) {
      if (!isCurrentMutation(token) || !projectIsCurrent(stateRef.current, projectId)) {
        return staleOutcome<MediaProjectAsset>("asset-create", retryIntent, projectId);
      }
      return {
        ok: false,
        failure: createFailure(error, "asset-create", "Could not add this project image.", retryIntent, projectId),
      };
    } finally {
      releaseMutation(token);
    }
  }, [activeCwdRef, beginMutation, commit, isCurrentMutation, releaseMutation, stateRef]);

  const deleteProjectAsset = useCallback(async (assetId: string): Promise<MediaProductionMutationOutcome> => {
    const projectId = stateRef.current.selectedProjectId;
    const retryIntent: MediaProductionRetryIntent = { kind: "asset-delete", projectId, assetId };
    if (!projectId || !projectIsCurrent(stateRef.current, projectId)) {
      return failedOutcome("asset-delete", "This media project is no longer selected.", retryIntent, assetId);
    }
    const token = beginMutation(`asset-delete:${assetId}`);
    try {
      await deleteMediaProjectAsset(activeCwdRef.current, assetId);
      if (!isCurrentMutation(token) || !projectIsCurrent(stateRef.current, projectId)) {
        return staleOutcome("asset-delete", retryIntent, assetId);
      }
      commit((current) => ({
        ...current,
        project: current.project?.mediaProject.id === projectId ? {
          ...current.project,
          assets: current.project.assets.filter((asset) => asset.id !== assetId),
        } : current.project,
      }));
      return { ok: true, value: undefined };
    } catch (error) {
      if (!isCurrentMutation(token) || !projectIsCurrent(stateRef.current, projectId)) {
        return staleOutcome("asset-delete", retryIntent, assetId);
      }
      return {
        ok: false,
        failure: createFailure(error, "asset-delete", "Could not delete this project image.", retryIntent, assetId),
      };
    } finally {
      releaseMutation(token);
    }
  }, [activeCwdRef, beginMutation, commit, isCurrentMutation, releaseMutation, stateRef]);

  return { createProjectAsset, deleteProjectAsset };
}

function projectIsCurrent(state: MediaProductionState, projectId: string): boolean {
  return state.selectedProjectId === projectId && state.project?.mediaProject.id === projectId;
}

function createFailure(
  error: unknown,
  owner: MediaProductionFailureOwner,
  productMessageKey: string,
  retryIntent: MediaProductionRetryIntent,
  subjectId: string,
): MediaProductionFailure {
  return {
    owner,
    subjectId,
    productMessageKey,
    technicalMessage: error instanceof Error ? error.message : String(error),
    retryIntent,
  };
}

function failedOutcome<T = undefined>(
  owner: MediaProductionFailureOwner,
  productMessageKey: string,
  retryIntent: MediaProductionRetryIntent,
  subjectId?: string,
): MediaProductionMutationOutcome<T> {
  return { ok: false, failure: { owner, productMessageKey, retryIntent, subjectId } };
}

function staleOutcome<T = undefined>(
  owner: MediaProductionFailureOwner,
  retryIntent: MediaProductionRetryIntent,
  subjectId?: string,
): MediaProductionMutationOutcome<T> {
  return failedOutcome<T>(owner, "This request no longer applies to the current workspace.", retryIntent, subjectId);
}

import type { SQLOutputValue } from "node:sqlite";
import type {
  MediaCanvasPosition,
  MediaCanvasViewport,
  MediaJobExecutionHandle,
  MediaProject,
  MediaProjectAsset,
  MediaScene,
  MediaSceneVideoImageInput,
  MediaSceneRun,
} from "../../media-types.js";
import {
  isRecord,
  omitUndefined,
  parseJson,
  parseJsonObject,
  parseJsonStringArray,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

const defaultCanvasViewport: MediaCanvasViewport = { x: 0, y: 0, zoom: 1 };
const defaultCanvasPosition: MediaCanvasPosition = { x: 0, y: 0 };

export function mapMediaProject(row: Record<string, SQLOutputValue>): MediaProject {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    name: readString(row, "name"),
    defaultProviderPresetId: readNullableString(row, "default_provider_preset_id"),
    defaultExecutionMode: readString(row, "default_execution_mode") as MediaProject["defaultExecutionMode"],
    defaultWorkflowDefinitionId: readNullableString(row, "default_workflow_definition_id"),
    canvasViewport: parseCanvasViewport(readString(row, "canvas_viewport_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapMediaProjectAsset(row: Record<string, SQLOutputValue>): MediaProjectAsset {
  return omitUndefined({
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    fileName: readString(row, "file_name"),
    contentType: readString(row, "content_type") as MediaProjectAsset["contentType"],
    sizeBytes: readNumber(row, "size_bytes"),
    width: readNumber(row, "width"),
    height: readNumber(row, "height"),
    checksum: readString(row, "checksum"),
    sourceArtifactId: readNullableString(row, "source_artifact_id"),
    path: readString(row, "path"),
    createdAt: readString(row, "created_at"),
  });
}

export function mapMediaScene(row: Record<string, SQLOutputValue>): MediaScene {
  return omitUndefined({
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    sortOrder: readNumber(row, "sort_order"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    executionMode: readString(row, "execution_mode") as MediaScene["executionMode"],
    workflowDefinitionId: readNullableString(row, "workflow_definition_id"),
    workflowInputValues: parseJsonObject(readString(row, "workflow_input_values_json")),
    ratio: readString(row, "ratio"),
    durationSeconds: readNumber(row, "duration_seconds"),
    referenceArtifactIds: parseJsonStringArray(readString(row, "reference_artifact_ids_json")),
    videoImageInputs: parseVideoImageInputs(readString(row, "video_image_inputs_json")),
    canvasPosition: parseCanvasPosition(readString(row, "canvas_position_json")),
    selectedMediaSceneRunId: readNullableString(row, "selected_media_scene_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseVideoImageInputs(value: string): MediaSceneVideoImageInput[] {
  let parsed: unknown;
  try {
    parsed = parseJson(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid SQLite media scene video_image_inputs_json: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid SQLite media scene video_image_inputs_json: expected an array");
  }

  const assetIds = new Set<string>();
  let sharedRole: MediaSceneVideoImageInput["role"] | undefined;
  return parsed.map((item, index) => {
    if (!isRecord(item) || typeof item.assetId !== "string" || item.assetId.trim().length === 0) {
      throw new Error(`Invalid SQLite media scene video_image_inputs_json item at index ${index}: expected a non-empty assetId`);
    }
    if (item.role !== "first_frame" && item.role !== "reference_image") {
      throw new Error(`Invalid SQLite media scene video_image_inputs_json item at index ${index}: unsupported role`);
    }
    if (assetIds.has(item.assetId)) {
      throw new Error(`Invalid SQLite media scene video_image_inputs_json item at index ${index}: duplicate assetId`);
    }
    if (sharedRole && sharedRole !== item.role) {
      throw new Error("Invalid SQLite media scene video_image_inputs_json: image roles must not be mixed");
    }
    assetIds.add(item.assetId);
    sharedRole = item.role;
    return { assetId: item.assetId, role: item.role };
  });
}

export function mapMediaSceneRun(row: Record<string, SQLOutputValue>): MediaSceneRun {
  return {
    id: readString(row, "id"),
    projectId: readString(row, "project_id"),
    sceneId: readString(row, "scene_id"),
    mediaJobId: readString(row, "media_job_id"),
    providerSnapshot: parseJsonObject(readString(row, "provider_snapshot_json")),
    executionSnapshot: parseJsonObject(readString(row, "execution_snapshot_json")),
    inputSnapshot: parseJsonObject(readString(row, "input_snapshot_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

export function mapMediaJobExecutionHandle(row: Record<string, SQLOutputValue>): MediaJobExecutionHandle {
  return {
    mediaJobId: readString(row, "media_job_id"),
    adapterKind: readString(row, "adapter_kind"),
    externalOperationId: readString(row, "external_operation_id"),
    recovery: parseJsonObject(readString(row, "recovery_json")),
    nextPollAt: readNullableString(row, "next_poll_at"),
    pollAttempts: readNumber(row, "poll_attempts"),
    workUnitId: readNullableString(row, "work_unit_id"),
    attemptId: readNullableString(row, "attempt_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function parseCanvasViewport(value: string): MediaCanvasViewport {
  const parsed = parseJsonObject(value);
  return {
    x: readFiniteNumber(parsed.x, defaultCanvasViewport.x),
    y: readFiniteNumber(parsed.y, defaultCanvasViewport.y),
    zoom: readFiniteNumber(parsed.zoom, defaultCanvasViewport.zoom),
  };
}

function parseCanvasPosition(value: string): MediaCanvasPosition {
  const parsed = parseJsonObject(value);
  return {
    x: readFiniteNumber(parsed.x, defaultCanvasPosition.x),
    y: readFiniteNumber(parsed.y, defaultCanvasPosition.y),
  };
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

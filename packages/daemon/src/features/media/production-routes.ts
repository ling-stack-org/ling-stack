import type { IncomingMessage, ServerResponse } from "node:http";
import {
  resolveMediaProviderRuntimeState,
  type MediaProject,
  type MediaScene,
  type MediaSceneExecutionMode,
  type MediaSceneVideoImageInput,
  type RunStore,
  type SecretResolver,
  type VideoGenerationCapabilities,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { MediaLocalExecutionAdmissionError } from "../../runtime/media-local-executions.js";
import { readJsonBody, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  isRecord,
  readNullableString,
  readOptionalNumber,
  readOptionalObject,
  readOptionalString,
  readOptionalStringArray,
  readString,
  readStringAllowEmpty,
} from "../../shared/validation.js";
import { assertMediaJobProvider } from "./provider.js";
import { cancelPendingMediaProductionApprovals } from "./media-cost-approval.js";
import { settleLocallyCancelledMediaJob, updateActiveMediaJobStatus } from "./scene-cancellation.js";
import { requireConnection, requireDefinition, requireVersion, resolveMediaWorkflowSecret } from "./workflows/workflow-service.js";
import {
  handleMediaProjectAssetsCollection,
  stageMediaProjectAssetContentsForDeletion,
  toPublicMediaProjectAsset,
} from "./project-asset-routes.js";

export type MediaProjectRouteAction = "assets" | "scenes" | "reorder" | "run";
export type MediaSceneRouteAction = "run" | "duplicate" | "select-run";

export interface MediaProjectRoute {
  readonly mediaProjectId: string;
  readonly action?: MediaProjectRouteAction;
}

export interface MediaSceneRoute {
  readonly mediaSceneId: string;
  readonly action?: MediaSceneRouteAction;
}

export interface MediaSceneRunRoute {
  readonly mediaSceneRunId: string;
  readonly action: "cancel";
}

export async function handleMediaProjectsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = requestUrl(request, config);
  const cwd = requireCwd(response, url);
  if (!cwd) {
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, mediaProjects: store.listMediaProjects() });
      return;
    }
    if (request.method === "POST") {
      const input = parseCreateMediaProject(await readJsonBody(request, config.maxBodyBytes));
      const mediaProject = store.createMediaProject(input, now());
      writeJson(response, 201, { mediaProject, assets: [], scenes: [], sceneRuns: [] });
      return;
    }
    methodNotAllowed(response, request.method, "/media-projects");
  } catch (error) {
    writeMediaProductionError(response, error);
  }
}

export async function handleMediaProjectRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  launchMediaJob: (cwd: string, mediaJobId: string) => void,
  route: MediaProjectRoute,
): Promise<void> {
  const url = requestUrl(request, config);
  const cwd = requireCwd(response, url);
  if (!cwd) {
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const project = store.getMediaProject(route.mediaProjectId);
    if (!project) {
      notFound(response, "media_project_not_found", `媒体项目不存在：${route.mediaProjectId}`);
      return;
    }
    if (!route.action) {
      await handleMediaProjectItem(request, response, config, store, project);
      return;
    }
    if (route.action === "assets") {
      await handleMediaProjectAssetsCollection(request, response, config, store, project);
      return;
    }
    if (route.action === "scenes") {
      await handleMediaProjectSceneCreate(request, response, config, store, project);
      return;
    }
    if (route.action === "reorder") {
      await handleMediaProjectSceneReorder(request, response, config, store, project);
      return;
    }
    if (route.action === "run") {
      await handleMediaProjectRun(request, response, config, store, project, secretResolver, cwd, launchMediaJob);
      return;
    }
    methodNotAllowed(response, request.method, "/media-projects/:id");
  } catch (error) {
    writeMediaProductionError(response, error);
  }
}

export async function handleMediaSceneRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  launchMediaJob: (cwd: string, mediaJobId: string) => void,
  route: MediaSceneRoute,
): Promise<void> {
  const url = requestUrl(request, config);
  const cwd = requireCwd(response, url);
  if (!cwd) {
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const scene = store.getMediaScene(route.mediaSceneId);
    if (!scene) {
      notFound(response, "media_scene_not_found", `分镜不存在：${route.mediaSceneId}`);
      return;
    }
    const project = store.getMediaProject(scene.projectId);
    if (!project) {
      notFound(response, "media_project_not_found", `分镜所属媒体项目不存在：${scene.projectId}`);
      return;
    }
    if (!route.action) {
      await handleMediaSceneItem(request, response, config, store, scene);
      return;
    }
    if (route.action === "run") {
      if (request.method !== "POST") {
        methodNotAllowed(response, request.method, "/media-scenes/:id/run");
        return;
      }
      const result = createSceneRun(store, project, scene, secretResolver);
      writeJson(response, 202, result);
      launchMediaJob(cwd, result.mediaJob.id);
      return;
    }
    if (route.action === "duplicate") {
      if (request.method !== "POST") {
        methodNotAllowed(response, request.method, "/media-scenes/:id/duplicate");
        return;
      }
      const duplicate = store.createMediaScene({
        projectId: scene.projectId,
        title: `${scene.title} 副本`,
        prompt: scene.prompt,
        providerPresetId: scene.providerPresetId,
        executionMode: scene.executionMode,
        workflowDefinitionId: scene.workflowDefinitionId,
        workflowInputValues: scene.workflowInputValues,
        ratio: scene.ratio,
        durationSeconds: scene.durationSeconds,
        referenceArtifactIds: scene.referenceArtifactIds,
        videoImageInputs: scene.videoImageInputs,
        canvasPosition: { x: scene.canvasPosition.x + 56, y: scene.canvasPosition.y + 48 },
      }, now());
      writeJson(response, 201, { mediaScene: duplicate });
      return;
    }
    if (route.action === "select-run") {
      await handleMediaSceneSelectRun(request, response, config, store, scene);
      return;
    }
    methodNotAllowed(response, request.method, "/media-scenes/:id");
  } catch (error) {
    writeMediaProductionError(response, error);
  }
}

export function handleMediaSceneRunRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: MediaSceneRunRoute,
): void {
  const url = requestUrl(request, config);
  const cwd = requireCwd(response, url);
  if (!cwd) {
    return;
  }
  if (request.method !== "POST") {
    methodNotAllowed(response, request.method, "/media-scene-runs/:id/cancel");
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const sceneRun = store.getMediaSceneRun(route.mediaSceneRunId);
    if (!sceneRun) {
      notFound(response, "media_scene_run_not_found", `场景运行记录不存在：${route.mediaSceneRunId}`);
      return;
    }
    const mediaJob = store.getMediaJob(sceneRun.mediaJobId);
    if (!mediaJob) {
      notFound(response, "media_job_not_found", `生成任务不存在：${sceneRun.mediaJobId}`);
      return;
    }
    if (mediaJob.status === "succeeded" || mediaJob.status === "failed" || mediaJob.status === "cancelled") {
      // A previous terminal CAS may have committed before a local cleanup write
      // failed. Preserve 409, but do not strand its exact child or semaphore.
      if (mediaJob.status === "cancelled" && settleLocallyCancelledMediaJob({
        store, registry: storeRegistry.mediaLocalExecutions, cwd, mediaJobId: mediaJob.id,
      })) cancelPendingMediaProductionApprovals(store, mediaJob.id, now());
      throw new HttpError(409, "media_job_not_cancellable", "该场景任务已结束，不能取消。");
    }
    const cancelledAt = now();
    let cancelled: ReturnType<typeof updateActiveMediaJobStatus>;
    try { cancelled = updateActiveMediaJobStatus(store, mediaJob.id, {
      status: "cancelled",
      errorMessage: "已取消场景生成。",
    }, cancelledAt); }
    catch (error) {
      if (!(error instanceof MediaLocalExecutionAdmissionError)) throw error;
      // A concurrent cancellation winner needs the same idempotent local repair;
      // the helper is read-only for succeeded/failed and retains entered EOFs.
      if (settleLocallyCancelledMediaJob({
        store, registry: storeRegistry.mediaLocalExecutions, cwd, mediaJobId: mediaJob.id,
      })) cancelPendingMediaProductionApprovals(store, mediaJob.id, now());
      throw new HttpError(409, "media_job_not_cancellable", "该场景任务已结束，不能取消。");
    }
    settleLocallyCancelledMediaJob({ store, registry: storeRegistry.mediaLocalExecutions, cwd, mediaJobId: mediaJob.id });
    cancelPendingMediaProductionApprovals(store, mediaJob.id, cancelledAt);
    writeJson(response, 200, { mediaJob: cancelled, mediaSceneRun: sceneRun });
  } catch (error) {
    writeMediaProductionError(response, error);
  }
}

export function parseMediaProjectRoute(pathname: string): MediaProjectRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "media-projects") {
    return { mediaProjectId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "media-projects" &&
    (segments[2] === "assets" || segments[2] === "scenes" || segments[2] === "reorder" || segments[2] === "run")
  ) {
    return { mediaProjectId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parseMediaSceneRoute(pathname: string): MediaSceneRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "media-scenes") {
    return { mediaSceneId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "media-scenes" &&
    (segments[2] === "run" || segments[2] === "duplicate" || segments[2] === "select-run")
  ) {
    return { mediaSceneId: segments[1], action: segments[2] };
  }
  return undefined;
}

export function parseMediaSceneRunRoute(pathname: string): MediaSceneRunRoute | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "media-scene-runs" && segments[2] === "cancel") {
    return { mediaSceneRunId: segments[1], action: "cancel" };
  }
  return undefined;
}

async function handleMediaProjectItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  store: RunStore,
  project: MediaProject,
): Promise<void> {
  if (request.method === "GET") {
    writeJson(response, 200, mediaProjectDetail(store, project));
    return;
  }
  if (request.method === "PATCH") {
    const input = parseUpdateMediaProject(await readJsonBody(request, config.maxBodyBytes));
    const mediaProject = store.updateMediaProject(project.id, input, now());
    writeJson(response, 200, mediaProjectDetail(store, mediaProject ?? project));
    return;
  }
  if (request.method === "DELETE") {
    const assets = store.listMediaProjectAssets(project.id);
    const contentDeletion = stageMediaProjectAssetContentsForDeletion(store, project, assets);
    try {
      if (!store.deleteMediaProject(project.id)) {
        throw new HttpError(404, "media_project_not_found", `媒体项目不存在：${project.id}`);
      }
    } catch (error) {
      contentDeletion.rollback();
      throw error;
    }
    contentDeletion.commit();
    writeJson(response, 200, { deleted: true, mediaProjectId: project.id });
    return;
  }
  methodNotAllowed(response, request.method, "/media-projects/:id");
}

async function handleMediaProjectSceneCreate(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  store: RunStore,
  project: MediaProject,
): Promise<void> {
  if (request.method !== "POST") {
    methodNotAllowed(response, request.method, "/media-projects/:id/scenes");
    return;
  }
  const input = parseCreateMediaScene(await readJsonBody(request, config.maxBodyBytes));
  const mediaScene = store.createMediaScene({ ...input, projectId: project.id }, now());
  writeJson(response, 201, { mediaScene });
}

async function handleMediaProjectSceneReorder(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  store: RunStore,
  project: MediaProject,
): Promise<void> {
  if (request.method !== "POST") {
    methodNotAllowed(response, request.method, "/media-projects/:id/reorder");
    return;
  }
  const body = await readJsonBody(request, config.maxBodyBytes);
  if (!isRecord(body)) {
    throw new Error("分镜排序请求必须是 JSON 对象");
  }
  const sceneIds = readOptionalStringArray(body, "sceneIds");
  if (!sceneIds) {
    throw new Error("sceneIds 是必填数组");
  }
  const scenes = store.reorderMediaScenes(project.id, sceneIds, now());
  writeJson(response, 200, { mediaProjectId: project.id, scenes });
}

async function handleMediaProjectRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  store: RunStore,
  project: MediaProject,
  secretResolver: SecretResolver,
  cwd: string,
  launchMediaJob: (cwd: string, mediaJobId: string) => void,
): Promise<void> {
  if (request.method !== "POST") {
    methodNotAllowed(response, request.method, "/media-projects/:id/run");
    return;
  }
  const input = parseRunMediaProject(await readOptionalJsonBody(request, config.maxBodyBytes));
  const scenes = store.listMediaScenes(project.id);
  const targets = resolveProjectRunScenes(scenes, input.sceneIds);
  const prepared = targets.map((scene) => prepareSceneRun(store, project, scene, secretResolver));
  const results = prepared.map((item) => persistSceneRun(store, project, item));
  writeJson(response, 202, {
    mediaProject: project,
    mediaSceneRuns: results.map((result) => result.mediaSceneRun),
    mediaJobs: results.map((result) => result.mediaJob),
  });
  for (const result of results) {
    launchMediaJob(cwd, result.mediaJob.id);
  }
}

async function handleMediaSceneItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  store: RunStore,
  scene: MediaScene,
): Promise<void> {
  if (request.method === "GET") {
    writeJson(response, 200, { mediaScene: scene, mediaSceneRuns: store.listMediaSceneRuns({ sceneId: scene.id }) });
    return;
  }
  if (request.method === "PATCH") {
    const input = parseUpdateMediaScene(await readJsonBody(request, config.maxBodyBytes));
    const mediaScene = store.updateMediaScene(scene.id, input, now()) ?? scene;
    writeJson(response, 200, { mediaScene });
    return;
  }
  if (request.method === "DELETE") {
    store.deleteMediaScene(scene.id);
    writeJson(response, 200, { deleted: true, mediaSceneId: scene.id });
    return;
  }
  methodNotAllowed(response, request.method, "/media-scenes/:id");
}

async function handleMediaSceneSelectRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  store: RunStore,
  scene: MediaScene,
): Promise<void> {
  if (request.method !== "POST") {
    methodNotAllowed(response, request.method, "/media-scenes/:id/select-run");
    return;
  }
  const body = await readJsonBody(request, config.maxBodyBytes);
  if (!isRecord(body)) {
    throw new Error("选择结果请求必须是 JSON 对象");
  }
  const mediaSceneRunId = readString(body, "mediaSceneRunId");
  const sceneRun = store.getMediaSceneRun(mediaSceneRunId);
  if (!sceneRun || sceneRun.sceneId !== scene.id) {
    throw new HttpError(404, "media_scene_run_not_found", `该分镜没有运行记录：${mediaSceneRunId}`);
  }
  const mediaJob = store.getMediaJob(sceneRun.mediaJobId);
  if (!mediaJob || mediaJob.status !== "succeeded") {
    throw new HttpError(409, "media_scene_run_not_selectable", "只有成功生成的片段可以设为当前结果。");
  }
  const mediaScene = store.updateMediaScene(scene.id, { selectedMediaSceneRunId: sceneRun.id }, now()) ?? scene;
  writeJson(response, 200, { mediaScene, mediaSceneRun: sceneRun });
}

function createSceneRun(
  store: RunStore,
  project: MediaProject,
  scene: MediaScene,
  secretResolver: SecretResolver,
): { readonly mediaJob: ReturnType<RunStore["createMediaJob"]>; readonly mediaSceneRun: ReturnType<RunStore["createMediaSceneRun"]> } {
  return persistSceneRun(store, project, prepareSceneRun(store, project, scene, secretResolver));
}

type PreparedSceneRun =
  | {
      readonly mode: "direct";
      readonly scene: MediaScene;
      readonly provider: ReturnType<typeof assertMediaJobProvider>;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly mode: "workflow";
      readonly scene: MediaScene;
      readonly workflow: ReturnType<typeof requireDefinition>;
      readonly version: ReturnType<typeof requireVersion>;
      readonly connection: ReturnType<typeof requireConnection>;
      readonly input: Record<string, unknown>;
    };

function prepareSceneRun(
  store: RunStore,
  project: MediaProject,
  scene: MediaScene,
  secretResolver: SecretResolver,
): PreparedSceneRun {
  assertNoActiveSceneRun(store, scene);
  const executionMode = scene.executionMode === "inherit" ? project.defaultExecutionMode : scene.executionMode;
  if (executionMode === "workflow") {
    const workflowDefinitionId = scene.workflowDefinitionId ?? project.defaultWorkflowDefinitionId;
    if (!workflowDefinitionId) {
      throw new HttpError(400, "workflow_required", "请先在项目或分镜中选择已启用的生产流程。");
    }
    const workflow = requireDefinition(store, workflowDefinitionId);
    if (workflow.status !== "ready" || !workflow.currentVersionId) {
      throw new HttpError(400, "workflow_not_ready", "当前生产流程尚未完成试运行并启用。");
    }
    const version = requireVersion(store, workflow.currentVersionId);
    const connection = requireConnection(store, workflow.connectionId);
    if (connection.status !== "ready") {
      throw new HttpError(400, "workflow_connection_not_ready", "生产流程连接尚未检查通过。");
    }
    resolveMediaWorkflowSecret(connection, secretResolver);
    const input = materializeSceneWorkflowInputs(store, scene, version.inputFields);
    return { mode: "workflow", scene, workflow, version, connection, input };
  }
  const providerPresetId = scene.providerPresetId ?? project.defaultProviderPresetId;
  if (!providerPresetId) {
    throw new HttpError(400, "provider_required", "请先在项目或分镜中选择已验证的视频模型。");
  }
  const provider = assertMediaJobProvider(store, {
    providerPresetId,
    operation: "video_generate",
    prompt: scene.prompt,
  }, secretResolver);
  const runtime = resolveMediaProviderRuntimeState(provider, "video_generate");
  const capabilities = runtime.videoGeneration;
  if (!runtime.canRun || !capabilities) {
    throw new HttpError(400, "unsupported_capability", "当前模型尚未验证可用于视频生成。");
  }
  if (!scene.prompt.trim()) {
    throw new HttpError(400, "invalid_request", "请先填写分镜提示词。");
  }
  if (capabilities.aspectRatios && !capabilities.aspectRatios.includes(scene.ratio)) {
    throw new HttpError(400, "unsupported_capability", `当前模型不支持 ${scene.ratio} 比例。`);
  }
  if (capabilities.durationsSeconds && !capabilities.durationsSeconds.includes(scene.durationSeconds)) {
    throw new HttpError(400, "unsupported_capability", `当前模型不支持 ${scene.durationSeconds} 秒时长。`);
  }
  const videoImageInputs = prepareDirectVideoImageInputs(store, project, scene, capabilities);
  const input = {
    ratio: scene.ratio,
    duration: scene.durationSeconds,
    ...(videoImageInputs.length ? { videoImageInputs } : {}),
  };
  return { mode: "direct", scene, provider, input };
}

function prepareDirectVideoImageInputs(
  store: RunStore,
  project: MediaProject,
  scene: MediaScene,
  capabilities: VideoGenerationCapabilities,
): readonly { readonly assetId: string; readonly role: MediaSceneVideoImageInput["role"]; readonly checksum: string }[] {
  if (scene.videoImageInputs.length === 0) {
    return [];
  }
  const role = scene.videoImageInputs[0]?.role;
  if (!role || scene.videoImageInputs.some((input) => input.role !== role)) {
    throw new HttpError(400, "invalid_media_asset", "同一场景的图片必须使用相同用途。");
  }
  if (!capabilities.inputModes.includes(role)) {
    throw new HttpError(
      400,
      "unsupported_capability",
      role === "first_frame" ? "当前视频模型不支持起始画面生成。" : "当前视频模型不支持参考图片生成。",
    );
  }
  if (role === "first_frame" && scene.videoImageInputs.length !== 1) {
    throw new HttpError(400, "invalid_media_asset", "起始画面模式只能选择一张图片。");
  }
  if (
    role === "reference_image" &&
    (!capabilities.maxReferenceImages || scene.videoImageInputs.length > capabilities.maxReferenceImages)
  ) {
    throw new HttpError(
      400,
      "invalid_media_asset",
      `当前视频模型最多支持 ${capabilities.maxReferenceImages ?? 0} 张参考图片。`,
    );
  }
  return scene.videoImageInputs.map((input) => {
    const asset = store.getMediaProjectAsset(input.assetId);
    if (!asset || asset.projectId !== project.id) {
      throw new HttpError(400, "invalid_media_asset", "场景图片必须来自当前媒体项目。");
    }
    return { assetId: asset.id, role: input.role, checksum: asset.checksum };
  });
}

function persistSceneRun(
  store: RunStore,
  project: MediaProject,
  prepared: PreparedSceneRun,
): { readonly mediaJob: ReturnType<RunStore["createMediaJob"]>; readonly mediaSceneRun: ReturnType<RunStore["createMediaSceneRun"]> } {
  const { scene, input } = prepared;
  const timestamp = now();
  const mediaJob = prepared.mode === "direct"
    ? store.createMediaJob({
        providerPresetId: prepared.provider.id,
        operation: "video_generate",
        prompt: scene.prompt,
        input,
      }, timestamp)
    : store.createMediaJob({
        workflowVersionId: prepared.version.id,
        operation: prepared.version.outputRules.some((rule) => rule.artifactType === "video") ? "video_generate" : "image_generate",
        prompt: scene.prompt,
        input: { workflowInputValues: input },
      }, timestamp);
  const executionSnapshot = prepared.mode === "direct"
    ? {
        kind: "provider",
        providerPresetId: prepared.provider.id,
        displayName: prepared.provider.displayName,
        providerId: prepared.provider.providerId,
        model: prepared.provider.model,
        capabilities: prepared.provider.capabilities ?? [],
      }
    : {
        kind: "workflow",
        workflowDefinitionId: prepared.workflow.id,
        workflowName: prepared.workflow.name,
        workflowVersionId: prepared.version.id,
        workflowVersion: prepared.version.version,
        connectionId: prepared.connection.id,
        connectionName: prepared.connection.name,
        adapterKind: prepared.connection.adapterKind,
      };
  const mediaSceneRun = store.createMediaSceneRun({
    projectId: project.id,
    sceneId: scene.id,
    mediaJobId: mediaJob.id,
    providerSnapshot: prepared.mode === "direct" ? executionSnapshot : {},
    executionSnapshot,
    inputSnapshot: { prompt: scene.prompt, ...input },
  }, timestamp);
  return { mediaJob, mediaSceneRun };
}

function assertNoActiveSceneRun(store: RunStore, scene: MediaScene): void {
  const active = store.listMediaSceneRuns({ sceneId: scene.id }).find((run) => {
    const job = store.getMediaJob(run.mediaJobId);
    return job?.status === "queued" || job?.status === "running" || job?.status === "waiting_for_approval";
  });
  if (active) {
    throw new HttpError(409, "media_scene_run_active", "该场景已有生成任务，请等待完成或先取消后再试。");
  }
}

function parseRunMediaProject(value: unknown | undefined): { readonly sceneIds?: readonly string[] } {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("批量生成请求必须是 JSON 对象");
  }
  const sceneIds = readOptionalStringArray(value, "sceneIds");
  if (sceneIds && sceneIds.length === 0) {
    throw new HttpError(400, "scene_selection_empty", "请至少选择一个可生成的场景。");
  }
  return { sceneIds };
}

function resolveProjectRunScenes(
  scenes: readonly MediaScene[],
  sceneIds: readonly string[] | undefined,
): readonly MediaScene[] {
  if (!sceneIds) {
    return scenes;
  }
  const requested = new Set(sceneIds);
  if (requested.size !== sceneIds.length) {
    throw new HttpError(400, "scene_selection_invalid", "批量生成场景不能重复。");
  }
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  for (const sceneId of sceneIds) {
    if (!byId.has(sceneId)) {
      throw new HttpError(404, "media_scene_not_found", `媒体项目中不存在分镜：${sceneId}`);
    }
  }
  return scenes.filter((scene) => requested.has(scene.id));
}

function mediaProjectDetail(store: RunStore, project: MediaProject) {
  return {
    mediaProject: project,
    assets: store.listMediaProjectAssets(project.id).map(toPublicMediaProjectAsset),
    scenes: store.listMediaScenes(project.id),
    sceneRuns: store.listMediaSceneRuns({ projectId: project.id }),
  };
}

function parseCreateMediaProject(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("媒体项目请求必须是 JSON 对象");
  }
  return {
    name: readString(value, "name"),
    defaultProviderPresetId: readOptionalString(value, "defaultProviderPresetId"),
    defaultExecutionMode: readOptionalDirectExecutionMode(value, "defaultExecutionMode"),
    defaultWorkflowDefinitionId: readOptionalString(value, "defaultWorkflowDefinitionId"),
    canvasViewport: readCanvasViewport(value, "canvasViewport"),
  };
}

function parseUpdateMediaProject(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("媒体项目更新必须是 JSON 对象");
  }
  return {
    name: readOptionalString(value, "name"),
    defaultProviderPresetId: readNullableString(value, "defaultProviderPresetId"),
    defaultExecutionMode: readOptionalDirectExecutionMode(value, "defaultExecutionMode"),
    defaultWorkflowDefinitionId: readNullableString(value, "defaultWorkflowDefinitionId"),
    canvasViewport: readCanvasViewport(value, "canvasViewport"),
  };
}

function parseCreateMediaScene(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("分镜请求必须是 JSON 对象");
  }
  return {
    title: readString(value, "title"),
    prompt: readStringAllowEmpty(value, "prompt"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    executionMode: readOptionalSceneExecutionMode(value, "executionMode"),
    workflowDefinitionId: readOptionalString(value, "workflowDefinitionId"),
    workflowInputValues: readOptionalObject(value, "workflowInputValues"),
    ratio: readOptionalString(value, "ratio"),
    durationSeconds: readOptionalPositiveInteger(value, "durationSeconds"),
    referenceArtifactIds: readOptionalStringArray(value, "referenceArtifactIds"),
    videoImageInputs: readOptionalVideoImageInputs(value, "videoImageInputs"),
    canvasPosition: readCanvasPosition(value, "canvasPosition"),
  };
}

function parseUpdateMediaScene(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("分镜更新必须是 JSON 对象");
  }
  return {
    sortOrder: readOptionalNonNegativeInteger(value, "sortOrder"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    providerPresetId: readNullableString(value, "providerPresetId"),
    executionMode: readOptionalSceneExecutionMode(value, "executionMode"),
    workflowDefinitionId: readNullableString(value, "workflowDefinitionId"),
    workflowInputValues: readOptionalObject(value, "workflowInputValues"),
    ratio: readOptionalString(value, "ratio"),
    durationSeconds: readOptionalPositiveInteger(value, "durationSeconds"),
    referenceArtifactIds: readOptionalStringArray(value, "referenceArtifactIds"),
    videoImageInputs: readOptionalVideoImageInputs(value, "videoImageInputs"),
    canvasPosition: readCanvasPosition(value, "canvasPosition"),
  };
}

function readCanvasViewport(record: Record<string, unknown>, key: string) {
  const value = readOptionalObject(record, key);
  if (!value) {
    return undefined;
  }
  return {
    x: readOptionalNumber(value, "x") ?? 0,
    y: readOptionalNumber(value, "y") ?? 0,
    zoom: readOptionalNumber(value, "zoom") ?? 1,
  };
}

function readCanvasPosition(record: Record<string, unknown>, key: string) {
  const value = readOptionalObject(record, key);
  if (!value) {
    return undefined;
  }
  return {
    x: readOptionalNumber(value, "x") ?? 0,
    y: readOptionalNumber(value, "y") ?? 0,
  };
}

function readOptionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNumber(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} 必须是正整数`);
  }
  return value;
}

function readOptionalVideoImageInputs(
  record: Record<string, unknown>,
  key: string,
): readonly MediaSceneVideoImageInput[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} 必须是数组`);
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error(`${key} 中的图片输入必须是对象`);
    }
    const role = readString(item, "role");
    if (role !== "first_frame" && role !== "reference_image") {
      throw new Error("图片用途必须是 first_frame 或 reference_image");
    }
    return { assetId: readString(item, "assetId"), role };
  });
}

function materializeSceneWorkflowInputs(
  store: RunStore,
  scene: MediaScene,
  fields: readonly import("@ling-stack/core").MediaWorkflowInputField[],
): Record<string, unknown> {
  const values: Record<string, unknown> = { ...scene.workflowInputValues };
  for (const field of fields) {
    if (field.semantic === "prompt") values[field.id] = scene.prompt;
    if (field.semantic === "ratio") values[field.id] = scene.ratio;
    if (field.semantic === "duration") values[field.id] = scene.durationSeconds;
    if (field.semantic === "reference_image" && scene.referenceArtifactIds[0]) values[field.id] = scene.referenceArtifactIds[0];
    const value = values[field.id] ?? field.defaultValue;
    if (field.required && (value === undefined || value === null || value === "")) {
      throw new HttpError(400, "workflow_input_required", `请填写工作流输入：${field.label}。`);
    }
    if (field.kind === "image_artifact" && typeof value === "string") {
      const artifact = store.getArtifact(value);
      if (!artifact || artifact.type !== "image") {
        throw new HttpError(400, "invalid_reference_artifact", `工作流输入“${field.label}”必须引用当前工作区图片产物。`);
      }
    }
  }
  return values;
}

function readOptionalDirectExecutionMode(record: Record<string, unknown>, key: string): "direct" | "workflow" | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value !== "direct" && value !== "workflow") throw new Error(`${key} 必须是 direct 或 workflow`);
  return value;
}

function readOptionalSceneExecutionMode(record: Record<string, unknown>, key: string): MediaSceneExecutionMode | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value !== "inherit" && value !== "direct" && value !== "workflow") {
    throw new Error(`${key} 必须是 inherit、direct 或 workflow`);
  }
  return value;
}

function readOptionalNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = readOptionalNumber(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} 必须是非负整数`);
  }
  return value;
}

function requestUrl(request: IncomingMessage, config: ResolvedDaemonConfig): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
}

function requireCwd(response: ServerResponse, url: URL): string | undefined {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
  }
  return cwd ?? undefined;
}

function methodNotAllowed(response: ServerResponse, method: string | undefined, route: string): void {
  writeJson(response, 405, { error: "method_not_allowed", message: `${method} is not supported for ${route}` });
}

function notFound(response: ServerResponse, error: string, message: string): void {
  writeJson(response, 404, { error, message });
}

function writeMediaProductionError(response: ServerResponse, error: unknown): void {
  const statusCode = error instanceof HttpError ? error.statusCode : 400;
  writeJson(response, statusCode, {
    error: error instanceof HttpError ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}

function now(): string {
  return new Date().toISOString();
}

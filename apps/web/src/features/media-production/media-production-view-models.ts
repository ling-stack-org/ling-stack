import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import type {
  MediaJob,
  MediaProject,
  MediaProjectAsset,
  MediaScene,
  MediaSceneRun,
  MediaWorkflowDefinitionDetail,
  MediaWorkflowInputField,
  ProviderPreset,
  RunArtifact,
} from "../../types.js";

export interface MediaProductionLabel {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export type SceneReadinessState = "needs_prompt" | "needs_model" | "ready" | "generating" | "needs_attention" | "current_result";
export type SceneReadinessAction = "none" | "configure-model" | "configure-workflow" | "run" | "open-history" | "cancel";

export interface SceneReadiness {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly sortOrder: number;
  readonly state: SceneReadinessState;
  readonly status: SceneReadinessState;
  readonly labelKey: string;
  readonly labelValues?: Readonly<Record<string, string | number>>;
  readonly reasonKey: string;
  readonly reasonValues?: Readonly<Record<string, string | number>>;
  readonly primaryAction: SceneReadinessAction;
  readonly blockerFieldLabel?: string;
  /** Translation-key aliases retained for S1/S4 consumers until their owned slices migrate. */
  readonly label: string;
  readonly reason: string;
  readonly provider?: ProviderPreset;
  readonly workflow?: MediaWorkflowDefinitionDetail;
  readonly latestRun?: MediaSceneRun;
  readonly latestJob?: MediaJob;
  readonly currentRun?: MediaSceneRun;
  readonly currentJob?: MediaJob;
  readonly currentArtifact?: RunArtifact;
  readonly isRegenerating: boolean;
  readonly latestIssue: boolean;
  readonly canRun: boolean;
}

export interface SceneSourceProjection {
  readonly mode: "direct" | "workflow";
  readonly providerId: string;
  readonly workflowId: string;
  readonly providers: readonly ProviderPreset[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
  readonly selectedProvider?: ProviderPreset;
  readonly selectedWorkflow?: MediaWorkflowDefinitionDetail;
  readonly blocker?: MediaProductionLabel;
  readonly repairAction: Extract<SceneReadinessAction, "none" | "configure-model" | "configure-workflow">;
}

export type SceneRunAction = "none" | "cancel" | "select";

export interface SceneRunProjection {
  readonly run: MediaSceneRun;
  readonly job?: MediaJob;
  readonly artifact?: RunArtifact;
  readonly selected: boolean;
  readonly status: MediaJob["status"] | "unknown";
  readonly statusLabel: MediaProductionLabel;
  readonly statusTone: "neutral" | "info" | "success" | "warning" | "danger";
  readonly primaryAction: SceneRunAction;
  readonly sourceName?: string;
  readonly sourceLabel: MediaProductionLabel;
  readonly createdAtLabel: string;
}

export interface SceneResultProjection {
  readonly state: "empty" | "current" | "updating" | "issue";
  readonly statusLabel: MediaProductionLabel;
  readonly statusTone: "neutral" | "info" | "success" | "warning";
}

export interface ProjectRunReview {
  readonly ready: readonly SceneReadiness[];
  readonly skipped: readonly SceneReadiness[];
}

export function deriveSceneReadiness(input: {
  readonly scene: MediaScene;
  readonly project: MediaProject;
  readonly assets: readonly MediaProjectAsset[];
  readonly providers: readonly ProviderPreset[];
  readonly workflows?: readonly MediaWorkflowDefinitionDetail[];
  readonly sceneRuns: readonly MediaSceneRun[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly imageInputsPending?: boolean;
}): SceneReadiness {
  const { scene, project, assets, providers, workflows = [], sceneRuns, jobs, artifactsByJob } = input;
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const runs = sceneRuns
    .filter((run) => run.sceneId === scene.id)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const currentRun = scene.selectedMediaSceneRunId
    ? runs.find((run) => run.id === scene.selectedMediaSceneRunId)
    : undefined;
  const currentJob = currentRun ? jobsById.get(currentRun.mediaJobId) : undefined;
  const currentArtifact = currentJob ? firstMediaArtifact(artifactsByJob[currentJob.id] ?? []) : undefined;
  const latestRun = runs[0];
  const latestJob = latestRun ? jobsById.get(latestRun.mediaJobId) : undefined;
  const hasCurrentResult = Boolean(currentRun && currentJob?.status === "succeeded" && currentArtifact);
  const latestJobActive = isActiveMediaJob(latestJob);
  const latestIssue = latestJob?.status === "failed" || latestJob?.status === "cancelled";
  const runContext = {
    latestRun,
    latestJob,
    currentRun,
    currentJob,
    currentArtifact,
    isRegenerating: Boolean(hasCurrentResult && latestJobActive),
    latestIssue,
  };
  const source = deriveSceneSourceProjection({ scene, project, providers, workflows });
  const sourceIdentity = source.mode === "workflow"
    ? source.selectedWorkflow ? { workflow: source.selectedWorkflow } : {}
    : source.selectedProvider ? { provider: source.selectedProvider } : {};
  const directImageIssue = source.mode === "direct" && source.selectedProvider
    ? deriveVideoImageInputIssue(scene, assets, resolveMediaProviderRuntimeState(source.selectedProvider, "video_generate").videoGeneration)
    : undefined;

  if (latestJobActive) {
    const awaitingApproval = latestJob?.status === "waiting_for_approval";
    return readiness(scene, {
      state: "generating",
      label: { key: hasCurrentResult ? "Generated · updating" : awaitingApproval ? "Waiting for approval" : "Generating" },
      reason: { key: hasCurrentResult ? "Generated · updating" : awaitingApproval ? "Approval requested" : "Generating" },
      primaryAction: "cancel",
      canRun: false,
      ...runContext,
      ...sourceIdentity,
    });
  }

  if (input.imageInputsPending) {
    return readiness(scene, {
      state: hasCurrentResult ? "current_result" : "needs_attention",
      label: { key: hasCurrentResult ? "Generated result" : "Not ready" },
      reason: { key: "Finish or remove pending image uploads before running." },
      primaryAction: "none",
      blockerFieldLabel: "Image inputs",
      canRun: false,
      ...runContext,
      ...sourceIdentity,
    });
  }

  if (hasCurrentResult) {
    return readiness(scene, {
      state: "current_result",
      label: { key: "Generated result" },
      reason: directImageIssue ?? { key: latestIssue ? "Generated · last attempt failed" : "Generated · skipped in batch" },
      primaryAction: directImageIssue ? "none" : latestIssue ? "open-history" : "run",
      canRun: !directImageIssue,
      ...runContext,
      ...sourceIdentity,
    });
  }

  if (latestIssue) {
    return readiness(scene, {
      state: "needs_attention",
      label: { key: "Needs attention" },
      reason: directImageIssue ?? { key: "Last attempt incomplete · retry available" },
      primaryAction: directImageIssue ? "none" : "run",
      canRun: !directImageIssue,
      ...runContext,
      ...sourceIdentity,
    });
  }

  if (source.blocker) {
    return readiness(scene, {
      state: "needs_model",
      label: { key: "Not ready" },
      reason: source.blocker,
      primaryAction: source.repairAction,
      canRun: false,
      ...runContext,
      ...sourceIdentity,
    });
  }

  if (source.mode === "workflow") {
    const workflow = source.selectedWorkflow;
    const missingField = workflow?.currentVersion?.inputFields.find((field) => field.required && fieldValueIsMissing(workflowFieldSceneValue(field, scene)));
    if (missingField) {
      return readiness(scene, {
        state: missingField.semantic === "prompt" ? "needs_prompt" : "needs_model",
        label: { key: "Not ready" },
        reason: { key: "Not ready" },
        primaryAction: "none",
        blockerFieldLabel: missingField.label,
        workflow,
        canRun: false,
        ...runContext,
      });
    }
    return readiness(scene, {
      state: "ready",
      label: { key: "Ready" },
      reason: { key: "Production workflows" },
      primaryAction: "run",
      workflow,
      canRun: true,
      ...runContext,
    });
  }

  if (!scene.prompt.trim()) {
    return readiness(scene, {
      state: "needs_prompt",
      label: { key: "Not ready" },
      reason: { key: "Prompt" },
      primaryAction: "none",
      canRun: false,
      ...runContext,
      ...sourceIdentity,
    });
  }

  if (directImageIssue) {
    return readiness(scene, {
      state: "needs_model",
      label: { key: "Not ready" },
      reason: directImageIssue,
      primaryAction: "none",
      blockerFieldLabel: "Image inputs",
      canRun: false,
      ...runContext,
      ...sourceIdentity,
    });
  }

  const runtime = source.selectedProvider
    ? resolveMediaProviderRuntimeState(source.selectedProvider, "video_generate")
    : undefined;
  if (runtime?.videoGeneration?.aspectRatios && !runtime.videoGeneration.aspectRatios.includes(scene.ratio)) {
    return readiness(scene, {
      state: "needs_model",
      label: { key: "Not ready" },
      reason: { key: "Aspect ratio" },
      primaryAction: "none",
      canRun: false,
      ...runContext,
      ...sourceIdentity,
    });
  }
  if (runtime?.videoGeneration?.durationsSeconds && !runtime.videoGeneration.durationsSeconds.includes(scene.durationSeconds)) {
    return readiness(scene, {
      state: "needs_model",
      label: { key: "Not ready" },
      reason: { key: "Video duration" },
      primaryAction: "none",
      canRun: false,
      ...runContext,
      ...sourceIdentity,
    });
  }
  return readiness(scene, {
    state: "ready",
    label: { key: "Ready" },
    reason: { key: "Default video model" },
    primaryAction: "run",
    canRun: true,
    ...runContext,
    ...sourceIdentity,
  });
}

export function deriveVideoImageInputIssue(
  scene: Pick<MediaScene, "videoImageInputs">,
  assets: readonly Pick<MediaProjectAsset, "id">[],
  capability: import("../../types.js").VideoGenerationCapabilities | undefined,
): MediaProductionLabel | undefined {
  if (scene.videoImageInputs.length === 0) return undefined;
  const roles = new Set(scene.videoImageInputs.map((item) => item.role));
  if (roles.size !== 1) return { key: "Use one image purpose per scene." };
  const missingAsset = scene.videoImageInputs.some((item) => !assets.some((asset) => asset.id === item.assetId));
  if (missingAsset) return { key: "One or more project images are no longer available." };
  const role = scene.videoImageInputs[0]?.role;
  if (!role || !capability?.inputModes.includes(role)) {
    return { key: role === "first_frame" ? "Current model does not support a starting frame." : "Current model does not support reference images." };
  }
  if (role === "first_frame" && scene.videoImageInputs.length !== 1) {
    return { key: "Choose one starting frame." };
  }
  if (role === "reference_image" && scene.videoImageInputs.length > (capability.maxReferenceImages ?? 0)) {
    return { key: "This model supports up to {count} reference images.", values: { count: capability.maxReferenceImages ?? 0 } };
  }
  return undefined;
}

export function shouldShowVideoImageInputs(
  scene: Pick<MediaScene, "videoImageInputs">,
  capability: import("../../types.js").VideoGenerationCapabilities | undefined,
): boolean {
  return scene.videoImageInputs.length > 0
    || Boolean(capability?.inputModes.some((mode) => mode === "first_frame" || mode === "reference_image"));
}

export function deriveSceneSourceProjection(input: {
  readonly scene: MediaScene;
  readonly project: MediaProject;
  readonly providers: readonly ProviderPreset[];
  readonly workflows: readonly MediaWorkflowDefinitionDetail[];
}): SceneSourceProjection {
  const mode = input.scene.executionMode === "inherit" ? input.project.defaultExecutionMode : input.scene.executionMode;
  const providerId = input.scene.providerPresetId ?? input.project.defaultProviderPresetId ?? "";
  const workflowId = input.scene.workflowDefinitionId ?? input.project.defaultWorkflowDefinitionId ?? "";
  const providers = input.providers.filter((provider) => {
    const runtime = resolveMediaProviderRuntimeState(provider, "video_generate");
    return runtime.canRun && Boolean(runtime.videoGeneration);
  });
  const workflows = input.workflows.filter((workflow) => workflow.definition.status === "ready" && Boolean(workflow.currentVersion));
  const selectedProvider = input.providers.find((provider) => provider.id === providerId);
  const selectedWorkflow = input.workflows.find((workflow) => workflow.definition.id === workflowId);
  const providerReady = providers.some((provider) => provider.id === providerId);
  const workflowReady = workflows.some((workflow) => workflow.definition.id === workflowId);

  if (mode === "workflow") {
    return {
      mode,
      providerId,
      workflowId,
      providers,
      workflows,
      selectedProvider,
      selectedWorkflow,
      blocker: workflowReady ? undefined : { key: "Choose a production workflow" },
      repairAction: workflowReady ? "none" : "configure-workflow",
    };
  }
  return {
    mode,
    providerId,
    workflowId,
    providers,
    workflows,
    selectedProvider,
    selectedWorkflow,
    blocker: providerReady ? undefined : { key: "Configure video model" },
    repairAction: providerReady ? "none" : "configure-model",
  };
}

export function deriveSceneResultProjection(readiness?: SceneReadiness): SceneResultProjection {
  if (readiness?.currentArtifact && readiness.latestIssue) {
    return { state: "issue", statusLabel: { key: "Generated · last attempt failed" }, statusTone: "warning" };
  }
  if (readiness?.currentArtifact && readiness.isRegenerating) {
    return { state: "updating", statusLabel: { key: "Generated · updating" }, statusTone: "info" };
  }
  if (readiness?.currentArtifact) {
    return { state: "current", statusLabel: { key: "Generated result" }, statusTone: "success" };
  }
  if (readiness?.latestIssue) {
    return { state: "issue", statusLabel: { key: "Last attempt incomplete · retry available" }, statusTone: "warning" };
  }
  return { state: "empty", statusLabel: { key: "No artifacts" }, statusTone: "neutral" };
}

export function deriveSceneRunProjections(input: {
  readonly scene: MediaScene;
  readonly runs: readonly MediaSceneRun[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly locale: string;
}): readonly SceneRunProjection[] {
  const jobsById = new Map(input.jobs.map((job) => [job.id, job]));
  return input.runs
    .filter((run) => run.sceneId === input.scene.id)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((run) => {
      const job = jobsById.get(run.mediaJobId);
      const artifact = job ? firstMediaArtifact(input.artifactsByJob[job.id] ?? []) : undefined;
      const selected = input.scene.selectedMediaSceneRunId === run.id;
      const status = job?.status ?? "unknown";
      return {
        run,
        job,
        artifact,
        selected,
        status,
        statusLabel: selected && status === "succeeded" ? { key: "Current" } : sceneRunStatusLabel(status),
        statusTone: sceneRunStatusTone(status, selected),
        primaryAction: isActiveMediaJob(job) ? "cancel" : status === "succeeded" && artifact && !selected ? "select" : "none",
        sourceName: sceneRunSourceName(run),
        sourceLabel: { key: sceneRunSourceName(run) ? "" : run.executionSnapshot.kind === "workflow" ? "Production workflows" : "Default video model" },
        createdAtLabel: formatSceneRunTimestamp(run.createdAt, input.locale),
      };
    });
}

export function workflowFieldSceneValue(field: MediaWorkflowInputField, scene: MediaScene): unknown {
  if (field.semantic === "prompt") return scene.prompt;
  if (field.semantic === "ratio") return scene.ratio;
  if (field.semantic === "duration") return scene.durationSeconds;
  if (field.semantic === "reference_image") return scene.referenceArtifactIds[0] ?? scene.workflowInputValues[field.id] ?? field.defaultValue ?? "";
  return scene.workflowInputValues[field.id] ?? field.defaultValue ?? "";
}

export function deriveProjectRunReview(readinessItems: readonly SceneReadiness[]): ProjectRunReview {
  return {
    ready: readinessItems.filter((item) => item.state === "ready"),
    skipped: readinessItems.filter((item) => item.state !== "ready"),
  };
}

export function firstMediaArtifact(artifacts: readonly RunArtifact[]): RunArtifact | undefined {
  return artifacts.find((artifact) => artifact.type === "video" || artifact.type === "image");
}

function readiness(
  scene: MediaScene,
  input: Omit<SceneReadiness, "label" | "labelKey" | "labelValues" | "reason" | "reasonKey" | "reasonValues" | "sceneId" | "sceneTitle" | "sortOrder" | "status">
    & { readonly label: MediaProductionLabel; readonly reason: MediaProductionLabel },
): SceneReadiness {
  return {
    sceneId: scene.id,
    sceneTitle: scene.title,
    sortOrder: scene.sortOrder,
    state: input.state,
    status: input.state,
    labelKey: input.label.key,
    labelValues: input.label.values,
    reasonKey: input.reason.key,
    reasonValues: input.reason.values,
    primaryAction: input.primaryAction,
    blockerFieldLabel: input.blockerFieldLabel,
    label: input.label.key,
    reason: input.reason.key,
    provider: input.provider,
    workflow: input.workflow,
    latestRun: input.latestRun,
    latestJob: input.latestJob,
    currentRun: input.currentRun,
    currentJob: input.currentJob,
    currentArtifact: input.currentArtifact,
    isRegenerating: input.isRegenerating,
    latestIssue: input.latestIssue,
    canRun: input.canRun,
  };
}

function isActiveMediaJob(job: MediaJob | undefined): boolean {
  return job?.status === "queued" || job?.status === "running" || job?.status === "waiting_for_approval";
}

function fieldValueIsMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function sceneRunStatusLabel(status: SceneRunProjection["status"]): MediaProductionLabel {
  if (status === "succeeded") return { key: "Generated result" };
  if (status === "failed") return { key: "Generation failed" };
  if (status === "cancelled") return { key: "Cancelled" };
  if (status === "waiting_for_approval") return { key: "Waiting for approval" };
  if (status === "queued") return { key: "Queued" };
  if (status === "running") return { key: "Running" };
  return { key: "Not ready" };
}

function sceneRunStatusTone(status: SceneRunProjection["status"], selected: boolean): SceneRunProjection["statusTone"] {
  if (selected && status === "succeeded") return "success";
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "warning";
  if (status === "queued" || status === "running" || status === "waiting_for_approval") return "info";
  return "neutral";
}

function sceneRunSourceName(run: MediaSceneRun): string | undefined {
  const snapshot = run.executionSnapshot ?? run.providerSnapshot;
  if (typeof snapshot.workflowName === "string" && snapshot.workflowName.trim()) return snapshot.workflowName.trim();
  if (typeof snapshot.displayName === "string" && snapshot.displayName.trim()) return snapshot.displayName.trim();
  return undefined;
}

function formatSceneRunTimestamp(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(date);
}

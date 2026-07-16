import { resolveMediaProviderRuntimeState } from "@ling-stack/core/provider-media-normalization";
import type {
  MediaJob,
  MediaProject,
  MediaScene,
  MediaSceneRun,
  MediaWorkflowDefinitionDetail,
  MediaWorkflowInputField,
  ProviderPreset,
  RunArtifact,
} from "../../types.js";

export type SceneReadinessState = "needs_prompt" | "needs_model" | "ready" | "generating" | "needs_attention" | "current_result";

export interface SceneReadiness {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly sortOrder: number;
  readonly state: SceneReadinessState;
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
  readonly latestIssue?: string;
  readonly canRun: boolean;
}

export interface ProjectRunReview {
  readonly ready: readonly SceneReadiness[];
  readonly skipped: readonly SceneReadiness[];
}

export function deriveSceneReadiness(input: {
  readonly scene: MediaScene;
  readonly project: MediaProject;
  readonly providers: readonly ProviderPreset[];
  readonly workflows?: readonly MediaWorkflowDefinitionDetail[];
  readonly sceneRuns: readonly MediaSceneRun[];
  readonly jobs: readonly MediaJob[];
  readonly artifactsByJob: Readonly<Record<string, readonly RunArtifact[]>>;
}): SceneReadiness {
  const { scene, project, providers, workflows = [], sceneRuns, jobs, artifactsByJob } = input;
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const runs = sceneRuns
    .filter((run) => run.sceneId === scene.id)
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const currentRun = scene.selectedMediaSceneRunId
    ? runs.find((run) => run.id === scene.selectedMediaSceneRunId)
    : undefined;
  const currentJob = currentRun ? jobsById.get(currentRun.mediaJobId) : undefined;
  const currentArtifact = currentJob
    ? firstMediaArtifact(artifactsByJob[currentJob.id] ?? [])
    : undefined;
  const latestRun = runs[0];
  const latestJob = latestRun ? jobsById.get(latestRun.mediaJobId) : undefined;
  const hasCurrentResult = Boolean(currentRun && currentJob?.status === "succeeded");
  const latestJobActive = latestJob?.status === "queued" || latestJob?.status === "running" || latestJob?.status === "waiting_for_approval";
  const latestIssue = latestJob?.status === "failed"
    ? latestJob.errorMessage ?? "上一次生成未完成，请查看生成记录后重试。"
    : latestJob?.status === "cancelled"
      ? "上一次生成已取消。"
      : undefined;
  const runContext = {
    latestRun,
    latestJob,
    currentRun,
    currentJob,
    currentArtifact,
    isRegenerating: Boolean(hasCurrentResult && latestJobActive),
    latestIssue,
  };
  const executionMode = scene.executionMode === "inherit" ? project.defaultExecutionMode : scene.executionMode;
  const configuredWorkflowId = scene.workflowDefinitionId ?? project.defaultWorkflowDefinitionId;
  const configuredWorkflow = executionMode === "workflow"
    ? workflows.find((item) => item.definition.id === configuredWorkflowId)
    : undefined;
  const configuredProviderId = scene.providerPresetId ?? project.defaultProviderPresetId;
  const configuredProvider = executionMode === "direct"
    ? providers.find((item) => item.id === configuredProviderId)
    : undefined;
  const sourceIdentity = configuredWorkflow ? { workflow: configuredWorkflow } : configuredProvider ? { provider: configuredProvider } : {};

  if (latestJobActive) {
    const awaitingApproval = latestJob.status === "waiting_for_approval";
    return {
      ...sceneIdentity(scene),
      state: "generating",
      label: awaitingApproval ? "待确认" : hasCurrentResult ? "重新生成中" : "生成中",
      reason: hasCurrentResult
        ? awaitingApproval ? "新版本正在等待确认，当前结果仍可预览。" : "正在生成新版本，当前结果仍可预览。"
        : awaitingApproval ? "该历史任务仍在等待确认，可取消后重新生成。" : "该场景已有生成任务在进行中。",
      ...runContext,
      ...sourceIdentity,
      canRun: false,
    };
  }

  if (hasCurrentResult) {
    return {
      ...sceneIdentity(scene),
      state: "current_result",
      label: "已生成",
      reason: latestIssue
        ? "当前结果仍保留；上一次重新生成没有完成。"
        : "已有当前结果，按顺序生成会跳过；可在场景中单独重新生成。",
      ...runContext,
      ...sourceIdentity,
      canRun: true,
    };
  }

  if (latestJob?.status === "failed" || latestJob?.status === "cancelled") {
    return {
      ...sceneIdentity(scene),
      state: "needs_attention",
      label: "需要处理",
      reason: latestJob.status === "cancelled" ? "上一次生成已取消。" : "上一次生成未完成，请查看原因后重试。",
      ...runContext,
      ...sourceIdentity,
      canRun: true,
    };
  }

  if (executionMode === "workflow") {
    const workflow = configuredWorkflow;
    if (!workflow || workflow.definition.status !== "ready" || !workflow.currentVersion) {
      return {
        ...sceneIdentity(scene),
        state: "needs_model",
        label: "待完善",
        reason: "请选择已试运行并启用的生产流程。",
        workflow,
        ...runContext,
        canRun: false,
      };
    }
    const missingField = workflow.currentVersion.inputFields.find((field) => {
      if (!field.required) return false;
      const value = workflowFieldValue(field, scene);
      return value === undefined || value === null || value === "";
    });
    if (missingField) {
      return {
        ...sceneIdentity(scene),
        state: missingField.semantic === "prompt" ? "needs_prompt" : "needs_model",
        label: "待完善",
        reason: `请填写流程输入：${missingField.label}。`,
        workflow,
        ...runContext,
        canRun: false,
      };
    }
    return {
      ...sceneIdentity(scene),
      state: "ready",
      label: "可生成",
      reason: `将使用生产流程“${workflow.definition.name}”。`,
      workflow,
      ...runContext,
      canRun: true,
    };
  }

  if (!scene.prompt.trim()) {
    return {
      ...sceneIdentity(scene),
      state: "needs_prompt",
      label: "待完善",
      reason: "请先填写画面提示。",
      ...runContext,
      canRun: false,
    };
  }

  const provider = configuredProvider;
  const runtime = provider ? resolveMediaProviderRuntimeState(provider, "video_generate") : undefined;
  if (!provider || !runtime?.canRun || !runtime.videoGeneration) {
    return {
      ...sceneIdentity(scene),
      state: "needs_model",
      label: "待完善",
      reason: "请为场景选择可运行的视频模型。",
      provider,
      ...runContext,
      canRun: false,
    };
  }
  if (runtime.videoGeneration.aspectRatios && !runtime.videoGeneration.aspectRatios.includes(scene.ratio)) {
    return {
      ...sceneIdentity(scene),
      state: "needs_model",
      label: "待完善",
      reason: `当前模型不支持 ${scene.ratio} 比例。`,
      provider,
      ...runContext,
      canRun: false,
    };
  }
  if (runtime.videoGeneration.durationsSeconds && !runtime.videoGeneration.durationsSeconds.includes(scene.durationSeconds)) {
    return {
      ...sceneIdentity(scene),
      state: "needs_model",
      label: "待完善",
      reason: `当前模型不支持 ${scene.durationSeconds} 秒时长。`,
      provider,
      ...runContext,
      canRun: false,
    };
  }
  return {
    ...sceneIdentity(scene),
    state: "ready",
    label: "可生成",
    reason: "画面提示和模型已准备好。",
    provider,
    ...runContext,
    canRun: true,
  };
}

function workflowFieldValue(
  field: MediaWorkflowInputField,
  scene: MediaScene,
): unknown {
  if (field.semantic === "prompt") return scene.prompt;
  if (field.semantic === "ratio") return scene.ratio;
  if (field.semantic === "duration") return scene.durationSeconds;
  if (field.semantic === "reference_image") return scene.referenceArtifactIds[0] ?? scene.workflowInputValues[field.id] ?? field.defaultValue;
  return scene.workflowInputValues[field.id] ?? field.defaultValue;
}

export function deriveProjectRunReview(readiness: readonly SceneReadiness[]): ProjectRunReview {
  return {
    ready: readiness.filter((item) => item.state === "ready"),
    skipped: readiness.filter((item) => item.state !== "ready"),
  };
}

export function firstMediaArtifact(artifacts: readonly RunArtifact[]): RunArtifact | undefined {
  return artifacts.find((artifact) => artifact.type === "video" || artifact.type === "image");
}

function sceneIdentity(scene: MediaScene): Pick<SceneReadiness, "sceneId" | "sceneTitle" | "sortOrder"> {
  return { sceneId: scene.id, sceneTitle: scene.title, sortOrder: scene.sortOrder };
}

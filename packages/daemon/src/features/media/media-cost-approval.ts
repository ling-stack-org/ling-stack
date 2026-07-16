import type {
  ApprovalRequest,
  MediaCostApprovalPayload,
  MediaJob,
  RunStore,
} from "@ling-stack/core";

export const MEDIA_PRODUCTION_APPROVAL_GATE = "media_cost";

export function requiresMediaProductionApproval(job: MediaJob): boolean {
  return job.input.approvalGate === MEDIA_PRODUCTION_APPROVAL_GATE;
}

export function requestMediaProductionApproval(input: {
  readonly store: RunStore;
  readonly mediaJob: MediaJob;
  readonly now: string;
}): { readonly mediaJob: MediaJob; readonly approval: ApprovalRequest } {
  if (!requiresMediaProductionApproval(input.mediaJob)) {
    throw new Error("媒体任务没有声明生产台费用审批边界。");
  }

  const waiting = input.store.updateMediaJobStatus(
    input.mediaJob.id,
    { status: "waiting_for_approval", errorMessage: null },
    input.now,
  ) ?? input.mediaJob;

  try {
    const source = approvalSource(input.store, waiting);
    const approval = input.store.createApprovalRequest({
      mediaJobId: waiting.id,
      actionType: "media_cost",
      risk: "medium",
      title: "确认媒体生成",
      description: source.description,
      payload: source.payload,
    }, input.now);
    return { mediaJob: waiting, approval };
  } catch (error) {
    input.store.updateMediaJobStatus(waiting.id, { status: "queued", errorMessage: null }, input.now);
    throw error;
  }
}

export function cancelPendingMediaProductionApprovals(
  store: RunStore,
  mediaJobId: string,
  now: string,
): readonly ApprovalRequest[] {
  return store.listApprovalRequests({ mediaJobId, status: "pending" })
    .filter((approval) => approval.actionType === "media_cost")
    .map((approval) => store.cancelApprovalRequest(
      approval.id,
      { reason: "用户取消了媒体生产任务。", resolvedBy: "local-user" },
      now,
    ) ?? approval);
}

function approvalSource(
  store: RunStore,
  mediaJob: MediaJob,
): { readonly description: string; readonly payload: MediaCostApprovalPayload } {
  const promptPreview = truncate(mediaJob.prompt.trim() || "未填写提示词", 240);
  if (mediaJob.executionSource.kind === "provider") {
    const provider = store.getProviderPreset(mediaJob.executionSource.providerPresetId);
    if (!provider) {
      throw new Error("媒体生成模型不存在，无法创建费用确认。");
    }
    return {
      description: `将使用模型“${provider.displayName}”执行一次媒体生成。`,
      payload: {
        type: "media_cost",
        sourceKind: "provider",
        providerPresetId: provider.id,
        model: provider.model,
        operation: mediaJob.operation,
        promptPreview,
      },
    };
  }

  const version = store.getMediaWorkflowVersion(mediaJob.executionSource.workflowVersionId);
  const workflow = version ? store.getMediaWorkflowDefinition(version.workflowDefinitionId) : undefined;
  if (!version || !workflow) {
    throw new Error("媒体生产流程不存在，无法创建费用确认。");
  }
  return {
    description: `将运行生产流程“${workflow.name}”并产生一次媒体生成。`,
    payload: {
      type: "media_cost",
      sourceKind: "workflow",
      workflowDefinitionId: workflow.id,
      workflowName: workflow.name,
      operation: mediaJob.operation,
      promptPreview,
    },
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

import type {
  AiTeammateListResponse,
  AiTeammateMutationResponse,
  AutomationDetailResponse,
  AutomationDraftDetailResponse,
  AutomationDraftListRequest,
  AutomationDraftListResponse,
  AutomationDraftMutationResponse,
  AutomationDraftPreviewResponse,
  AutomationListRequest,
  AutomationListResponse,
  AutomationMutationResponse,
  AutomationPreviewResponse,
  AutomationRunCancelRequest,
  AutomationRunDetailResponse,
  AutomationRunListRequest,
  AutomationRunListResponse,
  AutomationRunMutationResponse,
  AutomationRunRequest,
  AutomationSchedulerListResponse,
  AutomationSchedulerMutationResponse,
  ApprovalListResponse,
  ApprovalMutationResponse,
  ApprovalPolicyResponse,
  ChannelAttachmentListResponse,
  ChannelAttachmentMutationResponse,
  ChannelBriefMutationResponse,
  ChannelBriefResponse,
  ChannelContextSummaryListResponse,
  ChannelContextSummaryMutationResponse,
  ChannelContextSummaryTargetType,
  ChannelDecisionListResponse,
  ChannelDecisionMutationResponse,
  ChannelDecisionStatus,
  ChannelExecutionProposalListResponse,
  ChannelExecutionProposalMutationResponse,
  ChannelHandoffListResponse,
  ChannelHandoffMutationResponse,
  ChannelHandoffStatus,
  ChannelLinkPreviewListResponse,
  ChannelLinkPreviewMutationResponse,
  ChannelListResponse,
  ChannelMessageListResponse,
  ChannelMessageMutationResponse,
  ChannelMessageRouteDecisionListResponse,
  ChannelMutationResponse,
  ChannelWorkflowListResponse,
  ChannelWorkflowCancelResponse,
  ChannelWorkflowMutationResponse,
  ChannelWorkflowOrchestrationResponse,
  ChannelWorkflowStatus,
  ChannelWorkflowStepListResponse,
  ChannelWorkflowStepMutationResponse,
  ChannelWorkflowStepRetryResponse,
  ChannelWorkflowStepStartResponse,
  ChannelWorkflowStepStatus,
  ChannelWorkflowTemplateMutationResponse,
  WorkflowEvidenceResponse,
  CreateChannelAttachmentRequest,
  CreateChannelContextSummaryRequest,
  CreateChannelDecisionRequest,
  CreateChannelExecutionProposalRequest,
  CreateChannelHandoffRequest,
  CreateChannelLinkPreviewRequest,
  CreateChannelMessageRequest,
  CreateChannelRequest,
  CreateAiTeammateRequest,
  ConfirmAutomationDraftResponse,
  ControlPlaneDomain,
  ControlPlaneEventsRequest,
  ControlPlaneEventsResponse,
  ControlPlaneSnapshotResponse,
  CreateAutomationDraftRequest,
  CreateAutomationRequest,
  CreateLingTurnRequest,
  CreateLingThreadRequest,
  CreateTeammateDirectMessageRequest,
  CreateTeammatePrivateAttachmentRequest,
  CreateChannelWorkflowFromHandoffRequest,
  CreateChannelWorkflowTemplateCompileRequest,
  CreateChannelWorkflowRequest,
  CreateChannelWorkflowStepRequest,
  CreateMemoryObjectRequest,
  CreateMemoryConsolidationJobRequest,
  CreateMediaJobRequest,
  CreateRunInterventionRequest,
  CreateTaskRequest,
  DaemonHealthResponse,
  ExternalGitHubImportRequest,
  ExternalLinearImportRequest,
  ExternalWorkBackgroundListResponse,
  ExternalWorkBackgroundMutationResponse,
  ExternalWorkActionCancelRequest,
  ExternalWorkActionDetailResponse,
  ExternalWorkActionExecuteRequest,
  ExternalWorkActionListRequest,
  ExternalWorkActionListResponse,
  ExternalWorkActionMutationResponse,
  ExternalWorkActionProposeRequest,
  ExternalWorkCiTriageDetailResponse,
  ExternalWorkCiTriageListRequest,
  ExternalWorkCiTriageListResponse,
  ExternalWorkCiTriageRunRequest,
  ExternalWorkCiTriageRequest,
  ExternalWorkCiTriageResponse,
  ExternalWorkDetailResponse,
  ExternalWorkGitHubBackgroundStartRequest,
  ExternalWorkListRequest,
  ExternalWorkListResponse,
  ExternalWorkPollRequest,
  ExternalWorkPollResponse,
  ExternalWorkImportResponse,
  ExternalWorkReconcileRequest,
  ExternalWorkReconcileResponse,
  ExternalWorkRouteRequest,
  ExternalWorkRouteResponse,
  ExternalWorkSecretConfigureRequest,
  ExternalWorkSecretDeleteRequest,
  ExternalWorkSecretMutationResponse,
  ExternalWorkStatusResponse,
  ExternalWorkWorkflowConfigureRequest,
  ExternalWorkWorkflowMutationResponse,
  HardDeleteAiTeammateRequest,
  HardDeleteAiTeammateResponse,
  ListApprovalsRequest,
  LingThreadArchiveRequest,
  LingThreadDetailResponse,
  LingThreadEvidenceResponse,
  LingThreadForkRunRequest,
  LingThreadForkRunResponse,
  LingThreadForkRequest,
  LingThreadForkResponse,
  LingThreadListRequest,
  LingThreadListResponse,
  LingThreadMutationResponse,
  LingThreadPinRequest,
  LingThreadResumePreviewResponse,
  LingThreadResumeRequest,
  LingThreadResumeResponse,
  LingThreadTurnsResponse,
  LingTurnMutationResponse,
  ListResourceLeasesRequest,
  ListStateTransitionsRequest,
  ListTasksRequest,
  MediaJobArtifactListResponse,
  MediaJobListResponse,
  MediaJobMutationResponse,
  ApplyMemoryReviewActionRequest,
  MemoryListResponse,
  MemoryConsolidationJobListResponse,
  MemoryConsolidationJobMutationResponse,
  MemoryHealthRequest,
  MemoryHealthResponse,
  MemoryMutationResponse,
  MemoryPromotionInboxResponse,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemoryReviewPolicyResponse,
  MemoryReviewPolicyUpdateRequest,
  MemoryReviewMutationResponse,
  McpServerListResponse,
  McpServerCheckResponse,
  McpServerMutationRequest,
  McpServerMutationResponse,
  McpServerStatusResponse,
  McpServerToolSyncResponse,
  McpToolListResponse,
  ManagedPluginApplyPresetRequest,
  ManagedPluginApplyPresetResponse,
  ManagedPluginCheckResponse,
  ManagedPluginDetailResponse,
  ManagedPluginDisableRequest,
  ManagedPluginInstallRequest,
  ManagedPluginInstallResponse,
  ManagedPluginListResponse,
  ManagedPluginMutationResponse,
  ManagedPluginRefreshPackageResponse,
  ManagedPluginRuntimePreviewResponse,
  ManagedPluginUninstallRequest,
  ManagedPluginUninstallResponse,
  PluginPackageDetailResponse,
  PluginPackageValidationResponse,
  PluginSourceListResponse,
  ProviderCheckResult,
  ProviderDraftCheckRequest,
  ProviderListResponse,
  ProviderModelListRequest,
  ProviderModelListResponse,
  ProviderMutationRequest,
  ProviderMutationResponse,
  ProviderSecretResponse,
  ProviderTemplateListResponse,
  PreviewContentResponse,
  ResourceLeaseListResponse,
  RunnerListResponse,
  RuntimeExtensionListResponse,
  RuntimeDiagnosticsResponse,
  RuntimeResponse,
  RuntimeSemaphoreListResponse,
  RuntimeSettingsResponse,
  RunArtifactListResponse,
  RunCancelResponse,
  RunEventsResponse,
  RunInterventionListResponse,
  RunInterventionResponse,
  RunListRequest,
  RunListResponse,
  RunSession,
  SecretPurpose,
  SecretStatusResponse,
  ShellSnapshotListResponse,
  ShellSnapshotResponse,
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPublishResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
  SkillRegistryRefreshResponse,
  StateTransitionListResponse,
  TaskListResponse,
  TaskMutationResponse,
  UpdateApprovalPolicyRequest,
  UpdateChannelBriefRequest,
  UpdateChannelContextSummaryRequest,
  UpdateChannelDecisionRequest,
  UpdateChannelExecutionProposalRequest,
  UpdateChannelHandoffRequest,
  UpdateChannelWorkflowRequest,
  UpdateChannelWorkflowStepRequest,
  UpdateChannelRequest,
  UpdateMemoryObjectRequest,
  UpdateTaskRequest,
  StartChannelWorkflowStepRequest,
  ReplaceTeammateChannelMembershipRequest,
  ReplaceTeammateMemoryScopesRequest,
  ReplaceTeammateMcpBindingsRequest,
  ReplaceTeammateSkillBindingsRequest,
  TeammateActivityListResponse,
  TeammateChannelMembershipListResponse,
  TeammateDirectMessageListResponse,
  TeammateDirectMessageMutationResponse,
  TeammateDirectThreadResponse,
  TeammatePrivateAttachmentListResponse,
  TeammatePrivateAttachmentMutationResponse,
  TeammateMcpBindingListResponse,
  TeammateMemoryScopeListResponse,
  TeammatePersonaDraftRequest,
  TeammatePersonaDraftResponse,
  TeammateSkillBindingListResponse,
  UpdateAiTeammateRequest,
  UpdateAutomationDraftRequest,
  UpdateAutomationRequest,
  UsedMemoryListResponse,
  WorkUnitDetailResponse,
  WorkUnitEventsResponse,
  WorkUnitKind,
  WorkUnitListResponse,
  WorkUnitMutationResponse,
  WorkUnitStatus,
  ListWorkItemsRequest,
  WorkItemClaimRequest,
  WorkItemClaimResponse,
  WorkItemCompleteRequest,
  WorkItemDetailResponse,
  WorkItemFailRequest,
  WorkItemHeartbeatRequest,
  WorkItemListResponse,
  WorkItemMutationResponse,
  WorkItemReleaseRequest,
  WorkItemRouteRequest,
  WorkspaceRuntimeSettingsPatch,
} from "@ling-stack/contracts";
import { LingDaemonError } from "./errors.js";

export interface LingDaemonClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function daemonBaseUrlFromEnv(env: Record<string, string | undefined> = {}): string {
  return env.VITE_LING_STACK_DAEMON_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:17891";
}

export class LingDaemonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: LingDaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? daemonBaseUrlFromEnv()).replace(/\/$/, "");
    const configuredFetch = options.fetch;
    if (configuredFetch) {
      this.fetchImpl = (input, init) => configuredFetch(input, init);
      return;
    }
    if (!globalThis.fetch) {
      throw new Error("A fetch implementation is required.");
    }
    this.fetchImpl = globalThis.fetch.bind(globalThis);
  }

  async getHealth(): Promise<DaemonHealthResponse> {
    const response = await this.fetchImpl(this.url("/health"));
    if (!response.ok) {
      return { ok: false };
    }
    const body = (await response.json()) as {
      ok?: unknown;
      service?: unknown;
      defaultWorkspaceCwd?: unknown;
      features?: unknown;
    };
    return {
      ok: body.ok === true,
      service: typeof body.service === "string" ? body.service : undefined,
      defaultWorkspaceCwd: typeof body.defaultWorkspaceCwd === "string" ? body.defaultWorkspaceCwd : undefined,
      features: readDaemonFeatureFlags(body.features),
    };
  }

  async getControlPlaneSnapshot(
    cwd: string,
    domains?: readonly ControlPlaneDomain[],
  ): Promise<ControlPlaneSnapshotResponse> {
    return this.get("/control-plane/snapshot", {
      cwd,
      domains: domains?.join(","),
    });
  }

  async listControlPlaneEvents(
    cwd: string,
    options: ControlPlaneEventsRequest = {},
  ): Promise<ControlPlaneEventsResponse> {
    return this.get("/control-plane/events", {
      cwd,
      afterSeq: options.afterSeq,
      limit: options.limit,
      domains: options.domains?.join(","),
    });
  }

  async streamControlPlaneEvents(
    cwd: string,
    options: ControlPlaneEventsRequest = {},
  ): Promise<Response> {
    const response = await this.fetchImpl(this.url("/control-plane/stream", {
      cwd,
      afterSeq: options.afterSeq,
      domains: options.domains?.join(","),
    }), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
    });
    if (!response.ok) {
      throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
    }
    return response;
  }

  async listAutomations(cwd: string, options: AutomationListRequest = {}): Promise<AutomationListResponse> {
    return this.get("/automations", {
      cwd,
      status: options.status,
      kind: options.kind,
      channelId: options.channelId,
      includeArchived: options.includeArchived,
      scheduledOnly: options.scheduledOnly,
      limit: options.limit,
    });
  }

  async createAutomation(cwd: string, input: CreateAutomationRequest): Promise<AutomationMutationResponse> {
    return this.post("/automations", { cwd }, input);
  }

  async listAutomationDrafts(cwd: string, options: AutomationDraftListRequest = {}): Promise<AutomationDraftListResponse> {
    return this.get("/automation-drafts", {
      cwd,
      status: options.status,
      source: options.source,
      channelId: options.channelId,
      includeTerminal: options.includeTerminal,
      limit: options.limit,
    });
  }

  async createAutomationDraft(cwd: string, input: CreateAutomationDraftRequest): Promise<AutomationDraftMutationResponse> {
    return this.post("/automation-drafts", { cwd }, input);
  }

  async getAutomationDraft(cwd: string, draftId: string): Promise<AutomationDraftDetailResponse> {
    return this.get(`/automation-drafts/${encodeURIComponent(draftId)}`, { cwd });
  }

  async updateAutomationDraft(cwd: string, draftId: string, input: UpdateAutomationDraftRequest): Promise<AutomationDraftMutationResponse> {
    return this.patch(`/automation-drafts/${encodeURIComponent(draftId)}`, { cwd }, input);
  }

  async discardAutomationDraft(cwd: string, draftId: string): Promise<AutomationDraftMutationResponse> {
    return this.requestJson("DELETE", `/automation-drafts/${encodeURIComponent(draftId)}`, { cwd });
  }

  async previewAutomationDraft(cwd: string, draftId: string, input: Record<string, never> = {}): Promise<AutomationDraftPreviewResponse> {
    return this.post(`/automation-drafts/${encodeURIComponent(draftId)}/preview`, { cwd }, input);
  }

  async confirmAutomationDraft(cwd: string, draftId: string, input: Record<string, never> = {}): Promise<ConfirmAutomationDraftResponse> {
    return this.post(`/automation-drafts/${encodeURIComponent(draftId)}/confirm`, { cwd }, input);
  }

  async getAutomation(cwd: string, automationId: string): Promise<AutomationDetailResponse> {
    return this.get(`/automations/${encodeURIComponent(automationId)}`, { cwd });
  }

  async updateAutomation(cwd: string, automationId: string, input: UpdateAutomationRequest): Promise<AutomationMutationResponse> {
    return this.patch(`/automations/${encodeURIComponent(automationId)}`, { cwd }, input);
  }

  async archiveAutomation(cwd: string, automationId: string): Promise<AutomationMutationResponse> {
    return this.requestJson("DELETE", `/automations/${encodeURIComponent(automationId)}`, { cwd });
  }

  async previewAutomation(cwd: string, automationId: string, input: Record<string, never> = {}): Promise<AutomationPreviewResponse> {
    return this.post(`/automations/${encodeURIComponent(automationId)}/preview`, { cwd }, input);
  }

  async runAutomation(cwd: string, automationId: string, input: AutomationRunRequest = {}): Promise<AutomationRunMutationResponse> {
    return this.post(`/automations/${encodeURIComponent(automationId)}/run`, { cwd }, input);
  }

  async listAutomationRuns(cwd: string, options: AutomationRunListRequest = {}): Promise<AutomationRunListResponse> {
    return this.get("/automation-runs", {
      cwd,
      automationId: options.automationId,
      runId: options.runId,
      status: options.status,
      limit: options.limit,
    });
  }

  async getAutomationRun(cwd: string, automationRunId: string): Promise<AutomationRunDetailResponse> {
    return this.get(`/automation-runs/${encodeURIComponent(automationRunId)}`, { cwd });
  }

  async cancelAutomationRun(
    cwd: string,
    automationRunId: string,
    input: AutomationRunCancelRequest = {},
  ): Promise<AutomationRunMutationResponse> {
    return this.post(`/automation-runs/${encodeURIComponent(automationRunId)}/cancel`, { cwd }, input);
  }

  async startAutomationScheduler(cwd: string): Promise<AutomationSchedulerMutationResponse> {
    return this.post("/automations/scheduler/start", { cwd }, {});
  }

  async listAutomationSchedulers(cwd: string): Promise<AutomationSchedulerListResponse> {
    return this.get("/automations/scheduler", { cwd });
  }

  async stopAutomationScheduler(cwd: string): Promise<AutomationSchedulerMutationResponse> {
    return this.post("/automations/scheduler/stop", { cwd }, {});
  }

  async listSkills(cwd: string): Promise<SkillRegistryListResponse> {
    return this.get("/skills", { cwd });
  }

  async refreshSkills(cwd: string): Promise<SkillRegistryRefreshResponse> {
    return this.post("/skills/refresh", { cwd }, {});
  }

  async createSkillImportDraft(cwd: string, input: SkillImportDraftRequest): Promise<SkillImportDraftResponse> {
    return this.post("/skills/import-draft", { cwd }, input);
  }

  async getSkillImportDraft(cwd: string, draftId: string): Promise<SkillImportDraftResponse> {
    return this.get(`/skills/import-drafts/${encodeURIComponent(draftId)}`, { cwd });
  }

  async publishSkillImportDraft(cwd: string, draftId: string): Promise<SkillImportPublishResponse> {
    return this.post(`/skills/import-drafts/${encodeURIComponent(draftId)}/publish`, { cwd }, {});
  }

  async archiveSkill(cwd: string, skillId: string): Promise<SkillRegistryMutationResponse> {
    return this.request("DELETE", `/skills/${encodeURIComponent(skillId)}`, { cwd });
  }

  async listRuns(cwd: string, options: RunListRequest | number = 50): Promise<RunListResponse> {
    const request = typeof options === "number" ? { limit: options } : options;
    return this.get("/runs", {
      cwd,
      status: request.status,
      teammateId: request.teammateId,
      workflowStepId: request.workflowStepId,
      threadId: request.threadId,
      limit: request.limit,
    });
  }

  async listLingThreads(cwd: string, options: LingThreadListRequest = {}): Promise<LingThreadListResponse> {
    return this.get("/threads", {
      cwd,
      q: options.q,
      kind: options.kind,
      channelId: options.channelId,
      taskId: options.taskId,
      teammateId: options.teammateId,
      workflowStepId: options.workflowStepId,
      externalWorkId: options.externalWorkId,
      status: options.status,
      archived: options.archived,
      includeArchived: options.includeArchived,
      limit: options.limit,
    });
  }

  async createLingThread(cwd: string, input: CreateLingThreadRequest): Promise<LingThreadMutationResponse> {
    return this.post("/threads", { cwd }, input);
  }

  async getLingThread(cwd: string, threadId: string): Promise<LingThreadDetailResponse> {
    return this.get(`/threads/${encodeURIComponent(threadId)}`, { cwd });
  }

  async getLingThreadEvidence(cwd: string, threadId: string): Promise<LingThreadEvidenceResponse> {
    return this.get(`/threads/${encodeURIComponent(threadId)}/evidence`, { cwd });
  }

  async listLingThreadTurns(cwd: string, threadId: string, options: { readonly limit?: number; readonly beforeUpdatedAt?: string } = {}): Promise<LingThreadTurnsResponse> {
    return this.get(`/threads/${encodeURIComponent(threadId)}/turns`, {
      cwd,
      limit: options.limit,
      beforeUpdatedAt: options.beforeUpdatedAt,
    });
  }

  async createLingTurn(cwd: string, threadId: string, input: CreateLingTurnRequest): Promise<LingTurnMutationResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/turns`, { cwd }, input);
  }

  async resumeLingThread(cwd: string, threadId: string, input: LingThreadResumeRequest = {}): Promise<LingThreadResumeResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/resume`, { cwd }, input);
  }

  async previewLingThreadResume(cwd: string, threadId: string, input: LingThreadResumeRequest = {}): Promise<LingThreadResumePreviewResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/resume-preview`, { cwd }, input);
  }

  async forkLingThread(cwd: string, threadId: string, input: LingThreadForkRequest = {}): Promise<LingThreadForkResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/fork`, { cwd }, input);
  }

  async forkRunLingThread(cwd: string, threadId: string, input: LingThreadForkRunRequest): Promise<LingThreadForkRunResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/fork-run`, { cwd }, input);
  }

  async archiveLingThread(cwd: string, threadId: string, input: LingThreadArchiveRequest = {}): Promise<LingThreadMutationResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/archive`, { cwd }, input);
  }

  async unarchiveLingThread(cwd: string, threadId: string, input: LingThreadArchiveRequest = {}): Promise<LingThreadMutationResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/unarchive`, { cwd }, input);
  }

  async pinLingThread(cwd: string, threadId: string, input: LingThreadPinRequest = {}): Promise<LingThreadMutationResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/pin`, { cwd }, input);
  }

  async unpinLingThread(cwd: string, threadId: string, input: LingThreadPinRequest = {}): Promise<LingThreadMutationResponse> {
    return this.post(`/threads/${encodeURIComponent(threadId)}/unpin`, { cwd }, input);
  }

  async getRun(runId: string, cwd?: string): Promise<RunSession> {
    return this.get(`/runs/${encodeURIComponent(runId)}`, { cwd });
  }

  async getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/events`, { cwd });
  }

  async listRunArtifacts(runId: string, cwd?: string): Promise<RunArtifactListResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/artifacts`, { cwd });
  }

  async listRunShellSnapshots(runId: string, cwd?: string, toolCallId?: string): Promise<ShellSnapshotListResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/shell-snapshots`, { cwd, toolCallId });
  }

  async getRunShellSnapshot(runId: string, snapshotId: string, cwd?: string): Promise<ShellSnapshotResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/shell-snapshots/${encodeURIComponent(snapshotId)}`, { cwd });
  }

  async cancelRun(cwd: string, runId: string): Promise<RunCancelResponse> {
    return this.post(`/runs/${encodeURIComponent(runId)}/cancel`, { cwd });
  }

  async listRunInterventions(cwd: string, runId: string, limit = 100): Promise<RunInterventionListResponse> {
    return this.get(`/runs/${encodeURIComponent(runId)}/interventions`, { cwd, limit });
  }

  async createRunIntervention(cwd: string, runId: string, input: CreateRunInterventionRequest): Promise<RunInterventionResponse> {
    return this.post(`/runs/${encodeURIComponent(runId)}/interventions`, { cwd }, input);
  }

  async getRunIntervention(cwd: string, interventionId: string): Promise<RunInterventionResponse> {
    return this.get(`/run-interventions/${encodeURIComponent(interventionId)}`, { cwd });
  }

  async cancelRunIntervention(cwd: string, interventionId: string): Promise<RunInterventionResponse> {
    return this.post(`/run-interventions/${encodeURIComponent(interventionId)}/cancel`, { cwd }, {});
  }

  async listMemoryObjects(
    cwd: string,
    options: {
      readonly scopeType?: string;
      readonly ownerId?: string;
      readonly reviewState?: string;
      readonly enabled?: boolean;
      readonly sensitivity?: string;
      readonly tag?: string;
      readonly limit?: number;
    } = {},
  ): Promise<MemoryListResponse> {
    return this.get("/memory", { cwd, ...options });
  }

  async createMemoryObject(cwd: string, input: CreateMemoryObjectRequest): Promise<MemoryMutationResponse> {
    return this.post("/memory", { cwd }, input);
  }

  async getMemoryHealth(cwd: string, options: MemoryHealthRequest = {}): Promise<MemoryHealthResponse> {
    return this.get("/memory/health", {
      cwd,
      scopeType: options.scopeType,
      ownerId: options.ownerId,
      staleCandidateDays: options.staleCandidateDays,
      limit: options.limit,
    });
  }

  async listMemoryConsolidationJobs(
    cwd: string,
    options: {
      readonly kind?: string;
      readonly status?: string;
      readonly limit?: number;
    } = {},
  ): Promise<MemoryConsolidationJobListResponse> {
    return this.get("/memory/consolidation-jobs", { cwd, ...options });
  }

  async createMemoryConsolidationJob(cwd: string, input: CreateMemoryConsolidationJobRequest): Promise<MemoryConsolidationJobMutationResponse> {
    return this.post("/memory/consolidation-jobs", { cwd }, input);
  }

  async updateMemoryObject(cwd: string, memoryId: string, input: UpdateMemoryObjectRequest): Promise<MemoryMutationResponse> {
    return this.patch(`/memory/${encodeURIComponent(memoryId)}`, { cwd }, input);
  }

  async getMemoryReviewPolicy(cwd: string): Promise<MemoryReviewPolicyResponse> {
    return this.get("/memory/review-policy", { cwd });
  }

  async updateMemoryReviewPolicy(cwd: string, input: MemoryReviewPolicyUpdateRequest): Promise<MemoryReviewPolicyResponse> {
    return this.patch("/memory/review-policy", { cwd }, input);
  }

  async listMemoryPromotionInbox(
    cwd: string,
    options: {
      readonly scopeType?: string;
      readonly ownerId?: string;
      readonly sensitivity?: string;
      readonly limit?: number;
    } = {},
  ): Promise<MemoryPromotionInboxResponse> {
    return this.get("/memory/promotion-inbox", { cwd, ...options });
  }

  async reviewMemory(cwd: string, memoryId: string, input: ApplyMemoryReviewActionRequest): Promise<MemoryReviewMutationResponse> {
    return this.post(`/memory/${encodeURIComponent(memoryId)}/review`, { cwd }, input);
  }

  async recallMemory(cwd: string, input: MemoryRecallRequest): Promise<MemoryRecallResponse> {
    return this.post("/memory/recall", { cwd }, input);
  }

  async listUsedMemoryEvents(
    cwd: string,
    options: {
      readonly teammateId?: string;
      readonly channelId?: string;
      readonly taskId?: string;
      readonly runId?: string;
      readonly responseId?: string;
      readonly memoryId?: string;
      readonly limit?: number;
    } = {},
  ): Promise<UsedMemoryListResponse> {
    return this.get("/memory/used", { cwd, ...options });
  }

  async getRuntime(cwd: string): Promise<RuntimeResponse> {
    return this.get("/runtime", { cwd });
  }

  async listRunners(cwd: string): Promise<RunnerListResponse> {
    return this.get("/runners", { cwd });
  }

  async listRuntimeExtensions(cwd: string): Promise<RuntimeExtensionListResponse> {
    return this.get("/runtime/extensions", { cwd });
  }

  async getRuntimeSettings(cwd: string): Promise<RuntimeSettingsResponse> {
    return this.get("/runtime/settings", { cwd });
  }

  async updateRuntimeSettings(cwd: string, input: WorkspaceRuntimeSettingsPatch): Promise<RuntimeSettingsResponse> {
    return this.patch("/runtime/settings", { cwd }, input);
  }

  async getRuntimeDiagnostics(cwd: string): Promise<RuntimeDiagnosticsResponse> {
    return this.get("/runtime/supervisor", { cwd });
  }

  async listRuntimeActive(cwd: string): Promise<WorkUnitListResponse> {
    return this.get("/runtime/active", { cwd });
  }

  async listRuntimeStuck(cwd: string): Promise<WorkUnitListResponse> {
    return this.get("/runtime/stuck", { cwd });
  }

  async listRuntimeSemaphores(cwd: string): Promise<RuntimeSemaphoreListResponse> {
    return this.get("/runtime/semaphores", { cwd });
  }

  async listWorkUnits(
    cwd: string,
    options: {
      readonly status?: WorkUnitStatus;
      readonly kind?: WorkUnitKind;
      readonly ownerType?: string;
      readonly ownerId?: string;
      readonly channelId?: string;
      readonly linkedRunId?: string;
      readonly limit?: number;
    } = {},
  ): Promise<WorkUnitListResponse> {
    return this.get("/work-units", {
      cwd,
      status: options.status,
      kind: options.kind,
      ownerType: options.ownerType,
      ownerId: options.ownerId,
      channelId: options.channelId,
      linkedRunId: options.linkedRunId,
      limit: options.limit,
    });
  }

  async getWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitDetailResponse> {
    return this.get(`/work-units/${encodeURIComponent(workUnitId)}`, { cwd });
  }

  async getWorkUnitEvents(cwd: string, workUnitId: string, afterSeq?: number): Promise<WorkUnitEventsResponse> {
    return this.get(`/work-units/${encodeURIComponent(workUnitId)}/events`, { cwd, afterSeq });
  }

  async cancelWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
    return this.post(`/work-units/${encodeURIComponent(workUnitId)}/cancel`, { cwd });
  }

  async retryWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
    return this.post(`/work-units/${encodeURIComponent(workUnitId)}/retry`, { cwd });
  }

  async reconcileWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
    return this.post(`/work-units/${encodeURIComponent(workUnitId)}/reconcile`, { cwd });
  }

  async listChannels(cwd: string): Promise<ChannelListResponse> {
    return this.get("/channels", { cwd });
  }

  async createChannel(cwd: string, input: CreateChannelRequest): Promise<ChannelMutationResponse> {
    return this.post("/channels", { cwd }, input);
  }

  async updateChannel(cwd: string, channelId: string, input: UpdateChannelRequest): Promise<ChannelMutationResponse> {
    return this.patch(`/channels/${encodeURIComponent(channelId)}`, { cwd }, input);
  }

  async deleteChannel(cwd: string, channelId: string): Promise<void> {
    await this.request("DELETE", `/channels/${encodeURIComponent(channelId)}`, { cwd });
  }

  async listChannelMessages(
    cwd: string,
    channelId: string,
    options: { readonly limit?: number; readonly beforeMessageId?: string; readonly threadId?: string } = {},
  ): Promise<ChannelMessageListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/messages`, {
      cwd,
      limit: options.limit,
      beforeMessageId: options.beforeMessageId,
      threadId: options.threadId,
    });
  }

  async createChannelMessage(
    cwd: string,
    channelId: string,
    input: CreateChannelMessageRequest,
  ): Promise<ChannelMessageMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/messages`, { cwd }, input);
  }

  async listChannelMessageRouteDecisions(
    cwd: string,
    channelId: string,
    options: { readonly sourceMessageId?: string; readonly status?: string; readonly limit?: number } = {},
  ): Promise<ChannelMessageRouteDecisionListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/message-route-decisions`, {
      cwd,
      sourceMessageId: options.sourceMessageId,
      status: options.status,
      limit: options.limit,
    });
  }

  async listChannelExecutionProposals(cwd: string, channelId: string, limit = 100): Promise<ChannelExecutionProposalListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/proposals`, { cwd, limit });
  }

  async createChannelExecutionProposal(
    cwd: string,
    channelId: string,
    input: CreateChannelExecutionProposalRequest,
  ): Promise<ChannelExecutionProposalMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/proposals`, { cwd }, input);
  }

  async updateChannelExecutionProposal(
    cwd: string,
    proposalId: string,
    input: UpdateChannelExecutionProposalRequest,
  ): Promise<ChannelExecutionProposalMutationResponse> {
    return this.patch(`/channel-proposals/${encodeURIComponent(proposalId)}`, { cwd }, input);
  }

  async listAiTeammates(
    cwd: string,
    options: { readonly includeHidden?: boolean; readonly includeDisabled?: boolean; readonly limit?: number } = {},
  ): Promise<AiTeammateListResponse> {
    return this.get("/teammates", { cwd, ...options });
  }

  async createAiTeammate(cwd: string, input: CreateAiTeammateRequest): Promise<AiTeammateMutationResponse> {
    return this.post("/teammates", { cwd }, input);
  }

  async getAiTeammate(cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}`, { cwd });
  }

  async updateAiTeammate(cwd: string, teammateId: string, input: UpdateAiTeammateRequest): Promise<AiTeammateMutationResponse> {
    return this.patch(`/teammates/${encodeURIComponent(teammateId)}`, { cwd }, input);
  }

  async disableAiTeammate(cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
    return this.request("DELETE", `/teammates/${encodeURIComponent(teammateId)}`, { cwd });
  }

  async hardDeleteAiTeammate(cwd: string, teammateId: string, input: HardDeleteAiTeammateRequest = {}): Promise<HardDeleteAiTeammateResponse> {
    return this.post(`/teammates/${encodeURIComponent(teammateId)}/hard-delete`, { cwd }, input);
  }

  async listTeammateChannels(cwd: string, teammateId: string): Promise<TeammateChannelMembershipListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/channels`, { cwd });
  }

  async replaceTeammateChannels(
    cwd: string,
    teammateId: string,
    input: ReplaceTeammateChannelMembershipRequest,
  ): Promise<TeammateChannelMembershipListResponse> {
    return this.put(`/teammates/${encodeURIComponent(teammateId)}/channels`, { cwd }, input);
  }

  async listTeammateSkills(cwd: string, teammateId: string): Promise<TeammateSkillBindingListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/skills`, { cwd });
  }

  async replaceTeammateSkills(
    cwd: string,
    teammateId: string,
    input: ReplaceTeammateSkillBindingsRequest,
  ): Promise<TeammateSkillBindingListResponse> {
    return this.put(`/teammates/${encodeURIComponent(teammateId)}/skills`, { cwd }, input);
  }

  async listTeammateMcpBindings(cwd: string, teammateId: string): Promise<TeammateMcpBindingListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/mcp`, { cwd });
  }

  async replaceTeammateMcpBindings(
    cwd: string,
    teammateId: string,
    input: ReplaceTeammateMcpBindingsRequest,
  ): Promise<TeammateMcpBindingListResponse> {
    return this.put(`/teammates/${encodeURIComponent(teammateId)}/mcp`, { cwd }, input);
  }

  async listTeammateMemoryScopes(cwd: string, teammateId: string): Promise<TeammateMemoryScopeListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/memory-scopes`, { cwd });
  }

  async replaceTeammateMemoryScopes(
    cwd: string,
    teammateId: string,
    input: ReplaceTeammateMemoryScopesRequest,
  ): Promise<TeammateMemoryScopeListResponse> {
    return this.put(`/teammates/${encodeURIComponent(teammateId)}/memory-scopes`, { cwd }, input);
  }

  async createTeammatePersonaDraft(
    cwd: string,
    teammateId: string,
    input: TeammatePersonaDraftRequest,
  ): Promise<TeammatePersonaDraftResponse> {
    return this.post(`/teammates/${encodeURIComponent(teammateId)}/persona-draft`, { cwd }, input);
  }

  async getTeammateDirectThread(cwd: string, teammateId: string): Promise<TeammateDirectThreadResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/direct-thread`, { cwd });
  }

  async listTeammateDirectMessages(cwd: string, teammateId: string, limit = 100): Promise<TeammateDirectMessageListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/direct-messages`, { cwd, limit });
  }

  async createTeammateDirectMessage(
    cwd: string,
    teammateId: string,
    input: CreateTeammateDirectMessageRequest,
  ): Promise<TeammateDirectMessageMutationResponse> {
    return this.post(`/teammates/${encodeURIComponent(teammateId)}/direct-messages`, { cwd }, input);
  }

  async streamTeammateDirectMessage(
    cwd: string,
    teammateId: string,
    input: CreateTeammateDirectMessageRequest,
  ): Promise<Response> {
    const response = await this.fetchImpl(this.url(`/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream`, { cwd }), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
    }
    return response;
  }

  async listTeammatePrivateAttachments(cwd: string, teammateId: string, limit = 100): Promise<TeammatePrivateAttachmentListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/direct-attachments`, { cwd, limit });
  }

  async createTeammatePrivateAttachment(
    cwd: string,
    teammateId: string,
    input: CreateTeammatePrivateAttachmentRequest,
  ): Promise<TeammatePrivateAttachmentMutationResponse> {
    return this.post(`/teammates/${encodeURIComponent(teammateId)}/direct-attachments`, { cwd }, input);
  }

  async uploadTeammateAvatar(
    cwd: string,
    teammateId: string,
    input: CreateTeammatePrivateAttachmentRequest,
  ): Promise<AiTeammateMutationResponse & TeammatePrivateAttachmentMutationResponse> {
    return this.post(`/teammates/${encodeURIComponent(teammateId)}/avatar`, { cwd }, input);
  }

  async deleteTeammateAvatar(cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
    return this.request("DELETE", `/teammates/${encodeURIComponent(teammateId)}/avatar`, { cwd });
  }

  async listTeammateTasks(cwd: string, teammateId: string, limit = 100): Promise<TaskListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/tasks`, { cwd, limit });
  }

  async listTeammateActivity(cwd: string, teammateId: string, limit = 100): Promise<TeammateActivityListResponse> {
    return this.get(`/teammates/${encodeURIComponent(teammateId)}/activity`, { cwd, limit });
  }

  async listChannelAttachments(cwd: string, channelId: string, limit = 100): Promise<ChannelAttachmentListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/attachments`, { cwd, limit });
  }

  async createChannelAttachment(
    cwd: string,
    channelId: string,
    input: CreateChannelAttachmentRequest,
  ): Promise<ChannelAttachmentMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/attachments`, { cwd }, input);
  }

  async deleteChannelAttachment(cwd: string, attachmentId: string): Promise<void> {
    await this.request("DELETE", `/attachments/${encodeURIComponent(attachmentId)}`, { cwd });
  }

  async previewAttachmentContent(
    cwd: string,
    attachmentId: string,
    options: {
      readonly maxBytes?: number;
      readonly scope?: "channel" | "teammate_private";
      readonly channelId?: string;
      readonly teammateId?: string;
    } = {},
  ): Promise<PreviewContentResponse> {
    return this.get(`/attachments/${encodeURIComponent(attachmentId)}/preview`, {
      cwd,
      maxBytes: options.maxBytes,
      scope: options.scope,
      channelId: options.channelId,
      teammateId: options.teammateId,
    });
  }

  attachmentContentUrl(attachmentId: string, cwd?: string): string {
    return this.url(`/attachments/${encodeURIComponent(attachmentId)}/content`, { cwd });
  }

  async listChannelLinkPreviews(cwd: string, channelId: string, limit = 100): Promise<ChannelLinkPreviewListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/link-previews`, { cwd, limit });
  }

  async createChannelLinkPreview(
    cwd: string,
    channelId: string,
    input: CreateChannelLinkPreviewRequest,
  ): Promise<ChannelLinkPreviewMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/link-previews`, { cwd }, input);
  }

  async refreshChannelLinkPreview(cwd: string, linkPreviewId: string): Promise<ChannelLinkPreviewMutationResponse> {
    return this.post(`/link-previews/${encodeURIComponent(linkPreviewId)}/refresh`, { cwd });
  }

  async getChannelBrief(cwd: string, channelId: string): Promise<ChannelBriefResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/brief`, { cwd });
  }

  async updateChannelBrief(
    cwd: string,
    channelId: string,
    input: UpdateChannelBriefRequest,
  ): Promise<ChannelBriefMutationResponse> {
    return this.patch(`/channels/${encodeURIComponent(channelId)}/brief`, { cwd }, input);
  }

  async listChannelDecisions(
    cwd: string,
    channelId: string,
    options: { readonly status?: ChannelDecisionStatus; readonly limit?: number } = {},
  ): Promise<ChannelDecisionListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/decisions`, {
      cwd,
      status: options.status,
      limit: options.limit,
    });
  }

  async createChannelDecision(
    cwd: string,
    channelId: string,
    input: CreateChannelDecisionRequest,
  ): Promise<ChannelDecisionMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/decisions`, { cwd }, input);
  }

  async updateChannelDecision(
    cwd: string,
    decisionId: string,
    input: UpdateChannelDecisionRequest,
  ): Promise<ChannelDecisionMutationResponse> {
    return this.patch(`/decisions/${encodeURIComponent(decisionId)}`, { cwd }, input);
  }

  async listChannelHandoffs(
    cwd: string,
    channelId: string,
    options: { readonly status?: ChannelHandoffStatus; readonly limit?: number } = {},
  ): Promise<ChannelHandoffListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/handoffs`, {
      cwd,
      status: options.status,
      limit: options.limit,
    });
  }

  async createChannelHandoff(
    cwd: string,
    channelId: string,
    input: CreateChannelHandoffRequest,
  ): Promise<ChannelHandoffMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/handoffs`, { cwd }, input);
  }

  async updateChannelHandoff(
    cwd: string,
    handoffId: string,
    input: UpdateChannelHandoffRequest,
  ): Promise<ChannelHandoffMutationResponse> {
    return this.patch(`/handoffs/${encodeURIComponent(handoffId)}`, { cwd }, input);
  }

  async listChannelContextSummaries(
    cwd: string,
    channelId: string,
    options: { readonly targetType?: ChannelContextSummaryTargetType; readonly targetId?: string; readonly limit?: number } = {},
  ): Promise<ChannelContextSummaryListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/context-summaries`, {
      cwd,
      targetType: options.targetType,
      targetId: options.targetId,
      limit: options.limit,
    });
  }

  async createChannelContextSummary(
    cwd: string,
    channelId: string,
    input: CreateChannelContextSummaryRequest,
  ): Promise<ChannelContextSummaryMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/context-summaries`, { cwd }, input);
  }

  async updateChannelContextSummary(
    cwd: string,
    contextSummaryId: string,
    input: UpdateChannelContextSummaryRequest,
  ): Promise<ChannelContextSummaryMutationResponse> {
    return this.patch(`/context-summaries/${encodeURIComponent(contextSummaryId)}`, { cwd }, input);
  }

  async listChannelWorkflows(
    cwd: string,
    channelId: string,
    options: { readonly status?: ChannelWorkflowStatus; readonly limit?: number } = {},
  ): Promise<ChannelWorkflowListResponse> {
    return this.get(`/channels/${encodeURIComponent(channelId)}/workflows`, {
      cwd,
      status: options.status,
      limit: options.limit,
    });
  }

  async createChannelWorkflow(
    cwd: string,
    channelId: string,
    input: CreateChannelWorkflowRequest,
  ): Promise<ChannelWorkflowMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/workflows`, { cwd }, input);
  }

  async createChannelWorkflowFromTemplate(
    cwd: string,
    channelId: string,
    input: CreateChannelWorkflowTemplateCompileRequest,
  ): Promise<ChannelWorkflowTemplateMutationResponse> {
    return this.post(`/channels/${encodeURIComponent(channelId)}/workflows`, { cwd }, input);
  }

  async getChannelWorkflow(cwd: string, workflowId: string): Promise<ChannelWorkflowMutationResponse> {
    return this.get(`/workflows/${encodeURIComponent(workflowId)}`, { cwd });
  }

  async getChannelWorkflowEvidence(cwd: string, workflowId: string): Promise<WorkflowEvidenceResponse> {
    return this.get(`/workflows/${encodeURIComponent(workflowId)}/evidence`, { cwd });
  }

  async updateChannelWorkflow(
    cwd: string,
    workflowId: string,
    input: UpdateChannelWorkflowRequest,
  ): Promise<ChannelWorkflowMutationResponse> {
    return this.patch(`/workflows/${encodeURIComponent(workflowId)}`, { cwd }, input);
  }

  async cancelChannelWorkflow(cwd: string, workflowId: string): Promise<ChannelWorkflowCancelResponse> {
    return this.post(`/workflows/${encodeURIComponent(workflowId)}/cancel`, { cwd }, {});
  }

  async createChannelWorkflowFromHandoff(
    cwd: string,
    handoffId: string,
    input: CreateChannelWorkflowFromHandoffRequest,
  ): Promise<ChannelWorkflowMutationResponse> {
    return this.post(`/handoffs/${encodeURIComponent(handoffId)}/workflow`, { cwd }, input);
  }

  async listChannelWorkflowSteps(
    cwd: string,
    workflowId: string,
    options: { readonly status?: ChannelWorkflowStepStatus; readonly limit?: number } = {},
  ): Promise<ChannelWorkflowStepListResponse> {
    return this.get(`/workflows/${encodeURIComponent(workflowId)}/steps`, {
      cwd,
      status: options.status,
      limit: options.limit,
    });
  }

  async createChannelWorkflowStep(
    cwd: string,
    workflowId: string,
    input: CreateChannelWorkflowStepRequest,
  ): Promise<ChannelWorkflowStepMutationResponse> {
    return this.post(`/workflows/${encodeURIComponent(workflowId)}/steps`, { cwd }, input);
  }

  async updateChannelWorkflowStep(
    cwd: string,
    workflowStepId: string,
    input: UpdateChannelWorkflowStepRequest,
  ): Promise<ChannelWorkflowStepMutationResponse> {
    return this.patch(`/workflow-steps/${encodeURIComponent(workflowStepId)}`, { cwd }, input);
  }

  async startChannelWorkflowStep(
    cwd: string,
    workflowStepId: string,
    input: StartChannelWorkflowStepRequest,
  ): Promise<ChannelWorkflowStepStartResponse> {
    return this.post(`/workflow-steps/${encodeURIComponent(workflowStepId)}/start`, { cwd }, input);
  }

  async retryChannelWorkflowStep(cwd: string, workflowStepId: string): Promise<ChannelWorkflowStepRetryResponse> {
    return this.post(`/workflow-steps/${encodeURIComponent(workflowStepId)}/retry`, { cwd }, {});
  }

  async orchestrateChannelWorkflow(cwd: string, workflowId: string): Promise<ChannelWorkflowOrchestrationResponse> {
    return this.post(`/workflows/${encodeURIComponent(workflowId)}/orchestrate`, { cwd }, {});
  }

  async listTasks(cwd: string, options: ListTasksRequest = {}): Promise<TaskListResponse> {
    return this.get("/tasks", { cwd, channelId: options.channelId, status: options.status, limit: options.limit });
  }

  async createTask(cwd: string, input: CreateTaskRequest): Promise<TaskMutationResponse> {
    return this.post("/tasks", { cwd }, input);
  }

  async updateTask(cwd: string, taskId: string, input: UpdateTaskRequest): Promise<TaskMutationResponse> {
    return this.patch(`/tasks/${encodeURIComponent(taskId)}`, { cwd }, input);
  }

  async deleteTask(cwd: string, taskId: string): Promise<void> {
    await this.request("DELETE", `/tasks/${encodeURIComponent(taskId)}`, { cwd });
  }

  async listProviders(cwd: string): Promise<ProviderListResponse> {
    return this.get("/providers", { cwd });
  }

  async listProviderTemplates(): Promise<ProviderTemplateListResponse> {
    return this.get("/provider-templates");
  }

  async createProvider(cwd: string, input: ProviderMutationRequest): Promise<ProviderMutationResponse> {
    return this.post("/providers", { cwd }, input);
  }

  async updateProvider(cwd: string, providerId: string, input: ProviderMutationRequest): Promise<ProviderMutationResponse> {
    return this.patch(`/providers/${encodeURIComponent(providerId)}`, { cwd }, input);
  }

  async getProviderSecret(cwd: string, providerId: string): Promise<ProviderSecretResponse> {
    return this.get(`/providers/${encodeURIComponent(providerId)}/secret`, { cwd });
  }

  async deleteProvider(cwd: string, providerId: string): Promise<void> {
    await this.request("DELETE", `/providers/${encodeURIComponent(providerId)}`, { cwd });
  }

  async checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult> {
    return this.post(`/providers/${encodeURIComponent(providerId)}/check`, { cwd });
  }

  async checkProviderDraft(cwd: string, input: ProviderDraftCheckRequest): Promise<ProviderCheckResult> {
    return this.post("/provider-check", { cwd }, input);
  }

  async listProviderModels(cwd: string, input: ProviderModelListRequest): Promise<ProviderModelListResponse> {
    return this.post("/provider-models", { cwd }, input);
  }

  async listMcpServers(cwd: string): Promise<McpServerListResponse> {
    return this.get("/mcp/servers", { cwd });
  }

  async createMcpServer(cwd: string, input: McpServerMutationRequest): Promise<McpServerMutationResponse> {
    return this.post("/mcp/servers", { cwd }, input);
  }

  async updateMcpServer(cwd: string, serverId: string, input: McpServerMutationRequest): Promise<McpServerMutationResponse> {
    return this.patch(`/mcp/servers/${encodeURIComponent(serverId)}`, { cwd }, input);
  }

  async deleteMcpServer(cwd: string, serverId: string): Promise<void> {
    await this.request("DELETE", `/mcp/servers/${encodeURIComponent(serverId)}`, { cwd });
  }

  async checkMcpServer(cwd: string, serverId: string): Promise<McpServerCheckResponse> {
    return this.post(`/mcp/servers/${encodeURIComponent(serverId)}/check`, { cwd });
  }

  async getMcpServerStatus(cwd: string, serverId: string): Promise<McpServerStatusResponse> {
    return this.get(`/mcp/servers/${encodeURIComponent(serverId)}/status`, { cwd });
  }

  async syncMcpServerTools(cwd: string, serverId: string): Promise<McpServerToolSyncResponse> {
    return this.post(`/mcp/servers/${encodeURIComponent(serverId)}/sync-tools`, { cwd });
  }

  async listMcpTools(cwd: string, serverId?: string): Promise<McpToolListResponse> {
    return this.get("/mcp/tools", { cwd, serverId });
  }

  async listManagedPlugins(cwd: string): Promise<ManagedPluginListResponse> {
    return this.get("/plugins", { cwd });
  }

  async getManagedPlugin(cwd: string, pluginId: string): Promise<ManagedPluginDetailResponse> {
    return this.get(`/plugins/${encodeURIComponent(pluginId)}`, { cwd });
  }

  async enableManagedPlugin(cwd: string, pluginId: string): Promise<ManagedPluginMutationResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/enable`, { cwd }, {});
  }

  async disableManagedPlugin(cwd: string, pluginId: string, input: ManagedPluginDisableRequest = {}): Promise<ManagedPluginMutationResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/disable`, { cwd }, input);
  }

  async checkManagedPlugin(cwd: string, pluginId: string): Promise<ManagedPluginCheckResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/check`, { cwd }, {});
  }

  async applyManagedPluginPreset(
    cwd: string,
    pluginId: string,
    input: ManagedPluginApplyPresetRequest = {},
  ): Promise<ManagedPluginApplyPresetResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/apply-preset`, { cwd }, input);
  }

  async installManagedPlugin(
    cwd: string,
    pluginId: string,
    input: ManagedPluginInstallRequest = {},
  ): Promise<ManagedPluginInstallResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/install`, { cwd }, input);
  }

  async uninstallManagedPlugin(
    cwd: string,
    pluginId: string,
    input: ManagedPluginUninstallRequest = {},
  ): Promise<ManagedPluginUninstallResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/uninstall`, { cwd }, input);
  }

  async refreshManagedPluginPackage(
    cwd: string,
    pluginId: string,
    input: ManagedPluginInstallRequest = {},
  ): Promise<ManagedPluginRefreshPackageResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/refresh-package`, { cwd }, input);
  }

  async getManagedPluginRuntimePreview(cwd: string, pluginId: string): Promise<ManagedPluginRuntimePreviewResponse> {
    return this.get(`/plugins/${encodeURIComponent(pluginId)}/runtime-preview`, { cwd });
  }

  async listPluginSources(cwd: string): Promise<PluginSourceListResponse> {
    return this.get("/plugins/sources", { cwd });
  }

  async getPluginPackage(cwd: string, pluginId: string): Promise<PluginPackageDetailResponse> {
    return this.get(`/plugins/packages/${encodeURIComponent(pluginId)}`, { cwd });
  }

  async validatePluginPackage(cwd: string, pluginId: string): Promise<PluginPackageValidationResponse> {
    return this.post(`/plugins/${encodeURIComponent(pluginId)}/validate-package`, { cwd }, {});
  }

  async listApprovals(cwd: string, options: ListApprovalsRequest = {}): Promise<ApprovalListResponse> {
    return this.get("/approvals", {
      cwd,
      status: options.status,
      runId: options.runId,
      mediaJobId: options.mediaJobId,
      limit: options.limit,
    });
  }

  async approveApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/approve`, { cwd }, { reason });
  }

  async denyApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
    return this.post(`/approvals/${encodeURIComponent(approvalId)}/deny`, { cwd }, { reason });
  }

  async getApprovalPolicy(cwd: string): Promise<ApprovalPolicyResponse> {
    return this.get("/approval-policy", { cwd });
  }

  async updateApprovalPolicy(cwd: string, input: UpdateApprovalPolicyRequest): Promise<ApprovalPolicyResponse> {
    return this.patch("/approval-policy", { cwd }, input);
  }

  async listMediaJobs(cwd: string, limit = 100): Promise<MediaJobListResponse> {
    return this.get("/media-jobs", { cwd, limit });
  }

  async createMediaJob(cwd: string, input: CreateMediaJobRequest): Promise<MediaJobMutationResponse> {
    return this.post("/media-jobs", { cwd }, input);
  }

  async runMediaJob(cwd: string, mediaJobId: string): Promise<MediaJobMutationResponse> {
    return this.post(`/media-jobs/${encodeURIComponent(mediaJobId)}/run`, { cwd });
  }

  async listMediaJobArtifacts(mediaJobId: string, cwd?: string): Promise<MediaJobArtifactListResponse> {
    return this.get(`/media-jobs/${encodeURIComponent(mediaJobId)}/artifacts`, { cwd });
  }

  async importGitHubExternalWork(cwd: string, input: ExternalGitHubImportRequest): Promise<ExternalWorkImportResponse> {
    return this.post("/external-work/github/import", { cwd }, input);
  }

  async importLinearExternalWork(cwd: string, input: ExternalLinearImportRequest): Promise<ExternalWorkImportResponse> {
    return this.post("/external-work/linear/import", { cwd }, input);
  }

  async listExternalWork(cwd: string, options: ExternalWorkListRequest = {}): Promise<ExternalWorkListResponse> {
    return this.get("/external-work", {
      cwd,
      channelId: options.channelId,
      sourceKind: options.sourceKind,
      workItemKind: options.workItemKind,
      schedulerStatus: options.schedulerStatus,
      limit: options.limit,
    });
  }

  async getExternalWork(cwd: string, externalWorkId: string): Promise<ExternalWorkDetailResponse> {
    return this.get(`/external-work/${encodeURIComponent(externalWorkId)}`, { cwd });
  }

  async routeExternalWork(
    cwd: string,
    externalWorkId: string,
    input: ExternalWorkRouteRequest,
  ): Promise<ExternalWorkRouteResponse> {
    return this.post(`/external-work/${encodeURIComponent(externalWorkId)}/route`, { cwd }, input);
  }

  async getExternalWorkStatus(
    cwd: string,
    input: { readonly channelId: string; readonly workflowPath?: string },
  ): Promise<ExternalWorkStatusResponse> {
    return this.get("/external-work/status", {
      cwd,
      channelId: input.channelId,
      workflowPath: input.workflowPath,
    });
  }

  async configureExternalWorkSecret(
    cwd: string,
    input: ExternalWorkSecretConfigureRequest,
  ): Promise<ExternalWorkSecretMutationResponse> {
    return this.post("/external-work/secrets/configure", { cwd }, input);
  }

  async deleteExternalWorkSecret(
    cwd: string,
    input: ExternalWorkSecretDeleteRequest,
  ): Promise<ExternalWorkSecretMutationResponse> {
    return this.post("/external-work/secrets/delete", { cwd }, input);
  }

  async configureExternalWorkWorkflow(
    cwd: string,
    input: ExternalWorkWorkflowConfigureRequest,
  ): Promise<ExternalWorkWorkflowMutationResponse> {
    return this.post("/external-work/workflow/configure", { cwd }, input);
  }

  async proposeExternalWorkAction(cwd: string, input: ExternalWorkActionProposeRequest): Promise<ExternalWorkActionMutationResponse> {
    return this.post("/external-work/actions/propose", { cwd }, input);
  }

  async listExternalWorkActions(cwd: string, options: ExternalWorkActionListRequest = {}): Promise<ExternalWorkActionListResponse> {
    return this.get("/external-work/actions", {
      cwd,
      externalWorkId: options.externalWorkId,
      channelId: options.channelId,
      status: options.status,
      actionKind: options.actionKind,
      limit: options.limit,
    });
  }

  async getExternalWorkAction(cwd: string, actionId: string): Promise<ExternalWorkActionDetailResponse> {
    return this.get(`/external-work/actions/${encodeURIComponent(actionId)}`, { cwd });
  }

  async cancelExternalWorkAction(
    cwd: string,
    actionId: string,
    input: ExternalWorkActionCancelRequest = {},
  ): Promise<ExternalWorkActionMutationResponse> {
    return this.post(`/external-work/actions/${encodeURIComponent(actionId)}/cancel`, { cwd }, input);
  }

  async executeExternalWorkAction(
    cwd: string,
    actionId: string,
    input: ExternalWorkActionExecuteRequest = {},
  ): Promise<ExternalWorkActionMutationResponse> {
    return this.post(`/external-work/actions/${encodeURIComponent(actionId)}/execute`, { cwd }, input);
  }

  async pollGitHubExternalWork(cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
    return this.post("/external-work/github/poll", { cwd }, input);
  }

  async pollLinearExternalWork(cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
    return this.post("/external-work/linear/poll", { cwd }, input);
  }

  async startGitHubExternalWorkBackground(
    cwd: string,
    input: ExternalWorkGitHubBackgroundStartRequest,
  ): Promise<ExternalWorkBackgroundMutationResponse> {
    return this.post("/external-work/github/background/start", { cwd }, input);
  }

  async listExternalWorkBackgroundSchedulers(cwd: string): Promise<ExternalWorkBackgroundListResponse> {
    return this.get("/external-work/background", { cwd });
  }

  async stopExternalWorkBackgroundScheduler(cwd: string, schedulerId: string): Promise<ExternalWorkBackgroundMutationResponse> {
    return this.post(`/external-work/background/${encodeURIComponent(schedulerId)}/stop`, { cwd }, {});
  }

  async triageGitHubExternalWorkCi(cwd: string, input: ExternalWorkCiTriageRequest): Promise<ExternalWorkCiTriageResponse> {
    return this.post("/external-work/github/ci/triage", { cwd }, input);
  }

  async listGitHubExternalWorkCiTriage(
    cwd: string,
    options: ExternalWorkCiTriageListRequest = {},
  ): Promise<ExternalWorkCiTriageListResponse> {
    return this.get("/external-work/github/ci/triage", {
      cwd,
      externalWorkId: options.externalWorkId,
      channelId: options.channelId,
      status: options.status,
      limit: options.limit,
    });
  }

  async getGitHubExternalWorkCiTriage(cwd: string, triageId: string): Promise<ExternalWorkCiTriageDetailResponse> {
    return this.get(`/external-work/github/ci/triage/${encodeURIComponent(triageId)}`, { cwd });
  }

  async startGitHubExternalWorkCiTriageRun(
    cwd: string,
    triageId: string,
    input: ExternalWorkCiTriageRunRequest,
  ): Promise<Response> {
    const response = await this.fetchImpl(this.url(`/external-work/github/ci/triage/${encodeURIComponent(triageId)}/run`, { cwd }), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
    }
    return response;
  }

  async reconcileExternalWork(cwd: string, input: ExternalWorkReconcileRequest = {}): Promise<ExternalWorkReconcileResponse> {
    return this.post("/external-work/reconcile", { cwd }, input);
  }

  async listWorkItems(cwd: string, options: ListWorkItemsRequest = {}): Promise<WorkItemListResponse> {
    return this.get("/work-items", {
      cwd,
      channelId: options.channelId,
      status: options.status,
      sourceType: options.sourceType,
      assigneeTeammateId: options.assigneeTeammateId,
      limit: options.limit,
    });
  }

  async getWorkItem(cwd: string, workItemId: string): Promise<WorkItemDetailResponse> {
    return this.get(`/work-items/${encodeURIComponent(workItemId)}`, { cwd });
  }

  async routeWorkItem(cwd: string, workItemId: string, input: WorkItemRouteRequest): Promise<WorkItemMutationResponse> {
    return this.post(`/work-items/${encodeURIComponent(workItemId)}/route`, { cwd }, input);
  }

  async claimWorkItem(cwd: string, workItemId: string, input: WorkItemClaimRequest): Promise<WorkItemClaimResponse> {
    return this.post(`/work-items/${encodeURIComponent(workItemId)}/claim`, { cwd }, input);
  }

  async heartbeatWorkItem(cwd: string, workItemId: string, input: WorkItemHeartbeatRequest): Promise<WorkItemMutationResponse> {
    return this.post(`/work-items/${encodeURIComponent(workItemId)}/heartbeat`, { cwd }, input);
  }

  async releaseWorkItem(cwd: string, workItemId: string, input: WorkItemReleaseRequest): Promise<WorkItemMutationResponse> {
    return this.post(`/work-items/${encodeURIComponent(workItemId)}/release`, { cwd }, input);
  }

  async completeWorkItem(cwd: string, workItemId: string, input: WorkItemCompleteRequest): Promise<WorkItemMutationResponse> {
    return this.post(`/work-items/${encodeURIComponent(workItemId)}/complete`, { cwd }, input);
  }

  async failWorkItem(cwd: string, workItemId: string, input: WorkItemFailRequest): Promise<WorkItemMutationResponse> {
    return this.post(`/work-items/${encodeURIComponent(workItemId)}/fail`, { cwd }, input);
  }

  async listStateTransitions(cwd: string, options: ListStateTransitionsRequest = {}): Promise<StateTransitionListResponse> {
    return this.get("/state-transitions", {
      cwd,
      entityType: options.entityType,
      entityId: options.entityId,
      limit: options.limit,
    });
  }

  async listResourceLeases(cwd: string, options: ListResourceLeasesRequest = {}): Promise<ResourceLeaseListResponse> {
    return this.get("/runtime/leases", {
      cwd,
      status: options.status,
      ownerType: options.ownerType,
      ownerId: options.ownerId,
      resourceType: options.resourceType,
      resourceKey: options.resourceKey,
      workUnitId: options.workUnitId,
      attemptId: options.attemptId,
      limit: options.limit,
    });
  }

  async getSecretStatus(ref: string, purpose?: SecretPurpose): Promise<SecretStatusResponse> {
    return this.get("/secrets/status", { ref, purpose });
  }

  artifactContentUrl(artifactId: string, cwd?: string): string {
    return this.url(`/artifacts/${encodeURIComponent(artifactId)}/content`, { cwd });
  }

  async previewArtifactContent(cwd: string, artifactId: string, maxBytes?: number): Promise<PreviewContentResponse> {
    return this.get(`/artifacts/${encodeURIComponent(artifactId)}/preview`, { cwd, maxBytes });
  }

  private get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request("GET", path, query);
  }

  private post<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this.request("POST", path, query, body);
  }

  private put<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this.request("PUT", path, query, body);
  }

  private patch<T>(path: string, query: Query = {}, body?: unknown): Promise<T> {
    return this.request("PATCH", path, query, body);
  }

  private async requestJson<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.url(path, query), init);
    if (!response.ok) {
      throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
    }
    return (await response.json()) as T;
  }

  private async request<T>(method: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.url(path, query), init);
    if (!response.ok) {
      throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
    }
    if (method === "DELETE") {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private url(path: string, query: Query = {}): string {
    const parsed = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        parsed.searchParams.set(key, String(value));
      }
    }
    return parsed.toString();
  }
}

type Query = Record<string, string | number | boolean | undefined>;

function readDaemonFeatureFlags(value: unknown): DaemonHealthResponse["features"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { channels: { autoRoute: false } };
  }
  const features = value as Record<string, unknown>;
  const channels = features.channels;
  if (typeof channels !== "object" || channels === null || Array.isArray(channels)) {
    return { channels: { autoRoute: false } };
  }
  return {
    channels: {
      autoRoute: (channels as Record<string, unknown>).autoRoute === true,
    },
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string") {
      message = body.message;
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    return friendlyErrorMessage(message);
  }
  return friendlyErrorMessage(message);
}

function friendlyErrorMessage(message: string): string {
  if ((message.includes("EACCES") || message.includes("ENOENT")) && message.includes(".ling-stack")) {
    return `Workspace path does not exist or is not writable. Use the absolute path to your local checkout. ${message}`;
  }
  return message;
}

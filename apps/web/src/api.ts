import { LingDaemonClient, daemonBaseUrlFromEnv } from "@ling-stack/api-client";
import type {
  AiTeammateListResponse,
  AiTeammateMutationResponse,
  ApprovalListResponse,
  ApprovalMutationResponse,
  ApprovalPolicyFormState,
  ApprovalPolicyResponse,
  ChannelAttachment,
  ChannelAttachmentListResponse,
  ChannelAttachmentMutationResponse,
  ChannelBriefMutationResponse,
  ChannelBriefResponse,
  ChannelContextSummaryListResponse,
  ChannelContextSummaryMutationResponse,
  ChannelContextSummaryTargetType,
  ChannelDecisionListResponse,
  ChannelDecisionMutationResponse,
  ChannelExecutionProposalListResponse,
  ChannelExecutionProposalMutationResponse,
  ChannelHandoffListResponse,
  ChannelHandoffMutationResponse,
  ChannelLinkPreviewListResponse,
  ChannelLinkPreviewMutationResponse,
  Channel,
  ChannelFormState,
  ChannelListResponse,
  ChannelMessageListResponse,
  ChannelMessageMutationResponse,
  ChannelMutationResponse,
  ChannelWorkflowListResponse,
  ChannelWorkflowMutationResponse,
  ChannelWorkflowStepListResponse,
  ChannelWorkflowStepMutationResponse,
  ChannelWorkflowStepStartResponse,
  CreateChannelContextSummaryRequest,
  CreateChannelDecisionRequest,
  CreateChannelExecutionProposalRequest,
  CreateChannelHandoffRequest,
  CreateChannelLinkPreviewRequest,
  CreateChannelMessageRequest,
  CreateChannelRequest,
  CreateAiTeammateRequest,
  CreateTeammateDirectMessageRequest,
  CreateChannelWorkflowFromHandoffRequest,
  CreateChannelWorkflowRequest,
  CreateChannelWorkflowStepRequest,
  CreateMemoryObjectRequest,
  CreateMediaJobRequest,
  DaemonHealthResponse,
  ExternalWorkActionCancelRequest,
  ExternalWorkActionDetailResponse,
  ExternalWorkActionExecuteRequest,
  ExternalWorkActionListRequest,
  ExternalWorkActionListResponse,
  ExternalWorkActionMutationResponse,
  ExternalWorkCiTriageDetailResponse,
  ExternalWorkCiTriageListRequest,
  ExternalWorkCiTriageListResponse,
  ExternalWorkGitHubBackgroundStartRequest,
  ExternalWorkBackgroundMutationResponse,
  ExternalWorkPollRequest,
  ExternalWorkPollResponse,
  ExternalWorkReconcileRequest,
  ExternalWorkReconcileResponse,
  ExternalWorkSecretConfigureRequest,
  ExternalWorkSecretDeleteRequest,
  ExternalWorkSecretMutationResponse,
  ExternalWorkStatusResponse,
  ExternalWorkWorkflowConfigureRequest,
  ExternalWorkWorkflowMutationResponse,
  HardDeleteAiTeammateResponse,
  MediaJobFormState,
  MediaJobArtifactListResponse,
  MediaJobListResponse,
  MediaJobMutationResponse,
  MemoryListResponse,
  MemoryMutationResponse,
  MemoryRecallRequest,
  MemoryRecallResponse,
  McpServerFormState,
  McpServerListResponse,
  McpServerMutationRequest,
  McpServerMutationResponse,
  McpServerSecretResponse,
  McpServerToolSyncResponse,
  McpToolListResponse,
  ProviderCheckResult,
  ProviderFormState,
  ProviderListResponse,
  ProviderModelListResponse,
  ProviderMutationRequest,
  ProviderMutationResponse,
  ProviderSecretResponse,
  ProviderTemplateListResponse,
  ListResourceLeasesRequest,
  ResourceLeaseListResponse,
  ReplaceTeammateChannelMembershipRequest,
  ReplaceTeammateMemoryScopesRequest,
  ReplaceTeammateMcpBindingsRequest,
  ReplaceTeammateSkillBindingsRequest,
  RuntimeDiagnosticsResponse,
  RuntimeResponse,
  RuntimeSemaphoreListResponse,
  RunCancelResponse,
  RunArtifactListResponse,
  RunEventsResponse,
  RunFormState,
  RunListResponse,
  RunSession,
  SecretPurpose,
  SecretStatusResponse,
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPublishResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
  SkillApprovalProfile,
  StateEntityType,
  StateTransitionListResponse,
  Task,
  TaskEditFormState,
  TaskFormState,
  TaskListResponse,
  TaskMutationResponse,
  ToolName,
  TeammateActivityListResponse,
  TeammateChannelMembershipListResponse,
  TeammateDirectMessageListResponse,
  TeammateDirectMessageMutationResponse,
  TeammateDirectThreadResponse,
  TeammatePrivateAttachment,
  TeammatePrivateAttachmentListResponse,
  TeammatePrivateAttachmentMutationResponse,
  TeammateMcpBindingListResponse,
  TeammateMemoryScopeListResponse,
  TeammatePersonaDraftRequest,
  TeammatePersonaDraftResponse,
  TeammateSkillBindingListResponse,
  UpdateAiTeammateRequest,
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
  UsedMemoryListResponse,
  WorkUnitDetailResponse,
  WorkUnitEventsResponse,
  WorkUnitKind,
  WorkUnitListResponse,
  WorkUnitMutationResponse,
  WorkUnitStatus,
} from "./types.js";

export const daemonBaseUrl = daemonBaseUrlFromEnv(import.meta.env as Record<string, string | undefined>);

const daemonClient = new LingDaemonClient({ baseUrl: daemonBaseUrl });

export async function getDaemonHealth(): Promise<DaemonHealthResponse> {
  return daemonClient.getHealth();
}

export async function listSkills(cwd: string): Promise<SkillRegistryListResponse> {
  return daemonClient.listSkills(cwd);
}

export async function createSkillImportDraft(cwd: string, input: SkillImportDraftRequest): Promise<SkillImportDraftResponse> {
  return daemonClient.createSkillImportDraft(cwd, input);
}

export async function publishSkillImportDraft(cwd: string, draftId: string): Promise<SkillImportPublishResponse> {
  return daemonClient.publishSkillImportDraft(cwd, draftId);
}

export async function archiveSkill(cwd: string, skillId: string): Promise<SkillRegistryMutationResponse> {
  return daemonClient.archiveSkill(cwd, skillId);
}

export async function getRun(runId: string, cwd?: string): Promise<RunSession> {
  return daemonClient.getRun(runId, cwd);
}

export async function listRuns(cwd: string, limit = 50): Promise<RunListResponse> {
  return daemonClient.listRuns(cwd, limit);
}

export async function listProviders(cwd: string): Promise<ProviderListResponse> {
  return daemonClient.listProviders(cwd);
}

export async function listProviderTemplates(): Promise<ProviderTemplateListResponse> {
  return daemonClient.listProviderTemplates();
}

export async function listChannels(cwd: string): Promise<ChannelListResponse> {
  return daemonClient.listChannels(cwd);
}

export async function createChannel(cwd: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  return daemonClient.createChannel(cwd, channelFormToPayload(form));
}

export async function updateChannel(cwd: string, channelId: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  return daemonClient.updateChannel(cwd, channelId, channelFormToUpdatePayload(form));
}

export async function deleteChannel(cwd: string, channelId: string): Promise<void> {
  await daemonClient.deleteChannel(cwd, channelId);
}

export async function listChannelMessages(
  cwd: string,
  channelId: string,
  options: { readonly limit?: number; readonly beforeMessageId?: string; readonly threadId?: string } = {},
): Promise<ChannelMessageListResponse> {
  return daemonClient.listChannelMessages(cwd, channelId, options);
}

export async function createChannelMessage(
  cwd: string,
  channelId: string,
  input: CreateChannelMessageRequest,
): Promise<ChannelMessageMutationResponse> {
  return daemonClient.createChannelMessage(cwd, channelId, input);
}

export async function listChannelExecutionProposals(cwd: string, channelId: string): Promise<ChannelExecutionProposalListResponse> {
  return daemonClient.listChannelExecutionProposals(cwd, channelId);
}

export async function createChannelExecutionProposal(
  cwd: string,
  channelId: string,
  input: CreateChannelExecutionProposalRequest,
): Promise<ChannelExecutionProposalMutationResponse> {
  return daemonClient.createChannelExecutionProposal(cwd, channelId, input);
}

export async function updateChannelExecutionProposal(
  cwd: string,
  proposalId: string,
  input: UpdateChannelExecutionProposalRequest,
): Promise<ChannelExecutionProposalMutationResponse> {
  return daemonClient.updateChannelExecutionProposal(cwd, proposalId, input);
}

export async function listAiTeammates(cwd: string): Promise<AiTeammateListResponse> {
  return daemonClient.listAiTeammates(cwd, { includeHidden: true, includeDisabled: true });
}

export async function createAiTeammate(cwd: string, input: CreateAiTeammateRequest): Promise<AiTeammateMutationResponse> {
  return daemonClient.createAiTeammate(cwd, input);
}

export async function updateAiTeammate(cwd: string, teammateId: string, input: UpdateAiTeammateRequest): Promise<AiTeammateMutationResponse> {
  return daemonClient.updateAiTeammate(cwd, teammateId, input);
}

export async function disableAiTeammate(cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
  return daemonClient.disableAiTeammate(cwd, teammateId);
}

export async function hardDeleteAiTeammate(cwd: string, teammateId: string, reason?: string): Promise<HardDeleteAiTeammateResponse> {
  return daemonClient.hardDeleteAiTeammate(cwd, teammateId, reason?.trim() ? { reason: reason.trim() } : {});
}

export async function listTeammateChannels(cwd: string, teammateId: string): Promise<TeammateChannelMembershipListResponse> {
  return daemonClient.listTeammateChannels(cwd, teammateId);
}

export async function replaceTeammateChannels(
  cwd: string,
  teammateId: string,
  memberships: ReplaceTeammateChannelMembershipRequest["memberships"],
): Promise<TeammateChannelMembershipListResponse> {
  return daemonClient.replaceTeammateChannels(cwd, teammateId, { memberships });
}

export async function listTeammateSkills(cwd: string, teammateId: string): Promise<TeammateSkillBindingListResponse> {
  return daemonClient.listTeammateSkills(cwd, teammateId);
}

export async function replaceTeammateSkills(
  cwd: string,
  teammateId: string,
  bindings: ReplaceTeammateSkillBindingsRequest["bindings"],
): Promise<TeammateSkillBindingListResponse> {
  return daemonClient.replaceTeammateSkills(cwd, teammateId, { bindings });
}

export async function listTeammateMcpBindings(cwd: string, teammateId: string): Promise<TeammateMcpBindingListResponse> {
  return daemonClient.listTeammateMcpBindings(cwd, teammateId);
}

export async function replaceTeammateMcpBindings(
  cwd: string,
  teammateId: string,
  bindings: ReplaceTeammateMcpBindingsRequest["bindings"],
): Promise<TeammateMcpBindingListResponse> {
  return daemonClient.replaceTeammateMcpBindings(cwd, teammateId, { bindings });
}

export async function listTeammateMemoryScopes(cwd: string, teammateId: string): Promise<TeammateMemoryScopeListResponse> {
  return daemonClient.listTeammateMemoryScopes(cwd, teammateId);
}

export async function replaceTeammateMemoryScopes(
  cwd: string,
  teammateId: string,
  scopes: ReplaceTeammateMemoryScopesRequest["scopes"],
): Promise<TeammateMemoryScopeListResponse> {
  return daemonClient.replaceTeammateMemoryScopes(cwd, teammateId, { scopes });
}

export async function listMemoryObjects(cwd: string): Promise<MemoryListResponse> {
  return daemonClient.listMemoryObjects(cwd);
}

export async function createMemoryObject(cwd: string, input: CreateMemoryObjectRequest): Promise<MemoryMutationResponse> {
  return daemonClient.createMemoryObject(cwd, input);
}

export async function updateMemoryObject(cwd: string, memoryId: string, input: UpdateMemoryObjectRequest): Promise<MemoryMutationResponse> {
  return daemonClient.updateMemoryObject(cwd, memoryId, input);
}

export async function recallMemory(cwd: string, input: MemoryRecallRequest): Promise<MemoryRecallResponse> {
  return daemonClient.recallMemory(cwd, input);
}

export async function listUsedMemoryEvents(
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
  return daemonClient.listUsedMemoryEvents(cwd, options);
}

export async function createTeammatePersonaDraft(
  cwd: string,
  teammateId: string,
  input: TeammatePersonaDraftRequest,
): Promise<TeammatePersonaDraftResponse> {
  return daemonClient.createTeammatePersonaDraft(cwd, teammateId, input);
}

export async function getTeammateDirectThread(cwd: string, teammateId: string): Promise<TeammateDirectThreadResponse> {
  return daemonClient.getTeammateDirectThread(cwd, teammateId);
}

export async function listTeammateDirectMessages(cwd: string, teammateId: string): Promise<TeammateDirectMessageListResponse> {
  return daemonClient.listTeammateDirectMessages(cwd, teammateId);
}

export async function createTeammateDirectMessage(
  cwd: string,
  teammateId: string,
  input: CreateTeammateDirectMessageRequest,
): Promise<TeammateDirectMessageMutationResponse> {
  return daemonClient.createTeammateDirectMessage(cwd, teammateId, input);
}

export async function streamTeammateDirectMessage(
  cwd: string,
  teammateId: string,
  input: CreateTeammateDirectMessageRequest,
): Promise<Response> {
  return daemonClient.streamTeammateDirectMessage(cwd, teammateId, input);
}

export async function listTeammatePrivateAttachments(cwd: string, teammateId: string): Promise<TeammatePrivateAttachmentListResponse> {
  return daemonClient.listTeammatePrivateAttachments(cwd, teammateId);
}

export async function uploadTeammatePrivateAttachment(
  cwd: string,
  teammateId: string,
  file: File,
): Promise<TeammatePrivateAttachmentMutationResponse> {
  return daemonClient.createTeammatePrivateAttachment(cwd, teammateId, {
    fileName: file.name,
    contentType: file.type || undefined,
    contentBase64: await fileToBase64(file),
    scope: "teammate_direct_thread",
  });
}

export async function uploadTeammateAvatar(cwd: string, teammateId: string, file: File): Promise<AiTeammateMutationResponse & TeammatePrivateAttachmentMutationResponse> {
  return daemonClient.uploadTeammateAvatar(cwd, teammateId, {
    fileName: file.name,
    contentType: file.type || undefined,
    contentBase64: await fileToBase64(file),
    scope: "teammate_profile_avatar",
  });
}

export async function deleteTeammateAvatar(cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
  return daemonClient.deleteTeammateAvatar(cwd, teammateId);
}

export async function listTeammateTasks(cwd: string, teammateId: string): Promise<TaskListResponse> {
  return daemonClient.listTeammateTasks(cwd, teammateId);
}

export async function listTeammateActivity(cwd: string, teammateId: string): Promise<TeammateActivityListResponse> {
  return daemonClient.listTeammateActivity(cwd, teammateId);
}

export async function listChannelAttachments(cwd: string, channelId: string): Promise<ChannelAttachmentListResponse> {
  return daemonClient.listChannelAttachments(cwd, channelId);
}

export async function uploadChannelAttachment(
  cwd: string,
  channelId: string,
  file: File,
  messageId?: string,
): Promise<ChannelAttachmentMutationResponse> {
  return daemonClient.createChannelAttachment(cwd, channelId, {
    fileName: file.name,
    contentType: file.type || undefined,
    contentBase64: await fileToBase64(file),
    messageId,
  });
}

export async function deleteChannelAttachment(cwd: string, attachmentId: string): Promise<void> {
  await daemonClient.deleteChannelAttachment(cwd, attachmentId);
}

export function channelAttachmentContentUrl(attachment: ChannelAttachment, cwd?: string): string {
  return daemonClient.attachmentContentUrl(attachment.id, cwd);
}

export async function deleteAttachment(cwd: string, attachmentId: string): Promise<void> {
  await daemonClient.deleteChannelAttachment(cwd, attachmentId);
}

export function attachmentContentUrl(attachment: ChannelAttachment | TeammatePrivateAttachment, cwd?: string): string {
  return daemonClient.attachmentContentUrl(attachment.id, cwd);
}

export function attachmentContentUrlById(attachmentId: string, cwd?: string): string {
  return daemonClient.attachmentContentUrl(attachmentId, cwd);
}

export async function listChannelLinkPreviews(cwd: string, channelId: string): Promise<ChannelLinkPreviewListResponse> {
  return daemonClient.listChannelLinkPreviews(cwd, channelId);
}

export async function createChannelLinkPreview(
  cwd: string,
  channelId: string,
  input: CreateChannelLinkPreviewRequest,
): Promise<ChannelLinkPreviewMutationResponse> {
  return daemonClient.createChannelLinkPreview(cwd, channelId, input);
}

export async function refreshChannelLinkPreview(cwd: string, linkPreviewId: string): Promise<ChannelLinkPreviewMutationResponse> {
  return daemonClient.refreshChannelLinkPreview(cwd, linkPreviewId);
}

export async function getChannelBrief(cwd: string, channelId: string): Promise<ChannelBriefResponse> {
  return daemonClient.getChannelBrief(cwd, channelId);
}

export async function updateChannelBrief(
  cwd: string,
  channelId: string,
  input: UpdateChannelBriefRequest,
): Promise<ChannelBriefMutationResponse> {
  return daemonClient.updateChannelBrief(cwd, channelId, input);
}

export async function listChannelDecisions(cwd: string, channelId: string): Promise<ChannelDecisionListResponse> {
  return daemonClient.listChannelDecisions(cwd, channelId);
}

export async function createChannelDecision(
  cwd: string,
  channelId: string,
  input: CreateChannelDecisionRequest,
): Promise<ChannelDecisionMutationResponse> {
  return daemonClient.createChannelDecision(cwd, channelId, input);
}

export async function updateChannelDecision(
  cwd: string,
  decisionId: string,
  input: UpdateChannelDecisionRequest,
): Promise<ChannelDecisionMutationResponse> {
  return daemonClient.updateChannelDecision(cwd, decisionId, input);
}

export async function listChannelHandoffs(cwd: string, channelId: string): Promise<ChannelHandoffListResponse> {
  return daemonClient.listChannelHandoffs(cwd, channelId);
}

export async function createChannelHandoff(
  cwd: string,
  channelId: string,
  input: CreateChannelHandoffRequest,
): Promise<ChannelHandoffMutationResponse> {
  return daemonClient.createChannelHandoff(cwd, channelId, input);
}

export async function updateChannelHandoff(
  cwd: string,
  handoffId: string,
  input: UpdateChannelHandoffRequest,
): Promise<ChannelHandoffMutationResponse> {
  return daemonClient.updateChannelHandoff(cwd, handoffId, input);
}

export async function listChannelContextSummaries(
  cwd: string,
  channelId: string,
  options: { readonly targetType?: ChannelContextSummaryTargetType; readonly targetId?: string } = {},
): Promise<ChannelContextSummaryListResponse> {
  return daemonClient.listChannelContextSummaries(cwd, channelId, options);
}

export async function createChannelContextSummary(
  cwd: string,
  channelId: string,
  input: CreateChannelContextSummaryRequest,
): Promise<ChannelContextSummaryMutationResponse> {
  return daemonClient.createChannelContextSummary(cwd, channelId, input);
}

export async function updateChannelContextSummary(
  cwd: string,
  contextSummaryId: string,
  input: UpdateChannelContextSummaryRequest,
): Promise<ChannelContextSummaryMutationResponse> {
  return daemonClient.updateChannelContextSummary(cwd, contextSummaryId, input);
}

export async function listChannelWorkflows(cwd: string, channelId: string): Promise<ChannelWorkflowListResponse> {
  return daemonClient.listChannelWorkflows(cwd, channelId);
}

export async function createChannelWorkflow(
  cwd: string,
  channelId: string,
  input: CreateChannelWorkflowRequest,
): Promise<ChannelWorkflowMutationResponse> {
  return daemonClient.createChannelWorkflow(cwd, channelId, input);
}

export async function updateChannelWorkflow(
  cwd: string,
  workflowId: string,
  input: UpdateChannelWorkflowRequest,
): Promise<ChannelWorkflowMutationResponse> {
  return daemonClient.updateChannelWorkflow(cwd, workflowId, input);
}

export async function createChannelWorkflowFromHandoff(
  cwd: string,
  handoffId: string,
  input: CreateChannelWorkflowFromHandoffRequest,
): Promise<ChannelWorkflowMutationResponse> {
  return daemonClient.createChannelWorkflowFromHandoff(cwd, handoffId, input);
}

export async function listChannelWorkflowSteps(cwd: string, workflowId: string): Promise<ChannelWorkflowStepListResponse> {
  return daemonClient.listChannelWorkflowSteps(cwd, workflowId);
}

export async function createChannelWorkflowStep(
  cwd: string,
  workflowId: string,
  input: CreateChannelWorkflowStepRequest,
): Promise<ChannelWorkflowStepMutationResponse> {
  return daemonClient.createChannelWorkflowStep(cwd, workflowId, input);
}

export async function updateChannelWorkflowStep(
  cwd: string,
  workflowStepId: string,
  input: UpdateChannelWorkflowStepRequest,
): Promise<ChannelWorkflowStepMutationResponse> {
  return daemonClient.updateChannelWorkflowStep(cwd, workflowStepId, input);
}

export async function startChannelWorkflowStep(
  cwd: string,
  workflowStepId: string,
  input: StartChannelWorkflowStepRequest,
): Promise<ChannelWorkflowStepStartResponse> {
  return daemonClient.startChannelWorkflowStep(cwd, workflowStepId, input);
}

export async function listTasks(cwd: string, channelId?: string): Promise<TaskListResponse> {
  return daemonClient.listTasks(cwd, { channelId });
}

export async function createTask(cwd: string, channelId: string, form: TaskFormState): Promise<TaskMutationResponse> {
  return daemonClient.createTask(cwd, {
    channelId,
    title: form.title,
    prompt: form.prompt,
    assigneeTeammateId: form.assigneeTeammateId,
    requestedSkillId: form.requestedSkillId,
  });
}

export async function updateTaskStatus(cwd: string, taskId: string, status: Task["status"]): Promise<TaskMutationResponse> {
  return daemonClient.updateTask(cwd, taskId, { status });
}

export async function updateTask(cwd: string, taskId: string, form: TaskEditFormState): Promise<TaskMutationResponse> {
  return daemonClient.updateTask(cwd, taskId, taskEditFormToPayload(form));
}

export async function deleteTask(cwd: string, taskId: string): Promise<void> {
  await daemonClient.deleteTask(cwd, taskId);
}

export async function listStateTransitions(
  cwd: string,
  options: { readonly entityType?: StateEntityType; readonly entityId?: string; readonly limit?: number } = {},
): Promise<StateTransitionListResponse> {
  return daemonClient.listStateTransitions(cwd, options);
}

export async function listResourceLeases(
  cwd: string,
  options: ListResourceLeasesRequest = {},
): Promise<ResourceLeaseListResponse> {
  return daemonClient.listResourceLeases(cwd, options);
}

export async function getRuntime(cwd: string): Promise<RuntimeResponse> {
  return daemonClient.getRuntime(cwd);
}

export async function getRuntimeDiagnostics(cwd: string): Promise<RuntimeDiagnosticsResponse> {
  return daemonClient.getRuntimeDiagnostics(cwd);
}

export async function listRuntimeSemaphores(cwd: string): Promise<RuntimeSemaphoreListResponse> {
  return daemonClient.listRuntimeSemaphores(cwd);
}

export async function listWorkUnits(
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
  return daemonClient.listWorkUnits(cwd, options);
}

export async function getWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitDetailResponse> {
  return daemonClient.getWorkUnit(cwd, workUnitId);
}

export async function getWorkUnitEvents(cwd: string, workUnitId: string, afterSeq?: number): Promise<WorkUnitEventsResponse> {
  return daemonClient.getWorkUnitEvents(cwd, workUnitId, afterSeq);
}

export async function cancelWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
  return daemonClient.cancelWorkUnit(cwd, workUnitId);
}

export async function retryWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
  return daemonClient.retryWorkUnit(cwd, workUnitId);
}

export async function reconcileWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
  return daemonClient.reconcileWorkUnit(cwd, workUnitId);
}

export async function getSecretStatus(ref: string, purpose?: SecretPurpose): Promise<SecretStatusResponse> {
  return daemonClient.getSecretStatus(ref, purpose);
}

export async function createProvider(cwd: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  return daemonClient.createProvider(cwd, providerFormToPayload(form));
}

export async function updateProvider(cwd: string, providerId: string, form: ProviderFormState): Promise<ProviderMutationResponse> {
  return daemonClient.updateProvider(cwd, providerId, providerFormToPayload(form));
}

export async function getProviderSecret(cwd: string, providerId: string): Promise<ProviderSecretResponse> {
  return daemonClient.getProviderSecret(cwd, providerId);
}

export async function deleteProvider(cwd: string, providerId: string): Promise<void> {
  await daemonClient.deleteProvider(cwd, providerId);
}

export async function checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult> {
  return daemonClient.checkProvider(cwd, providerId);
}

export async function checkProviderDraft(cwd: string, form: ProviderFormState): Promise<ProviderCheckResult> {
  return daemonClient.checkProviderDraft(cwd, providerFormToPayload(form));
}

export async function listProviderModels(cwd: string, form: ProviderFormState): Promise<ProviderModelListResponse> {
  return daemonClient.listProviderModels(cwd, {
    kind: form.kind,
    providerId: form.providerId,
    api: form.api,
    baseUrl: form.baseUrl || undefined,
    apiKey: form.apiKey.trim() || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    authHeader: form.authHeader,
  });
}

export async function listMcpServers(cwd: string): Promise<McpServerListResponse> {
  return daemonClient.listMcpServers(cwd);
}

export async function createMcpServer(cwd: string, form: McpServerFormState): Promise<McpServerMutationResponse> {
  return daemonClient.createMcpServer(cwd, mcpServerFormToPayload(form));
}

export async function updateMcpServer(cwd: string, serverId: string, form: McpServerFormState): Promise<McpServerMutationResponse> {
  return daemonClient.updateMcpServer(cwd, serverId, mcpServerFormToPayload(form));
}

export async function getMcpServerSecret(cwd: string, serverId: string, secretName: string): Promise<McpServerSecretResponse> {
  return daemonClient.getMcpServerSecret(cwd, serverId, secretName);
}

export async function deleteMcpServer(cwd: string, serverId: string): Promise<void> {
  await daemonClient.deleteMcpServer(cwd, serverId);
}

export async function checkMcpServer(cwd: string, serverId: string): Promise<McpServerMutationResponse> {
  return daemonClient.checkMcpServer(cwd, serverId);
}

export async function syncMcpServerTools(cwd: string, serverId: string): Promise<McpServerToolSyncResponse> {
  return daemonClient.syncMcpServerTools(cwd, serverId);
}

export async function listMcpTools(cwd: string, serverId?: string): Promise<McpToolListResponse> {
  return daemonClient.listMcpTools(cwd, serverId);
}

export async function listApprovals(
  cwd: string,
  options: { readonly status?: string; readonly runId?: string; readonly mediaJobId?: string } = {},
): Promise<ApprovalListResponse> {
  return daemonClient.listApprovals(cwd, options);
}

export async function getApprovalPolicy(cwd: string): Promise<ApprovalPolicyResponse> {
  return daemonClient.getApprovalPolicy(cwd);
}

export async function updateApprovalPolicy(cwd: string, form: ApprovalPolicyFormState): Promise<ApprovalPolicyResponse> {
  return daemonClient.updateApprovalPolicy(cwd, {
    toolDecisions: form.toolDecisions,
    allowedWritePaths: splitLines(form.allowedWritePathsText),
  });
}

export async function approveApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "approve", reason);
}

export async function denyApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "deny", reason);
}

export async function listExternalWorkActions(
  cwd: string,
  options: ExternalWorkActionListRequest = {},
): Promise<ExternalWorkActionListResponse> {
  return daemonClient.listExternalWorkActions(cwd, options);
}

export async function getExternalWorkAction(cwd: string, actionId: string): Promise<ExternalWorkActionDetailResponse> {
  return daemonClient.getExternalWorkAction(cwd, actionId);
}

export async function cancelExternalWorkAction(
  cwd: string,
  actionId: string,
  input: ExternalWorkActionCancelRequest = {},
): Promise<ExternalWorkActionMutationResponse> {
  return daemonClient.cancelExternalWorkAction(cwd, actionId, input);
}

export async function executeExternalWorkAction(
  cwd: string,
  actionId: string,
  input: ExternalWorkActionExecuteRequest = {},
): Promise<ExternalWorkActionMutationResponse> {
  return daemonClient.executeExternalWorkAction(cwd, actionId, input);
}

export async function getExternalWorkStatus(
  cwd: string,
  input: { readonly channelId: string; readonly workflowPath?: string },
): Promise<ExternalWorkStatusResponse> {
  return daemonClient.getExternalWorkStatus(cwd, input);
}

export async function configureExternalWorkSecret(
  cwd: string,
  input: ExternalWorkSecretConfigureRequest,
): Promise<ExternalWorkSecretMutationResponse> {
  return daemonClient.configureExternalWorkSecret(cwd, input);
}

export async function deleteExternalWorkSecret(
  cwd: string,
  input: ExternalWorkSecretDeleteRequest,
): Promise<ExternalWorkSecretMutationResponse> {
  return daemonClient.deleteExternalWorkSecret(cwd, input);
}

export async function configureExternalWorkWorkflow(
  cwd: string,
  input: ExternalWorkWorkflowConfigureRequest,
): Promise<ExternalWorkWorkflowMutationResponse> {
  return daemonClient.configureExternalWorkWorkflow(cwd, input);
}

export async function pollGitHubExternalWork(cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
  return daemonClient.pollGitHubExternalWork(cwd, input);
}

export async function pollLinearExternalWork(cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
  return daemonClient.pollLinearExternalWork(cwd, input);
}

export async function reconcileExternalWork(
  cwd: string,
  input: ExternalWorkReconcileRequest = {},
): Promise<ExternalWorkReconcileResponse> {
  return daemonClient.reconcileExternalWork(cwd, input);
}

export async function startGitHubExternalWorkBackground(
  cwd: string,
  input: ExternalWorkGitHubBackgroundStartRequest,
): Promise<ExternalWorkBackgroundMutationResponse> {
  return daemonClient.startGitHubExternalWorkBackground(cwd, input);
}

export async function stopExternalWorkBackground(
  cwd: string,
  schedulerId: string,
): Promise<ExternalWorkBackgroundMutationResponse> {
  return daemonClient.stopExternalWorkBackgroundScheduler(cwd, schedulerId);
}

export async function listGitHubExternalWorkCiTriage(
  cwd: string,
  options: ExternalWorkCiTriageListRequest = {},
): Promise<ExternalWorkCiTriageListResponse> {
  return daemonClient.listGitHubExternalWorkCiTriage(cwd, options);
}

export async function getGitHubExternalWorkCiTriage(cwd: string, triageId: string): Promise<ExternalWorkCiTriageDetailResponse> {
  return daemonClient.getGitHubExternalWorkCiTriage(cwd, triageId);
}

export async function getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse> {
  return daemonClient.getRunEvents(runId, cwd);
}

export async function listRunArtifacts(runId: string, cwd?: string): Promise<RunArtifactListResponse> {
  return daemonClient.listRunArtifacts(runId, cwd);
}

export async function listMediaJobs(cwd: string, limit = 100): Promise<MediaJobListResponse> {
  return daemonClient.listMediaJobs(cwd, limit);
}

export async function createMediaJob(cwd: string, form: MediaJobFormState): Promise<MediaJobMutationResponse> {
  return daemonClient.createMediaJob(cwd, mediaJobFormToPayload(form));
}

export async function runMediaJob(cwd: string, mediaJobId: string): Promise<MediaJobMutationResponse> {
  return daemonClient.runMediaJob(cwd, mediaJobId);
}

export async function listMediaJobArtifacts(mediaJobId: string, cwd?: string): Promise<MediaJobArtifactListResponse> {
  return daemonClient.listMediaJobArtifacts(mediaJobId, cwd);
}

export function artifactContentUrl(artifactId: string, cwd?: string): string {
  return daemonClient.artifactContentUrl(artifactId, cwd);
}

export async function cancelRun(cwd: string, runId: string): Promise<RunCancelResponse> {
  return daemonClient.cancelRun(cwd, runId);
}

export function buildRunRequest(form: RunFormState): unknown {
  if (form.providerPresetId) {
    return {
      cwd: form.cwd,
      task: {
        id: form.taskId,
        title: form.title,
        prompt: form.prompt,
        channelId: "workspace",
      },
      providerPresetId: form.providerPresetId,
      tools: form.tools.filter(isRunnerTool),
      permissionMode: form.permissionMode,
      thinkingLevel: "medium",
    };
  }

  return {
    cwd: form.cwd,
    task: {
      id: form.taskId,
      title: form.title,
      prompt: form.prompt,
      channelId: "workspace",
    },
    provider: {
      provider: form.provider,
      model: form.model,
      baseUrl: form.baseUrl || undefined,
      apiKey: form.apiKey || undefined,
      api: form.api || undefined,
      authHeader: true,
      input: ["text"],
    },
    tools: form.tools.filter(isRunnerTool),
    permissionMode: form.permissionMode,
    thinkingLevel: "medium",
  };
}

export function buildTaskRunRequest(
  workspaceCwd: string,
  task: Task,
  channel: Channel,
  providerPresetId: string,
  options: {
    readonly tools?: readonly ToolName[];
    readonly approvalProfile?: SkillApprovalProfile;
    readonly permissionMode?: RunFormState["permissionMode"];
  } = {},
): unknown {
  const fallbackTools: readonly ToolName[] = ["read", "grep", "find", "ls"];
  return {
    workspaceCwd,
    cwd: channel.boundPath || workspaceCwd,
    task: {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      channelId: task.channelId,
    },
    providerPresetId,
    tools: (options.tools && options.tools.length > 0 ? options.tools : channel.allowedTools.length > 0 ? channel.allowedTools : fallbackTools).filter(isRunnerTool),
    approvalProfile: options.approvalProfile,
    permissionMode: options.permissionMode,
    thinkingLevel: "medium",
  };
}

export function buildRerunRequest(run: RunSession): unknown {
  const snapshot = readRecord(run.requestSnapshot);
  const providerPresetId = run.providerPresetId ?? readOptionalString(snapshot, "providerPresetId");
  if (!providerPresetId) {
    throw new Error("This run cannot be rerun because it did not use a provider preset.");
  }

  return removeUndefined({
    workspaceCwd: readOptionalString(snapshot, "workspaceCwd") ?? run.cwd,
    cwd: readOptionalString(snapshot, "cwd") ?? run.cwd,
    task: readRunTask(run),
    providerPresetId,
    tools: readToolArray(snapshot, "tools"),
    permissionMode: readOptionalString(snapshot, "permissionMode"),
    thinkingLevel: readOptionalString(snapshot, "thinkingLevel") ?? "medium",
    systemPrompt: readOptionalString(snapshot, "systemPrompt"),
    appendSystemPrompt: readStringArray(snapshot, "appendSystemPrompt"),
    agentDir: readOptionalString(snapshot, "agentDir"),
  });
}

async function resolveApproval(
  cwd: string,
  approvalId: string,
  action: "approve" | "deny",
  reason?: string,
): Promise<ApprovalMutationResponse> {
  return action === "approve"
    ? daemonClient.approveApproval(cwd, approvalId, reason)
    : daemonClient.denyApproval(cwd, approvalId, reason);
}

function providerFormToPayload(form: ProviderFormState): ProviderMutationRequest {
  return {
    kind: form.kind,
    displayName: form.displayName,
    providerId: form.providerId,
    model: form.model,
    api: form.api,
    baseUrl: form.baseUrl || undefined,
    apiKeyRef: form.apiKeyRef || undefined,
    apiKey: form.apiKey.trim() || undefined,
    clearApiKey: form.clearApiKey || undefined,
    capabilities: splitCsv(form.capabilitiesText),
    input: splitCsv(form.inputText),
    enabled: form.enabled,
    authHeader: form.authHeader,
    reasoning: form.reasoning,
    contextWindow: form.contextWindow ? Number(form.contextWindow) : undefined,
    maxTokens: form.maxTokens ? Number(form.maxTokens) : undefined,
  };
}

function mcpServerFormToPayload(form: McpServerFormState): McpServerMutationRequest {
  const secretNames = [
    form.transportType === "streamable-http" ? form.headerName.trim() : "",
    form.transportType === "stdio" ? form.envName.trim() : "",
  ].filter(Boolean);
  const secrets = Object.fromEntries([
    form.transportType === "streamable-http" && form.headerName.trim() && form.headerValue.trim()
      ? [form.headerName.trim(), form.headerValue.trim()]
      : undefined,
    form.transportType === "stdio" && form.envName.trim() && form.envValue.trim()
      ? [form.envName.trim(), form.envValue.trim()]
      : undefined,
  ].filter((entry): entry is [string, string] => Boolean(entry)));

  return {
    id: form.serverId.trim() || undefined,
    displayName: form.displayName.trim(),
    transport: form.transportType === "stdio"
      ? {
        type: "stdio",
        command: form.command.trim(),
        args: splitShellishArgs(form.argsText),
        cwd: form.cwd.trim() || undefined,
        env: {},
        secretEnvNames: secretNames,
      }
      : {
        type: "streamable-http",
        url: form.url.trim(),
        headers: {},
        envHeaders: {},
        secretHeaderNames: secretNames,
      },
    enabled: form.enabled,
    required: form.required,
    startupTimeoutSec: form.startupTimeoutSec ? Number(form.startupTimeoutSec) : undefined,
    toolTimeoutSec: form.toolTimeoutSec ? Number(form.toolTimeoutSec) : undefined,
    secrets,
    clearSecretNames: form.clearSecretNames,
  };
}

function channelFormToPayload(form: ChannelFormState): CreateChannelRequest {
  return {
    name: form.name.trim(),
    status: form.status,
    boundPath: form.boundPath.trim() || undefined,
    defaultProviderPresetId: form.defaultProviderPresetId || undefined,
    defaultTeammateId: form.defaultTeammateId || undefined,
    allowedTools: form.allowedTools.filter(isRunnerTool),
    runtimePolicy: form.runtimePolicy,
  };
}

function channelFormToUpdatePayload(form: ChannelFormState): UpdateChannelRequest {
  return {
    name: form.name.trim(),
    status: form.status,
    boundPath: form.boundPath.trim() || null,
    defaultProviderPresetId: form.defaultProviderPresetId || null,
    defaultTeammateId: form.defaultTeammateId || null,
    allowedTools: form.allowedTools.filter(isRunnerTool),
    runtimePolicy: form.runtimePolicy,
  };
}

function taskEditFormToPayload(form: TaskEditFormState): UpdateTaskRequest {
  return {
    title: form.title,
    prompt: form.prompt,
    status: form.status,
  };
}

function mediaJobFormToPayload(form: MediaJobFormState): CreateMediaJobRequest {
  return {
    providerPresetId: form.providerPresetId,
    operation: form.operation,
    prompt: form.prompt,
    input: parseMediaInput(form.inputText),
  };
}

function parseMediaInput(inputText: string): Record<string, unknown> | undefined {
  const trimmed = inputText.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Media job input must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitShellishArgs(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("FileReader did not return a data URL"));
        return;
      }
      resolve(reader.result);
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Failed to read file")));
    reader.readAsDataURL(file);
  });
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

function isRunnerTool(tool: ToolName): tool is "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write" {
  return ["read", "grep", "find", "ls", "bash", "edit", "write"].includes(tool);
}

function readRunTask(run: RunSession): { readonly id: string; readonly title: string; readonly prompt: string; readonly channelId: string } {
  const task = readRecord(run.taskSnapshot);
  const prompt = readOptionalString(task, "prompt");
  if (!prompt) {
    throw new Error("This run cannot be rerun because its task snapshot has no prompt.");
  }

  return {
    id: readOptionalString(task, "id") ?? run.taskId,
    title: readOptionalString(task, "title") ?? run.taskId,
    prompt,
    channelId: readOptionalString(task, "channelId") ?? run.channelId ?? "workspace",
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const items = field.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function readToolArray(value: Record<string, unknown>, key: string): ToolName[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const tools = field.filter((item): item is ToolName => typeof item === "string" && isRunnerTool(item as ToolName));
  return tools.length > 0 ? tools : undefined;
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

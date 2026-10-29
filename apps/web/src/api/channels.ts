import type {
  ChannelBriefMutationResponse,
  ChannelBriefResponse,
  ChannelBranchListResponse,
  ChannelBranchMutationResponse,
  ChannelCollaborationProtocolMutationResponse,
  ChannelCollaborationProtocolDraftListResponse,
  ChannelCollaborationProtocolDraftMutationResponse,
  ChannelCollaborationProtocolResponse,
  ChannelContextSummaryListResponse,
  ChannelContextSummaryMutationResponse,
  ChannelContextSummaryTargetType,
  ChannelDecisionListResponse,
  ChannelDecisionMutationResponse,
  ChannelExecutionProposalListResponse,
  ChannelExecutionProposalMutationResponse,
  ChannelExecutionProposalWorkflowConfirmResponse,
  ChannelHandoffListResponse,
  ChannelHandoffMutationResponse,
  ChannelLinkPreviewListResponse,
  ChannelLinkPreviewMutationResponse,
  ChannelListResponse,
  ChannelConversationContextInspectResponse,
  ChannelConversationItemPageResponse,
  ChannelConversationTurnResponse,
  ChannelIntentDecisionListResponse,
  ChannelMessageRouteDecisionListResponse,
  ChannelMutationResponse,
  ChannelPlaybookCandidateListResponse,
  ChannelPlaybookCandidateMutationResponse,
  ChannelPlaybookCandidateReviewRequest,
  ChannelPlaybookCandidateStatus,
  ChannelProtocolCandidateListResponse,
  ChannelProtocolCandidateMutationResponse,
  ChannelProtocolCandidateReviewRequest,
  ChannelProtocolCanvasResponse,
  ChannelProtocolDraftStatus,
  ChannelTeamExpertsProjectionResponse,
  ChannelTeamMetricsProjectionResponse,
  ChannelWorkflowCancelResponse,
  ChannelWorkflowListResponse,
  ChannelWorkflowMutationResponse,
  ChannelWorkflowOrchestrationResponse,
  ChannelWorkflowStepListResponse,
  ChannelWorkflowStepMutationResponse,
  ChannelWorkflowStepRetryResponse,
  ChannelWorkflowStepStartResponse,
  ChannelWorkflowTemplateMutationResponse,
  ChannelWorkspaceCreateWorktreeRequest,
  ChannelWorkspaceGitStatusResponse,
  ChannelWorkspaceHandoffRequest,
  ChannelWorkspaceMutationResponse,
  ChannelWorkspaceResponse,
  ChannelCollaborationCardListResponse,
  WorkflowEvidenceResponse,
  WorkflowCollaborationCardResponse,
  CreateChannelBranchRequest,
  CreateChannelCollaborationProtocolDraftRequest,
  CreateChannelPlaybookCandidateFromClusterRequest,
  CreateChannelProtocolCandidateFromClusterRequest,
  CreateChannelContextSummaryRequest,
  CreateChannelDecisionRequest,
  CreateChannelExecutionProposalRequest,
  CreateChannelHandoffRequest,
  CreateChannelLinkPreviewRequest,
  CreateChannelTurnRequest,
  CreateTaskRequest,
  CreateChannelWorkflowFromHandoffRequest,
  CreateChannelWorkflowRequest,
  CreateChannelWorkflowStepRequest,
  CreateChannelWorkflowTemplateCompileRequest,
  StartChannelWorkflowStepRequest,
  ListChannelConversationItemsOptions,
  Task,
  TaskListResponse,
  TaskMutationResponse,
  TerminalReportListResponse,
  TerminalReportResponse,
  TerminalReportSourceKind,
  UpdateChannelBriefRequest,
  UpdateChannelBranchRequest,
  UpdateChannelCollaborationProtocolRequest,
  UpdateChannelContextSummaryRequest,
  UpdateChannelDecisionRequest,
  UpdateChannelExecutionProposalRequest,
  UpdateChannelHandoffRequest,
  UpdateChannelWorkflowRequest,
  UpdateChannelWorkflowStepRequest,
  UpdateChannelRequest,
  CorrectChannelTurnContextRequest,
  CorrectChannelTurnContextResponse,
} from "@ling-stack/contracts";
import type { ChannelFormState, TaskEditFormState } from "../types.js";
import { channelFormToPayload, channelFormToUpdatePayload, taskEditFormToPayload } from "./channel-payloads.js";
import { daemonClient } from "./client.js";

export async function listChannels(cwd: string, options: { readonly archived?: boolean; readonly limit?: number } = {}): Promise<ChannelListResponse> {
  return daemonClient.listChannels(cwd, options);
}

export async function createChannel(cwd: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  return daemonClient.createChannel(cwd, channelFormToPayload(form));
}

export async function updateChannel(cwd: string, channelId: string, form: ChannelFormState): Promise<ChannelMutationResponse> {
  return daemonClient.updateChannel(cwd, channelId, channelFormToUpdatePayload(form));
}

export async function patchChannel(cwd: string, channelId: string, input: UpdateChannelRequest): Promise<ChannelMutationResponse> {
  return daemonClient.updateChannel(cwd, channelId, input);
}

export async function listChannelBranches(
  cwd: string,
  channelId: string,
  options: { readonly archived?: boolean; readonly limit?: number } = {},
): Promise<ChannelBranchListResponse> {
  return daemonClient.listChannelBranches(cwd, channelId, options);
}

export async function createChannelBranch(
  cwd: string,
  channelId: string,
  input: CreateChannelBranchRequest,
): Promise<ChannelBranchMutationResponse> {
  return daemonClient.createChannelBranch(cwd, channelId, input);
}

export async function updateChannelBranch(
  cwd: string,
  channelId: string,
  branchId: string,
  input: UpdateChannelBranchRequest,
): Promise<ChannelBranchMutationResponse> {
  return daemonClient.updateChannelBranch(cwd, channelId, branchId, input);
}

export async function deleteChannelBranch(cwd: string, channelId: string, branchId: string): Promise<void> {
  await daemonClient.deleteChannelBranch(cwd, channelId, branchId);
}

export async function getChannelCollaborationProtocol(cwd: string, channelId: string): Promise<ChannelCollaborationProtocolResponse> {
  return daemonClient.getChannelCollaborationProtocol(cwd, channelId);
}

export async function updateChannelCollaborationProtocol(
  cwd: string,
  channelId: string,
  input: UpdateChannelCollaborationProtocolRequest,
): Promise<ChannelCollaborationProtocolMutationResponse> {
  return daemonClient.updateChannelCollaborationProtocol(cwd, channelId, input);
}

export async function listChannelCollaborationProtocolDrafts(
  cwd: string,
  channelId: string,
  options: { readonly status?: ChannelProtocolDraftStatus; readonly limit?: number } = {},
): Promise<ChannelCollaborationProtocolDraftListResponse> {
  return daemonClient.listChannelCollaborationProtocolDrafts(cwd, channelId, options);
}

export async function createChannelCollaborationProtocolDraft(
  cwd: string,
  channelId: string,
  input: CreateChannelCollaborationProtocolDraftRequest,
): Promise<ChannelCollaborationProtocolDraftMutationResponse> {
  return daemonClient.createChannelCollaborationProtocolDraft(cwd, channelId, input);
}

export async function createChannelProtocolCandidateFromCluster(
  cwd: string,
  channelId: string,
  clusterId: string,
  input: CreateChannelProtocolCandidateFromClusterRequest = {},
): Promise<ChannelProtocolCandidateMutationResponse> {
  return daemonClient.createChannelProtocolCandidateFromCluster(cwd, channelId, clusterId, input);
}

export async function listChannelPlaybookCandidates(
  cwd: string,
  channelId: string,
  options: { readonly status?: ChannelPlaybookCandidateStatus; readonly limit?: number } = {},
): Promise<ChannelPlaybookCandidateListResponse> {
  return daemonClient.listChannelPlaybookCandidates(cwd, channelId, options);
}

export async function createChannelPlaybookCandidateFromCluster(
  cwd: string,
  channelId: string,
  clusterId: string,
  input: CreateChannelPlaybookCandidateFromClusterRequest = {},
): Promise<ChannelPlaybookCandidateMutationResponse> {
  return daemonClient.createChannelPlaybookCandidateFromCluster(cwd, channelId, clusterId, input);
}

export async function reviewChannelPlaybookCandidate(
  cwd: string,
  channelId: string,
  candidateId: string,
  input: ChannelPlaybookCandidateReviewRequest,
): Promise<ChannelPlaybookCandidateMutationResponse> {
  return daemonClient.reviewChannelPlaybookCandidate(cwd, channelId, candidateId, input);
}

export async function applyChannelCollaborationProtocolDraft(
  cwd: string,
  channelId: string,
  draftId: string,
): Promise<ChannelCollaborationProtocolDraftMutationResponse> {
  return daemonClient.applyChannelCollaborationProtocolDraft(cwd, channelId, draftId);
}

export async function listChannelProtocolCandidates(
  cwd: string,
  channelId: string,
  options: { readonly status?: ChannelProtocolDraftStatus; readonly limit?: number } = {},
): Promise<ChannelProtocolCandidateListResponse> {
  return daemonClient.listChannelProtocolCandidates(cwd, channelId, options);
}

export async function getChannelProtocolCanvas(
  cwd: string,
  channelId: string,
  options: { readonly limit?: number } = {},
): Promise<ChannelProtocolCanvasResponse> {
  return daemonClient.getChannelProtocolCanvas(cwd, channelId, options);
}

export async function createChannelProtocolCandidate(
  cwd: string,
  channelId: string,
  input: CreateChannelCollaborationProtocolDraftRequest,
): Promise<ChannelProtocolCandidateMutationResponse> {
  return daemonClient.createChannelProtocolCandidate(cwd, channelId, input);
}

export async function reviewChannelProtocolCandidate(
  cwd: string,
  channelId: string,
  candidateId: string,
  input: ChannelProtocolCandidateReviewRequest,
): Promise<ChannelProtocolCandidateMutationResponse> {
  return daemonClient.reviewChannelProtocolCandidate(cwd, channelId, candidateId, input);
}

export async function revertChannelCollaborationProtocol(cwd: string, channelId: string): Promise<ChannelCollaborationProtocolMutationResponse> {
  return daemonClient.revertChannelCollaborationProtocol(cwd, channelId);
}

export async function deleteChannel(cwd: string, channelId: string): Promise<void> {
  await daemonClient.deleteChannel(cwd, channelId);
}

export async function getChannelWorkspace(cwd: string, channelId: string): Promise<ChannelWorkspaceResponse> {
  return daemonClient.getChannelWorkspace(cwd, channelId);
}

export async function getChannelWorkspaceGitStatus(cwd: string, channelId: string): Promise<ChannelWorkspaceGitStatusResponse> {
  return daemonClient.getChannelWorkspaceGitStatus(cwd, channelId);
}

export async function createChannelWorktree(
  cwd: string,
  channelId: string,
  input: ChannelWorkspaceCreateWorktreeRequest = {},
): Promise<ChannelWorkspaceMutationResponse> {
  return daemonClient.createChannelWorktree(cwd, channelId, input);
}

export async function handoffChannelWorkspace(
  cwd: string,
  channelId: string,
  input: ChannelWorkspaceHandoffRequest,
): Promise<ChannelWorkspaceMutationResponse> {
  return daemonClient.handoffChannelWorkspace(cwd, channelId, input);
}

export async function refreshChannelWorkspace(cwd: string, channelId: string): Promise<ChannelWorkspaceMutationResponse> {
  return daemonClient.refreshChannelWorkspace(cwd, channelId);
}

export async function openChannelWorkspace(cwd: string, channelId: string): Promise<ChannelWorkspaceResponse> {
  return daemonClient.openChannelWorkspace(cwd, channelId);
}

export async function listChannelConversationItems(
  cwd: string,
  channelId: string,
  options: ListChannelConversationItemsOptions = {},
): Promise<ChannelConversationItemPageResponse> {
  return daemonClient.listChannelConversationItems(cwd, channelId, options);
}

export async function createChannelTurn(
  cwd: string,
  channelId: string,
  input: CreateChannelTurnRequest,
): Promise<ChannelConversationTurnResponse> {
  return daemonClient.createChannelTurn(cwd, channelId, input);
}

export async function streamChannelTurn(
  cwd: string,
  channelId: string,
  input: CreateChannelTurnRequest,
): Promise<Response> {
  return daemonClient.streamChannelTurn(cwd, channelId, input);
}

export async function getChannelTurnContext(
  cwd: string,
  channelId: string,
  turnId: string,
): Promise<ChannelConversationContextInspectResponse> {
  return daemonClient.getChannelTurnContext(cwd, channelId, turnId);
}

export async function correctChannelTurnContext(
  cwd: string,
  channelId: string,
  turnId: string,
  input: CorrectChannelTurnContextRequest,
): Promise<CorrectChannelTurnContextResponse> {
  return daemonClient.correctChannelTurnContext(cwd, channelId, turnId, input);
}

export async function listChannelMessageRouteDecisions(
  cwd: string,
  channelId: string,
  options: { readonly sourceMessageId?: string; readonly status?: string; readonly limit?: number } = {},
): Promise<ChannelMessageRouteDecisionListResponse> {
  return daemonClient.listChannelMessageRouteDecisions(cwd, channelId, options);
}

export async function listChannelIntentDecisions(
  cwd: string,
  channelId: string,
  options: { readonly sourceItemId?: string; readonly action?: string; readonly status?: string; readonly limit?: number } = {},
): Promise<ChannelIntentDecisionListResponse> {
  return daemonClient.listChannelIntentDecisions(cwd, channelId, options);
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

export async function confirmChannelExecutionProposalWorkflow(
  cwd: string,
  proposalId: string,
): Promise<ChannelExecutionProposalWorkflowConfirmResponse> {
  return daemonClient.confirmChannelExecutionProposalWorkflow(cwd, proposalId);
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

export async function createChannelWorkflowFromTemplate(
  cwd: string,
  channelId: string,
  input: CreateChannelWorkflowTemplateCompileRequest,
): Promise<ChannelWorkflowTemplateMutationResponse> {
  return daemonClient.createChannelWorkflowFromTemplate(cwd, channelId, input);
}

export async function updateChannelWorkflow(
  cwd: string,
  workflowId: string,
  input: UpdateChannelWorkflowRequest,
): Promise<ChannelWorkflowMutationResponse> {
  return daemonClient.updateChannelWorkflow(cwd, workflowId, input);
}

export async function getChannelWorkflowEvidence(cwd: string, workflowId: string): Promise<WorkflowEvidenceResponse> {
  return daemonClient.getChannelWorkflowEvidence(cwd, workflowId);
}

export async function getChannelWorkflowCollaborationCard(cwd: string, workflowId: string): Promise<WorkflowCollaborationCardResponse> {
  return daemonClient.getChannelWorkflowCollaborationCard(cwd, workflowId);
}

export async function cancelChannelWorkflow(cwd: string, workflowId: string): Promise<ChannelWorkflowCancelResponse> {
  return daemonClient.cancelChannelWorkflow(cwd, workflowId);
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

export async function retryChannelWorkflowStep(cwd: string, workflowStepId: string): Promise<ChannelWorkflowStepRetryResponse> {
  return daemonClient.retryChannelWorkflowStep(cwd, workflowStepId);
}

export async function orchestrateChannelWorkflow(cwd: string, workflowId: string): Promise<ChannelWorkflowOrchestrationResponse> {
  return daemonClient.orchestrateChannelWorkflow(cwd, workflowId);
}

export async function listChannelCollaborationCards(
  cwd: string,
  channelId: string,
  options: { readonly limit?: number } = {},
): Promise<ChannelCollaborationCardListResponse> {
  return daemonClient.listChannelCollaborationCards(cwd, channelId, options);
}

export async function getChannelTeamExpertsProjection(
  cwd: string,
  channelId: string,
  turnId: string,
  options: { readonly includeExpired?: boolean; readonly limit?: number } = {},
): Promise<ChannelTeamExpertsProjectionResponse> {
  return daemonClient.getChannelTeamExpertsProjection(cwd, channelId, turnId, options);
}

export async function getChannelTeamMetricsProjection(
  cwd: string,
  channelId: string,
  options: { readonly limit?: number } = {},
): Promise<ChannelTeamMetricsProjectionResponse> {
  return daemonClient.getChannelTeamMetricsProjection(cwd, channelId, options);
}

export async function getTerminalReport(
  cwd: string,
  reportId: string,
): Promise<TerminalReportResponse> {
  return daemonClient.getTerminalReport(cwd, reportId);
}

export async function listTerminalReports(
  cwd: string,
  options: {
    readonly threadId?: string;
    readonly sourceKind?: TerminalReportSourceKind;
    readonly sourceId?: string;
    readonly includeHistory?: boolean;
    readonly limit?: number;
  } = {},
): Promise<TerminalReportListResponse> {
  return daemonClient.listTerminalReports(cwd, options);
}

export async function listChannelTerminalReports(
  cwd: string,
  channelId: string,
  options: {
    readonly threadId?: string;
    readonly sourceKind?: TerminalReportSourceKind;
    readonly sourceId?: string;
    readonly includeHistory?: boolean;
    readonly limit?: number;
  } = {},
): Promise<TerminalReportListResponse> {
  return daemonClient.listChannelTerminalReports(cwd, channelId, options);
}

export async function listTasks(cwd: string, channelId?: string): Promise<TaskListResponse> {
  return daemonClient.listTasks(cwd, { channelId });
}

export async function createTask(cwd: string, channelId: string, form: Omit<CreateTaskRequest, "channelId">): Promise<TaskMutationResponse> {
  return daemonClient.createTask(cwd, {
    channelId,
    title: form.title,
    prompt: form.prompt,
    assigneeTeammateId: form.assigneeTeammateId,
    requestedSkillId: form.requestedSkillId,
    attachmentIds: form.attachmentIds,
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

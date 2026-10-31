import type {
  ChannelSessionListResponse,
  ChannelSessionMutationResponse,
  CreateChannelSessionRequest,
  UpdateChannelSessionRequest,
  ListChannelSessionsOptions,
  ChannelAttachmentListResponse,
  ChannelAttachmentMutationResponse,
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
  ChannelDecisionStatus,
  ChannelExecutionProposalListResponse,
  ChannelExecutionProposalMutationResponse,
  ChannelExecutionProposalWorkflowConfirmResponse,
  ChannelHandoffListResponse,
  ChannelHandoffMutationResponse,
  ChannelHandoffStatus,
  ChannelLinkPreviewListResponse,
  ChannelLinkPreviewMutationResponse,
  ChannelListResponse,
  ChannelConversationContextInspectResponse,
  ChannelConversationItemPageResponse,
  ChannelConversationSurface,
  ChannelConversationTurnResponse,
  ChannelPlaybookCandidateListResponse,
  ChannelPlaybookCandidateMutationResponse,
  ChannelPlaybookCandidateReviewRequest,
  ChannelProtocolCandidateListResponse,
  ChannelProtocolCandidateMutationResponse,
  ChannelProtocolCandidateReviewRequest,
  ChannelProtocolCanvasResponse,
  ChannelProtocolDraftStatus,
  ChannelIntentDecisionListResponse,
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
  ChannelWorkspaceCreateWorktreeRequest,
  ChannelWorkspaceGitStatusResponse,
  ChannelWorkspaceHandoffRequest,
  ChannelWorkspaceMutationResponse,
  ChannelWorkspaceResponse,
  ChannelCollaborationCardListResponse,
  ChannelTeamAuthorityLedgerResponse,
  ChannelTeamExpertsProjectionResponse,
  ChannelTeamMetricsProjectionResponse,
  ChannelTeamPatternResponse,
  ChannelTeamPatternsResponse,
  ChannelTeamEvaluationRunResponse,
  ChannelTeamEvaluationRunsResponse,
  ChannelTeamSnapshotDiffResponse,
  ChannelTeamSnapshotResponse,
  ChannelTeamSnapshotsResponse,
  WorkflowEvidenceResponse,
  WorkflowWorkspaceChangesResponse,
  WorkflowCollaborationCardResponse,
  CreateChannelAttachmentRequest,
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
  CreateChannelRequest,
  CreateChannelTeamPatternRequest,
  CreateChannelTeamEvaluationRunRequest,
  CreateChannelTeamSnapshotRequest,
  CreateChannelWorkflowFromHandoffRequest,
  CreateChannelWorkflowTemplateCompileRequest,
  CreateChannelWorkflowRequest,
  CreateChannelWorkflowStepRequest,
  CreateAndRunTaskChannelWorkflowStepStartRequest,
  CreateTaskChannelWorkflowStepStartRequest,
  CorrectChannelTurnContextRequest,
  CorrectChannelTurnContextResponse,
  ListChannelConversationItemsOptions,
  PreviewContentResponse,
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
  ChannelWorkflowStepStartResponseContext,
} from "@ling-stack/contracts";
import { parseChannelWorkflowStepStartResponse } from "@ling-stack/contracts";
import { LingDaemonError } from "../errors.js";
import { readErrorMessage } from "../transport.js";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

function channelConversationSurfaceQuery(surface: ChannelConversationSurface | undefined): {
  readonly threadId?: string;
  readonly anchorItemId?: string;
} {
  if (!surface || surface.kind === "channel_root") {
    return {};
  }
  return surface.kind === "thread"
    ? { threadId: surface.threadId }
    : { anchorItemId: surface.anchorItemId };
}

export const channelEndpoints = {
  async listChannels(this: LingDaemonEndpointContext, cwd: string, options: { readonly archived?: boolean; readonly limit?: number } = {}): Promise<ChannelListResponse> {
      return this._get("/channels", { cwd, archived: options.archived, limit: options.limit });
    },

  async createChannel(this: LingDaemonEndpointContext, cwd: string, input: CreateChannelRequest): Promise<ChannelMutationResponse> {
      return this._post("/channels", { cwd }, input);
    },

  async updateChannel(this: LingDaemonEndpointContext, cwd: string, channelId: string, input: UpdateChannelRequest): Promise<ChannelMutationResponse> {
      return this._patch(`/channels/${encodeURIComponent(channelId)}`, { cwd }, input);
    },

  async listChannelSessions(this: LingDaemonEndpointContext, cwd: string, channelId: string,
      options: ListChannelSessionsOptions = {}): Promise<ChannelSessionListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/sessions`, { cwd, ...options });
    },

  async createChannelSession(this: LingDaemonEndpointContext, cwd: string, channelId: string,
      input: CreateChannelSessionRequest): Promise<ChannelSessionMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/sessions`, { cwd }, input);
    },

  async getChannelSession(this: LingDaemonEndpointContext, cwd: string, channelId: string,
      threadId: string): Promise<ChannelSessionMutationResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/sessions/${encodeURIComponent(threadId)}`, { cwd });
    },

  async updateChannelSession(this: LingDaemonEndpointContext, cwd: string, channelId: string,
      threadId: string, input: UpdateChannelSessionRequest): Promise<ChannelSessionMutationResponse> {
      return this._patch(`/channels/${encodeURIComponent(channelId)}/sessions/${encodeURIComponent(threadId)}`, { cwd }, input);
    },

  async listChannelBranches(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly archived?: boolean; readonly limit?: number } = {},
    ): Promise<ChannelBranchListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/branches`, { cwd, archived: options.archived, limit: options.limit });
    },

  async createChannelBranch(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelBranchRequest,
    ): Promise<ChannelBranchMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/branches`, { cwd }, input);
    },

  async updateChannelBranch(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      branchId: string,
      input: UpdateChannelBranchRequest,
    ): Promise<ChannelBranchMutationResponse> {
      return this._patch(`/channels/${encodeURIComponent(channelId)}/branches/${encodeURIComponent(branchId)}`, { cwd }, input);
    },

  async repairChannelBranch(this: LingDaemonEndpointContext, cwd: string, channelId: string, branchId: string): Promise<ChannelBranchMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/branches/${encodeURIComponent(branchId)}/repair`, { cwd }, {});
    },

  async deleteChannelBranch(this: LingDaemonEndpointContext, cwd: string, channelId: string, branchId: string): Promise<void> {
      await this._request("DELETE", `/channels/${encodeURIComponent(channelId)}/branches/${encodeURIComponent(branchId)}`, { cwd });
    },

  async getChannelCollaborationProtocol(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelCollaborationProtocolResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/protocol`, { cwd });
    },

  async updateChannelCollaborationProtocol(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: UpdateChannelCollaborationProtocolRequest,
    ): Promise<ChannelCollaborationProtocolMutationResponse> {
      return this._patch(`/channels/${encodeURIComponent(channelId)}/protocol`, { cwd }, input);
    },

  async listChannelCollaborationProtocolDrafts(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly status?: ChannelProtocolDraftStatus; readonly limit?: number } = {},
    ): Promise<ChannelCollaborationProtocolDraftListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/protocol/drafts`, { cwd, status: options.status, limit: options.limit });
    },

  async createChannelCollaborationProtocolDraft(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelCollaborationProtocolDraftRequest,
    ): Promise<ChannelCollaborationProtocolDraftMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/protocol/drafts`, { cwd }, input);
    },

  async applyChannelCollaborationProtocolDraft(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      draftId: string,
    ): Promise<ChannelCollaborationProtocolDraftMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/protocol/drafts/${encodeURIComponent(draftId)}/apply`, { cwd });
    },

  async listChannelProtocolCandidates(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly status?: ChannelProtocolDraftStatus; readonly limit?: number } = {},
    ): Promise<ChannelProtocolCandidateListResponse> {
    return this._get(`/channels/${encodeURIComponent(channelId)}/protocol-candidates`, { cwd, status: options.status, limit: options.limit });
  },

  async getChannelProtocolCanvas(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly limit?: number } = {},
    ): Promise<ChannelProtocolCanvasResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/protocol/canvas`, { cwd, limit: options.limit });
    },

  async createChannelProtocolCandidate(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelCollaborationProtocolDraftRequest,
    ): Promise<ChannelProtocolCandidateMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/protocol-candidates`, { cwd }, input);
    },

  async createChannelProtocolCandidateFromCluster(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      clusterId: string,
      input: CreateChannelProtocolCandidateFromClusterRequest = {},
    ): Promise<ChannelProtocolCandidateMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/protocol-candidates/from-cluster/${encodeURIComponent(clusterId)}`, { cwd }, input);
    },

  async reviewChannelProtocolCandidate(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      candidateId: string,
      input: ChannelProtocolCandidateReviewRequest,
    ): Promise<ChannelProtocolCandidateMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/protocol-candidates/${encodeURIComponent(candidateId)}/review`, { cwd }, input);
    },

  async listChannelPlaybookCandidates(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly status?: "draft" | "active" | "cancelled" | "stale"; readonly limit?: number } = {},
    ): Promise<ChannelPlaybookCandidateListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/playbook-candidates`, { cwd, status: options.status, limit: options.limit });
    },

  async createChannelPlaybookCandidateFromCluster(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      clusterId: string,
      input: CreateChannelPlaybookCandidateFromClusterRequest = {},
    ): Promise<ChannelPlaybookCandidateMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/playbook-candidates/from-cluster/${encodeURIComponent(clusterId)}`, { cwd }, input);
    },

  async reviewChannelPlaybookCandidate(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      candidateId: string,
      input: ChannelPlaybookCandidateReviewRequest,
    ): Promise<ChannelPlaybookCandidateMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/playbook-candidates/${encodeURIComponent(candidateId)}/review`, { cwd }, input);
    },

  async revertChannelCollaborationProtocol(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelCollaborationProtocolMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/protocol/revert`, { cwd });
    },

  async deleteChannel(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<void> {
      await this._request("DELETE", `/channels/${encodeURIComponent(channelId)}`, { cwd });
    },

  async getChannelWorkspace(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelWorkspaceResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/workspace`, { cwd });
    },

  async getChannelWorkspaceGitStatus(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelWorkspaceGitStatusResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/workspace/git-status`, { cwd });
    },

  async createChannelWorktree(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: ChannelWorkspaceCreateWorktreeRequest = {},
    ): Promise<ChannelWorkspaceMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/workspace/create-worktree`, { cwd }, input);
    },

  async handoffChannelWorkspace(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: ChannelWorkspaceHandoffRequest,
    ): Promise<ChannelWorkspaceMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/workspace/handoff`, { cwd }, input);
    },

  async refreshChannelWorkspace(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelWorkspaceMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/workspace/refresh`, { cwd });
    },

  async openChannelWorkspace(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelWorkspaceResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/workspace/open`, { cwd });
    },

  async cleanupChannelWorkspace(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelWorkspaceMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/workspace/cleanup`, { cwd });
    },

  async listChannelConversationItems(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: ListChannelConversationItemsOptions = {},
    ): Promise<ChannelConversationItemPageResponse> {
      const surfaceQuery = channelConversationSurfaceQuery(options.surface);
      return this._get(`/channels/${encodeURIComponent(channelId)}/items`, {
        cwd,
        limit: options.limit,
        beforeSequence: options.beforeSequence,
        ...surfaceQuery,
      });
    },

  async createChannelTurn(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelTurnRequest,
    ): Promise<ChannelConversationTurnResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/turns`, { cwd }, input);
    },

  async streamChannelTurn(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelTurnRequest,
    ): Promise<Response> {
      const response = await this._fetch(this._url(`/channels/${encodeURIComponent(channelId)}/turns/stream`, { cwd }), {
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
    },

  async getChannelTurnContext(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      turnId: string,
    ): Promise<ChannelConversationContextInspectResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/turns/${encodeURIComponent(turnId)}/context`, { cwd });
    },

  async correctChannelTurnContext(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      turnId: string,
      input: CorrectChannelTurnContextRequest,
    ): Promise<CorrectChannelTurnContextResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/turns/${encodeURIComponent(turnId)}/context/corrections`, { cwd }, input);
    },

  async listChannelMessageRouteDecisions(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly sourceMessageId?: string; readonly status?: string; readonly limit?: number } = {},
    ): Promise<ChannelMessageRouteDecisionListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/message-route-decisions`, {
        cwd,
        sourceMessageId: options.sourceMessageId,
        status: options.status,
        limit: options.limit,
      });
    },

  async listChannelIntentDecisions(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly sourceItemId?: string; readonly action?: string; readonly status?: string; readonly limit?: number } = {},
    ): Promise<ChannelIntentDecisionListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/intent-decisions`, {
        cwd,
        sourceItemId: options.sourceItemId,
        action: options.action,
        status: options.status,
        limit: options.limit,
      });
    },

  async listChannelExecutionProposals(this: LingDaemonEndpointContext, cwd: string, channelId: string, limit: number = 100): Promise<ChannelExecutionProposalListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/proposals`, { cwd, limit });
    },

  async createChannelExecutionProposal(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelExecutionProposalRequest,
    ): Promise<ChannelExecutionProposalMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/proposals`, { cwd }, input);
    },

  async updateChannelExecutionProposal(this: LingDaemonEndpointContext,
      cwd: string,
      proposalId: string,
      input: UpdateChannelExecutionProposalRequest,
    ): Promise<ChannelExecutionProposalMutationResponse> {
      return this._patch(`/channel-proposals/${encodeURIComponent(proposalId)}`, { cwd }, input);
    },

  async confirmChannelExecutionProposalWorkflow(this: LingDaemonEndpointContext,
      cwd: string,
      proposalId: string,
    ): Promise<ChannelExecutionProposalWorkflowConfirmResponse> {
      return this._post(`/channel-proposals/${encodeURIComponent(proposalId)}/confirm-workflow`, { cwd }, {});
    },

  async listChannelAttachments(this: LingDaemonEndpointContext, cwd: string, channelId: string, limit: number = 100): Promise<ChannelAttachmentListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/attachments`, { cwd, limit });
    },

  async createChannelAttachment(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelAttachmentRequest,
    ): Promise<ChannelAttachmentMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/attachments`, { cwd }, input);
    },

  async deleteChannelAttachment(this: LingDaemonEndpointContext, cwd: string, attachmentId: string): Promise<void> {
      await this._request("DELETE", `/attachments/${encodeURIComponent(attachmentId)}`, { cwd });
    },

  async previewAttachmentContent(this: LingDaemonEndpointContext,
      cwd: string,
      attachmentId: string,
      options: {
        readonly maxBytes?: number;
        readonly scope?: "channel" | "teammate_private" | "conversation";
        readonly channelId?: string;
        readonly teammateId?: string;
        readonly threadId?: string;
      } = {},
    ): Promise<PreviewContentResponse> {
      return this._get(`/attachments/${encodeURIComponent(attachmentId)}/preview`, {
        cwd,
        maxBytes: options.maxBytes,
        scope: options.scope,
        channelId: options.channelId,
        teammateId: options.teammateId,
        threadId: options.threadId,
      });
    },

  attachmentContentUrl(this: LingDaemonEndpointContext, attachmentId: string, cwd?: string): string {
      return this._url(`/attachments/${encodeURIComponent(attachmentId)}/content`, { cwd });
    },

  async listChannelLinkPreviews(this: LingDaemonEndpointContext, cwd: string, channelId: string, limit: number = 100): Promise<ChannelLinkPreviewListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/link-previews`, { cwd, limit });
    },

  async createChannelLinkPreview(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelLinkPreviewRequest,
    ): Promise<ChannelLinkPreviewMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/link-previews`, { cwd }, input);
    },

  async refreshChannelLinkPreview(this: LingDaemonEndpointContext, cwd: string, linkPreviewId: string): Promise<ChannelLinkPreviewMutationResponse> {
      return this._post(`/link-previews/${encodeURIComponent(linkPreviewId)}/refresh`, { cwd });
    },

  async getChannelBrief(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelBriefResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/brief`, { cwd });
    },

  async updateChannelBrief(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: UpdateChannelBriefRequest,
    ): Promise<ChannelBriefMutationResponse> {
      return this._patch(`/channels/${encodeURIComponent(channelId)}/brief`, { cwd }, input);
    },

  async listChannelDecisions(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly status?: ChannelDecisionStatus; readonly limit?: number } = {},
    ): Promise<ChannelDecisionListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/decisions`, {
        cwd,
        status: options.status,
        limit: options.limit,
      });
    },

  async createChannelDecision(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelDecisionRequest,
    ): Promise<ChannelDecisionMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/decisions`, { cwd }, input);
    },

  async updateChannelDecision(this: LingDaemonEndpointContext,
      cwd: string,
      decisionId: string,
      input: UpdateChannelDecisionRequest,
    ): Promise<ChannelDecisionMutationResponse> {
      return this._patch(`/decisions/${encodeURIComponent(decisionId)}`, { cwd }, input);
    },

  async listChannelHandoffs(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly status?: ChannelHandoffStatus; readonly limit?: number } = {},
    ): Promise<ChannelHandoffListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/handoffs`, {
        cwd,
        status: options.status,
        limit: options.limit,
      });
    },

  async createChannelHandoff(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelHandoffRequest,
    ): Promise<ChannelHandoffMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/handoffs`, { cwd }, input);
    },

  async updateChannelHandoff(this: LingDaemonEndpointContext,
      cwd: string,
      handoffId: string,
      input: UpdateChannelHandoffRequest,
    ): Promise<ChannelHandoffMutationResponse> {
      return this._patch(`/handoffs/${encodeURIComponent(handoffId)}`, { cwd }, input);
    },

  async listChannelContextSummaries(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly targetType?: ChannelContextSummaryTargetType; readonly targetId?: string; readonly limit?: number } = {},
    ): Promise<ChannelContextSummaryListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/context-summaries`, {
        cwd,
        targetType: options.targetType,
        targetId: options.targetId,
        limit: options.limit,
      });
    },

  async createChannelContextSummary(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelContextSummaryRequest,
    ): Promise<ChannelContextSummaryMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/context-summaries`, { cwd }, input);
    },

  async updateChannelContextSummary(this: LingDaemonEndpointContext,
      cwd: string,
      contextSummaryId: string,
      input: UpdateChannelContextSummaryRequest,
    ): Promise<ChannelContextSummaryMutationResponse> {
      return this._patch(`/context-summaries/${encodeURIComponent(contextSummaryId)}`, { cwd }, input);
    },

  async listChannelWorkflows(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly status?: ChannelWorkflowStatus; readonly limit?: number } = {},
    ): Promise<ChannelWorkflowListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/workflows`, {
        cwd,
        status: options.status,
        limit: options.limit,
      });
    },

  async createChannelWorkflow(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelWorkflowRequest,
    ): Promise<ChannelWorkflowMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/workflows`, { cwd }, input);
    },

  async createChannelWorkflowFromTemplate(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelWorkflowTemplateCompileRequest,
    ): Promise<ChannelWorkflowTemplateMutationResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/workflows`, { cwd }, input);
    },

  async getChannelWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<ChannelWorkflowMutationResponse> {
      return this._get(`/workflows/${encodeURIComponent(workflowId)}`, { cwd });
    },

  async getWorkflowWorkspaceChanges(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<WorkflowWorkspaceChangesResponse> {
      return this._get(`/workflows/${encodeURIComponent(workflowId)}/workspace-changes`, { cwd });
    },

  async undoWorkflowWorkspaceChanges(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<WorkflowWorkspaceChangesResponse> {
      return this._post(`/workflows/${encodeURIComponent(workflowId)}/workspace-changes/undo`, { cwd }, {});
    },

  async reapplyWorkflowWorkspaceChanges(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<WorkflowWorkspaceChangesResponse> {
      return this._post(`/workflows/${encodeURIComponent(workflowId)}/workspace-changes/reapply`, { cwd }, {});
    },

  async getChannelWorkflowEvidence(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<WorkflowEvidenceResponse> {
      return this._get(`/workflows/${encodeURIComponent(workflowId)}/evidence`, { cwd });
    },

  async getChannelWorkflowCollaborationCard(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<WorkflowCollaborationCardResponse> {
      return this._get(`/workflows/${encodeURIComponent(workflowId)}/collaboration-card`, { cwd });
    },

  async getChannelTeamExpertsProjection(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      turnId: string,
      options: { readonly includeExpired?: boolean; readonly limit?: number } = {},
    ): Promise<ChannelTeamExpertsProjectionResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/team-experts`, { cwd, turnId, includeExpired: options.includeExpired, limit: options.limit });
    },

  async getChannelTeamMetricsProjection(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly limit?: number } = {},
    ): Promise<ChannelTeamMetricsProjectionResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/team-metrics`, { cwd, limit: options.limit });
    },

  async getChannelTeamAuthorityLedger(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly limit?: number } = {},
    ): Promise<ChannelTeamAuthorityLedgerResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/team-authority-ledger`, { cwd, limit: options.limit });
    },

  async listChannelTeamPatterns(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly status?: string; readonly includeExpired?: boolean; readonly limit?: number } = {},
    ): Promise<ChannelTeamPatternsResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/team-patterns`, {
        cwd,
        status: options.status,
        includeExpired: options.includeExpired,
        limit: options.limit,
      });
    },

  async createChannelTeamPattern(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelTeamPatternRequest,
    ): Promise<ChannelTeamPatternResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/team-patterns`, { cwd }, input);
    },

  async listChannelTeamSnapshots(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly limit?: number } = {},
    ): Promise<ChannelTeamSnapshotsResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/team-snapshots`, { cwd, limit: options.limit });
    },

  async createChannelTeamSnapshot(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelTeamSnapshotRequest,
    ): Promise<ChannelTeamSnapshotResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/team-snapshots`, { cwd }, input);
    },

  async diffChannelTeamSnapshots(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      baseSnapshotId: string,
      targetSnapshotId: string,
    ): Promise<ChannelTeamSnapshotDiffResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/team-snapshots`, {
        cwd,
        baseSnapshotId,
        targetSnapshotId,
      });
    },

  async listChannelTeamEvaluations(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly limit?: number } = {},
    ): Promise<ChannelTeamEvaluationRunsResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/team-evaluations`, { cwd, limit: options.limit });
    },

  async createChannelTeamEvaluation(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      input: CreateChannelTeamEvaluationRunRequest,
    ): Promise<ChannelTeamEvaluationRunResponse> {
      return this._post(`/channels/${encodeURIComponent(channelId)}/team-evaluations`, { cwd }, input);
    },

  async updateChannelWorkflow(this: LingDaemonEndpointContext,
      cwd: string,
      workflowId: string,
      input: UpdateChannelWorkflowRequest,
    ): Promise<ChannelWorkflowMutationResponse> {
      return this._patch(`/workflows/${encodeURIComponent(workflowId)}`, { cwd }, input);
    },

  async cancelChannelWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<ChannelWorkflowCancelResponse> {
      return this._post(`/workflows/${encodeURIComponent(workflowId)}/cancel`, { cwd }, {});
    },

  async createChannelWorkflowFromHandoff(this: LingDaemonEndpointContext,
      cwd: string,
      handoffId: string,
      input: CreateChannelWorkflowFromHandoffRequest,
    ): Promise<ChannelWorkflowMutationResponse> {
      return this._post(`/handoffs/${encodeURIComponent(handoffId)}/workflow`, { cwd }, input);
    },

  async listChannelWorkflowSteps(this: LingDaemonEndpointContext,
      cwd: string,
      workflowId: string,
      options: { readonly status?: ChannelWorkflowStepStatus; readonly limit?: number } = {},
    ): Promise<ChannelWorkflowStepListResponse> {
      return this._get(`/workflows/${encodeURIComponent(workflowId)}/steps`, {
        cwd,
        status: options.status,
        limit: options.limit,
      });
    },

  async createChannelWorkflowStep(this: LingDaemonEndpointContext,
      cwd: string,
      workflowId: string,
      input: CreateChannelWorkflowStepRequest,
    ): Promise<ChannelWorkflowStepMutationResponse> {
      return this._post(`/workflows/${encodeURIComponent(workflowId)}/steps`, { cwd }, input);
    },

  async updateChannelWorkflowStep(this: LingDaemonEndpointContext,
      cwd: string,
      workflowStepId: string,
      input: UpdateChannelWorkflowStepRequest,
    ): Promise<ChannelWorkflowStepMutationResponse> {
      return this._patch(`/workflow-steps/${encodeURIComponent(workflowStepId)}`, { cwd }, input);
    },

  async startChannelWorkflowStep(this: LingDaemonEndpointContext,
      cwd: string,
      workflowStepId: string,
      input: CreateTaskChannelWorkflowStepStartRequest,
      expected: Omit<ChannelWorkflowStepStartResponseContext, "mode">,
    ): Promise<ChannelWorkflowStepStartResponse> {
      if ((input as { readonly mode?: unknown }).mode !== "create_task") {
        throw new TypeError("startChannelWorkflowStep only accepts create_task; use streamChannelWorkflowStep for create_and_run_task.");
      }
      if (expected.workflowStep.id !== workflowStepId) {
        throw new TypeError("Workflow step start path does not match the frozen expected workflow step.");
      }
      const value = await this._post<unknown>(`/workflow-steps/${encodeURIComponent(workflowStepId)}/start`, { cwd }, input);
      const parsed = parseChannelWorkflowStepStartResponse(value, {
        ...expected,
        mode: input.mode,
      });
      if (!parsed) throw new Error("Workflow step start returned an invalid response or foreign lineage.");
      return parsed;
    },

  async streamChannelWorkflowStep(this: LingDaemonEndpointContext,
      cwd: string,
      workflowStepId: string,
      input: CreateAndRunTaskChannelWorkflowStepStartRequest,
    ): Promise<Response> {
      if ((input as { readonly mode?: unknown }).mode !== "create_and_run_task") {
        throw new TypeError("streamChannelWorkflowStep only accepts create_and_run_task; use startChannelWorkflowStep for create_task.");
      }
      const response = await this._fetch(this._url(`/workflow-steps/${encodeURIComponent(workflowStepId)}/start`, { cwd }), {
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
    },

  async retryChannelWorkflowStep(this: LingDaemonEndpointContext, cwd: string, workflowStepId: string): Promise<ChannelWorkflowStepRetryResponse> {
      return this._post(`/workflow-steps/${encodeURIComponent(workflowStepId)}/retry`, { cwd }, {});
    },

  async orchestrateChannelWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowId: string): Promise<ChannelWorkflowOrchestrationResponse> {
      return this._post(`/workflows/${encodeURIComponent(workflowId)}/orchestrate`, { cwd }, {});
    },

  async listChannelCollaborationCards(this: LingDaemonEndpointContext,
      cwd: string,
      channelId: string,
      options: { readonly limit?: number } = {},
    ): Promise<ChannelCollaborationCardListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/collaboration-cards`, {
        cwd,
        limit: options.limit,
      });
    },
};

export type ChannelEndpoints = PublicEndpointGroup<typeof channelEndpoints>;

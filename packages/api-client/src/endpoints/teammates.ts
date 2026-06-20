import type {
  AiTeammateListResponse,
  AiTeammateMutationResponse,
  CreateAiTeammateRequest,
  CancelTeammateDirectReplyInterventionRequest,
  CancelTeammateDirectReplyRequest,
  CreateTeammateDirectReplyInterventionRequest,
  CreateTeammateDirectLinkPreviewRequest,
  CreateTeammateDirectMessageRequest,
  PromoteTeammateDirectReplyInterventionRequest,
  CreateTeammatePrivateAttachmentRequest,
  HardDeleteAiTeammateRequest,
  HardDeleteAiTeammateResponse,
  TaskListResponse,
  ReplaceTeammateChannelMembershipRequest,
  ReplaceTeammateMemoryScopesRequest,
  ReplaceTeammateMcpBindingsRequest,
  ReplaceTeammateSkillBindingsRequest,
  TeammateActivityListResponse,
  TeammateChannelMembershipListResponse,
  TeammateDirectMessageListResponse,
  TeammateDirectMessageMutationResponse,
  TeammateDirectInterventionListResponse,
  TeammateDirectInterventionResponse,
  TeammateDirectLinkPreviewListResponse,
  TeammateDirectLinkPreviewMutationResponse,
  TeammateDirectReplyCancelResponse,
  TeammateDirectRuntimeResponse,
  TeammateDirectThreadResponse,
  DirectWorkspaceCreateWorktreeRequest,
  DirectWorkspaceHandoffRequest,
  DirectWorkspaceMutationResponse,
  DirectWorkspaceResponse,
  TeammatePrivateAttachmentListResponse,
  TeammatePrivateAttachmentMutationResponse,
  TeammateMcpBindingListResponse,
  TeammateMemoryScopeListResponse,
  TeammatePersonaDraftRequest,
  TeammatePersonaDraftResponse,
  TeammateSkillBindingListResponse,
  UpdateAiTeammateRequest,
} from "@ling-stack/contracts";
import { LingDaemonError } from "../errors.js";
import { readErrorMessage } from "../transport.js";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const teammateEndpoints = {
  async listAiTeammates(this: LingDaemonEndpointContext,
      cwd: string,
      options: { readonly includeHidden?: boolean; readonly includeDisabled?: boolean; readonly limit?: number } = {},
    ): Promise<AiTeammateListResponse> {
      return this._get("/teammates", { cwd, ...options });
    },

  async createAiTeammate(this: LingDaemonEndpointContext, cwd: string, input: CreateAiTeammateRequest): Promise<AiTeammateMutationResponse> {
      return this._post("/teammates", { cwd }, input);
    },

  async getAiTeammate(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}`, { cwd });
    },

  async updateAiTeammate(this: LingDaemonEndpointContext, cwd: string, teammateId: string, input: UpdateAiTeammateRequest): Promise<AiTeammateMutationResponse> {
      return this._patch(`/teammates/${encodeURIComponent(teammateId)}`, { cwd }, input);
    },

  async disableAiTeammate(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
      return this._request("DELETE", `/teammates/${encodeURIComponent(teammateId)}`, { cwd });
    },

  async hardDeleteAiTeammate(this: LingDaemonEndpointContext, cwd: string, teammateId: string, input: HardDeleteAiTeammateRequest = {}): Promise<HardDeleteAiTeammateResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/hard-delete`, { cwd }, input);
    },

  async listTeammateChannels(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<TeammateChannelMembershipListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/channels`, { cwd });
    },

  async replaceTeammateChannels(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: ReplaceTeammateChannelMembershipRequest,
    ): Promise<TeammateChannelMembershipListResponse> {
      return this._put(`/teammates/${encodeURIComponent(teammateId)}/channels`, { cwd }, input);
    },

  async listTeammateSkills(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<TeammateSkillBindingListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/skills`, { cwd });
    },

  async replaceTeammateSkills(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: ReplaceTeammateSkillBindingsRequest,
    ): Promise<TeammateSkillBindingListResponse> {
      return this._put(`/teammates/${encodeURIComponent(teammateId)}/skills`, { cwd }, input);
    },

  async listTeammateMcpBindings(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<TeammateMcpBindingListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/mcp`, { cwd });
    },

  async replaceTeammateMcpBindings(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: ReplaceTeammateMcpBindingsRequest,
    ): Promise<TeammateMcpBindingListResponse> {
      return this._put(`/teammates/${encodeURIComponent(teammateId)}/mcp`, { cwd }, input);
    },

  async listTeammateMemoryScopes(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<TeammateMemoryScopeListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/memory-scopes`, { cwd });
    },

  async replaceTeammateMemoryScopes(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: ReplaceTeammateMemoryScopesRequest,
    ): Promise<TeammateMemoryScopeListResponse> {
      return this._put(`/teammates/${encodeURIComponent(teammateId)}/memory-scopes`, { cwd }, input);
    },

  async createTeammatePersonaDraft(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: TeammatePersonaDraftRequest,
    ): Promise<TeammatePersonaDraftResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/persona-draft`, { cwd }, input);
    },

  async getTeammateDirectThread(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<TeammateDirectThreadResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/direct-thread`, { cwd });
    },

  async getTeammateDirectWorkspace(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<DirectWorkspaceResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/direct-workspace`, { cwd });
    },

  async createTeammateDirectWorktree(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: DirectWorkspaceCreateWorktreeRequest = {},
    ): Promise<DirectWorkspaceMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-workspace/create-worktree`, { cwd }, input);
    },

  async handoffTeammateDirectWorkspace(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: DirectWorkspaceHandoffRequest,
    ): Promise<DirectWorkspaceMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-workspace/handoff`, { cwd }, input);
    },

  async refreshTeammateDirectWorkspace(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<DirectWorkspaceMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-workspace/refresh`, { cwd });
    },

  async cleanupTeammateDirectWorkspace(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<DirectWorkspaceMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-workspace/cleanup`, { cwd });
    },

  async listTeammateDirectMessages(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      options: { readonly limit?: number; readonly beforeMessageId?: string } = {},
    ): Promise<TeammateDirectMessageListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/direct-messages`, {
        cwd,
        limit: options.limit,
        beforeMessageId: options.beforeMessageId,
      });
    },

  async listTeammateDirectLinkPreviews(this: LingDaemonEndpointContext, cwd: string, teammateId: string, limit: number = 100): Promise<TeammateDirectLinkPreviewListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/direct-link-previews`, { cwd, limit });
    },

  async createTeammateDirectLinkPreview(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: CreateTeammateDirectLinkPreviewRequest,
    ): Promise<TeammateDirectLinkPreviewMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-link-previews`, { cwd }, input);
    },

  async createTeammateDirectMessage(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: CreateTeammateDirectMessageRequest,
    ): Promise<TeammateDirectMessageMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-messages`, { cwd }, input);
    },

  async getTeammateDirectRuntime(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<TeammateDirectRuntimeResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/direct-runtime`, { cwd });
    },

  async listTeammateDirectInterventions(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<TeammateDirectInterventionListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/direct-interventions`, { cwd });
    },

  async createTeammateDirectIntervention(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: CreateTeammateDirectReplyInterventionRequest,
    ): Promise<TeammateDirectInterventionResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-interventions`, { cwd }, input);
    },

  async cancelTeammateDirectIntervention(this: LingDaemonEndpointContext,
      cwd: string,
      interventionId: string,
      input: CancelTeammateDirectReplyInterventionRequest = {},
    ): Promise<TeammateDirectInterventionResponse> {
      return this._post(`/teammate-direct-interventions/${encodeURIComponent(interventionId)}/cancel`, { cwd }, input);
    },

  async promoteTeammateDirectIntervention(this: LingDaemonEndpointContext,
      cwd: string,
      interventionId: string,
      input: PromoteTeammateDirectReplyInterventionRequest = {},
    ): Promise<TeammateDirectInterventionResponse> {
      return this._post(`/teammate-direct-interventions/${encodeURIComponent(interventionId)}/promote`, { cwd }, input);
    },

  async cancelTeammateDirectReply(this: LingDaemonEndpointContext,
      cwd: string,
      workUnitId: string,
      input: CancelTeammateDirectReplyRequest = {},
    ): Promise<TeammateDirectReplyCancelResponse> {
      return this._post(`/teammate-direct-replies/${encodeURIComponent(workUnitId)}/cancel`, { cwd }, input);
    },

  async streamTeammateDirectMessage(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: CreateTeammateDirectMessageRequest,
    ): Promise<Response> {
      const response = await this._fetch(this._url(`/teammates/${encodeURIComponent(teammateId)}/direct-messages/stream`, { cwd }), {
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

  async listTeammatePrivateAttachments(this: LingDaemonEndpointContext, cwd: string, teammateId: string, limit: number = 100): Promise<TeammatePrivateAttachmentListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/direct-attachments`, { cwd, limit });
    },

  async createTeammatePrivateAttachment(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: CreateTeammatePrivateAttachmentRequest,
    ): Promise<TeammatePrivateAttachmentMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/direct-attachments`, { cwd }, input);
    },

  async uploadTeammateAvatar(this: LingDaemonEndpointContext,
      cwd: string,
      teammateId: string,
      input: CreateTeammatePrivateAttachmentRequest,
    ): Promise<AiTeammateMutationResponse & TeammatePrivateAttachmentMutationResponse> {
      return this._post(`/teammates/${encodeURIComponent(teammateId)}/avatar`, { cwd }, input);
    },

  async deleteTeammateAvatar(this: LingDaemonEndpointContext, cwd: string, teammateId: string): Promise<AiTeammateMutationResponse> {
      return this._requestJson("DELETE", `/teammates/${encodeURIComponent(teammateId)}/avatar`, { cwd });
    },

  async listTeammateTasks(this: LingDaemonEndpointContext, cwd: string, teammateId: string, limit: number = 100): Promise<TaskListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/tasks`, { cwd, limit });
    },

  async listTeammateActivity(this: LingDaemonEndpointContext, cwd: string, teammateId: string, limit: number = 100): Promise<TeammateActivityListResponse> {
      return this._get(`/teammates/${encodeURIComponent(teammateId)}/activity`, { cwd, limit });
    },
};

export type TeammateEndpoints = PublicEndpointGroup<typeof teammateEndpoints>;

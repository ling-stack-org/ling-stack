import type {
  AiCouncilListResponse,
  AiCouncilMemberListResponse,
  AiCouncilResponse,
  ChannelCouncilPolicyResponse,
  EffectiveChannelCouncilResponse,
  ReplaceAiCouncilMembersRequest,
  UpdateChannelCouncilPolicyRequest,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const aiCouncilEndpoints = {
  async listAiCouncils(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: { readonly includeArchived?: boolean; readonly limit?: number } = {},
  ): Promise<AiCouncilListResponse> {
    return this._get("/ai-councils", { cwd, includeArchived: options.includeArchived, limit: options.limit });
  },

  async getAiCouncil(this: LingDaemonEndpointContext, cwd: string, councilId: string): Promise<AiCouncilResponse> {
    return this._get(`/ai-councils/${encodeURIComponent(councilId)}`, { cwd });
  },

  async listAiCouncilMembers(this: LingDaemonEndpointContext, cwd: string, councilId: string): Promise<AiCouncilMemberListResponse> {
    return this._get(`/ai-councils/${encodeURIComponent(councilId)}/members`, { cwd });
  },

  async replaceAiCouncilMembers(
    this: LingDaemonEndpointContext,
    cwd: string,
    councilId: string,
    input: ReplaceAiCouncilMembersRequest,
  ): Promise<AiCouncilMemberListResponse> {
    return this._put(`/ai-councils/${encodeURIComponent(councilId)}/members`, { cwd }, input);
  },

  async getChannelCouncilPolicy(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<ChannelCouncilPolicyResponse> {
    return this._get(`/channels/${encodeURIComponent(channelId)}/council-policy`, { cwd });
  },

  async updateChannelCouncilPolicy(
    this: LingDaemonEndpointContext,
    cwd: string,
    channelId: string,
    input: UpdateChannelCouncilPolicyRequest,
  ): Promise<ChannelCouncilPolicyResponse> {
    return this._put(`/channels/${encodeURIComponent(channelId)}/council-policy`, { cwd }, input);
  },

  async getChannelEffectiveCouncil(this: LingDaemonEndpointContext, cwd: string, channelId: string): Promise<EffectiveChannelCouncilResponse> {
    return this._get(`/channels/${encodeURIComponent(channelId)}/effective-council`, { cwd });
  },
};

export type AiCouncilEndpoints = PublicEndpointGroup<typeof aiCouncilEndpoints>;

import type {
  AiCouncilHealthResponse,
  AiCouncilListResponse,
  AiCouncilMemberListResponse,
  AiCouncilResponse,
  ChannelCouncilPolicyResponse,
  CloneAiCouncilRequest,
  CreateAiCouncilRequest,
  EffectiveChannelCouncilResponse,
  ReplaceAiCouncilMembersRequest,
  UpdateAiCouncilRequest,
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

  async createAiCouncil(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: CreateAiCouncilRequest,
  ): Promise<AiCouncilResponse> {
    return this._post("/ai-councils", { cwd }, input);
  },

  async cloneAiCouncil(
    this: LingDaemonEndpointContext,
    cwd: string,
    councilId: string,
    input: CloneAiCouncilRequest,
  ): Promise<AiCouncilResponse> {
    return this._post(`/ai-councils/${encodeURIComponent(councilId)}/clone`, { cwd }, input);
  },

  async updateAiCouncil(
    this: LingDaemonEndpointContext,
    cwd: string,
    councilId: string,
    input: UpdateAiCouncilRequest,
  ): Promise<AiCouncilResponse> {
    return this._patch(`/ai-councils/${encodeURIComponent(councilId)}`, { cwd }, input);
  },

  async getAiCouncilHealth(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: { readonly limit?: number } = {},
  ): Promise<AiCouncilHealthResponse> {
    return this._get("/ai-councils/health", { cwd, limit: options.limit });
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

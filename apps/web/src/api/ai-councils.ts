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
import { daemonClient } from "./client.js";

export async function listAiCouncils(
  cwd: string,
  options: { readonly includeArchived?: boolean; readonly limit?: number } = {},
): Promise<AiCouncilListResponse> {
  return daemonClient.listAiCouncils(cwd, options);
}

export async function getAiCouncil(cwd: string, councilId: string): Promise<AiCouncilResponse> {
  return daemonClient.getAiCouncil(cwd, councilId);
}

export async function createAiCouncil(cwd: string, input: CreateAiCouncilRequest): Promise<AiCouncilResponse> {
  return daemonClient.createAiCouncil(cwd, input);
}

export async function cloneAiCouncil(cwd: string, councilId: string, input: CloneAiCouncilRequest): Promise<AiCouncilResponse> {
  return daemonClient.cloneAiCouncil(cwd, councilId, input);
}

export async function updateAiCouncil(cwd: string, councilId: string, input: UpdateAiCouncilRequest): Promise<AiCouncilResponse> {
  return daemonClient.updateAiCouncil(cwd, councilId, input);
}

export async function getAiCouncilHealth(
  cwd: string,
  options: { readonly limit?: number } = {},
): Promise<AiCouncilHealthResponse> {
  return daemonClient.getAiCouncilHealth(cwd, options);
}

export async function listAiCouncilMembers(cwd: string, councilId: string): Promise<AiCouncilMemberListResponse> {
  return daemonClient.listAiCouncilMembers(cwd, councilId);
}

export async function replaceAiCouncilMembers(
  cwd: string,
  councilId: string,
  input: ReplaceAiCouncilMembersRequest,
): Promise<AiCouncilMemberListResponse> {
  return daemonClient.replaceAiCouncilMembers(cwd, councilId, input);
}

export async function getChannelCouncilPolicy(cwd: string, channelId: string): Promise<ChannelCouncilPolicyResponse> {
  return daemonClient.getChannelCouncilPolicy(cwd, channelId);
}

export async function updateChannelCouncilPolicy(
  cwd: string,
  channelId: string,
  input: UpdateChannelCouncilPolicyRequest,
): Promise<ChannelCouncilPolicyResponse> {
  return daemonClient.updateChannelCouncilPolicy(cwd, channelId, input);
}

export async function getChannelEffectiveCouncil(cwd: string, channelId: string): Promise<EffectiveChannelCouncilResponse> {
  return daemonClient.getChannelEffectiveCouncil(cwd, channelId);
}

import type {
  AiCouncilListResponse,
  AiCouncilMemberListResponse,
  AiCouncilResponse,
  ChannelCouncilPolicyResponse,
  EffectiveChannelCouncilResponse,
  ReplaceAiCouncilMembersRequest,
  UpdateChannelCouncilPolicyRequest,
} from "../types.js";
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

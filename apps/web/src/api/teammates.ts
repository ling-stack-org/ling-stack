import type {
  AiTeammateListResponse,
  AiTeammateMutationResponse,
  CancelTeammateDirectReplyInterventionRequest,
  CancelTeammateDirectReplyRequest,
  CreateAiTeammateRequest,
  CreateTeammateDirectMessageRequest,
  CreateTeammateDirectReplyInterventionRequest,
  HardDeleteAiTeammateResponse,
  ReplaceTeammateChannelMembershipRequest,
  ReplaceTeammateMcpBindingsRequest,
  ReplaceTeammateMemoryScopesRequest,
  ReplaceTeammateSkillBindingsRequest,
  TaskListResponse,
  TeammateActivityListResponse,
  TeammateChannelMembershipListResponse,
  TeammateDirectMessageListResponse,
  TeammateDirectMessageMutationResponse,
  TeammateDirectInterventionListResponse,
  TeammateDirectInterventionResponse,
  TeammateDirectReplyCancelResponse,
  TeammateDirectRuntimeResponse,
  TeammateDirectThreadResponse,
  TeammateMcpBindingListResponse,
  TeammateMemoryScopeListResponse,
  TeammatePersonaDraftRequest,
  TeammatePersonaDraftResponse,
  TeammatePrivateAttachmentListResponse,
  TeammatePrivateAttachmentMutationResponse,
  TeammateSkillBindingListResponse,
  UpdateAiTeammateRequest,
} from "../types.js";
import { daemonClient } from "./client.js";
import { fileToBase64 } from "./file-uploads.js";

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

export async function getTeammateDirectRuntime(cwd: string, teammateId: string): Promise<TeammateDirectRuntimeResponse> {
  return daemonClient.getTeammateDirectRuntime(cwd, teammateId);
}

export async function listTeammateDirectInterventions(cwd: string, teammateId: string): Promise<TeammateDirectInterventionListResponse> {
  return daemonClient.listTeammateDirectInterventions(cwd, teammateId);
}

export async function createTeammateDirectIntervention(
  cwd: string,
  teammateId: string,
  input: CreateTeammateDirectReplyInterventionRequest,
): Promise<TeammateDirectInterventionResponse> {
  return daemonClient.createTeammateDirectIntervention(cwd, teammateId, input);
}

export async function cancelTeammateDirectIntervention(
  cwd: string,
  interventionId: string,
  input: CancelTeammateDirectReplyInterventionRequest = {},
): Promise<TeammateDirectInterventionResponse> {
  return daemonClient.cancelTeammateDirectIntervention(cwd, interventionId, input);
}

export async function cancelTeammateDirectReply(
  cwd: string,
  workUnitId: string,
  input: CancelTeammateDirectReplyRequest = {},
): Promise<TeammateDirectReplyCancelResponse> {
  return daemonClient.cancelTeammateDirectReply(cwd, workUnitId, input);
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

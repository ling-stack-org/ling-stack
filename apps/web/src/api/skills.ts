import type {
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPublishResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

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

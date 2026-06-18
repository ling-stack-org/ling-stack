import type {
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPublishResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
  SkillRegistryRefreshResponse,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const skillEndpoints = {
  async listSkills(this: LingDaemonEndpointContext, cwd: string): Promise<SkillRegistryListResponse> {
      return this._get("/skills", { cwd });
    },

  async refreshSkills(this: LingDaemonEndpointContext, cwd: string): Promise<SkillRegistryRefreshResponse> {
      return this._post("/skills/refresh", { cwd }, {});
    },

  async createSkillImportDraft(this: LingDaemonEndpointContext, cwd: string, input: SkillImportDraftRequest): Promise<SkillImportDraftResponse> {
      return this._post("/skills/import-draft", { cwd }, input);
    },

  async getSkillImportDraft(this: LingDaemonEndpointContext, cwd: string, draftId: string): Promise<SkillImportDraftResponse> {
      return this._get(`/skills/import-drafts/${encodeURIComponent(draftId)}`, { cwd });
    },

  async publishSkillImportDraft(this: LingDaemonEndpointContext, cwd: string, draftId: string): Promise<SkillImportPublishResponse> {
      return this._post(`/skills/import-drafts/${encodeURIComponent(draftId)}/publish`, { cwd }, {});
    },

  async archiveSkill(this: LingDaemonEndpointContext, cwd: string, skillId: string): Promise<SkillRegistryMutationResponse> {
      return this._request("DELETE", `/skills/${encodeURIComponent(skillId)}`, { cwd });
    },
};

export type SkillEndpoints = PublicEndpointGroup<typeof skillEndpoints>;
import type {
  ApprovalListResponse,
  ApprovalMutationResponse,
  ApprovalPolicyResponse,
  CreateMediaJobRequest,
  ListApprovalsRequest,
  MediaJobArtifactListResponse,
  MediaJobListResponse,
  MediaJobMutationResponse,
  McpServerListResponse,
  McpServerCheckResponse,
  McpServerMutationRequest,
  McpServerMutationResponse,
  McpServerStatusResponse,
  McpServerToolSyncResponse,
  McpToolListResponse,
  ManagedPluginApplyPresetRequest,
  ManagedPluginApplyPresetResponse,
  ManagedPluginCheckResponse,
  ManagedPluginDetailResponse,
  ManagedPluginDisableRequest,
  ManagedPluginInstallRequest,
  ManagedPluginInstallResponse,
  ManagedPluginListResponse,
  ManagedPluginMutationResponse,
  ManagedPluginRefreshPackageResponse,
  ManagedPluginRuntimePreviewResponse,
  ManagedPluginUninstallRequest,
  ManagedPluginUninstallResponse,
  PluginPackageDetailResponse,
  PluginPackageValidationResponse,
  PluginSourceListResponse,
  ProviderCheckResult,
  ProviderDraftCheckRequest,
  ProviderKeychainSecretConfigureRequest,
  ProviderKeychainSecretDeleteRequest,
  ProviderKeychainSecretResponse,
  ProviderListResponse,
  ProviderModelImportRequest,
  ProviderModelImportResponse,
  ProviderModelListRequest,
  ProviderModelListResponse,
  ProviderMutationRequest,
  ProviderMutationResponse,
  ProviderSecretResponse,
  ProviderTemplateListResponse,
  UpdateApprovalPolicyRequest,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const adminEndpoints = {
  async listProviders(this: LingDaemonEndpointContext, cwd: string): Promise<ProviderListResponse> {
      return this._get("/providers", { cwd });
    },

  async listProviderTemplates(this: LingDaemonEndpointContext): Promise<ProviderTemplateListResponse> {
      return this._get("/provider-templates");
    },

  async createProvider(this: LingDaemonEndpointContext, cwd: string, input: ProviderMutationRequest): Promise<ProviderMutationResponse> {
      return this._post("/providers", { cwd }, input);
    },

  async updateProvider(this: LingDaemonEndpointContext, cwd: string, providerId: string, input: ProviderMutationRequest): Promise<ProviderMutationResponse> {
      return this._patch(`/providers/${encodeURIComponent(providerId)}`, { cwd }, input);
    },

  async getProviderSecret(this: LingDaemonEndpointContext, cwd: string, providerId: string): Promise<ProviderSecretResponse> {
      return this._get(`/providers/${encodeURIComponent(providerId)}/secret`, { cwd });
    },

  async configureProviderKeychainSecret(
    this: LingDaemonEndpointContext,
    cwd: string,
    providerId: string,
    input: ProviderKeychainSecretConfigureRequest,
  ): Promise<ProviderKeychainSecretResponse> {
      return this._post(`/providers/${encodeURIComponent(providerId)}/secrets/configure`, { cwd }, input);
    },

  async deleteProviderKeychainSecret(
    this: LingDaemonEndpointContext,
    cwd: string,
    providerId: string,
    input: ProviderKeychainSecretDeleteRequest = {},
  ): Promise<ProviderKeychainSecretResponse> {
      return this._requestJson("DELETE", `/providers/${encodeURIComponent(providerId)}/secrets/keychain`, { cwd }, input);
    },

  async deleteProvider(this: LingDaemonEndpointContext, cwd: string, providerId: string): Promise<void> {
      await this._request("DELETE", `/providers/${encodeURIComponent(providerId)}`, { cwd });
    },

  async checkProvider(this: LingDaemonEndpointContext, cwd: string, providerId: string): Promise<ProviderCheckResult> {
      return this._post(`/providers/${encodeURIComponent(providerId)}/check`, { cwd });
    },

  async checkProviderDraft(this: LingDaemonEndpointContext, cwd: string, input: ProviderDraftCheckRequest): Promise<ProviderCheckResult> {
      return this._post("/provider-check", { cwd }, input);
    },

  async listProviderModels(this: LingDaemonEndpointContext, cwd: string, input: ProviderModelListRequest): Promise<ProviderModelListResponse> {
      return this._post("/provider-models", { cwd }, input);
    },

  async importProviderModels(this: LingDaemonEndpointContext, cwd: string, input: ProviderModelImportRequest): Promise<ProviderModelImportResponse> {
      return this._post("/providers/import-models", { cwd }, input);
    },

  async listMcpServers(this: LingDaemonEndpointContext, cwd: string): Promise<McpServerListResponse> {
      return this._get("/mcp/servers", { cwd });
    },

  async createMcpServer(this: LingDaemonEndpointContext, cwd: string, input: McpServerMutationRequest): Promise<McpServerMutationResponse> {
      return this._post("/mcp/servers", { cwd }, input);
    },

  async updateMcpServer(this: LingDaemonEndpointContext, cwd: string, serverId: string, input: McpServerMutationRequest): Promise<McpServerMutationResponse> {
      return this._patch(`/mcp/servers/${encodeURIComponent(serverId)}`, { cwd }, input);
    },

  async deleteMcpServer(this: LingDaemonEndpointContext, cwd: string, serverId: string): Promise<void> {
      await this._request("DELETE", `/mcp/servers/${encodeURIComponent(serverId)}`, { cwd });
    },

  async checkMcpServer(this: LingDaemonEndpointContext, cwd: string, serverId: string): Promise<McpServerCheckResponse> {
      return this._post(`/mcp/servers/${encodeURIComponent(serverId)}/check`, { cwd });
    },

  async getMcpServerStatus(this: LingDaemonEndpointContext, cwd: string, serverId: string): Promise<McpServerStatusResponse> {
      return this._get(`/mcp/servers/${encodeURIComponent(serverId)}/status`, { cwd });
    },

  async syncMcpServerTools(this: LingDaemonEndpointContext, cwd: string, serverId: string): Promise<McpServerToolSyncResponse> {
      return this._post(`/mcp/servers/${encodeURIComponent(serverId)}/sync-tools`, { cwd });
    },

  async listMcpTools(this: LingDaemonEndpointContext, cwd: string, serverId?: string): Promise<McpToolListResponse> {
      return this._get("/mcp/tools", { cwd, serverId });
    },

  async listManagedPlugins(this: LingDaemonEndpointContext, cwd: string): Promise<ManagedPluginListResponse> {
      return this._get("/plugins", { cwd });
    },

  async getManagedPlugin(this: LingDaemonEndpointContext, cwd: string, pluginId: string): Promise<ManagedPluginDetailResponse> {
      return this._get(`/plugins/${encodeURIComponent(pluginId)}`, { cwd });
    },

  async enableManagedPlugin(this: LingDaemonEndpointContext, cwd: string, pluginId: string): Promise<ManagedPluginMutationResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/enable`, { cwd }, {});
    },

  async disableManagedPlugin(this: LingDaemonEndpointContext, cwd: string, pluginId: string, input: ManagedPluginDisableRequest = {}): Promise<ManagedPluginMutationResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/disable`, { cwd }, input);
    },

  async checkManagedPlugin(this: LingDaemonEndpointContext, cwd: string, pluginId: string): Promise<ManagedPluginCheckResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/check`, { cwd }, {});
    },

  async applyManagedPluginPreset(this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
      input: ManagedPluginApplyPresetRequest = {},
    ): Promise<ManagedPluginApplyPresetResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/apply-preset`, { cwd }, input);
    },

  async installManagedPlugin(this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
      input: ManagedPluginInstallRequest = {},
    ): Promise<ManagedPluginInstallResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/install`, { cwd }, input);
    },

  async uninstallManagedPlugin(this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
      input: ManagedPluginUninstallRequest = {},
    ): Promise<ManagedPluginUninstallResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/uninstall`, { cwd }, input);
    },

  async refreshManagedPluginPackage(this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
      input: ManagedPluginInstallRequest = {},
    ): Promise<ManagedPluginRefreshPackageResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/refresh-package`, { cwd }, input);
    },

  async getManagedPluginRuntimePreview(this: LingDaemonEndpointContext, cwd: string, pluginId: string): Promise<ManagedPluginRuntimePreviewResponse> {
      return this._get(`/plugins/${encodeURIComponent(pluginId)}/runtime-preview`, { cwd });
    },

  async listPluginSources(this: LingDaemonEndpointContext, cwd: string): Promise<PluginSourceListResponse> {
      return this._get("/plugins/sources", { cwd });
    },

  async getPluginPackage(this: LingDaemonEndpointContext, cwd: string, pluginId: string): Promise<PluginPackageDetailResponse> {
      return this._get(`/plugins/packages/${encodeURIComponent(pluginId)}`, { cwd });
    },

  async validatePluginPackage(this: LingDaemonEndpointContext, cwd: string, pluginId: string): Promise<PluginPackageValidationResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/validate-package`, { cwd }, {});
    },

  async listApprovals(this: LingDaemonEndpointContext, cwd: string, options: ListApprovalsRequest = {}): Promise<ApprovalListResponse> {
      return this._get("/approvals", {
        cwd,
        status: options.status,
        runId: options.runId,
        mediaJobId: options.mediaJobId,
        limit: options.limit,
      });
    },

  async approveApproval(this: LingDaemonEndpointContext, cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
      return this._post(`/approvals/${encodeURIComponent(approvalId)}/approve`, { cwd }, { reason });
    },

  async denyApproval(this: LingDaemonEndpointContext, cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
      return this._post(`/approvals/${encodeURIComponent(approvalId)}/deny`, { cwd }, { reason });
    },

  async getApprovalPolicy(this: LingDaemonEndpointContext, cwd: string): Promise<ApprovalPolicyResponse> {
      return this._get("/approval-policy", { cwd });
    },

  async updateApprovalPolicy(this: LingDaemonEndpointContext, cwd: string, input: UpdateApprovalPolicyRequest): Promise<ApprovalPolicyResponse> {
      return this._patch("/approval-policy", { cwd }, input);
    },

  async listMediaJobs(this: LingDaemonEndpointContext, cwd: string, limit: number = 100): Promise<MediaJobListResponse> {
      return this._get("/media-jobs", { cwd, limit });
    },

  async createMediaJob(this: LingDaemonEndpointContext, cwd: string, input: CreateMediaJobRequest): Promise<MediaJobMutationResponse> {
      return this._post("/media-jobs", { cwd }, input);
    },

  async runMediaJob(this: LingDaemonEndpointContext, cwd: string, mediaJobId: string): Promise<MediaJobMutationResponse> {
      return this._post(`/media-jobs/${encodeURIComponent(mediaJobId)}/run`, { cwd });
    },

  async listMediaJobArtifacts(this: LingDaemonEndpointContext, mediaJobId: string, cwd?: string): Promise<MediaJobArtifactListResponse> {
      return this._get(`/media-jobs/${encodeURIComponent(mediaJobId)}/artifacts`, { cwd });
    },
};

export type AdminEndpoints = PublicEndpointGroup<typeof adminEndpoints>;

import type {
  ApprovalListResponse,
  ApprovalMutationResponse,
  ApprovalPolicyResponse,
  ChromeBrowserPairingStartResponse,
  CreateMediaJobRequest,
  ConversationMediaGenerationTargetsResponse,
  CreateMediaProjectRequest,
  CreateMediaProjectAssetRequest,
  CreateMediaSceneRequest,
  ListApprovalsRequest,
  MediaJobArtifactListResponse,
  MediaJobListResponse,
  MediaJobMutationResponse,
  MediaProductionDeleteResponse,
  MediaProductionProjectListResponse,
  MediaProductionProjectResponse,
  MediaProductionProjectRunResponse,
  MediaProductionSceneRunResponse,
  MediaProjectMutationResponse,
  MediaProjectAssetListResponse,
  MediaProjectAssetMutationResponse,
  MediaSceneDetailResponse,
  MediaSceneMutationResponse,
  MediaSceneReorderResponse,
  MediaWorkflowAnalysis,
  MediaWorkflowConnectionListResponse,
  MediaWorkflowConnectionResponse,
  MediaWorkflowDefinitionListResponse,
  MediaWorkflowDefinitionResponse,
  MediaWorkflowDeleteResponse,
  MediaWorkflowImportResponse,
  MediaWorkflowTestResponse,
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
  ManagedPluginConnectRequest,
  ManagedPluginConnectResponse,
  ManagedPluginCreateRequest,
  ManagedPluginCreateResponse,
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
  RunMediaProjectRequest,
  UpdateApprovalPolicyRequest,
  UpdateMediaProjectRequest,
  UpdateMediaSceneRequest,
  CreateMediaWorkflowConnectionRequest,
  UpdateMediaWorkflowConnectionRequest,
  ImportMediaWorkflowRequest,
  TestMediaWorkflowRequest,
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

  async createManagedPlugin(this: LingDaemonEndpointContext, cwd: string, input: ManagedPluginCreateRequest): Promise<ManagedPluginCreateResponse> {
      return this._post("/plugins", { cwd }, input);
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

  async connectManagedPlugin(
      this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
      input: ManagedPluginConnectRequest = {},
    ): Promise<ManagedPluginConnectResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/connect`, { cwd }, input);
    },

  async startChromeBrowserPairing(
      this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
    ): Promise<ChromeBrowserPairingStartResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/pairing`, { cwd }, {});
    },

  async revokeChromeBrowserAccess(
      this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
    ): Promise<ManagedPluginMutationResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/revoke`, { cwd }, {});
    },

  async repairChromeBrowserHost(
      this: LingDaemonEndpointContext,
      cwd: string,
      pluginId: string,
    ): Promise<ManagedPluginCheckResponse> {
      return this._post(`/plugins/${encodeURIComponent(pluginId)}/repair-browser-host`, { cwd }, {});
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

  async getConversationMediaGenerationTargets(
    this: LingDaemonEndpointContext,
    cwd: string,
  ): Promise<ConversationMediaGenerationTargetsResponse> {
      return this._get("/media-generation-targets", { cwd });
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

  async listMediaProjects(this: LingDaemonEndpointContext, cwd: string): Promise<MediaProductionProjectListResponse> {
      return this._get("/media-projects", { cwd });
    },

  async createMediaProject(this: LingDaemonEndpointContext, cwd: string, input: CreateMediaProjectRequest): Promise<MediaProductionProjectResponse> {
      return this._post("/media-projects", { cwd }, input);
    },

  async getMediaProject(this: LingDaemonEndpointContext, cwd: string, mediaProjectId: string): Promise<MediaProductionProjectResponse> {
      return this._get(`/media-projects/${encodeURIComponent(mediaProjectId)}`, { cwd });
    },

  async updateMediaProject(this: LingDaemonEndpointContext, cwd: string, mediaProjectId: string, input: UpdateMediaProjectRequest): Promise<MediaProjectMutationResponse> {
      return this._patch(`/media-projects/${encodeURIComponent(mediaProjectId)}`, { cwd }, input);
    },

  async deleteMediaProject(this: LingDaemonEndpointContext, cwd: string, mediaProjectId: string): Promise<MediaProductionDeleteResponse> {
      return this._delete(`/media-projects/${encodeURIComponent(mediaProjectId)}`, { cwd });
    },

  async listMediaProjectAssets(this: LingDaemonEndpointContext, cwd: string, mediaProjectId: string): Promise<MediaProjectAssetListResponse> {
      return this._get(`/media-projects/${encodeURIComponent(mediaProjectId)}/assets`, { cwd });
    },

  async createMediaProjectAsset(
    this: LingDaemonEndpointContext,
    cwd: string,
    mediaProjectId: string,
    input: CreateMediaProjectAssetRequest,
  ): Promise<MediaProjectAssetMutationResponse> {
      return this._post(`/media-projects/${encodeURIComponent(mediaProjectId)}/assets`, { cwd }, input);
    },

  mediaProjectAssetContentUrl(this: LingDaemonEndpointContext, cwd: string, mediaProjectAssetId: string): string {
      return this._url(`/media-project-assets/${encodeURIComponent(mediaProjectAssetId)}/content`, { cwd });
    },

  async deleteMediaProjectAsset(this: LingDaemonEndpointContext, cwd: string, mediaProjectAssetId: string): Promise<MediaProductionDeleteResponse> {
      return this._delete(`/media-project-assets/${encodeURIComponent(mediaProjectAssetId)}`, { cwd });
    },

  async createMediaScene(this: LingDaemonEndpointContext, cwd: string, mediaProjectId: string, input: CreateMediaSceneRequest): Promise<MediaSceneMutationResponse> {
      return this._post(`/media-projects/${encodeURIComponent(mediaProjectId)}/scenes`, { cwd }, input);
    },

  async reorderMediaScenes(this: LingDaemonEndpointContext, cwd: string, mediaProjectId: string, sceneIds: readonly string[]): Promise<MediaSceneReorderResponse> {
      return this._post(`/media-projects/${encodeURIComponent(mediaProjectId)}/reorder`, { cwd }, { sceneIds });
    },

  async runMediaProject(
    this: LingDaemonEndpointContext,
    cwd: string,
    mediaProjectId: string,
    input: RunMediaProjectRequest = {},
  ): Promise<MediaProductionProjectRunResponse> {
      return this._post(`/media-projects/${encodeURIComponent(mediaProjectId)}/run`, { cwd }, input);
    },

  async getMediaScene(this: LingDaemonEndpointContext, cwd: string, mediaSceneId: string): Promise<MediaSceneDetailResponse> {
      return this._get(`/media-scenes/${encodeURIComponent(mediaSceneId)}`, { cwd });
    },

  async updateMediaScene(this: LingDaemonEndpointContext, cwd: string, mediaSceneId: string, input: UpdateMediaSceneRequest): Promise<MediaSceneMutationResponse> {
      return this._patch(`/media-scenes/${encodeURIComponent(mediaSceneId)}`, { cwd }, input);
    },

  async deleteMediaScene(this: LingDaemonEndpointContext, cwd: string, mediaSceneId: string): Promise<MediaProductionDeleteResponse> {
      return this._delete(`/media-scenes/${encodeURIComponent(mediaSceneId)}`, { cwd });
    },

  async duplicateMediaScene(this: LingDaemonEndpointContext, cwd: string, mediaSceneId: string): Promise<MediaSceneMutationResponse> {
      return this._post(`/media-scenes/${encodeURIComponent(mediaSceneId)}/duplicate`, { cwd });
    },

  async runMediaScene(this: LingDaemonEndpointContext, cwd: string, mediaSceneId: string): Promise<MediaProductionSceneRunResponse> {
      return this._post(`/media-scenes/${encodeURIComponent(mediaSceneId)}/run`, { cwd });
    },

  async selectMediaSceneRun(this: LingDaemonEndpointContext, cwd: string, mediaSceneId: string, mediaSceneRunId: string): Promise<MediaSceneMutationResponse> {
      return this._post(`/media-scenes/${encodeURIComponent(mediaSceneId)}/select-run`, { cwd }, { mediaSceneRunId });
    },

  async cancelMediaSceneRun(this: LingDaemonEndpointContext, cwd: string, mediaSceneRunId: string): Promise<MediaProductionSceneRunResponse> {
      return this._post(`/media-scene-runs/${encodeURIComponent(mediaSceneRunId)}/cancel`, { cwd });
    },

  async listMediaWorkflowConnections(this: LingDaemonEndpointContext, cwd: string): Promise<MediaWorkflowConnectionListResponse> {
      return this._get("/media-workflow-connections", { cwd });
    },

  async createMediaWorkflowConnection(this: LingDaemonEndpointContext, cwd: string, input: CreateMediaWorkflowConnectionRequest): Promise<MediaWorkflowConnectionResponse> {
      return this._post("/media-workflow-connections", { cwd }, input);
    },

  async updateMediaWorkflowConnection(this: LingDaemonEndpointContext, cwd: string, connectionId: string, input: UpdateMediaWorkflowConnectionRequest): Promise<MediaWorkflowConnectionResponse> {
      return this._patch(`/media-workflow-connections/${encodeURIComponent(connectionId)}`, { cwd }, input);
    },

  async checkMediaWorkflowConnection(this: LingDaemonEndpointContext, cwd: string, connectionId: string): Promise<MediaWorkflowConnectionResponse> {
      return this._post(`/media-workflow-connections/${encodeURIComponent(connectionId)}/check`, { cwd });
    },

  async deleteMediaWorkflowConnection(this: LingDaemonEndpointContext, cwd: string, connectionId: string): Promise<MediaWorkflowDeleteResponse> {
      return this._delete(`/media-workflow-connections/${encodeURIComponent(connectionId)}`, { cwd });
    },

  async listMediaWorkflows(this: LingDaemonEndpointContext, cwd: string): Promise<MediaWorkflowDefinitionListResponse> {
      return this._get("/media-workflows", { cwd });
    },

  async analyzeMediaWorkflow(this: LingDaemonEndpointContext, cwd: string, input: Pick<ImportMediaWorkflowRequest, "connectionId" | "graph">): Promise<MediaWorkflowAnalysis> {
      return this._post("/media-workflows/analyze", { cwd }, input);
    },

  async importMediaWorkflow(this: LingDaemonEndpointContext, cwd: string, input: ImportMediaWorkflowRequest): Promise<MediaWorkflowImportResponse> {
      return this._post("/media-workflows/import", { cwd }, input);
    },

  async getMediaWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowDefinitionId: string): Promise<MediaWorkflowDefinitionResponse> {
      return this._get(`/media-workflows/${encodeURIComponent(workflowDefinitionId)}`, { cwd });
    },

  async testMediaWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowDefinitionId: string, input: TestMediaWorkflowRequest & { readonly versionId?: string }): Promise<MediaWorkflowTestResponse> {
      return this._post(`/media-workflows/${encodeURIComponent(workflowDefinitionId)}/test`, { cwd }, input);
    },

  async activateMediaWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowDefinitionId: string, versionId: string): Promise<MediaWorkflowDefinitionResponse> {
      return this._post(`/media-workflows/${encodeURIComponent(workflowDefinitionId)}/activate`, { cwd }, { versionId });
    },

  async archiveMediaWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowDefinitionId: string): Promise<MediaWorkflowDefinitionResponse> {
      return this._post(`/media-workflows/${encodeURIComponent(workflowDefinitionId)}/archive`, { cwd });
    },

  async deleteMediaWorkflow(this: LingDaemonEndpointContext, cwd: string, workflowDefinitionId: string): Promise<MediaWorkflowDeleteResponse> {
      return this._delete(`/media-workflows/${encodeURIComponent(workflowDefinitionId)}`, { cwd });
    },
};

export type AdminEndpoints = PublicEndpointGroup<typeof adminEndpoints>;

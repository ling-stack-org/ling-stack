import type {
  CandidateGenerationDecisionAction,
  CandidateGenerationDecisionListResponse,
  CreateSkillCandidateRequest,
  ProcedureObservationClusterListResponse,
  ProcedureObservationClusterResponse,
  ProcedureObservationClusterStatus,
  ProcedureObservationListResponse,
  ProcedureObservationJobRequest,
  ProcedureObservationJobResponse,
  ProcedureObservationRequest,
  ProcedureObservationResponse,
  SkillCandidateDraftRequest,
  SkillCandidateDraftResponse,
  SkillCandidateListResponse,
  SkillCandidateOrigin,
  SkillCandidateObserveResponse,
  SkillCandidateResponse,
  SkillCandidateReviewRequest,
  SkillCandidateReviewResponse,
  SkillCandidateStatus,
  OfficialSkillSourceStatusResponse,
  CandidateRouteKind,
  SkillInvocationSuggestionRequest,
  SkillInvocationSuggestionResponse,
  SkillCompiledRuntimeViewCreateRequest,
  SkillCompiledRuntimeViewListResponse,
  SkillCompiledRuntimeViewMutationResponse,
  SkillImportDraftOptimizationPreviewRequest,
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPreviewResponse,
  SkillImportPublishResponse,
  SkillHealthResponse,
  SkillHardDeleteResponse,
  SkillOptimizationPreviewRequest,
  SkillOptimizationPreviewResponse,
  SkillRecordingEligibilityResponse,
  SkillRecordingObservationRequest,
  SkillRecordingObservationResponse,
  SkillCorrectionRequest,
  SkillCorrectionResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
  SkillRegistryRefreshResponse,
  SkillRevisionPreviewRequest,
  SkillRevisionPreviewResponse,
  SkillRevisionPublishRequest,
  SkillRevisionPublishResponse,
  SharedSkillSourcePublishRequest,
  SharedSkillSourcePublishResponse,
  SharedSkillSourceScanRequest,
  SharedSkillSourceScanResponse,
  SkillSourceHealthResponse,
  SkillSourceArtifactListResponse,
  SkillSourceSnapshotArchiveResponse,
  SkillSourceSnapshotRollbackRequest,
  SkillSourceSnapshotRollbackResponse,
  SkillSourceSnapshotResponse,
  SkillSourceSyncApplyResponse,
  SkillSourceSyncCheckUpdatesResponse,
  SkillSourceSyncPreviewResponse,
  SkillSourceSyncPublishRequest,
  SkillSourceSyncPublishResponse,
  SkillSourceSyncRefreshResponse,
  SkillSourceSyncRequest,
  SkillSourceUpgradePolicyResponse,
  SkillSourceUpgradePolicyUpdateRequest,
  SkillUsageEventKind,
  SkillUsageEventListResponse,
  SkillUsageStatsListResponse,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const skillEndpoints = {
  async getOfficialSkillSourceStatus(this: LingDaemonEndpointContext, cwd: string): Promise<OfficialSkillSourceStatusResponse> {
    return this._get("/skills/sync/gstack/status", { cwd });
  },

  async listSkills(this: LingDaemonEndpointContext, cwd: string): Promise<SkillRegistryListResponse> {
    return this._get("/skills", { cwd });
  },

  async getSkillHealth(this: LingDaemonEndpointContext, cwd: string, options: { readonly limit?: number } = {}): Promise<SkillHealthResponse> {
    return this._get("/skills/health", { cwd, limit: options.limit });
  },

  async getSkillSourceHealth(this: LingDaemonEndpointContext, cwd: string, options: { readonly limit?: number } = {}): Promise<SkillSourceHealthResponse> {
    return this._get("/skills/source-health", { cwd, limit: options.limit });
  },

  async getSkillSourceSnapshot(this: LingDaemonEndpointContext, cwd: string, skillId: string): Promise<SkillSourceSnapshotResponse> {
    return this._get(`/skills/${encodeURIComponent(skillId)}/source`, { cwd });
  },

  async archiveSkillSourceSnapshot(this: LingDaemonEndpointContext, cwd: string, skillId: string): Promise<SkillSourceSnapshotArchiveResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/source/archive`, { cwd }, {});
  },

  async rollbackSkillSourceSnapshot(this: LingDaemonEndpointContext, cwd: string, skillId: string, input: SkillSourceSnapshotRollbackRequest): Promise<SkillSourceSnapshotRollbackResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/source/rollback`, { cwd }, input);
  },

  async listSkillSourceArtifacts(this: LingDaemonEndpointContext, cwd: string, skillId: string): Promise<SkillSourceArtifactListResponse> {
    return this._get(`/skills/${encodeURIComponent(skillId)}/source/artifacts`, { cwd });
  },

  async previewSkillOptimization(this: LingDaemonEndpointContext, cwd: string, skillId: string, input: SkillOptimizationPreviewRequest = {}): Promise<SkillOptimizationPreviewResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/optimization-preview`, { cwd }, input);
  },

  async listSkillCompiledRuntimeViews(this: LingDaemonEndpointContext, cwd: string, skillId: string): Promise<SkillCompiledRuntimeViewListResponse> {
    return this._get(`/skills/${encodeURIComponent(skillId)}/compiled-views`, { cwd });
  },

  async createSkillCompiledRuntimeView(
    this: LingDaemonEndpointContext,
    cwd: string,
    skillId: string,
    input: SkillCompiledRuntimeViewCreateRequest = {},
  ): Promise<SkillCompiledRuntimeViewMutationResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/compiled-views`, { cwd }, input);
  },

  async archiveSkillCompiledRuntimeView(
    this: LingDaemonEndpointContext,
    cwd: string,
    skillId: string,
    viewId: string,
  ): Promise<SkillCompiledRuntimeViewMutationResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/compiled-views/${encodeURIComponent(viewId)}/archive`, { cwd }, {});
  },

  async previewSkillImportDraftOptimization(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: SkillImportDraftOptimizationPreviewRequest,
  ): Promise<SkillOptimizationPreviewResponse> {
    return this._post("/skills/import-draft/optimization-preview", { cwd }, input);
  },

  skillSourceArtifactContentUrl(this: LingDaemonEndpointContext, artifactId: string, cwd?: string): string {
    return this._url(`/skills/source-artifacts/${encodeURIComponent(artifactId)}/content`, { cwd });
  },

  async getSkillSourceUpgradePolicy(this: LingDaemonEndpointContext, cwd: string): Promise<SkillSourceUpgradePolicyResponse> {
    return this._get("/skills/source-upgrade-policy", { cwd });
  },

  async updateSkillSourceUpgradePolicy(this: LingDaemonEndpointContext, cwd: string, input: SkillSourceUpgradePolicyUpdateRequest): Promise<SkillSourceUpgradePolicyResponse> {
    return this._put("/skills/source-upgrade-policy", { cwd }, input);
  },

  async previewGstackSkillSourceSync(this: LingDaemonEndpointContext, cwd: string, input: SkillSourceSyncRequest = {}): Promise<SkillSourceSyncPreviewResponse> {
    return this._post("/skills/sync/gstack/preview", { cwd }, input);
  },

  async applyGstackSkillSourceSync(this: LingDaemonEndpointContext, cwd: string): Promise<SkillSourceSyncApplyResponse> {
    return this._post("/skills/sync/gstack/apply", { cwd }, {});
  },

  async checkGstackSkillSourceUpdates(this: LingDaemonEndpointContext, cwd: string, input: SkillSourceSyncRequest = {}): Promise<SkillSourceSyncCheckUpdatesResponse> {
    return this._post("/skills/sync/gstack/check-updates", { cwd }, input);
  },

  async refreshGstackSkillSourceSync(this: LingDaemonEndpointContext, cwd: string, input: SkillSourceSyncRequest = {}): Promise<SkillSourceSyncRefreshResponse> {
    return this._post("/skills/sync/gstack/refresh", { cwd }, input);
  },

  async publishGstackSkillSourceSync(this: LingDaemonEndpointContext, cwd: string, input: SkillSourceSyncPublishRequest): Promise<SkillSourceSyncPublishResponse> {
    return this._post("/skills/sync/gstack/publish", { cwd }, input);
  },

  async previewSharedSkillSources(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: SharedSkillSourceScanRequest = {},
  ): Promise<SharedSkillSourceScanResponse> {
    return this._post("/skills/sync/shared/preview", { cwd }, input);
  },

  async publishSharedSkillSources(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: SharedSkillSourcePublishRequest,
  ): Promise<SharedSkillSourcePublishResponse> {
    return this._post("/skills/sync/shared/publish", { cwd }, input);
  },

  async listSkillUsageEvents(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: {
      readonly skillId?: string;
      readonly candidateId?: string;
      readonly runId?: string;
      readonly kind?: SkillUsageEventKind;
      readonly limit?: number;
    } = {},
  ): Promise<SkillUsageEventListResponse> {
    return this._get("/skills/usage-events", {
      cwd,
      skillId: options.skillId,
      candidateId: options.candidateId,
      runId: options.runId,
      kind: options.kind,
      limit: options.limit,
    });
  },

  async listSkillUsageStats(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: { readonly skillId?: string } = {},
  ): Promise<SkillUsageStatsListResponse> {
    return this._get("/skills/usage-stats", {
      cwd,
      skillId: options.skillId,
    });
  },

  async suggestSkillInvocations(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: SkillInvocationSuggestionRequest,
  ): Promise<SkillInvocationSuggestionResponse> {
    return this._post("/skills/suggestions", { cwd }, input);
  },

  async listCandidateGenerationDecisions(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: {
      readonly observationId?: string;
      readonly clusterId?: string;
      readonly decision?: CandidateGenerationDecisionAction;
      readonly limit?: number;
    } = {},
  ): Promise<CandidateGenerationDecisionListResponse> {
    return this._get("/candidate-generation-decisions", {
      cwd,
      observationId: options.observationId,
      clusterId: options.clusterId,
      decision: options.decision,
      limit: options.limit,
    });
  },

  async recordSkillCorrection(
    this: LingDaemonEndpointContext,
    cwd: string,
    skillId: string,
    input: SkillCorrectionRequest,
  ): Promise<SkillCorrectionResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/corrections`, { cwd }, input);
  },

  async listProcedureObservations(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: {
      readonly clusterId?: string;
      readonly channelId?: string;
      readonly routeKind?: CandidateRouteKind;
      readonly limit?: number;
    } = {},
  ): Promise<ProcedureObservationListResponse> {
    return this._get("/procedure-observations", {
      cwd,
      clusterId: options.clusterId,
      channelId: options.channelId,
      routeKind: options.routeKind,
      limit: options.limit,
    });
  },

  async listProcedureObservationClusters(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: {
      readonly channelId?: string;
      readonly routeKind?: CandidateRouteKind;
      readonly status?: ProcedureObservationClusterStatus;
      readonly limit?: number;
    } = {},
  ): Promise<ProcedureObservationClusterListResponse> {
    return this._get("/procedure-observation-clusters", {
      cwd,
      channelId: options.channelId,
      routeKind: options.routeKind,
      status: options.status,
      limit: options.limit,
    });
  },

  async getProcedureObservationCluster(
    this: LingDaemonEndpointContext,
    cwd: string,
    clusterId: string,
  ): Promise<ProcedureObservationClusterResponse> {
    return this._get(`/procedure-observation-clusters/${encodeURIComponent(clusterId)}`, { cwd });
  },

  async createProcedureObservation(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: ProcedureObservationRequest,
  ): Promise<ProcedureObservationResponse> {
    return this._post("/procedure-observations", { cwd }, input);
  },

  async createProcedureObservationJob(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: ProcedureObservationJobRequest,
  ): Promise<ProcedureObservationJobResponse> {
    return this._post("/procedure-observations/jobs", { cwd }, input);
  },

  async recordSkillRecording(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: SkillRecordingObservationRequest,
  ): Promise<SkillRecordingObservationResponse> {
    return this._post("/skill-recordings", { cwd }, input);
  },

  async getSkillRecordingEligibility(
    this: LingDaemonEndpointContext,
    cwd: string,
    runId: string,
  ): Promise<SkillRecordingEligibilityResponse> {
    return this._get("/skill-recordings/eligibility", { cwd, runId });
  },

  async listSkillCandidates(
    this: LingDaemonEndpointContext,
    cwd: string,
    options: {
      readonly status?: SkillCandidateStatus;
      readonly origin?: SkillCandidateOrigin;
      readonly limit?: number;
    } = {},
  ): Promise<SkillCandidateListResponse> {
    return this._get("/skill-candidates", {
      cwd,
      status: options.status,
      origin: options.origin,
      limit: options.limit,
    });
  },

  async getSkillCandidate(this: LingDaemonEndpointContext, cwd: string, candidateId: string): Promise<SkillCandidateResponse> {
    return this._get(`/skill-candidates/${encodeURIComponent(candidateId)}`, { cwd });
  },

  async createSkillCandidate(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: CreateSkillCandidateRequest,
  ): Promise<SkillCandidateResponse> {
    return this._post("/skill-candidates", { cwd }, input);
  },

  async observeSkillCandidate(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: ProcedureObservationRequest,
  ): Promise<SkillCandidateObserveResponse> {
    return this._post("/skill-candidates/observe", { cwd }, input);
  },

  async reviewSkillCandidate(
    this: LingDaemonEndpointContext,
    cwd: string,
    candidateId: string,
    input: SkillCandidateReviewRequest,
  ): Promise<SkillCandidateReviewResponse> {
    return this._post(`/skill-candidates/${encodeURIComponent(candidateId)}/review`, { cwd }, input);
  },

  async createSkillCandidateDraft(
    this: LingDaemonEndpointContext,
    cwd: string,
    candidateId: string,
    input: SkillCandidateDraftRequest = {},
  ): Promise<SkillCandidateDraftResponse> {
    return this._post(`/skill-candidates/${encodeURIComponent(candidateId)}/draft`, { cwd }, input);
  },

  async refreshSkills(this: LingDaemonEndpointContext, cwd: string): Promise<SkillRegistryRefreshResponse> {
    return this._post("/skills/refresh", { cwd }, {});
  },

  async createSkillImportDraft(this: LingDaemonEndpointContext, cwd: string, input: SkillImportDraftRequest): Promise<SkillImportDraftResponse> {
    return this._post("/skills/import-draft", { cwd }, input);
  },

  async previewSkillImport(this: LingDaemonEndpointContext, cwd: string, input: SkillImportDraftRequest): Promise<SkillImportPreviewResponse> {
    return this._post("/skills/import-preview", { cwd }, input);
  },

  async previewSkillRevision(
    this: LingDaemonEndpointContext,
    cwd: string,
    skillId: string,
    input: SkillRevisionPreviewRequest,
  ): Promise<SkillRevisionPreviewResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/revision-preview`, { cwd }, input);
  },

  async publishSkillRevision(
    this: LingDaemonEndpointContext,
    cwd: string,
    skillId: string,
    input: SkillRevisionPublishRequest,
  ): Promise<SkillRevisionPublishResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/revisions`, { cwd }, input);
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

  async hardDeleteSkill(this: LingDaemonEndpointContext, cwd: string, skillId: string): Promise<SkillHardDeleteResponse> {
    return this._post(`/skills/${encodeURIComponent(skillId)}/hard-delete`, { cwd }, {});
  },
};

export type SkillEndpoints = PublicEndpointGroup<typeof skillEndpoints>;

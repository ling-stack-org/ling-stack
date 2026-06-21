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
  SkillCandidateDraftResponse,
  SkillCandidateListResponse,
  SkillCandidateOrigin,
  SkillCandidateObserveResponse,
  SkillCandidateResponse,
  SkillCandidateReviewRequest,
  SkillCandidateReviewResponse,
  SkillCandidateStatus,
  CandidateRouteKind,
  SkillInvocationSuggestionRequest,
  SkillInvocationSuggestionResponse,
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPublishResponse,
  SkillHealthResponse,
  SkillRecordingObservationRequest,
  SkillRecordingObservationResponse,
  SkillCorrectionRequest,
  SkillCorrectionResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
  SkillRegistryRefreshResponse,
  SkillUsageEventKind,
  SkillUsageEventListResponse,
  SkillUsageStatsListResponse,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const skillEndpoints = {
  async listSkills(this: LingDaemonEndpointContext, cwd: string): Promise<SkillRegistryListResponse> {
    return this._get("/skills", { cwd });
  },

  async getSkillHealth(this: LingDaemonEndpointContext, cwd: string, options: { readonly limit?: number } = {}): Promise<SkillHealthResponse> {
    return this._get("/skills/health", { cwd, limit: options.limit });
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
  ): Promise<SkillCandidateDraftResponse> {
    return this._post(`/skill-candidates/${encodeURIComponent(candidateId)}/draft`, { cwd }, {});
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

import type {
  AutomationDetailResponse,
  AutomationDraftDetailResponse,
  AutomationDraftListRequest,
  AutomationDraftListResponse,
  AutomationDraftMutationResponse,
  AutomationDraftPreviewResponse,
  AutomationListRequest,
  AutomationListResponse,
  AutomationMutationResponse,
  AutomationPreviewResponse,
  AutomationRunCancelRequest,
  AutomationRunDetailResponse,
  AutomationRunListRequest,
  AutomationRunListResponse,
  AutomationRunMutationResponse,
  AutomationRunRequest,
  AutomationSchedulerListResponse,
  AutomationSchedulerMutationResponse,
  ConfirmAutomationDraftResponse,
  CreateAutomationDraftRequest,
  CreateAutomationRequest,
  UpdateAutomationDraftRequest,
  UpdateAutomationRequest,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const automationEndpoints = {
  async listAutomations(this: LingDaemonEndpointContext, cwd: string, options: AutomationListRequest = {}): Promise<AutomationListResponse> {
      return this._get("/automations", {
        cwd,
        status: options.status,
        kind: options.kind,
        channelId: options.channelId,
        includeArchived: options.includeArchived,
        scheduledOnly: options.scheduledOnly,
        limit: options.limit,
      });
    },

  async createAutomation(this: LingDaemonEndpointContext, cwd: string, input: CreateAutomationRequest): Promise<AutomationMutationResponse> {
      return this._post("/automations", { cwd }, input);
    },

  async listAutomationDrafts(this: LingDaemonEndpointContext, cwd: string, options: AutomationDraftListRequest = {}): Promise<AutomationDraftListResponse> {
      return this._get("/automation-drafts", {
        cwd,
        status: options.status,
        source: options.source,
        channelId: options.channelId,
        includeTerminal: options.includeTerminal,
        limit: options.limit,
      });
    },

  async createAutomationDraft(this: LingDaemonEndpointContext, cwd: string, input: CreateAutomationDraftRequest): Promise<AutomationDraftMutationResponse> {
      return this._post("/automation-drafts", { cwd }, input);
    },

  async getAutomationDraft(this: LingDaemonEndpointContext, cwd: string, draftId: string): Promise<AutomationDraftDetailResponse> {
      return this._get(`/automation-drafts/${encodeURIComponent(draftId)}`, { cwd });
    },

  async updateAutomationDraft(this: LingDaemonEndpointContext, cwd: string, draftId: string, input: UpdateAutomationDraftRequest): Promise<AutomationDraftMutationResponse> {
      return this._patch(`/automation-drafts/${encodeURIComponent(draftId)}`, { cwd }, input);
    },

  async discardAutomationDraft(this: LingDaemonEndpointContext, cwd: string, draftId: string): Promise<AutomationDraftMutationResponse> {
      return this._requestJson("DELETE", `/automation-drafts/${encodeURIComponent(draftId)}`, { cwd });
    },

  async previewAutomationDraft(this: LingDaemonEndpointContext, cwd: string, draftId: string, input: Record<string, never> = {}): Promise<AutomationDraftPreviewResponse> {
      return this._post(`/automation-drafts/${encodeURIComponent(draftId)}/preview`, { cwd }, input);
    },

  async confirmAutomationDraft(this: LingDaemonEndpointContext, cwd: string, draftId: string, input: Record<string, never> = {}): Promise<ConfirmAutomationDraftResponse> {
      return this._post(`/automation-drafts/${encodeURIComponent(draftId)}/confirm`, { cwd }, input);
    },

  async getAutomation(this: LingDaemonEndpointContext, cwd: string, automationId: string): Promise<AutomationDetailResponse> {
      return this._get(`/automations/${encodeURIComponent(automationId)}`, { cwd });
    },

  async updateAutomation(this: LingDaemonEndpointContext, cwd: string, automationId: string, input: UpdateAutomationRequest): Promise<AutomationMutationResponse> {
      return this._patch(`/automations/${encodeURIComponent(automationId)}`, { cwd }, input);
    },

  async archiveAutomation(this: LingDaemonEndpointContext, cwd: string, automationId: string): Promise<AutomationMutationResponse> {
      return this._requestJson("DELETE", `/automations/${encodeURIComponent(automationId)}`, { cwd });
    },

  async previewAutomation(this: LingDaemonEndpointContext, cwd: string, automationId: string, input: Record<string, never> = {}): Promise<AutomationPreviewResponse> {
      return this._post(`/automations/${encodeURIComponent(automationId)}/preview`, { cwd }, input);
    },

  async runAutomation(this: LingDaemonEndpointContext, cwd: string, automationId: string, input: AutomationRunRequest = {}): Promise<AutomationRunMutationResponse> {
      return this._post(`/automations/${encodeURIComponent(automationId)}/run`, { cwd }, input);
    },

  async listAutomationRuns(this: LingDaemonEndpointContext, cwd: string, options: AutomationRunListRequest = {}): Promise<AutomationRunListResponse> {
      return this._get("/automation-runs", {
        cwd,
        automationId: options.automationId,
        runId: options.runId,
        status: options.status,
        limit: options.limit,
      });
    },

  async getAutomationRun(this: LingDaemonEndpointContext, cwd: string, automationRunId: string): Promise<AutomationRunDetailResponse> {
      return this._get(`/automation-runs/${encodeURIComponent(automationRunId)}`, { cwd });
    },

  async cancelAutomationRun(this: LingDaemonEndpointContext,
      cwd: string,
      automationRunId: string,
      input: AutomationRunCancelRequest = {},
    ): Promise<AutomationRunMutationResponse> {
      return this._post(`/automation-runs/${encodeURIComponent(automationRunId)}/cancel`, { cwd }, input);
    },

  async startAutomationScheduler(this: LingDaemonEndpointContext, cwd: string): Promise<AutomationSchedulerMutationResponse> {
      return this._post("/automations/scheduler/start", { cwd }, {});
    },

  async listAutomationSchedulers(this: LingDaemonEndpointContext, cwd: string): Promise<AutomationSchedulerListResponse> {
      return this._get("/automations/scheduler", { cwd });
    },

  async stopAutomationScheduler(this: LingDaemonEndpointContext, cwd: string): Promise<AutomationSchedulerMutationResponse> {
      return this._post("/automations/scheduler/stop", { cwd }, {});
    },
};

export type AutomationEndpoints = PublicEndpointGroup<typeof automationEndpoints>;
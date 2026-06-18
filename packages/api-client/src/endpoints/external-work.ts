import type {
  ExternalGitHubImportRequest,
  ExternalLinearImportRequest,
  ExternalWorkBackgroundListResponse,
  ExternalWorkBackgroundMutationResponse,
  ExternalWorkActionCancelRequest,
  ExternalWorkActionDetailResponse,
  ExternalWorkActionExecuteRequest,
  ExternalWorkActionListRequest,
  ExternalWorkActionListResponse,
  ExternalWorkActionMutationResponse,
  ExternalWorkActionProposeRequest,
  ExternalWorkCiTriageDetailResponse,
  ExternalWorkCiTriageListRequest,
  ExternalWorkCiTriageListResponse,
  ExternalWorkCiTriageRunRequest,
  ExternalWorkCiTriageRequest,
  ExternalWorkCiTriageResponse,
  ExternalWorkDetailResponse,
  ExternalWorkGitHubBackgroundStartRequest,
  ExternalWorkListRequest,
  ExternalWorkListResponse,
  ExternalWorkPollRequest,
  ExternalWorkPollResponse,
  ExternalWorkImportResponse,
  ExternalWorkReconcileRequest,
  ExternalWorkReconcileResponse,
  ExternalWorkRouteRequest,
  ExternalWorkRouteResponse,
  ExternalWorkSecretConfigureRequest,
  ExternalWorkSecretDeleteRequest,
  ExternalWorkSecretMutationResponse,
  ExternalWorkStatusResponse,
  ExternalWorkWorkflowConfigureRequest,
  ExternalWorkWorkflowMutationResponse,
} from "@ling-stack/contracts";
import { LingDaemonError } from "../errors.js";
import { readErrorMessage } from "../transport.js";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const externalWorkEndpoints = {
  async importGitHubExternalWork(this: LingDaemonEndpointContext, cwd: string, input: ExternalGitHubImportRequest): Promise<ExternalWorkImportResponse> {
      return this._post("/external-work/github/import", { cwd }, input);
    },

  async importLinearExternalWork(this: LingDaemonEndpointContext, cwd: string, input: ExternalLinearImportRequest): Promise<ExternalWorkImportResponse> {
      return this._post("/external-work/linear/import", { cwd }, input);
    },

  async listExternalWork(this: LingDaemonEndpointContext, cwd: string, options: ExternalWorkListRequest = {}): Promise<ExternalWorkListResponse> {
      return this._get("/external-work", {
        cwd,
        channelId: options.channelId,
        sourceKind: options.sourceKind,
        workItemKind: options.workItemKind,
        schedulerStatus: options.schedulerStatus,
        limit: options.limit,
      });
    },

  async getExternalWork(this: LingDaemonEndpointContext, cwd: string, externalWorkId: string): Promise<ExternalWorkDetailResponse> {
      return this._get(`/external-work/${encodeURIComponent(externalWorkId)}`, { cwd });
    },

  async routeExternalWork(this: LingDaemonEndpointContext,
      cwd: string,
      externalWorkId: string,
      input: ExternalWorkRouteRequest,
    ): Promise<ExternalWorkRouteResponse> {
      return this._post(`/external-work/${encodeURIComponent(externalWorkId)}/route`, { cwd }, input);
    },

  async getExternalWorkStatus(this: LingDaemonEndpointContext,
      cwd: string,
      input: { readonly channelId: string; readonly workflowPath?: string },
    ): Promise<ExternalWorkStatusResponse> {
      return this._get("/external-work/status", {
        cwd,
        channelId: input.channelId,
        workflowPath: input.workflowPath,
      });
    },

  async configureExternalWorkSecret(this: LingDaemonEndpointContext,
      cwd: string,
      input: ExternalWorkSecretConfigureRequest,
    ): Promise<ExternalWorkSecretMutationResponse> {
      return this._post("/external-work/secrets/configure", { cwd }, input);
    },

  async deleteExternalWorkSecret(this: LingDaemonEndpointContext,
      cwd: string,
      input: ExternalWorkSecretDeleteRequest,
    ): Promise<ExternalWorkSecretMutationResponse> {
      return this._post("/external-work/secrets/delete", { cwd }, input);
    },

  async configureExternalWorkWorkflow(this: LingDaemonEndpointContext,
      cwd: string,
      input: ExternalWorkWorkflowConfigureRequest,
    ): Promise<ExternalWorkWorkflowMutationResponse> {
      return this._post("/external-work/workflow/configure", { cwd }, input);
    },

  async proposeExternalWorkAction(this: LingDaemonEndpointContext, cwd: string, input: ExternalWorkActionProposeRequest): Promise<ExternalWorkActionMutationResponse> {
      return this._post("/external-work/actions/propose", { cwd }, input);
    },

  async listExternalWorkActions(this: LingDaemonEndpointContext, cwd: string, options: ExternalWorkActionListRequest = {}): Promise<ExternalWorkActionListResponse> {
      return this._get("/external-work/actions", {
        cwd,
        externalWorkId: options.externalWorkId,
        channelId: options.channelId,
        status: options.status,
        actionKind: options.actionKind,
        limit: options.limit,
      });
    },

  async getExternalWorkAction(this: LingDaemonEndpointContext, cwd: string, actionId: string): Promise<ExternalWorkActionDetailResponse> {
      return this._get(`/external-work/actions/${encodeURIComponent(actionId)}`, { cwd });
    },

  async cancelExternalWorkAction(this: LingDaemonEndpointContext,
      cwd: string,
      actionId: string,
      input: ExternalWorkActionCancelRequest = {},
    ): Promise<ExternalWorkActionMutationResponse> {
      return this._post(`/external-work/actions/${encodeURIComponent(actionId)}/cancel`, { cwd }, input);
    },

  async executeExternalWorkAction(this: LingDaemonEndpointContext,
      cwd: string,
      actionId: string,
      input: ExternalWorkActionExecuteRequest = {},
    ): Promise<ExternalWorkActionMutationResponse> {
      return this._post(`/external-work/actions/${encodeURIComponent(actionId)}/execute`, { cwd }, input);
    },

  async pollGitHubExternalWork(this: LingDaemonEndpointContext, cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
      return this._post("/external-work/github/poll", { cwd }, input);
    },

  async pollLinearExternalWork(this: LingDaemonEndpointContext, cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
      return this._post("/external-work/linear/poll", { cwd }, input);
    },

  async startGitHubExternalWorkBackground(this: LingDaemonEndpointContext,
      cwd: string,
      input: ExternalWorkGitHubBackgroundStartRequest,
    ): Promise<ExternalWorkBackgroundMutationResponse> {
      return this._post("/external-work/github/background/start", { cwd }, input);
    },

  async listExternalWorkBackgroundSchedulers(this: LingDaemonEndpointContext, cwd: string): Promise<ExternalWorkBackgroundListResponse> {
      return this._get("/external-work/background", { cwd });
    },

  async stopExternalWorkBackgroundScheduler(this: LingDaemonEndpointContext, cwd: string, schedulerId: string): Promise<ExternalWorkBackgroundMutationResponse> {
      return this._post(`/external-work/background/${encodeURIComponent(schedulerId)}/stop`, { cwd }, {});
    },

  async triageGitHubExternalWorkCi(this: LingDaemonEndpointContext, cwd: string, input: ExternalWorkCiTriageRequest): Promise<ExternalWorkCiTriageResponse> {
      return this._post("/external-work/github/ci/triage", { cwd }, input);
    },

  async listGitHubExternalWorkCiTriage(this: LingDaemonEndpointContext,
      cwd: string,
      options: ExternalWorkCiTriageListRequest = {},
    ): Promise<ExternalWorkCiTriageListResponse> {
      return this._get("/external-work/github/ci/triage", {
        cwd,
        externalWorkId: options.externalWorkId,
        channelId: options.channelId,
        status: options.status,
        limit: options.limit,
      });
    },

  async getGitHubExternalWorkCiTriage(this: LingDaemonEndpointContext, cwd: string, triageId: string): Promise<ExternalWorkCiTriageDetailResponse> {
      return this._get(`/external-work/github/ci/triage/${encodeURIComponent(triageId)}`, { cwd });
    },

  async startGitHubExternalWorkCiTriageRun(this: LingDaemonEndpointContext,
      cwd: string,
      triageId: string,
      input: ExternalWorkCiTriageRunRequest,
    ): Promise<Response> {
      const response = await this._fetch(this._url(`/external-work/github/ci/triage/${encodeURIComponent(triageId)}/run`, { cwd }), {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
      }
      return response;
    },

  async reconcileExternalWork(this: LingDaemonEndpointContext, cwd: string, input: ExternalWorkReconcileRequest = {}): Promise<ExternalWorkReconcileResponse> {
      return this._post("/external-work/reconcile", { cwd }, input);
    },
};

export type ExternalWorkEndpoints = PublicEndpointGroup<typeof externalWorkEndpoints>;
import type {
  CompanionEventsResponse,
  CompanionInteractionRequest,
  CompanionInteractionResponse,
  CompanionListResponse,
  CompanionMessageRequest,
  CompanionMessageResponse,
  CompanionMessagesResponse,
  CompanionMutationResponse,
  CompanionProactiveResponse,
  CompanionProactiveRequest,
  CompanionStateResponse,
  CreateCompanionRequest,
  UpdateCompanionRequest,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const companionEndpoints = {
  async listCompanions(this: LingDaemonEndpointContext, cwd: string): Promise<CompanionListResponse> {
    return this._get("/companions", { cwd });
  },

  async getCompanion(this: LingDaemonEndpointContext, cwd: string, companionId: string): Promise<CompanionMutationResponse> {
    return this._get(`/companions/${encodeURIComponent(companionId)}`, { cwd });
  },

  async createCompanion(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: CreateCompanionRequest,
  ): Promise<CompanionMutationResponse> {
    return this._post("/companions", { cwd }, input);
  },

  async updateCompanion(
    this: LingDaemonEndpointContext,
    cwd: string,
    companionId: string,
    input: UpdateCompanionRequest,
  ): Promise<CompanionMutationResponse> {
    return this._patch(`/companions/${encodeURIComponent(companionId)}`, { cwd }, input);
  },

  async disableCompanion(this: LingDaemonEndpointContext, cwd: string, companionId: string): Promise<CompanionMutationResponse> {
    return this._requestJson("DELETE", `/companions/${encodeURIComponent(companionId)}`, { cwd });
  },

  async getCompanionState(this: LingDaemonEndpointContext, cwd: string, companionId: string): Promise<CompanionStateResponse> {
    return this._get(`/companions/${encodeURIComponent(companionId)}/state`, { cwd });
  },

  async listCompanionEvents(
    this: LingDaemonEndpointContext,
    cwd: string,
    companionId: string,
    options: { readonly limit?: number; readonly beforeCreatedAt?: string; readonly beforeEventId?: string } = {},
  ): Promise<CompanionEventsResponse> {
    return this._get(`/companions/${encodeURIComponent(companionId)}/events`, {
      cwd,
      limit: options.limit,
      beforeCreatedAt: options.beforeCreatedAt,
      beforeEventId: options.beforeEventId,
    });
  },

  async interactWithCompanion(
    this: LingDaemonEndpointContext,
    cwd: string,
    companionId: string,
    input: CompanionInteractionRequest,
  ): Promise<CompanionInteractionResponse> {
    return this._post(`/companions/${encodeURIComponent(companionId)}/interactions`, { cwd }, input);
  },

  async listCompanionMessages(
    this: LingDaemonEndpointContext,
    cwd: string,
    companionId: string,
    options: { readonly limit?: number; readonly beforeMessageId?: string } = {},
  ): Promise<CompanionMessagesResponse> {
    return this._get(`/companions/${encodeURIComponent(companionId)}/messages`, {
      cwd,
      limit: options.limit,
      beforeMessageId: options.beforeMessageId,
    });
  },

  async createCompanionMessage(
    this: LingDaemonEndpointContext,
    cwd: string,
    companionId: string,
    input: CompanionMessageRequest,
  ): Promise<CompanionMessageResponse> {
    return this._post(`/companions/${encodeURIComponent(companionId)}/messages`, { cwd }, input);
  },

  async streamCompanionMessage(
    this: LingDaemonEndpointContext,
    cwd: string,
    companionId: string,
    input: CompanionMessageRequest,
  ): Promise<Response> {
    const response = await this._fetch(this._url(`/companions/${encodeURIComponent(companionId)}/messages/stream`, { cwd }), {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`Companion stream failed with status ${response.status}`);
    }
    return response;
  },

  async triggerCompanionProactive(
    this: LingDaemonEndpointContext,
    cwd: string,
    companionId: string,
    input: CompanionProactiveRequest = {},
  ): Promise<CompanionProactiveResponse> {
    return this._post(`/companions/${encodeURIComponent(companionId)}/proactive`, { cwd }, input);
  },
};

export type CompanionEndpoints = PublicEndpointGroup<typeof companionEndpoints>;

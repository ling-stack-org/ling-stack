import type {
  ComputerUsePreviewEventsResponse,
  ComputerUsePreviewListResponse,
  ComputerUsePreviewSnapshotResponse,
  StopComputerUseRequest,
  StopComputerUseResponse,
} from "@ling-stack/contracts";
import { COMPUTER_USE_ROUTE_TOKEN_HEADER } from "@ling-stack/contracts";
import { LingDaemonError } from "../errors.js";
import { readErrorMessage } from "../transport.js";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const computerUseEndpoints = {
  async listComputerUsePreviews(this: LingDaemonEndpointContext, cwd: string): Promise<ComputerUsePreviewListResponse> {
    return this._requestWithHeaders("GET", "/computer-use/sessions", { cwd }, undefined, computerUseRouteHeaders(this));
  },

  async getComputerUsePreviewSnapshot(
    this: LingDaemonEndpointContext,
    cwd: string,
  ): Promise<ComputerUsePreviewSnapshotResponse> {
    return this._requestWithHeaders(
      "GET",
      "/computer-use/snapshot",
      { cwd },
      undefined,
      computerUseRouteHeaders(this),
    );
  },

  async listComputerUsePreviewEvents(
    this: LingDaemonEndpointContext,
    cwd: string,
    afterSeq = 0,
    limit = 500,
  ): Promise<ComputerUsePreviewEventsResponse> {
    return this._requestWithHeaders(
      "GET",
      "/computer-use/events",
      { cwd, afterSeq, limit },
      undefined,
      computerUseRouteHeaders(this),
    );
  },

  async streamComputerUsePreviews(
    this: LingDaemonEndpointContext,
    cwd: string,
    afterSeq = 0,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this._fetch(this._url("/computer-use/stream", { cwd, afterSeq }), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...computerUseRouteHeaders(this),
      },
      signal,
    });
    if (!response.ok) {
      throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
    }
    return response;
  },

  async stopComputerUse(
    this: LingDaemonEndpointContext,
    cwd: string,
    sessionId: string,
    input: StopComputerUseRequest = {},
  ): Promise<StopComputerUseResponse> {
    return this._requestWithHeaders(
      "POST",
      `/computer-use/sessions/${encodeURIComponent(sessionId)}/stop`,
      { cwd },
      input,
      computerUseRouteHeaders(this),
    );
  },
};

function computerUseRouteHeaders(context: LingDaemonEndpointContext): Record<string, string> {
  return context.computerUseRouteToken
    ? { [COMPUTER_USE_ROUTE_TOKEN_HEADER]: context.computerUseRouteToken }
    : {};
}

export type ComputerUseEndpoints = PublicEndpointGroup<typeof computerUseEndpoints>;

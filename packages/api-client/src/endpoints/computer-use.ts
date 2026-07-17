import type {
  ComputerUsePreviewEventsResponse,
  ComputerUsePreviewListResponse,
  ComputerUsePreviewSnapshotResponse,
  StopComputerUseRequest,
  StopComputerUseResponse,
} from "@ling-stack/contracts";
import {
  COMPUTER_USE_ROUTE_TOKEN_HEADER,
  parseComputerUsePreviewEventsResponse,
  parseComputerUsePreviewListResponse,
  parseComputerUsePreviewSnapshotResponse,
  parseStopComputerUseResponse,
} from "@ling-stack/contracts";
import { LingDaemonError } from "../errors.js";
import { readErrorMessage } from "../transport.js";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const computerUseEndpoints = {
  async listComputerUsePreviews(this: LingDaemonEndpointContext, cwd: string): Promise<ComputerUsePreviewListResponse> {
    const value = await this._requestWithHeaders<unknown>(
      "GET",
      "/computer-use/sessions",
      { cwd },
      undefined,
      computerUseRouteHeaders(this),
    );
    const parsed = parseComputerUsePreviewListResponse(value, cwd);
    if (!parsed) {
      throw new Error("computer_use_list_response_invalid");
    }
    return parsed;
  },

  async getComputerUsePreviewSnapshot(
    this: LingDaemonEndpointContext,
    cwd: string,
  ): Promise<ComputerUsePreviewSnapshotResponse> {
    const value = await this._requestWithHeaders<unknown>(
      "GET",
      "/computer-use/snapshot",
      { cwd },
      undefined,
      computerUseRouteHeaders(this),
    );
    const parsed = parseComputerUsePreviewSnapshotResponse(value, cwd);
    if (!parsed) {
      throw new Error("computer_use_snapshot_response_invalid");
    }
    return parsed;
  },

  async listComputerUsePreviewEvents(
    this: LingDaemonEndpointContext,
    cwd: string,
    afterSeq = 0,
    limit = 500,
  ): Promise<ComputerUsePreviewEventsResponse> {
    const value = await this._requestWithHeaders<unknown>(
      "GET",
      "/computer-use/events",
      { cwd, afterSeq, limit },
      undefined,
      computerUseRouteHeaders(this),
    );
    const parsed = parseComputerUsePreviewEventsResponse(value, cwd);
    if (!parsed) {
      throw new Error("computer_use_events_response_invalid");
    }
    return parsed;
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
    const value = await this._requestWithHeaders<unknown>(
      "POST",
      `/computer-use/sessions/${encodeURIComponent(sessionId)}/stop`,
      { cwd },
      input,
      computerUseRouteHeaders(this),
    );
    const parsed = parseStopComputerUseResponse(value, sessionId);
    if (!parsed) {
      throw new Error("computer_use_stop_response_invalid");
    }
    return parsed;
  },
};

function computerUseRouteHeaders(context: LingDaemonEndpointContext): Record<string, string> {
  return context.computerUseRouteToken
    ? { [COMPUTER_USE_ROUTE_TOKEN_HEADER]: context.computerUseRouteToken }
    : {};
}

export type ComputerUseEndpoints = PublicEndpointGroup<typeof computerUseEndpoints>;

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  parseReplaceAiCouncilMembersRequest,
  parseUpsertChannelCouncilPolicyRequest,
} from "./schemas.js";

export async function handleAiCouncilsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        councils: store.listAiCouncils({
          includeArchived: url.searchParams.get("includeArchived") === "true",
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /ai-councils` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleAiCouncilItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  councilId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const council = store.getAiCouncil(councilId);
    if (!council) {
      writeJson(response, 404, { error: "council_not_found", message: `AI council not found: ${councilId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, council });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for AI council` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleAiCouncilMembers(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  councilId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const council = store.getAiCouncil(councilId);
    if (!council) {
      writeJson(response, 404, { error: "council_not_found", message: `AI council not found: ${councilId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        councilId,
        members: store.listAiCouncilMembers(councilId),
      });
      return;
    }
    if (request.method === "PUT") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const members = store.replaceAiCouncilMembers(
        councilId,
        parseReplaceAiCouncilMembersRequest(body),
        new Date().toISOString(),
      );
      writeJson(response, 200, { cwd, councilId, members });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for AI council members` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelCouncilPolicy(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const policy = store.getChannelCouncilPolicy(channelId);
    if (!policy) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { cwd, channelId, policy });
      return;
    }
    if (request.method === "PUT") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = store.upsertChannelCouncilPolicy(
        channelId,
        parseUpsertChannelCouncilPolicyRequest(body),
        new Date().toISOString(),
      );
      writeJson(response, 200, { cwd, channelId, policy: updated });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel council policy` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelEffectiveCouncil(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method !== "GET") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel effective council` });
      return;
    }
    const effectiveCouncil = store.getEffectiveChannelCouncil(channelId);
    if (!effectiveCouncil) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    writeJson(response, 200, { cwd, channelId, effectiveCouncil });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

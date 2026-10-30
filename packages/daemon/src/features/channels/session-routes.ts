import type { IncomingMessage, ServerResponse } from "node:http";
import { isCreateChannelSessionRequest, isUpdateChannelSessionRequest } from "@ling-stack/contracts";
import { ChannelSessionError } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalJsonBody, readOptionalBooleanQuery, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

/** The facade owns HTTP validation; the store owns identity, lifecycle and transactions. */
export async function handleChannelSessions(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
  threadId?: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    if (threadId) {
      const session = store.getChannelSession(channelId, threadId);
      if (!session) {
        writeJson(response, 404, { error: "channel_session_not_found", message: "Conversation not found in this channel." });
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, { session });
        return;
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        if (!isUpdateChannelSessionRequest(body)) {
          throw new HttpError(400, "invalid_session_update", "Expected title (1–120 characters) and/or archived (boolean)." );
        }
        writeJson(response, 200, { session: store.updateChannelSession(channelId, threadId, body, new Date().toISOString()) });
        return;
      }
    } else {
      if (request.method === "GET") {
        const page = store.listChannelSessions(channelId, {
          archived: readOptionalBooleanQuery(url, "archived"),
          q: url.searchParams.get("q") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        });
        writeJson(response, 200, { cwd, channelId, ...page });
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        if (!isCreateChannelSessionRequest(body)) {
          throw new HttpError(400, "invalid_session_create", "Expected idempotencyKey (1–256 characters) and optional title (1–120 characters)." );
        }
        const result = store.createChannelSession({ channelId, ...body }, new Date().toISOString());
        writeJson(response, result.idempotentReplay ? 200 : 201, result);
        return;
      }
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel sessions` });
  } catch (error) {
    writeChannelSessionError(response, error);
  }
}

export function writeChannelSessionError(response: ServerResponse, error: unknown): void {
  const known = error instanceof ChannelSessionError || error instanceof HttpError;
  writeJson(response, known ? error.statusCode : 400, {
    error: known ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Repair is deliberately a mutation: reading a legacy directory never manufactures history. */
export async function handleChannelSessionDirectoryRepair(
  request: IncomingMessage, response: ServerResponse, config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry, channelId: string, branchId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Directory repair requires POST." });
    return;
  }
  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    if (body !== undefined && (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length !== 0)) {
      throw new HttpError(400, "invalid_session_repair", "Directory repair accepts only an empty object or body.");
    }
    const store = storeRegistry.getStore(cwd);
    const session = store.repairChannelSessionDirectory(channelId, branchId, new Date().toISOString());
    writeJson(response, 200, { session, branch: store.getChannelBranch(branchId) });
  } catch (error) {
    writeChannelSessionError(response, error);
  }
}

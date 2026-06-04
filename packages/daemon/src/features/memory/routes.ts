import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalBooleanQuery, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  parseCreateMemoryObjectInput,
  parseMemoryObjectUpdateInput,
  parseMemoryRecallRequest,
  readOptionalMemoryReviewStateQuery,
  readOptionalMemoryScopeTypeQuery,
  readOptionalMemorySensitivityQuery,
} from "./schemas.js";

export async function handleMemoryCollection(
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
        memories: store.listMemoryObjects({
          scopeType: readOptionalMemoryScopeTypeQuery(url),
          ownerId: url.searchParams.get("ownerId") ?? undefined,
          reviewState: readOptionalMemoryReviewStateQuery(url),
          enabled: readOptionalBooleanQuery(url, "enabled"),
          sensitivity: readOptionalMemorySensitivityQuery(url),
          tag: url.searchParams.get("tag") ?? undefined,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
        vectorRetrieval: {
          status: "not_installed",
          optional: true,
        },
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const memory = store.createMemoryObject(parseCreateMemoryObjectInput(body), new Date().toISOString());
      writeJson(response, 201, { memory });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  memoryId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const memory = store.getMemoryObject(memoryId);
    if (!memory) {
      writeJson(response, 404, { error: "memory_not_found", message: `Memory object not found: ${memoryId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { memory });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = store.updateMemoryObject(memoryId, parseMemoryObjectUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { memory: updated ?? memory });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for memory item` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMemoryRecall(
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
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /memory/recall` });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const result = storeRegistry.getStore(cwd).recallMemory(parseMemoryRecallRequest(body));
    writeJson(response, 200, {
      cwd,
      memories: result.memories,
      policyVersion: result.policyVersion,
    });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function handleListUsedMemoryEvents(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      events: store.listUsedMemoryEvents({
        teammateId: url.searchParams.get("teammateId") ?? undefined,
        channelId: url.searchParams.get("channelId") ?? undefined,
        taskId: url.searchParams.get("taskId") ?? undefined,
        runId: url.searchParams.get("runId") ?? undefined,
        responseId: url.searchParams.get("responseId") ?? undefined,
        memoryId: url.searchParams.get("memoryId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

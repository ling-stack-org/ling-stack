import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery, readOptionalJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  parseCompanionInteractionRequest,
  parseCompanionProactiveRequest,
  parseCompanionStatus,
  parseCreateCompanionInput,
  parseUpdateCompanionInput,
} from "./schemas.js";
import type { CompanionSchedulerRegistry } from "./scheduler.js";

export async function handleCompanionsCollection(
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
        companions: store.listCompanions({
          status: parseCompanionStatus(url.searchParams.get("status")),
          limit: readOptionalIntegerQuery(url, "limit", 1),
          offset: readOptionalIntegerQuery(url, "offset", 0),
        }),
      });
      return;
    }
    if (request.method === "POST") {
      const input = parseCreateCompanionInput(await readJsonBody(request, config.maxBodyBytes));
      const companion = store.createCompanion(input, new Date().toISOString());
      writeJson(response, 201, { companion });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /companions` });
  } catch (error) {
    writeCompanionError(response, error);
  }
}

export async function handleCompanionItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  companionId: string,
  action?: "state" | "events" | "interactions" | "proactive",
  scheduler?: CompanionSchedulerRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const companion = store.getCompanion(companionId);
    if (!companion) {
      writeJson(response, 404, { error: "companion_not_found", message: `Companion not found: ${companionId}` });
      return;
    }
    if (!action) {
      if (request.method === "GET") {
        writeJson(response, 200, { cwd, companion });
        return;
      }
      if (request.method === "PATCH") {
        const updated = store.updateCompanion(
          companionId,
          parseUpdateCompanionInput(await readJsonBody(request, config.maxBodyBytes)),
          new Date().toISOString(),
        );
        writeJson(response, 200, { companion: updated });
        return;
      }
      if (request.method === "DELETE") {
        writeJson(response, 200, { companion: store.disableCompanion(companionId, new Date().toISOString()) });
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /companions/:id` });
      return;
    }
    if (action === "proactive") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for Companion proactive trigger` });
        return;
      }
      if (!scheduler) {
        writeJson(response, 503, { error: "companion_scheduler_unavailable", message: "Companion scheduler is unavailable." });
        return;
      }
      const input = parseCompanionProactiveRequest(await readOptionalJsonBody(request, config.maxBodyBytes));
      const result = await scheduler.trigger(cwd, companionId, { ...input, source: "manual" });
      writeJson(response, result.status === "started" ? 201 : 200, result);
      return;
    }
    if (action === "state") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for companion state` });
        return;
      }
      writeJson(response, 200, { cwd, companionId, state: store.getCompanionState(companionId) });
      return;
    }
    if (action === "events") {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for companion events` });
        return;
      }
      const page = store.listCompanionEventsPage({
        companionId,
        beforeCreatedAt: url.searchParams.get("beforeCreatedAt") ?? undefined,
        beforeEventId: url.searchParams.get("beforeEventId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      writeJson(response, 200, {
        cwd,
        companionId,
        events: page.events,
        hasMore: page.hasMore,
        ...(page.nextBeforeCreatedAt ? { nextBeforeCreatedAt: page.nextBeforeCreatedAt } : {}),
        ...(page.nextBeforeEventId ? { nextBeforeEventId: page.nextBeforeEventId } : {}),
      });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for companion interactions` });
      return;
    }
    const result = store.recordCompanionInteraction({
      companionId,
      ...parseCompanionInteractionRequest(await readJsonBody(request, config.maxBodyBytes)),
    }, new Date().toISOString());
    writeJson(response, 201, { cwd, ...result });
  } catch (error) {
    writeCompanionError(response, error);
  }
}

function writeCompanionError(response: ServerResponse, error: unknown): void {
  writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
    error: error instanceof HttpError ? error.code : "bad_request",
    message: error instanceof Error ? error.message : String(error),
  });
}

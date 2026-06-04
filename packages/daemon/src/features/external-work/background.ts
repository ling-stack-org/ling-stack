import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ExternalWorkBackgroundListResponse,
  ExternalWorkBackgroundMutationResponse,
  ExternalWorkBackgroundScheduler,
  ExternalWorkGitHubBackgroundStartRequest,
  ExternalWorkReconcileResponse,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { parseExternalGitHubBackgroundStartRequest } from "./schemas.js";

export interface ExternalWorkBackgroundSchedulerStore {
  list(cwd: string): ExternalWorkBackgroundScheduler[];
  stop(cwd: string, schedulerId: string): ExternalWorkBackgroundScheduler | undefined;
  start(cwd: string, input: ExternalWorkGitHubBackgroundStartRequest): Promise<{
    readonly scheduler: ExternalWorkBackgroundScheduler;
    readonly duplicate: boolean;
    readonly startupReconcile?: ExternalWorkReconcileResponse;
  }>;
}

export async function handleExternalGitHubBackgroundStart(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerStore | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub external work background start` });
    return;
  }
  if (!backgroundSchedulers) {
    writeJson(response, 500, { error: "background_scheduler_unavailable", message: "External work background scheduler is unavailable." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubBackgroundStartRequest(body);
    storeRegistry.getStore(cwd);
    const result = await backgroundSchedulers.start(cwd, input);
    const responseBody: ExternalWorkBackgroundMutationResponse = {
      cwd,
      scheduler: result.scheduler,
      duplicate: result.duplicate,
      ...(result.startupReconcile ? { startupReconcile: result.startupReconcile } : {}),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkBackgroundCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerStore | undefined,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work background schedulers` });
    return;
  }
  if (!backgroundSchedulers) {
    writeJson(response, 500, { error: "background_scheduler_unavailable", message: "External work background scheduler is unavailable." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const responseBody: ExternalWorkBackgroundListResponse = {
    cwd,
    schedulers: backgroundSchedulers.list(cwd),
  };
  writeJson(response, 200, responseBody);
}

export async function handleExternalWorkBackgroundStop(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerStore | undefined,
  schedulerId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work background stop` });
    return;
  }
  if (!backgroundSchedulers) {
    writeJson(response, 500, { error: "background_scheduler_unavailable", message: "External work background scheduler is unavailable." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const scheduler = backgroundSchedulers.stop(cwd, schedulerId);
  if (!scheduler) {
    writeJson(response, 404, { error: "background_scheduler_not_found", message: `External work background scheduler not found: ${schedulerId}` });
    return;
  }
  const responseBody: ExternalWorkBackgroundMutationResponse = { cwd, scheduler };
  writeJson(response, 200, responseBody);
}

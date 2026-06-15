import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecretResolver } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { assertMediaJobProvider } from "./provider.js";
import { parseCreateMediaJobInput, readOptionalMediaJobStatusQuery } from "./schemas.js";

export type RunMediaJob = (input: {
  readonly response: ServerResponse;
  readonly url: URL;
  readonly mediaJobId: string;
}) => Promise<void>;

export async function handleMediaJobsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
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
        mediaJobs: store.listMediaJobs({
          providerPresetId: url.searchParams.get("providerPresetId") ?? undefined,
          status: readOptionalMediaJobStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateMediaJobInput(body);
      assertMediaJobProvider(store, input, secretResolver);
      const job = store.createMediaJob(input, new Date().toISOString());
      writeJson(response, 201, { mediaJob: job });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /media-jobs` });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleMediaJobRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
  action: "run" | "artifacts" | undefined,
  runMediaJob: RunMediaJob,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  if (request.method === "POST" && action === "run") {
    await runMediaJob({ response, url, mediaJobId });
    return;
  }
  if (request.method === "GET" && action === "artifacts") {
    handleListMediaJobArtifacts(response, url, storeRegistry, mediaJobId);
    return;
  }
  if (action) {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for generation task ${action}` });
    return;
  }
  handleMediaJobItem(request, response, config, storeRegistry, mediaJobId);
}

function handleMediaJobItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
): void {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for generation tasks` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Generation task not found: ${mediaJobId}` });
      return;
    }
    writeJson(response, 200, { mediaJob: job });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleListMediaJobArtifacts(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Generation task not found: ${mediaJobId}` });
      return;
    }
    writeJson(response, 200, {
      mediaJobId,
      artifacts: store.listMediaJobArtifacts(mediaJobId),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

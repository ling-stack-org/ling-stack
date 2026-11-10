import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecretResolver } from "@ling-stack/core";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { readWorkSummary } from "./service.js";
import { parseSummaryPullRequest } from "./pull-requests.js";

export async function handleWorkSummary(request: IncomingMessage, response: ServerResponse, url: URL,
  registry: RunStoreRegistry, secrets: SecretResolver): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) { writeJson(response, 400, { error: "bad_request", message: "cwd is required" }); return; }
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: registry, cwd })) return;
  try {
    const store = registry.getInitializedStore(cwd);
    if (!store) { writeJson(response, 404, { error: "workspace_not_loaded", message: "Open this project before reading its work summary." }); return; }
    if (url.pathname === "/workspace/work-summary" && request.method === "GET") {
      writeJson(response, 200, await readWorkSummary(store, secrets)); return;
    }
    if (url.pathname === "/workspace/work-summary/pull-requests" && request.method === "POST") {
      const body = await readJsonBody(request, 4096);
      if (!body || typeof body !== "object" || !("url" in body) || typeof body.url !== "string") throw new Error("url is required");
      store.attachWorkSummaryPullRequest(parseSummaryPullRequest(body.url).url, new Date().toISOString());
      writeJson(response, 200, { ok: true }); return;
    }
    if (url.pathname === "/workspace/work-summary/pull-requests" && request.method === "DELETE") {
      store.detachWorkSummaryPullRequest(parseSummaryPullRequest(url.searchParams.get("url") ?? "").url);
      writeJson(response, 200, { ok: true }); return;
    }
    writeJson(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    writeJson(response, 400, { error: "work_summary_failed", message: error instanceof Error ? error.message : String(error) });
  }
}

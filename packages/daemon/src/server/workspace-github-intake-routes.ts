import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import { allowLocalWorkspaceRequest } from "../shared/local-workspace-access.js";
import { readJsonBody } from "../shared/request.js";
import { writeJson } from "../shared/response.js";
import { isRecord } from "../shared/validation.js";
import { listGitHubIntakePolicies, pollGitHubIntake } from "./app-server-github-intake.js";

export async function handleWorkspaceGitHubIntake(request: IncomingMessage, response: ServerResponse, url: URL, context: DaemonContext): Promise<void> {
  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) throw new HttpError(400, "cwd_required", "cwd query parameter is required.");
  if (!allowLocalWorkspaceRequest({ request, response, storeRegistry: context.storeRegistry, cwd })) return;
  const store = context.storeRegistry.getInitializedStore(cwd);
  if (!store) throw new HttpError(404, "workspace_not_loaded", "Open this project before inspecting GitHub intake.");
  if (request.method === "GET") {
    writeJson(response, 200, listGitHubIntakePolicies(context, store));
  } else if (request.method === "POST") {
    if (context.activeRuns.isShuttingDown()) throw new HttpError(503, "server_draining", "The daemon is shutting down.");
    const body = await readJsonBody(request, 8 * 1024);
    if (!isRecord(body)) throw new HttpError(400, "invalid_params", "Supply GitHub intake poll parameters.");
    const result = await pollGitHubIntake(context, store, body);
    if (result.receipts.some(receipt => receipt.outcome === "accepted")) context.automationEvents.poke(store.paths.cwd);
    writeJson(response, 200, result);
  } else {
    writeJson(response, 405, { error: "method_not_allowed" });
  }
}

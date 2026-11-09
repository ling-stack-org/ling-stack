import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { allowLocalServiceRequest, allowLocalWorkspaceRequest } from "../../shared/local-workspace-access.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import type { WorkflowIsolationHost } from "./workflow-isolation-selection.js";
import { readWorkflowConflictRecovery, recoverWorkflowConflict } from "./workflow-conflict-recovery.js";

export async function handleWorkflowConflictRecovery(input: { readonly request: IncomingMessage; readonly response: ServerResponse;
  readonly url: URL; readonly workflowId: string; readonly config: ResolvedDaemonConfig; readonly storeRegistry: RunStoreRegistry;
  readonly runnerRegistry: RunnerRegistry; readonly host: WorkflowIsolationHost }): Promise<void> {
  const { request, response, url } = input;
  try {
    if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Conflict recovery supports GET and POST.");
    if (!allowLocalServiceRequest(request, response)) return;
    const cwd = url.searchParams.get("cwd");
    if (!cwd) throw new HttpError(400, "bad_request", "cwd query parameter is required");
    if (!allowLocalWorkspaceRequest({ request, response, cwd, storeRegistry: input.storeRegistry })) return;
    const store = input.storeRegistry.getStore(cwd);
    if (!store.getChannelWorkflow(input.workflowId)) throw new HttpError(404, "workflow_not_found", "Workflow not found.");
    if (request.method === "GET") {
      const recovery = readWorkflowConflictRecovery(store, input.workflowId);
      if (!recovery) throw new HttpError(404, "workflow_recovery.not_found", "No explicit conflict recovery has been created.");
      writeJson(response, 200, recovery);
      return;
    }
    const body = await readJsonBody(request, input.config.maxBodyBytes);
    writeJson(response, 200, await recoverWorkflowConflict({ store, workflowId: input.workflowId, request: body,
      runnerRegistry: input.runnerRegistry, host: input.host }));
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request", message: error instanceof Error ? error.message : "Invalid conflict recovery request",
    });
  }
}

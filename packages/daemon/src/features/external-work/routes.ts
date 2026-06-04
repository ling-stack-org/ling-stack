import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ExternalWorkDetailResponse,
  ExternalWorkListResponse,
  ExternalWorkRecord,
  ExternalWorkView,
  RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  readOptionalExternalSourceKindQuery,
  readOptionalExternalWorkItemKindQuery,
  readOptionalExternalWorkSchedulerStatusQuery,
} from "./schemas.js";

export async function handleExternalWorkCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work list` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const records = store.listExternalWorkRecords({
      channelId: url.searchParams.get("channelId") ?? undefined,
      sourceKind: readOptionalExternalSourceKindQuery(url),
      workItemKind: readOptionalExternalWorkItemKindQuery(url),
      schedulerStatus: readOptionalExternalWorkSchedulerStatusQuery(url),
      limit: readOptionalIntegerQuery(url, "limit", 1),
    });
    const responseBody: ExternalWorkListResponse = {
      cwd,
      externalWork: records.map((record) => buildExternalWorkView(store, record)),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleExternalWorkItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  externalWorkId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work detail` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const record = store.getExternalWorkRecord(externalWorkId);
    if (!record) {
      writeJson(response, 404, { error: "external_work_not_found", message: `External work item not found: ${externalWorkId}` });
      return;
    }
    const responseBody: ExternalWorkDetailResponse = {
      cwd,
      externalWork: buildExternalWorkView(store, record),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export function buildExternalWorkView(store: RunStore, externalWork: ExternalWorkRecord): ExternalWorkView {
  const workflow = store.getChannelWorkflow(externalWork.workflowId);
  const workflowStep = store.getChannelWorkflowStep(externalWork.workflowStepId);
  const schedulerState = store.getExternalWorkSchedulerState(externalWork.id);
  return {
    externalWork,
    ...(workflow ? { workflow } : {}),
    ...(workflowStep ? { workflowStep } : {}),
    ...(schedulerState ? { schedulerState } : {}),
    artifacts: store.listExternalWorkArtifacts(externalWork.id),
  };
}

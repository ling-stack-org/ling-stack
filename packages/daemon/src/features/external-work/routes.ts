import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildExternalWorkActionView,
  type ChannelDecision,
  ExternalWorkDetailResponse,
  ExternalWorkListResponse,
  ExternalWorkRecord,
  ExternalWorkRouteResponse,
  ExternalWorkView,
  type RunStore,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  readExternalWorkRouteRequest,
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

export async function handleExternalWorkRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  externalWorkId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work routing` });
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
    const input = readExternalWorkRouteRequest(body);
    const store = storeRegistry.getStore(cwd);
    const existing = store.getExternalWorkRecord(externalWorkId);
    if (!existing) {
      writeJson(response, 404, { error: "external_work_not_found", message: `External work item not found: ${externalWorkId}` });
      return;
    }
    const targetChannel = store.getChannel(input.channelId);
    if (!targetChannel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }
    if (input.assigneeTeammateId && !store.getAiTeammate(input.assigneeTeammateId)) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${input.assigneeTeammateId}` });
      return;
    }
    const priorityChanged = input.priority !== undefined && input.priority !== existing.item.priority;
    const channelChanged = input.channelId !== existing.channelId;
    const now = new Date().toISOString();
    const routed = store.routeExternalWorkRecord(externalWorkId, input, now);
    if (!routed) {
      writeJson(response, 404, { error: "external_work_not_found", message: `External work item not found: ${externalWorkId}` });
      return;
    }
    const decision = channelChanged || priorityChanged || input.assigneeTeammateId
      ? createExternalWorkRouteDecision(store, {
        externalWork: routed,
        fromChannelId: existing.channelId,
        toChannelId: input.channelId,
        priorityChanged,
        assigneeTeammateId: input.assigneeTeammateId,
        now,
      })
      : undefined;
    const actions = store.listExternalWorkActions({ externalWorkId: routed.id }).map((action) => buildExternalWorkActionView(store, action));
    const responseBody: ExternalWorkRouteResponse = {
      cwd,
      externalWork: buildExternalWorkView(store, routed),
      actions,
      ...(decision ? { decision } : {}),
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

function createExternalWorkRouteDecision(
  store: RunStore,
  input: {
    readonly externalWork: ExternalWorkRecord;
    readonly fromChannelId: string;
    readonly toChannelId: string;
    readonly priorityChanged: boolean;
    readonly assigneeTeammateId?: string;
    readonly now: string;
  },
): ChannelDecision {
  const fromChannel = store.getChannel(input.fromChannelId);
  const toChannel = store.getChannel(input.toChannelId);
  const parts = [`Routed external work ${input.externalWork.identifier}`];
  if (fromChannel?.name || toChannel?.name) {
    parts.push(`from ${fromChannel?.name ?? input.fromChannelId} to ${toChannel?.name ?? input.toChannelId}`);
  }
  if (input.externalWork.item.priority !== undefined && input.priorityChanged) {
    parts.push(`priority ${input.externalWork.item.priority}`);
  }
  if (input.assigneeTeammateId) {
    const teammate = store.getAiTeammate(input.assigneeTeammateId);
    parts.push(`assignee ${teammate?.displayName ?? input.assigneeTeammateId}`);
  }
  return store.createChannelDecision({
    channelId: input.toChannelId,
    title: "External work routed",
    decision: parts.join("; "),
    rationale: "Recorded by local external work routing. No external system mutation was performed.",
    alternatives: [],
    createdBy: "local-user",
  }, input.now);
}

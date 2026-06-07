import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ListWorkItemsOptions,
  WorkItemClaimRequest,
  WorkItemCompleteRequest,
  WorkItemFailRequest,
  WorkItemHeartbeatRequest,
  WorkItemReleaseRequest,
  WorkItemRouteRequest,
  WorkItemStatus,
  WorkItemSourceType,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import {
  isRecord,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readOptionalStringArray,
  readString,
  readStringAllowEmpty,
} from "../../shared/validation.js";

const workItemStatuses = [
  "intake",
  "triage",
  "backlog",
  "ready",
  "running",
  "waiting",
  "review",
  "blocked",
  "done",
  "archived",
] as const satisfies readonly WorkItemStatus[];

const workItemSourceTypes = [
  "channel_task",
  "channel_workflow_step",
  "external_work",
  "external_work_action",
  "approval",
  "run",
  "manual",
] as const satisfies readonly WorkItemSourceType[];

export async function handleWorkItemsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for work item list` });
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
    const now = new Date().toISOString();
    const options: ListWorkItemsOptions = {
      channelId: url.searchParams.get("channelId") ?? undefined,
      status: readOptionalWorkItemStatusQuery(url),
      sourceType: readOptionalWorkItemSourceTypeQuery(url),
      assigneeTeammateId: url.searchParams.get("assigneeTeammateId") ?? undefined,
      limit: readOptionalIntegerQuery(url, "limit", 1),
    };
    writeJson(response, 200, {
      cwd,
      workItems: store.listWorkItems(options, now),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleWorkItemRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workItemId: string,
  action?: "route" | "claim" | "heartbeat" | "release" | "complete" | "fail",
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getWorkItem(workItemId);
    if (!existing) {
      writeJson(response, 404, { error: "work_item_not_found", message: `Work item not found: ${workItemId}` });
      return;
    }

    if (!action) {
      if (request.method !== "GET") {
        writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for work item detail` });
        return;
      }
      writeJson(response, 200, { cwd, workItem: existing });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for work item ${action}` });
      return;
    }

    const now = new Date().toISOString();
    const body = await readJsonBody(request, config.maxBodyBytes);
    if (action === "route") {
      const input = readWorkItemRouteRequest(body);
      const routed = store.routeWorkItem(workItemId, input, now);
      if (!routed) {
        writeJson(response, 404, { error: "work_item_not_found", message: `Work item not found: ${workItemId}` });
        return;
      }
      writeJson(response, 200, { cwd, workItem: routed });
      return;
    }
    if (action === "claim") {
      const input = readWorkItemClaimRequest(body);
      const result = store.claimWorkItem(workItemId, input, now);
      if (!result) {
        writeJson(response, 404, { error: "work_item_not_found", message: `Work item not found: ${workItemId}` });
        return;
      }
      writeJson(response, 200, {
        cwd,
        workItem: result.workItem,
        ...(result.claimToken ? { claimToken: result.claimToken } : {}),
        ...(result.blocker ? { blocker: result.blocker } : {}),
      });
      return;
    }
    if (action === "heartbeat") {
      const input = readWorkItemHeartbeatRequest(body);
      const heartbeated = store.heartbeatWorkItem(workItemId, input, now);
      if (!heartbeated) {
        writeJson(response, 409, { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." });
        return;
      }
      writeJson(response, 200, { cwd, workItem: heartbeated });
      return;
    }
    if (action === "release") {
      const input = readWorkItemReleaseRequest(body);
      const released = store.releaseWorkItem(workItemId, input, now);
      if (!released) {
        writeJson(response, 409, { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." });
        return;
      }
      writeJson(response, 200, { cwd, workItem: released });
      return;
    }
    if (action === "complete") {
      const input = readWorkItemCompleteRequest(body);
      const completed = store.completeWorkItem(workItemId, input, now);
      if (!completed) {
        writeJson(response, 409, { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." });
        return;
      }
      writeJson(response, 200, { cwd, workItem: completed });
      return;
    }

    const input = readWorkItemFailRequest(body);
    const failed = store.failWorkItem(workItemId, input, now);
    if (!failed) {
      writeJson(response, 409, { error: "work_item_claim_mismatch", message: "Work item claim token is invalid or expired." });
      return;
    }
    writeJson(response, 200, { cwd, workItem: failed });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function readOptionalWorkItemStatusQuery(url: URL): WorkItemStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!workItemStatuses.includes(value as WorkItemStatus)) {
    throw new Error(`status must be one of: ${workItemStatuses.join(", ")}`);
  }
  return value as WorkItemStatus;
}

function readOptionalWorkItemSourceTypeQuery(url: URL): WorkItemSourceType | undefined {
  const value = url.searchParams.get("sourceType");
  if (value === null) {
    return undefined;
  }
  if (!workItemSourceTypes.includes(value as WorkItemSourceType)) {
    throw new Error(`sourceType must be one of: ${workItemSourceTypes.join(", ")}`);
  }
  return value as WorkItemSourceType;
}

function readWorkItemRouteRequest(body: unknown): WorkItemRouteRequest {
  if (!isRecord(body)) {
    throw new Error("work item route request must be a JSON object");
  }
  const channelId = readOptionalString(body, "channelId");
  const priority = readOptionalString(body, "priority");
  if (priority !== undefined && priority !== "low" && priority !== "normal" && priority !== "high" && priority !== "urgent") {
    throw new Error("priority must be one of: low, normal, high, urgent");
  }
  const assigneeTeammateId = readOptionalNullableString(body, "assigneeTeammateId");
  return {
    channelId,
    priority: priority as WorkItemRouteRequest["priority"],
    assigneeTeammateId,
  };
}

function readWorkItemClaimRequest(body: unknown): WorkItemClaimRequest {
  if (!isRecord(body)) {
    throw new Error("work item claim request must be a JSON object");
  }
  return {
    ownerId: readStringAllowEmpty(body, "ownerId").trim(),
    leaseMs: readOptionalNumber(body, "leaseMs"),
  };
}

function readWorkItemHeartbeatRequest(body: unknown): WorkItemHeartbeatRequest {
  if (!isRecord(body)) {
    throw new Error("work item heartbeat request must be a JSON object");
  }
  return {
    claimToken: readString(body, "claimToken"),
    leaseMs: readOptionalNumber(body, "leaseMs"),
  };
}

function readWorkItemReleaseRequest(body: unknown): WorkItemReleaseRequest {
  if (!isRecord(body)) {
    throw new Error("work item release request must be a JSON object");
  }
  return { claimToken: readString(body, "claimToken") };
}

function readWorkItemCompleteRequest(body: unknown): WorkItemCompleteRequest {
  if (!isRecord(body)) {
    throw new Error("work item complete request must be a JSON object");
  }
  return {
    claimToken: readString(body, "claimToken"),
    proofArtifactIds: readOptionalStringArray(body, "proofArtifactIds"),
  };
}

function readWorkItemFailRequest(body: unknown): WorkItemFailRequest {
  if (!isRecord(body)) {
    throw new Error("work item fail request must be a JSON object");
  }
  return {
    claimToken: readString(body, "claimToken"),
    reason: readStringAllowEmpty(body, "reason").trim(),
    retry: readOptionalBoolean(body, "retry"),
  };
}

function readOptionalNullableString(value: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in value)) {
    return undefined;
  }
  const raw = value[key];
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

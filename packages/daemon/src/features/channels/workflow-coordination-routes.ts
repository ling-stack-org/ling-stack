import type { IncomingMessage, ServerResponse } from "node:http";
import {
  workflowHandoffIntentStatuses,
  workflowSelectorDecisionStatuses,
  type CreateWorkflowHandoffIntentInput,
  type RunStore,
  type UpdateWorkflowHandoffIntentInput,
  type WorkflowHandoffIntentStatus,
  type WorkflowPacketSourceRef,
  type WorkflowSelectorDecisionStatus,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readJsonBody, readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readNullableString, readOptionalString, readString } from "../../shared/validation.js";
import {
  acceptWorkflowHandoffIntent,
  createValidatedWorkflowHandoffIntent,
} from "./workflow-handoffs.js";

export async function handleWorkflowHandoffIntentsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = requestUrl(request, config);
  const store = storeFromRequest(url, response, storeRegistry);
  if (!store) {
    return;
  }
  try {
    if (request.method === "GET") {
      writeJson(response, 200, {
        handoffIntents: store.listWorkflowHandoffIntents({
          channelId: url.searchParams.get("channelId") ?? undefined,
          workflowId: url.searchParams.get("workflowId") ?? undefined,
          sourceWorkflowStepId: url.searchParams.get("sourceWorkflowStepId") ?? undefined,
          sourceRunId: url.searchParams.get("sourceRunId") ?? undefined,
          status: readOptionalWorkflowHandoffIntentStatusQuery(url, "status"),
          limit: readOptionalIntegerQuery(url, "limit", 100),
        }),
      });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const intent = createValidatedWorkflowHandoffIntent({
        store,
        intent: parseCreateWorkflowHandoffIntentInput(body),
        now: new Date().toISOString(),
      });
      writeJson(response, 201, { handoffIntent: intent });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow handoff intents` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleWorkflowHandoffIntentItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  intentId: string,
): Promise<void> {
  const url = requestUrl(request, config);
  const store = storeFromRequest(url, response, storeRegistry);
  if (!store) {
    return;
  }
  try {
    const existing = store.getWorkflowHandoffIntent(intentId);
    if (!existing) {
      writeJson(response, 404, { error: "workflow_handoff_intent_not_found", message: `Workflow handoff intent not found: ${intentId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { handoffIntent: existing });
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = store.updateWorkflowHandoffIntent(intentId, parseWorkflowHandoffIntentUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { handoffIntent: updated ?? existing });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow handoff intent` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleWorkflowHandoffIntentAccept(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  intentId: string,
): Promise<void> {
  const url = requestUrl(request, config);
  const store = storeFromRequest(url, response, storeRegistry);
  if (!store) {
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for accepting workflow handoff intent` });
    return;
  }
  try {
    writeJson(response, 200, acceptWorkflowHandoffIntent({ store, intentId, now: new Date().toISOString() }));
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleWorkflowSelectorDecisionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = requestUrl(request, config);
  const store = storeFromRequest(url, response, storeRegistry);
  if (!store) {
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow selector decisions` });
    return;
  }
  try {
    writeJson(response, 200, {
      selectorDecisions: store.listWorkflowSelectorDecisions({
        channelId: url.searchParams.get("channelId") ?? undefined,
        workflowId: url.searchParams.get("workflowId") ?? undefined,
        sourceWorkflowStepId: url.searchParams.get("sourceWorkflowStepId") ?? undefined,
        selectedWorkflowStepId: url.searchParams.get("selectedWorkflowStepId") ?? undefined,
        status: readOptionalWorkflowSelectorDecisionStatusQuery(url, "status"),
        limit: readOptionalIntegerQuery(url, "limit", 100),
      }),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

export async function handleWorkflowSelectorDecisionItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  decisionId: string,
): Promise<void> {
  const url = requestUrl(request, config);
  const store = storeFromRequest(url, response, storeRegistry);
  if (!store) {
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow selector decision` });
    return;
  }
  const decision = store.getWorkflowSelectorDecision(decisionId);
  if (!decision) {
    writeJson(response, 404, { error: "workflow_selector_decision_not_found", message: `Workflow selector decision not found: ${decisionId}` });
    return;
  }
  writeJson(response, 200, { selectorDecision: decision });
}

function requestUrl(request: IncomingMessage, config: ResolvedDaemonConfig): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
}

function storeFromRequest(url: URL, response: ServerResponse, storeRegistry: RunStoreRegistry): RunStore | undefined {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return undefined;
  }
  return storeRegistry.getStore(cwd);
}

function parseCreateWorkflowHandoffIntentInput(value: unknown): CreateWorkflowHandoffIntentInput {
  if (!isRecord(value)) {
    throw new Error("Workflow handoff intent request must be a JSON object");
  }
  return {
    channelId: readString(value, "channelId"),
    workflowId: readOptionalString(value, "workflowId"),
    sourceWorkflowStepId: readOptionalString(value, "sourceWorkflowStepId"),
    sourceRunId: readOptionalString(value, "sourceRunId"),
    sourceMessageId: readOptionalString(value, "sourceMessageId"),
    channelHandoffId: readOptionalString(value, "channelHandoffId"),
    fromParticipantId: readString(value, "fromParticipantId"),
    fromParticipantLabel: readString(value, "fromParticipantLabel"),
    toParticipantId: readString(value, "toParticipantId"),
    toParticipantLabel: readOptionalString(value, "toParticipantLabel"),
    reason: readString(value, "reason"),
    requiredInput: readString(value, "requiredInput"),
    expectedOutput: readString(value, "expectedOutput"),
    riskSummary: readOptionalString(value, "riskSummary"),
    sourceRefs: readOptionalWorkflowPacketSourceRefs(value, "sourceRefs"),
    createdBy: readString(value, "createdBy") as CreateWorkflowHandoffIntentInput["createdBy"],
  };
}

function parseWorkflowHandoffIntentUpdateInput(value: unknown): UpdateWorkflowHandoffIntentInput {
  if (!isRecord(value)) {
    throw new Error("Workflow handoff intent update must be a JSON object");
  }
  return {
    channelHandoffId: readNullableString(value, "channelHandoffId"),
    toParticipantLabel: readNullableString(value, "toParticipantLabel"),
    reason: readOptionalString(value, "reason"),
    requiredInput: readOptionalString(value, "requiredInput"),
    expectedOutput: readOptionalString(value, "expectedOutput"),
    riskSummary: readNullableString(value, "riskSummary"),
    sourceRefs: readOptionalWorkflowPacketSourceRefs(value, "sourceRefs"),
    status: readOptionalWorkflowHandoffIntentStatus(value, "status"),
  };
}

function readOptionalWorkflowPacketSourceRefs(record: Record<string, unknown>, key: string): readonly WorkflowPacketSourceRef[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    return {
      type: readString(item, "type") as WorkflowPacketSourceRef["type"],
      id: readString(item, "id"),
      label: readOptionalString(item, "label"),
    };
  });
}

function readOptionalWorkflowHandoffIntentStatus(record: Record<string, unknown>, key: string): WorkflowHandoffIntentStatus | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!workflowHandoffIntentStatuses.includes(value as WorkflowHandoffIntentStatus)) {
    throw new Error(`${key} must be a workflow handoff intent status`);
  }
  return value as WorkflowHandoffIntentStatus;
}

function readOptionalWorkflowHandoffIntentStatusQuery(url: URL, key: string): WorkflowHandoffIntentStatus | undefined {
  const value = url.searchParams.get(key);
  return value && workflowHandoffIntentStatuses.includes(value as WorkflowHandoffIntentStatus) ? value as WorkflowHandoffIntentStatus : undefined;
}

function readOptionalWorkflowSelectorDecisionStatusQuery(url: URL, key: string): WorkflowSelectorDecisionStatus | undefined {
  const value = url.searchParams.get(key);
  return value && workflowSelectorDecisionStatuses.includes(value as WorkflowSelectorDecisionStatus) ? value as WorkflowSelectorDecisionStatus : undefined;
}

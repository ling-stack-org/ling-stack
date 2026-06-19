import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildLingToolNamespaceCatalog,
  type LingToolDescriptor,
  type LingToolNamespace,
  type LingToolNamespaceCatalog,
  type RunStore,
} from "@ling-stack/core";
import type {
  CreateToolLoadRequest,
  ToolLoadRequestResponse,
  ToolLoadRequestScope,
  ToolMaterializationSummary,
  ToolSurfaceDefaultApproval,
  ToolSurfaceResponse,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalString, readString } from "../../shared/validation.js";

export function handleToolSurfacesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /tool-surfaces` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const runId = url.searchParams.get("runId") ?? undefined;
    const store = runId ? storeRegistry.findStoreForRun(runId, cwd) : storeRegistry.getStore(cwd);
    const run = runId ? store?.getRun(runId) : undefined;
    if (runId && (!store || !run)) {
      writeJson(response, 404, { error: "run_not_found", message: `Run was not found for tool surface catalog: ${runId}` });
      return;
    }
    if (!store) {
      writeJson(response, 404, { error: "workspace_not_found", message: `Workspace store was not found: ${cwd}` });
      return;
    }

    const body: ToolSurfaceResponse = {
      cwd,
      ...(runId ? { runId } : {}),
      catalog: buildToolCatalog(store, runnerRegistry, new Date().toISOString()),
    };
    writeJson(response, 200, body);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleToolLoadRequestsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runnerRegistry: RunnerRegistry,
  runId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for tool load requests` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.findStoreForRun(runId, cwd);
    const run = store?.getRun(runId);
    if (!store || !run) {
      writeJson(response, 404, {
        error: "run_not_found",
        message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
      });
      return;
    }

    const input = parseCreateToolLoadRequest(await readJsonBody(request, config.maxBodyBytes));
    const now = new Date().toISOString();
    const catalog = buildToolCatalog(store, runnerRegistry, now);
    const selection = resolveToolLoadScope(catalog, input.scope);
    const idempotencyDigest = input.idempotencyKey ? hashIdempotencyKey(input.idempotencyKey) : undefined;
    const existingMaterialization = idempotencyDigest
      ? findExistingMaterialization(store, run.workUnitId, runId, idempotencyDigest)
      : undefined;
    const materialization = existingMaterialization ?? buildMaterializationSummary(runId, selection.namespace, selection.tools, now);

    if (!existingMaterialization) {
      appendToolMaterializationRuntimeEvent(store, run.workUnitId, materialization, input, now, idempotencyDigest);
    }

    const body: ToolLoadRequestResponse = {
      cwd,
      runId,
      catalog,
      materialization,
    };
    writeJson(response, 201, body);
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildToolCatalog(store: RunStore, runnerRegistry: RunnerRegistry, generatedAt: string): LingToolNamespaceCatalog {
  return buildLingToolNamespaceCatalog({
    approvalPolicy: store.getApprovalPolicy(),
    mcpServers: store.listMcpServers(),
    mcpTools: store.listMcpTools(),
    skills: store.listSkillRegistryEntries().map((entry) => entry.definition),
    runners: runnerRegistry.list().map((runner) => ({
      id: runner.id,
      displayName: runner.displayName,
      status: runner.status,
      supportedTools: runner.supportedTools,
    })),
    generatedAt,
  });
}

function parseCreateToolLoadRequest(value: unknown): CreateToolLoadRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const scopeValue = value.scope;
  if (!isRecord(scopeValue)) {
    throw new Error("scope must be an object");
  }
  const kind = readString(scopeValue, "kind");
  let scope: ToolLoadRequestScope;
  if (kind === "namespace") {
    scope = { kind, namespaceId: readString(scopeValue, "namespaceId") };
  } else if (kind === "tool") {
    scope = { kind, toolId: readString(scopeValue, "toolId") };
  } else {
    throw new Error("scope.kind must be namespace or tool");
  }
  return {
    scope,
    reason: readOptionalString(value, "reason"),
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
  };
}

function resolveToolLoadScope(
  catalog: LingToolNamespaceCatalog,
  scope: ToolLoadRequestScope,
): { readonly namespace: LingToolNamespace; readonly tools: readonly LingToolDescriptor[] } {
  if (scope.kind === "namespace") {
    const namespace = catalog.namespaces.find((candidate) => candidate.id === scope.namespaceId);
    if (!namespace) {
      throw new HttpError(404, "tool_namespace_not_found", `Tool namespace was not found: ${scope.namespaceId}`);
    }
    return { namespace, tools: namespace.tools };
  }

  for (const namespace of catalog.namespaces) {
    const tool = namespace.tools.find((candidate) => candidate.id === scope.toolId);
    if (tool) {
      return { namespace, tools: [tool] };
    }
  }
  throw new HttpError(404, "tool_not_found", `Tool was not found: ${scope.toolId}`);
}

function buildMaterializationSummary(
  runId: string,
  namespace: LingToolNamespace,
  tools: readonly LingToolDescriptor[],
  generatedAt: string,
): ToolMaterializationSummary {
  const executionApprovalSummary: Record<ToolSurfaceDefaultApproval, number> = { allow: 0, ask: 0, deny: 0 };
  for (const tool of tools) {
    executionApprovalSummary[tool.executionApproval] += 1;
  }
  return {
    id: `tool_materialization_${randomUUID()}`,
    runId,
    namespaceId: namespace.id,
    toolIds: tools.map((tool) => tool.id),
    materializedToolCount: tools.length,
    disabledToolCount: tools.filter((tool) => !tool.enabled).length,
    executionApprovalSummary,
    generatedAt,
  };
}

function appendToolMaterializationRuntimeEvent(
  store: RunStore,
  workUnitId: string | undefined,
  materialization: ToolMaterializationSummary,
  input: CreateToolLoadRequest,
  now: string,
  idempotencyDigest: string | undefined,
): void {
  if (!workUnitId) {
    return;
  }
  const workUnit = store.getWorkUnit(workUnitId);
  if (!workUnit) {
    return;
  }
  const attemptId = workUnit.activeAttemptId ?? store.listWorkUnitAttempts(workUnit.id).at(-1)?.id;
  store.appendRuntimeEvent({
    workUnitId,
    attemptId,
    type: "tool_namespace_materialized",
    actor: "system",
    ts: now,
    data: {
      materializationId: materialization.id,
      runId: materialization.runId,
      namespaceId: materialization.namespaceId,
      toolIds: materialization.toolIds,
      materializedToolCount: materialization.materializedToolCount,
      disabledToolCount: materialization.disabledToolCount,
      executionApprovalSummary: materialization.executionApprovalSummary,
      scopeKind: input.scope.kind,
      reasonProvided: Boolean(input.reason),
      idempotencyKeyProvided: Boolean(input.idempotencyKey),
      ...(idempotencyDigest ? { idempotencyDigest } : {}),
    },
  });
}

function findExistingMaterialization(
  store: RunStore,
  workUnitId: string | undefined,
  runId: string,
  idempotencyDigest: string,
): ToolMaterializationSummary | undefined {
  if (!workUnitId) {
    return undefined;
  }
  for (const event of store.listRuntimeEvents(workUnitId, { limit: 1000 })) {
    if (event.type !== "tool_namespace_materialized" || !isRecord(event.data)) {
      continue;
    }
    if (event.data.runId !== runId || event.data.idempotencyDigest !== idempotencyDigest) {
      continue;
    }
    const materialization = materializationFromRuntimeEventData(event.data, runId, event.ts);
    if (materialization) {
      return materialization;
    }
  }
  return undefined;
}

function materializationFromRuntimeEventData(
  data: Record<string, unknown>,
  runId: string,
  generatedAt: string,
): ToolMaterializationSummary | undefined {
  if (
    typeof data.materializationId !== "string" ||
    typeof data.namespaceId !== "string" ||
    !Array.isArray(data.toolIds) ||
    typeof data.materializedToolCount !== "number" ||
    typeof data.disabledToolCount !== "number" ||
    !isRecord(data.executionApprovalSummary)
  ) {
    return undefined;
  }
  const toolIds = data.toolIds.filter((toolId): toolId is string => typeof toolId === "string");
  if (toolIds.length !== data.toolIds.length) {
    return undefined;
  }
  return {
    id: data.materializationId,
    runId,
    namespaceId: data.namespaceId,
    toolIds,
    materializedToolCount: data.materializedToolCount,
    disabledToolCount: data.disabledToolCount,
    executionApprovalSummary: {
      allow: readApprovalCount(data.executionApprovalSummary, "allow"),
      ask: readApprovalCount(data.executionApprovalSummary, "ask"),
      deny: readApprovalCount(data.executionApprovalSummary, "deny"),
    },
    generatedAt,
  };
}

function readApprovalCount(summary: Record<string, unknown>, key: ToolSurfaceDefaultApproval): number {
  const value = summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hashIdempotencyKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

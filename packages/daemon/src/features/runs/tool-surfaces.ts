import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildLingToolNamespaceCatalog,
  toRuntimeAttemptFence,
  type LingToolDescriptor,
  type LingToolNamespace,
  type LingToolNamespaceCatalog,
  type RunSession,
  type RunStore,
} from "@ling-stack/core";
import type {
  CreateToolLoadRequest,
  ToolMaterializationBudget,
  ToolLoadRequestResponse,
  ToolLoadRequestScope,
  ToolMaterializationSummary,
  ToolSurfaceDefaultApproval,
  ToolSurfaceResponse,
  RunnerHydratedToolDescriptor,
  RunnerToolHydrationObservability,
  RunnerToolHydrationRequest,
  RunnerToolHydrationRejectionCode,
  RunnerToolHydrationResponse,
} from "@ling-stack/contracts";
import type { ResolvedDaemonConfig } from "../../config.js";
import { HttpError } from "../../errors.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { readJsonBody } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";
import { isRecord, readOptionalString, readString } from "../../shared/validation.js";
import { estimateTextTokens, resolveProviderContextBudget } from "../channels/context-packs.js";

const MAX_MATERIALIZED_TOOL_COUNT = 64;

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
    const result = materializeToolSurface({
      store,
      runnerRegistry,
      run,
      request: input,
      now: new Date().toISOString(),
    });

    const body: ToolLoadRequestResponse = {
      cwd,
      runId,
      catalog: result.catalog,
      materialization: result.materialization,
    };
    writeJson(response, 201, body);
  } catch (error) {
    if (error instanceof ToolMaterializationBudgetError) {
      writeJson(response, error.statusCode, {
        error: error.code,
        message: error.message,
        budget: error.budget,
      });
      return;
    }
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function hydrateRunnerToolSurface(input: {
  readonly store: RunStore;
  readonly runnerRegistry: RunnerRegistry;
  readonly run: RunSession;
  readonly request: RunnerToolHydrationRequest;
  readonly now?: string;
}): RunnerToolHydrationResponse {
  const generatedAt = input.now ?? new Date().toISOString();
  try {
    const result = materializeToolSurface({
      store: input.store,
      runnerRegistry: input.runnerRegistry,
      run: input.run,
      request: {
        scope: input.request.scope,
        reason: input.request.reason,
        idempotencyKey: input.request.idempotencyKey,
      },
      now: generatedAt,
    });
    const tools = result.tools.map(toRunnerHydratedToolDescriptor);
    return {
      ok: true,
      materialization: result.materialization,
      tools,
      hydration: buildAcceptedRunnerHydrationObservability(input.request, result.materialization, result.tools, generatedAt),
      generatedAt,
    };
  } catch (error) {
    if (error instanceof ToolMaterializationBudgetError) {
      const hydration = buildRejectedRunnerHydrationObservability(input.request, "tool_materialization_over_budget", false, generatedAt, {
        budget: error.budget,
      });
      appendToolHydrationRejectedRuntimeEvent(input.store, input.run, input.request, hydration, generatedAt);
      return {
        ok: false,
        code: "tool_materialization_over_budget",
        message: error.message,
        retryable: false,
        budget: error.budget,
        hydration,
        generatedAt,
      };
    }
    if (error instanceof HttpError && isRunnerHydrationRejectionCode(error.code)) {
      const hydration = buildRejectedRunnerHydrationObservability(input.request, error.code, false, generatedAt);
      appendToolHydrationRejectedRuntimeEvent(input.store, input.run, input.request, hydration, generatedAt);
      return {
        ok: false,
        code: error.code,
        message: error.message,
        retryable: false,
        hydration,
        generatedAt,
      };
    }
    const hydration = buildRejectedRunnerHydrationObservability(input.request, "invalid_hydration_request", false, generatedAt);
    appendToolHydrationRejectedRuntimeEvent(input.store, input.run, input.request, hydration, generatedAt);
    return {
      ok: false,
      code: "invalid_hydration_request",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      hydration,
      generatedAt,
    };
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

function materializeToolSurface(input: {
  readonly store: RunStore;
  readonly runnerRegistry: RunnerRegistry;
  readonly run: RunSession;
  readonly request: CreateToolLoadRequest;
  readonly now: string;
}): {
  readonly catalog: LingToolNamespaceCatalog;
  readonly materialization: ToolMaterializationSummary;
  readonly tools: readonly LingToolDescriptor[];
} {
  const catalog = buildToolCatalog(input.store, input.runnerRegistry, input.now);
  const selection = resolveToolLoadScope(catalog, input.request.scope);
  const budget = buildMaterializationBudget(input.store, input.run, selection.namespace, selection.tools);
  const idempotencyDigest = input.request.idempotencyKey ? hashIdempotencyKey(input.request.idempotencyKey) : undefined;
  const existingMaterialization = idempotencyDigest
    ? findExistingMaterialization(input.store, input.run.workUnitId, input.run.id, idempotencyDigest, budget)
    : undefined;
  if (!existingMaterialization) {
    assertMaterializationWithinBudget(budget);
  }
  const materialization = existingMaterialization ??
    buildMaterializationSummary(input.run.id, selection.namespace, selection.tools, budget, input.now);

  if (!existingMaterialization) {
    appendToolMaterializationRuntimeEvent(input.store, input.run.workUnitId, materialization, selection.tools, input.request, input.now, idempotencyDigest);
  }

  return {
    catalog,
    materialization,
    tools: selection.tools,
  };
}

function toRunnerHydratedToolDescriptor(tool: LingToolDescriptor): RunnerHydratedToolDescriptor {
  return {
    id: tool.id,
    namespaceId: tool.namespaceId,
    sourceKind: tool.sourceKind,
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    inputSchema: tool.inputSchema,
    sideEffectLevel: tool.sideEffectLevel,
    defaultApproval: tool.defaultApproval,
    executionApproval: tool.executionApproval,
    enabled: tool.enabled,
    disabledReasons: tool.disabledReasons,
  };
}

function buildAcceptedRunnerHydrationObservability(
  request: RunnerToolHydrationRequest,
  materialization: ToolMaterializationSummary,
  tools: readonly LingToolDescriptor[],
  generatedAt: string,
): RunnerToolHydrationObservability {
  return {
    status: "accepted",
    ...hydrationScopeSummary(request.scope),
    materializationId: materialization.id,
    descriptorIds: materialization.toolIds,
    descriptorSchemaHashes: tools.map(hashToolDescriptorSchema),
    schemaReturnedToRunner: true,
    materializedToolCount: materialization.materializedToolCount,
    disabledToolCount: materialization.disabledToolCount,
    budgetDecision: materialization.budget.decision,
    overBudgetByTokens: materialization.budget.overBudgetByTokens,
    generatedAt,
  };
}

function buildRejectedRunnerHydrationObservability(
  request: RunnerToolHydrationRequest,
  code: RunnerToolHydrationRejectionCode,
  retryable: boolean,
  generatedAt: string,
  input: {
    readonly budget?: ToolMaterializationBudget;
    readonly materialization?: ToolMaterializationSummary;
  } = {},
): RunnerToolHydrationObservability {
  return {
    status: "rejected",
    ...hydrationScopeSummary(request.scope),
    ...(input.materialization ? { materializationId: input.materialization.id } : {}),
    descriptorIds: input.materialization?.toolIds ?? [],
    descriptorSchemaHashes: [],
    schemaReturnedToRunner: false,
    materializedToolCount: input.materialization?.materializedToolCount ?? 0,
    disabledToolCount: input.materialization?.disabledToolCount ?? 0,
    ...(input.budget ? {
      budgetDecision: input.budget.decision,
      overBudgetByTokens: input.budget.overBudgetByTokens,
    } : {}),
    rejectionCode: code,
    retryable,
    generatedAt,
  };
}

function hydrationScopeSummary(scope: ToolLoadRequestScope): Pick<RunnerToolHydrationObservability, "scopeKind" | "namespaceId" | "toolId"> {
  if (scope.kind === "namespace") {
    return { scopeKind: "namespace", namespaceId: scope.namespaceId };
  }
  return { scopeKind: "tool", toolId: scope.toolId };
}

function isRunnerHydrationRejectionCode(code: string): code is Exclude<RunnerToolHydrationResponse, { readonly ok: true }>["code"] {
  return code === "tool_namespace_not_found" ||
    code === "tool_not_found" ||
    code === "invalid_hydration_request" ||
    code === "hydration_not_supported" ||
    code === "tool_materialization_denied" ||
    code === "tool_materialization_over_budget";
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
  budget: ToolMaterializationBudget,
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
    budget,
    generatedAt,
  };
}

function buildMaterializationBudget(
  store: RunStore,
  run: RunSession,
  namespace: LingToolNamespace,
  tools: readonly LingToolDescriptor[],
): ToolMaterializationBudget {
  const providerPreset = run.providerPresetId ? store.getProviderPreset(run.providerPresetId) : undefined;
  const contextBudget = resolveProviderContextBudget(providerPreset, run.workflowStepId ? "workflow_step" : "channel_reply");
  const estimatedTokens = estimateMaterializedToolTokens(namespace, tools);
  const overBudgetByTokens = Math.max(0, estimatedTokens - contextBudget.inputBudgetTokens);
  const overBudgetByCount = tools.length > MAX_MATERIALIZED_TOOL_COUNT;
  return {
    decision: overBudgetByTokens > 0 || overBudgetByCount ? "over_budget" : "within_budget",
    estimatedTokens,
    inputBudgetTokens: contextBudget.inputBudgetTokens,
    remainingBudgetTokens: Math.max(0, contextBudget.inputBudgetTokens - estimatedTokens),
    overBudgetByTokens,
    requestedToolCount: tools.length,
    maxMaterializedToolCount: MAX_MATERIALIZED_TOOL_COUNT,
    mode: contextBudget.mode,
    tokenizer: contextBudget.tokenizer,
    capabilitySource: contextBudget.capabilitySource,
    capabilityConfidence: contextBudget.capabilityConfidence,
  };
}

function estimateMaterializedToolTokens(namespace: LingToolNamespace, tools: readonly LingToolDescriptor[]): number {
  const payload = {
    schemaVersion: 1,
    namespace: {
      id: namespace.id,
      kind: namespace.kind,
      displayName: namespace.displayName,
      ownerId: namespace.ownerId,
    },
    tools: tools.map((tool) => ({
      id: tool.id,
      namespaceId: tool.namespaceId,
      sourceKind: tool.sourceKind,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      sideEffectLevel: tool.sideEffectLevel,
      defaultApproval: tool.defaultApproval,
      executionApproval: tool.executionApproval,
      schemaAvailable: tool.schemaAvailable,
      enabled: tool.enabled,
      disabledReasons: tool.disabledReasons,
      requiredBySkillIds: tool.requiredBySkillIds,
      supportedByRunnerIds: tool.supportedByRunnerIds,
    })),
  };
  return estimateTextTokens(JSON.stringify(payload));
}

function assertMaterializationWithinBudget(budget: ToolMaterializationBudget): void {
  if (budget.decision === "within_budget") {
    return;
  }
  const countClause = budget.requestedToolCount > budget.maxMaterializedToolCount
    ? ` and requested ${budget.requestedToolCount} tools exceeds the maximum ${budget.maxMaterializedToolCount}`
    : "";
  throw new ToolMaterializationBudgetError(
    budget,
    `Tool materialization is over the run context budget: estimated ${budget.estimatedTokens} tokens, input budget ${budget.inputBudgetTokens}${countClause}.`,
  );
}

class ToolMaterializationBudgetError extends Error {
  readonly statusCode = 413;
  readonly code = "tool_materialization_over_budget";

  constructor(
    readonly budget: ToolMaterializationBudget,
    message: string,
  ) {
    super(message);
  }
}

function appendToolMaterializationRuntimeEvent(
  store: RunStore,
  workUnitId: string | undefined,
  materialization: ToolMaterializationSummary,
  tools: readonly LingToolDescriptor[],
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
  const event = {
    type: "tool_namespace_materialized",
    actor: "system" as const,
    ts: now,
    data: {
      materializationId: materialization.id,
      runId: materialization.runId,
      namespaceId: materialization.namespaceId,
      toolIds: [...materialization.toolIds],
      descriptorIds: [...materialization.toolIds],
      descriptorSchemaHashes: tools.map(hashToolDescriptorSchema),
      materializedToolCount: materialization.materializedToolCount,
      disabledToolCount: materialization.disabledToolCount,
      executionApprovalSummary: materialization.executionApprovalSummary,
      budget: materialization.budget,
      hydrationStatus: "accepted",
      schemaReturnedToRunner: false,
      scopeKind: input.scope.kind,
      reasonProvided: Boolean(input.reason),
      idempotencyKeyProvided: Boolean(input.idempotencyKey),
      ...(idempotencyDigest ? { idempotencyDigest } : {}),
    },
  } as const;
  const attempt = attemptId ? store.getWorkUnitAttempt(attemptId) : undefined;
  if (attempt) {
    store.appendRuntimeEvent({ ...toRuntimeAttemptFence(attempt), ...event });
  } else if (!attemptId) {
    store.appendRuntimeEvent({ workUnitId, ...event });
  }
}

function appendToolHydrationRejectedRuntimeEvent(
  store: RunStore,
  run: RunSession,
  request: RunnerToolHydrationRequest,
  hydration: RunnerToolHydrationObservability,
  now: string,
): void {
  if (!run.workUnitId) {
    return;
  }
  const workUnit = store.getWorkUnit(run.workUnitId);
  if (!workUnit) {
    return;
  }
  const attemptId = workUnit.activeAttemptId ?? store.listWorkUnitAttempts(workUnit.id).at(-1)?.id;
  const event = {
    type: "tool_hydration_rejected",
    actor: "system" as const,
    ts: now,
    data: {
      runId: request.runId,
      runnerAttemptId: request.runnerAttemptId,
      hydrationStatus: hydration.status,
      rejectionCode: hydration.rejectionCode,
      retryable: hydration.retryable,
      scopeKind: hydration.scopeKind,
      ...(hydration.namespaceId ? { namespaceId: hydration.namespaceId } : {}),
      ...(hydration.toolId ? { toolId: hydration.toolId } : {}),
      descriptorIds: hydration.descriptorIds,
      descriptorSchemaHashes: hydration.descriptorSchemaHashes,
      materializedToolCount: hydration.materializedToolCount,
      disabledToolCount: hydration.disabledToolCount,
      schemaReturnedToRunner: hydration.schemaReturnedToRunner,
      ...(hydration.budgetDecision ? { budgetDecision: hydration.budgetDecision } : {}),
      ...(hydration.overBudgetByTokens !== undefined ? { overBudgetByTokens: hydration.overBudgetByTokens } : {}),
      reasonProvided: Boolean(request.reason),
      idempotencyKeyProvided: Boolean(request.idempotencyKey),
      idempotencyDigest: hashIdempotencyKey(request.idempotencyKey),
    },
  } as const;
  const attempt = attemptId ? store.getWorkUnitAttempt(attemptId) : undefined;
  if (attempt) {
    store.appendRuntimeEvent({ ...toRuntimeAttemptFence(attempt), ...event });
  } else if (!attemptId) {
    store.appendRuntimeEvent({ workUnitId: run.workUnitId, ...event });
  }
}

function findExistingMaterialization(
  store: RunStore,
  workUnitId: string | undefined,
  runId: string,
  idempotencyDigest: string,
  fallbackBudget: ToolMaterializationBudget,
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
    const materialization = materializationFromRuntimeEventData(event.data, runId, event.ts, fallbackBudget);
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
  fallbackBudget: ToolMaterializationBudget,
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
  const budget = readMaterializationBudget(data.budget) ?? fallbackBudget;
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
    budget,
    generatedAt,
  };
}

function readMaterializationBudget(value: unknown): ToolMaterializationBudget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.decision !== "within_budget" && value.decision !== "over_budget") {
    return undefined;
  }
  if (value.mode !== "model_known" && value.mode !== "model_estimated" && value.mode !== "model_unknown") {
    return undefined;
  }
  if (value.tokenizer !== "openai-compatible" && value.tokenizer !== "anthropic-compatible" && value.tokenizer !== "estimated") {
    return undefined;
  }
  const estimatedTokens = readFiniteNumber(value.estimatedTokens);
  const inputBudgetTokens = readFiniteNumber(value.inputBudgetTokens);
  const remainingBudgetTokens = readFiniteNumber(value.remainingBudgetTokens);
  const overBudgetByTokens = readFiniteNumber(value.overBudgetByTokens);
  const requestedToolCount = readFiniteNumber(value.requestedToolCount);
  const maxMaterializedToolCount = readFiniteNumber(value.maxMaterializedToolCount);
  if (
    estimatedTokens === undefined ||
    inputBudgetTokens === undefined ||
    remainingBudgetTokens === undefined ||
    overBudgetByTokens === undefined ||
    requestedToolCount === undefined ||
    maxMaterializedToolCount === undefined
  ) {
    return undefined;
  }
  return {
    decision: value.decision,
    estimatedTokens,
    inputBudgetTokens,
    remainingBudgetTokens,
    overBudgetByTokens,
    requestedToolCount,
    maxMaterializedToolCount,
    mode: value.mode,
    tokenizer: value.tokenizer,
    ...(typeof value.capabilitySource === "string" ? { capabilitySource: value.capabilitySource } : {}),
    ...(typeof value.capabilityConfidence === "string" ? { capabilityConfidence: value.capabilityConfidence } : {}),
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readApprovalCount(summary: Record<string, unknown>, key: ToolSurfaceDefaultApproval): number {
  const value = summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hashToolDescriptorSchema(tool: LingToolDescriptor): string {
  return createHash("sha256")
    .update(JSON.stringify({
      id: tool.id,
      inputSchema: tool.inputSchema ?? null,
    }))
    .digest("hex");
}

function hashIdempotencyKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

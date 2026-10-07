import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostToolResultAdapter, type HostToolResultAdapter } from "../host-tool-results.js";
import type {
  PiRunnerHydratedToolDescriptor,
  PiRunnerRunOptions,
  PiRunnerToolHydrationRequest,
  PiRunnerToolHydrationScope,
} from "../types.js";
import { isRecord } from "../utils.js";

export const TOOL_HYDRATION_LOAD_TOOL_NAME = "load_tools";
export const TOOL_HYDRATION_CALL_TOOL_NAME = "hydrated_tool_call";

export function createLingStackToolHydrationExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const adaptResult = createHostToolResultAdapter(pi);
    const hydratedToolsById = new Map<string, PiRunnerHydratedToolDescriptor>();
    pi.registerTool(createLoadToolsDefinition(options, hydratedToolsById));
    pi.registerTool(createHydratedToolCallDefinition(options, hydratedToolsById, adaptResult));
  };
}

function createLoadToolsDefinition(
  options: PiRunnerRunOptions,
  hydratedToolsById: Map<string, PiRunnerHydratedToolDescriptor>,
): ToolDefinition {
  return {
    name: TOOL_HYDRATION_LOAD_TOOL_NAME,
    label: "Load tools",
    description: "Load a bounded Ling Stack tool namespace or single tool schema for this runner turn.",
    promptSnippet: "Load additional tool schemas from Ling Stack before using hydrated_tool_call.",
    parameters: {
      type: "object",
      properties: {
        scopeKind: {
          type: "string",
          enum: ["namespace", "tool"],
          description: "Load a namespace or a single tool.",
        },
        namespaceId: {
          type: "string",
          description: "Namespace id to load when scopeKind is namespace.",
        },
        toolId: {
          type: "string",
          description: "Tool id to load when scopeKind is tool.",
        },
        reason: {
          type: "string",
          description: "Why these tool schemas are needed for the current turn.",
        },
      },
      required: ["scopeKind", "reason"],
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      if (!options.onToolHydrationRequest) {
        throw new Error("Ling Stack tool hydration is not connected in this runner.");
      }
      const request = buildHydrationRequest(options, params);
      options.onEvent?.({
        type: "tool_hydration_request",
        runId: request.runId,
        runnerAttemptId: request.runnerAttemptId,
        scope: request.scope,
        idempotencyKeyProvided: Boolean(request.idempotencyKey),
      });
      const response = await options.onToolHydrationRequest(request);
      if (!response.ok) {
        options.onEvent?.({
          type: "tool_hydration_end",
          runId: request.runId,
          runnerAttemptId: request.runnerAttemptId,
          materializationId: response.materialization?.id,
          toolIds: response.materialization?.toolIds,
          descriptorSchemaHashes: response.hydration?.descriptorSchemaHashes,
          materializedToolCount: response.hydration?.materializedToolCount,
          disabledToolCount: response.hydration?.disabledToolCount,
          schemaReturnedToRunner: response.hydration?.schemaReturnedToRunner ?? false,
          budgetDecision: response.hydration?.budgetDecision ?? response.budget?.decision,
          overBudgetByTokens: response.hydration?.overBudgetByTokens ?? response.budget?.overBudgetByTokens,
          rejected: true,
          code: response.code,
        });
        throw new Error(response.message);
      }
      for (const tool of response.tools) {
        hydratedToolsById.set(tool.id, tool);
      }
      options.onEvent?.({
        type: "tool_hydration_end",
        runId: request.runId,
        runnerAttemptId: request.runnerAttemptId,
        materializationId: response.materialization.id,
        toolIds: response.materialization.toolIds,
        descriptorSchemaHashes: response.hydration?.descriptorSchemaHashes,
        materializedToolCount: response.hydration?.materializedToolCount ?? response.materialization.materializedToolCount,
        disabledToolCount: response.hydration?.disabledToolCount ?? response.materialization.disabledToolCount,
        schemaReturnedToRunner: response.hydration?.schemaReturnedToRunner ?? true,
        budgetDecision: response.hydration?.budgetDecision ?? response.materialization.budget.decision,
        overBudgetByTokens: response.hydration?.overBudgetByTokens ?? response.materialization.budget.overBudgetByTokens,
        rejected: false,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            materialization: response.materialization,
            tools: response.tools,
            usage: "Call hydrated_tool_call with { toolId, input } for enabled MCP tools. Core tools should be called by their native names.",
          }),
        }],
        details: {
          materialization: response.materialization,
          tools: response.tools.map((tool) => ({
            id: tool.id,
            enabled: tool.enabled,
            executionApproval: tool.executionApproval,
          })),
        },
      };
    },
  };
}

function createHydratedToolCallDefinition(
  options: PiRunnerRunOptions,
  hydratedToolsById: Map<string, PiRunnerHydratedToolDescriptor>,
  adaptResult: HostToolResultAdapter,
): ToolDefinition {
  return {
    name: TOOL_HYDRATION_CALL_TOOL_NAME,
    label: "Hydrated tool call",
    description: "Call an MCP tool that was loaded through load_tools. Approval is checked by Ling Stack before execution.",
    promptSnippet: "Call a hydrated MCP tool after loading it with load_tools.",
    parameters: {
      type: "object",
      properties: {
        toolId: {
          type: "string",
          description: "Hydrated tool id returned by load_tools.",
        },
        input: {
          type: "object",
          description: "Tool input matching the hydrated schema.",
        },
      },
      required: ["toolId", "input"],
    } as ToolDefinition["parameters"],
    executionMode: "sequential",
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const toolId = readRequiredString(params, "toolId");
      const input = isRecord(params) && Object.hasOwn(params, "input") ? params.input : undefined;
      const tool = hydratedToolsById.get(toolId);
      if (!tool) {
        throw new Error(`Hydrated tool was not loaded in this runner turn: ${toolId}`);
      }
      if (!tool.enabled) {
        throw new Error(`Hydrated tool ${toolId} is disabled: ${tool.disabledReasons.map((reason) => reason.code).join(", ")}`);
      }
      if (tool.sourceKind !== "mcp_tool") {
        throw new Error(`Hydrated core tool ${tool.name} should be called through the native runner tool surface.`);
      }
      const serverId = readMcpServerId(tool);
      if (options.onApprovalRequired) {
        const decision = await options.onApprovalRequired({
          toolCallId,
          toolName: tool.name,
          input,
          task: options.task,
          cwd: options.cwd,
          defaultApproval: tool.executionApproval,
        });
        if (!decision.approved) {
          throw new Error(decision.reason ?? `Hydrated MCP tool ${tool.name} was denied by Ling Stack approval policy.`);
        }
        signal?.throwIfAborted();
      } else if (tool.executionApproval !== "allow") {
        throw new Error(`Hydrated MCP tool ${tool.name} requires approval but no approval handler is configured.`);
      }
      if (!options.onMcpToolCall) {
        throw new Error(`Hydrated MCP tool ${tool.name} is not connected in this runner.`);
      }
      const result = await options.onMcpToolCall({
        toolCallId,
        registeredName: `${TOOL_HYDRATION_CALL_TOOL_NAME}:${tool.id}`,
        serverId,
        rawName: tool.name,
        input,
        task: options.task,
        cwd: options.cwd,
        defaultApproval: tool.executionApproval,
        signal,
      });
      signal?.throwIfAborted();
      return adaptResult(toolCallId, TOOL_HYDRATION_CALL_TOOL_NAME, {
        ...result,
        details: {
          serverId,
          rawName: tool.name,
          toolId: tool.id,
          result: result.details,
        },
      });
    },
  };
}

function buildHydrationRequest(options: PiRunnerRunOptions, params: unknown): PiRunnerToolHydrationRequest {
  const scope = readHydrationScope(params);
  const reason = readRequiredString(params, "reason");
  const runId = options.runId ?? options.task.id;
  const runnerAttemptId = options.runnerAttemptId ?? "attempt_pi";
  return {
    runId,
    runnerAttemptId,
    scope,
    reason,
    idempotencyKey: `${runId}:${runnerAttemptId}:${scope.kind}:${scope.kind === "namespace" ? scope.namespaceId : scope.toolId}`,
    task: options.task,
    cwd: options.cwd,
  };
}

function readHydrationScope(params: unknown): PiRunnerToolHydrationScope {
  const scopeKind = readRequiredString(params, "scopeKind");
  if (scopeKind === "namespace") {
    return { kind: "namespace", namespaceId: readRequiredString(params, "namespaceId") };
  }
  if (scopeKind === "tool") {
    return { kind: "tool", toolId: readRequiredString(params, "toolId") };
  }
  throw new Error("scopeKind must be namespace or tool.");
}

function readRequiredString(value: unknown, key: string): string {
  if (!isRecord(value)) {
    throw new Error(`${key} is required.`);
  }
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw new Error(`${key} is required.`);
  }
  return field;
}

function readMcpServerId(tool: PiRunnerHydratedToolDescriptor): string {
  if (tool.namespaceId.startsWith("mcp:")) {
    return tool.namespaceId.slice("mcp:".length);
  }
  const [, serverId] = tool.id.split(":");
  if (serverId) {
    return serverId;
  }
  throw new Error(`Hydrated MCP tool id is invalid: ${tool.id}`);
}

import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import type { PiRunnerRunOptions } from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackMcpProxyExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const adaptResult = createHostToolResultAdapter(pi);
    for (const tool of options.mcpTools ?? []) {
      const definition: ToolDefinition = {
        name: tool.registeredName,
        label: tool.displayName,
        description: tool.description ?? `Call MCP tool ${tool.rawName} from ${tool.serverId}.`,
        promptSnippet: `Call MCP tool ${tool.displayName}`,
        parameters: normalizeMcpToolParameters(tool.inputSchema),
        executionMode: tool.sideEffectLevel === "read" ? "parallel" : "sequential",
        execute: async (toolCallId, params, signal) => {
          signal?.throwIfAborted();
          if (!options.onMcpToolCall) {
            throw new Error(`MCP tool ${tool.rawName} is not connected in this runner.`);
          }
          if (options.onApprovalRequired) {
            const decision = await options.onApprovalRequired({
              toolCallId,
              toolName: tool.registeredName,
              input: params,
              task: options.task,
              cwd: options.cwd,
              defaultApproval: tool.defaultApproval,
            });
            if (!decision.approved) {
              throw new Error(decision.reason ?? `MCP tool ${tool.rawName} was denied by Ling Stack approval policy.`);
            }
            signal?.throwIfAborted();
          } else if (tool.defaultApproval !== "allow") {
            throw new Error(`MCP tool ${tool.rawName} requires approval but no approval handler is configured.`);
          }

          const result = await options.onMcpToolCall({
            toolCallId,
            registeredName: tool.registeredName,
            serverId: tool.serverId,
            rawName: tool.rawName,
            input: params,
            task: options.task,
            cwd: options.cwd,
            defaultApproval: tool.defaultApproval,
            signal,
          });
          signal?.throwIfAborted();
          return adaptResult(toolCallId, tool.registeredName, {
            ...result,
            details: {
              serverId: tool.serverId,
              rawName: tool.rawName,
              result: result.details,
            },
          });
        },
      };
      pi.registerTool(definition);
    }
  };
}

function normalizeMcpToolParameters(inputSchema: unknown): ToolDefinition["parameters"] {
  if (isRecord(inputSchema) && inputSchema.type === "object") {
    return inputSchema as ToolDefinition["parameters"];
  }
  return {
    type: "object",
    properties: {},
    required: [],
  } as ToolDefinition["parameters"];
}

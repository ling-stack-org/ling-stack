import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeMcpToolResultContent } from "../content.js";
import type { PiRunnerMcpToolCallResult, PiRunnerRunOptions } from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackMcpProxyExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    for (const tool of options.mcpTools ?? []) {
      const definition: ToolDefinition = {
        name: tool.registeredName,
        label: tool.displayName,
        description: tool.description ?? `Call MCP tool ${tool.rawName} from ${tool.serverId}.`,
        promptSnippet: `Call MCP tool ${tool.displayName}`,
        parameters: normalizeMcpToolParameters(tool.inputSchema),
        executionMode: tool.sideEffectLevel === "read" ? "parallel" : "sequential",
        execute: async (toolCallId, params, signal) => {
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
          });
          if (result.isError) {
            throw new Error(formatMcpToolError(result));
          }
          return {
            content: normalizeMcpToolResultContent(result.content),
            details: {
              serverId: tool.serverId,
              rawName: tool.rawName,
              result: result.details,
            },
          };
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

function formatMcpToolError(result: PiRunnerMcpToolCallResult): string {
  const text = result.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "MCP tool returned an error.";
}

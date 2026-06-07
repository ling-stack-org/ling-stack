import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TOOLS } from "../constants.js";
import type {
  PiRunnerBuiltinToolName,
  PiRunnerPermissionDecision,
  PiRunnerPermissionRequest,
  PiRunnerPermissionRequestKind,
  PiRunnerPermissionScope,
  PiRunnerRunOptions,
} from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackPermissionRequestExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "request_permission",
      label: "request_permission",
      description: "Ask Ling Stack for a narrowly scoped runtime permission grant when the current run is blocked by missing tools or scope.",
      promptSnippet: "Request a runtime permission grant from Ling Stack",
      parameters: {
        type: "object",
        properties: {
          requestKind: {
            type: "string",
            enum: ["core_tool", "write_scope", "mcp_tool", "runner_capability"],
          },
          reason: {
            type: "string",
            description: "Why this permission is needed for the current task.",
          },
          requestedScope: {
            type: "object",
            description: "Structured scope matching requestKind.",
          },
        },
        required: ["requestKind", "reason", "requestedScope"],
      } as ToolDefinition["parameters"],
      async execute(toolCallId, params) {
        if (!options.onPermissionRequired) {
          throw new Error("Ling Stack blocked request_permission: no permission request handler is configured.");
        }
        const request = parsePermissionRequestToolParams(toolCallId, params, options);
        const decision = await options.onPermissionRequired(request);
        return {
          content: [
            {
              type: "text",
              text: formatPermissionDecision(decision),
            },
          ],
          details: decision,
        };
      },
    });
  };
}

function parsePermissionRequestToolParams(
  toolCallId: string,
  params: unknown,
  options: PiRunnerRunOptions,
): PiRunnerPermissionRequest {
  if (!isRecord(params)) {
    throw new Error("request_permission parameters must be an object.");
  }
  const requestKind = readPermissionRequestKind(params.requestKind);
  const reason = readRequiredString(params, "reason");
  const requestedScope = readPermissionScope(params.requestedScope, requestKind);
  return {
    toolCallId,
    requestKind,
    reason,
    requestedScope,
    task: options.task,
    cwd: options.cwd,
  };
}

function readPermissionRequestKind(value: unknown): PiRunnerPermissionRequestKind {
  if (value === "core_tool" || value === "write_scope" || value === "mcp_tool" || value === "runner_capability") {
    return value;
  }
  throw new Error(`Unsupported permission request kind: ${String(value)}.`);
}

function readPermissionScope(value: unknown, requestKind: PiRunnerPermissionRequestKind): PiRunnerPermissionScope {
  if (!isRecord(value)) {
    throw new Error("requestedScope must be an object.");
  }
  const kind = readPermissionRequestKind(value.kind);
  if (kind !== requestKind) {
    throw new Error(`requestedScope.kind ${kind} does not match requestKind ${requestKind}.`);
  }
  if (kind === "core_tool") {
    const tools = readStringArray(value.tools).map(readBuiltinToolName);
    if (tools.length === 0) {
      throw new Error("core_tool requestedScope requires at least one tool.");
    }
    return { kind, tools };
  }
  if (kind === "write_scope") {
    const paths = readStringArray(value.paths);
    if (paths.length === 0) {
      throw new Error("write_scope requestedScope requires at least one path.");
    }
    return {
      kind,
      paths,
      operation: readWriteScopeOperation(value.operation),
    };
  }
  if (kind === "mcp_tool") {
    return {
      kind,
      serverId: readRequiredString(value, "serverId"),
      toolName: readRequiredString(value, "toolName"),
      sideEffectLevel: readRequiredString(value, "sideEffectLevel"),
      defaultApproval: readRequiredString(value, "defaultApproval"),
    };
  }
  return {
    kind,
    runnerId: readRequiredString(value, "runnerId"),
    capability: readRequiredString(value, "capability"),
  };
}

function readBuiltinToolName(value: string): PiRunnerBuiltinToolName {
  if ((DEFAULT_TOOLS as readonly string[]).includes(value)) {
    return value as PiRunnerBuiltinToolName;
  }
  throw new Error(`Unsupported core tool: ${value}.`);
}

function readWriteScopeOperation(value: unknown): "read_write" | "create" | "update" | "delete" {
  if (value === "read_write" || value === "create" || value === "update" || value === "delete") {
    return value;
  }
  throw new Error(`Unsupported write-scope operation: ${String(value)}.`);
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function formatPermissionDecision(decision: PiRunnerPermissionDecision): string {
  if (!decision.approved) {
    return decision.reason ?? "Ling Stack denied the runtime permission request.";
  }
  const mode = decision.grant?.mode ?? "continuation";
  const suffix = mode === "same_run"
    ? "The grant is available to the current run."
    : "The grant is recorded for a continuation; the active tool registry was not changed.";
  return [decision.reason ?? "Ling Stack approved the runtime permission request.", suffix].join(" ");
}

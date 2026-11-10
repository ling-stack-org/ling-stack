import { createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import type { PiRunnerReadonlyToolName, PiRunnerRunOptions } from "../types.js";
import { isRecord } from "../utils.js";

const toolNames = new Set<string>(["read", "grep", "find", "ls"]);

/** Must also run before adapter observation can supply a non-authorizing tool hook. */
export function assertHostReadonlyToolSurface(options: PiRunnerRunOptions): void {
  if (options.readonlyToolsProfile === undefined) return;
  if (options.readonlyToolsProfile !== "host_readonly_v1") throw new Error("workflow_readonly_profile_invalid");
  if (typeof options.onToolBefore !== "function") throw new Error("workflow_readonly_tool_before_missing");
  if (typeof options.onReadonlyToolCall !== "function") throw new Error("workflow_readonly_host_handler_missing");
  const externalNames = [...(options.mcpTools?.map(tool => tool.registeredName) ?? []),
    ...(options.hostCapabilityTools?.map(tool => tool.name) ?? []), ...(options.mediaGenerationTools?.map(tool => tool.name) ?? [])];
  if (externalNames.some(name => toolNames.has(name))) throw new Error("workflow_readonly_tool_name_collision");
}

export function createLingStackHostReadonlyExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    assertHostReadonlyToolSurface(options);
    if (options.readonlyToolsProfile !== "host_readonly_v1") throw new Error("workflow_readonly_profile_required");
    const adapt = createHostToolResultAdapter(pi);
    const definitions = [createReadToolDefinition(options.cwd), createGrepToolDefinition(options.cwd),
      createFindToolDefinition(options.cwd), createLsToolDefinition(options.cwd)] as ToolDefinition[];
    const descriptions: Record<PiRunnerReadonlyToolName, string> = {
      read: "Read a bounded UTF-8 text file through the Host within the approved workspace. Symlinks, private configuration and special files are excluded. Supports 1-indexed offset and line limit.",
      grep: "Search bounded UTF-8 workspace files through the Host using literal:true. Regex is unsupported. Supports glob, ignoreCase, context and match limit; symlinks and private configuration are excluded.",
      find: "Find bounded workspace files through the Host by a simple glob (*, ?, **). Returns workspace-relative paths. Symlinks and private configuration are excluded.",
      ls: "List a bounded workspace directory through the Host. Symlinks and private configuration are excluded. Directory names end in /.",
    };
    for (const original of definitions) {
      const name = original.name as PiRunnerReadonlyToolName;
      pi.registerTool({
        name, label: name, description: descriptions[name],
        parameters: name === "grep" ? literalGrepParameters(original.parameters) : original.parameters,
        renderCall: original.renderCall, renderResult: original.renderResult, renderShell: original.renderShell,
        async execute(toolCallId, input, toolSignal) {
          assertHostReadonlyToolSurface(options);
          const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(toolSignal ? [toolSignal] : [])]);
          signal.throwIfAborted();
          const request = { toolCallId, toolName: name, input, cwd: options.cwd, signal };
          // The SDK can admit a whole batch before dispatch; recheck the actual producer too.
          const decision = await options.onToolBefore!(request);
          signal.throwIfAborted();
          if (!decision.allowed) return adapt(toolCallId, name, { isError: true,
            content: [{ type: "text", text: decision.reason }], details: { code: decision.code } });
          const result = await options.onReadonlyToolCall!(request);
          signal.throwIfAborted();
          if (!result || !Array.isArray(result.content)) throw new Error("workflow_readonly_host_result_missing");
          return adapt(toolCallId, name, result);
        },
      });
    }
  };
}

function literalGrepParameters(original: ToolDefinition["parameters"]): ToolDefinition["parameters"] {
  const base = isRecord(original) ? original : {};
  const properties = isRecord(base.properties) ? base.properties : {};
  return { ...base, properties: { ...properties,
    literal: { type: "boolean", const: true, description: "Required: true. The Host does not execute regular expressions." } },
    required: [...new Set([...(Array.isArray(base.required) ? base.required : []), "literal"])],
  } as ToolDefinition["parameters"];
}

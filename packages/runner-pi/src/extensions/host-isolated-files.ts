import { createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  createWriteToolDefinition, createEditToolDefinition, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import type { PiRunnerIsolatedToolName, PiRunnerRunOptions } from "../types.js";
import { isRecord } from "../utils.js";

const toolNames: readonly PiRunnerIsolatedToolName[] = Object.freeze(["read", "grep", "find", "ls", "write", "edit"]);
const allowedNames = new Set<string>(toolNames);

/** Validate before observation may supply a non-authorizing onToolBefore hook. Never trim requested tools. */
export function assertHostIsolatedFilesToolSurface(options: PiRunnerRunOptions): void {
  if (options.isolatedToolsProfile === undefined) return;
  if (options.isolatedToolsProfile !== "host_isolated_files_v1") throw new Error("workflow_isolated_profile_invalid");
  if (options.readonlyToolsProfile !== undefined) throw new Error("workflow_isolated_profile_conflict");
  if (typeof options.onToolBefore !== "function") throw new Error("workflow_isolated_tool_before_missing");
  if (typeof options.onIsolatedToolCall !== "function") throw new Error("workflow_isolated_host_handler_missing");
  if (options.tools !== undefined && (!Array.isArray(options.tools) || options.tools.some(name => !allowedNames.has(name)))) {
    throw new Error("workflow_isolated_tool_selection_invalid");
  }
  if (options.mcpTools?.length || options.hostCapabilityTools?.length || options.mediaGenerationTools?.length
    || Object.values(options.initialToolSurface ?? {}).some(value => value !== false && value !== undefined)
    || Object.values(options.runtimeToolFeatures ?? {}).some(value => value !== false && value !== undefined)
    || options.onMcpToolCall !== undefined || options.onHostCapabilityCall !== undefined
    || options.onMediaGenerationToolCall !== undefined || options.onToolHydrationRequest !== undefined
    || options.onDelegationToolCall !== undefined || options.onUserInputRequest !== undefined
    || options.onPermissionRequired !== undefined) {
    throw new Error("workflow_isolated_external_surface_forbidden");
  }
}

/** Snapshot only this profile's selection before SDK/Host awaits. Legacy options keep their existing behavior. */
export function withHostIsolatedFilesToolSurface(options: PiRunnerRunOptions): PiRunnerRunOptions {
  assertHostIsolatedFilesToolSurface(options);
  if (options.isolatedToolsProfile === undefined) return options;
  return { ...options, tools: Object.freeze([...(options.tools ?? toolNames)]),
    ...(options.initialToolSurface ? { initialToolSurface: Object.freeze({ ...options.initialToolSurface }) } : {}),
    ...(options.runtimeToolFeatures ? { runtimeToolFeatures: Object.freeze({ ...options.runtimeToolFeatures }) } : {}) };
}

/** Tool routing only. Host must independently establish authority, confinement and mutation semantics. */
export function createLingStackHostIsolatedFilesExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    const assertProfile = (): void => {
      assertHostIsolatedFilesToolSurface(options);
      if (options.isolatedToolsProfile !== "host_isolated_files_v1") throw new Error("workflow_isolated_profile_required");
    };
    assertProfile();
    const selected = new Set(options.tools ?? toolNames);
    const adapt = createHostToolResultAdapter(pi);
    // Defense in depth if an SDK/control path attempts a tool outside the frozen selection.
    pi.on("tool_call", event => selected.has(event.toolName) ? undefined
      : { block: true, reason: "workflow_isolated_tool_denied: Tool is outside the Host isolated-files selection." });
    const definitions = [createReadToolDefinition(options.cwd), createGrepToolDefinition(options.cwd),
      createFindToolDefinition(options.cwd), createLsToolDefinition(options.cwd),
      createWriteToolDefinition(options.cwd), createEditToolDefinition(options.cwd)] as ToolDefinition[];
    const descriptions: Record<PiRunnerIsolatedToolName, string> = {
      read: "Read bounded UTF-8 text through the Host isolated-files handler. Supports 1-indexed offset and line limit. Host admission and path restrictions apply.",
      grep: "Search bounded UTF-8 files through the Host isolated-files handler using literal:true. Regex is unsupported. Supports glob, ignoreCase, context and match limit.",
      find: "Find bounded files through the Host isolated-files handler by a simple glob (*, ?, **). Returns workspace-relative paths.",
      ls: "List a bounded directory through the Host isolated-files handler. Directory names end in /.",
      write: "Write one UTF-8 file using path and content through the Host isolated-files handler. Missing parent directories are not created. Host admission and path restrictions apply.",
      edit: "Edit one UTF-8 file through the Host isolated-files handler using path and edits[]. Each oldText must match exactly once in the original file; replacements must not overlap.",
    };
    for (const original of definitions) {
      const name = original.name as PiRunnerIsolatedToolName;
      pi.registerTool({ name, label: name, description: descriptions[name],
        parameters: name === "grep" ? literalGrepParameters(original.parameters)
          : name === "edit" ? nonemptyEditParameters(original.parameters) : original.parameters,
        executionMode: "sequential",
        renderCall: original.renderCall, renderResult: original.renderResult, renderShell: original.renderShell,
        async execute(toolCallId, input, toolSignal) {
          assertProfile();
          const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(toolSignal ? [toolSignal] : [])]);
          signal.throwIfAborted();
          if (!selected.has(name)) throw new Error("workflow_isolated_tool_denied");
          const request = { toolCallId, toolName: name, input, cwd: options.cwd, signal };
          // SDK batch admission is not the actual producer's current Host authority.
          const decision = await options.onToolBefore!(request);
          signal.throwIfAborted();
          assertProfile();
          if (!decision || typeof decision.allowed !== "boolean") throw new Error("workflow_isolated_tool_before_result_invalid");
          if (!decision.allowed) return adapt(toolCallId, name, { isError: true,
            content: [{ type: "text", text: decision.reason }], details: { code: decision.code } });
          const result = await options.onIsolatedToolCall!(request);
          signal.throwIfAborted();
          if (!result || !Array.isArray(result.content)) throw new Error("workflow_isolated_host_result_missing");
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

function nonemptyEditParameters(original: ToolDefinition["parameters"]): ToolDefinition["parameters"] {
  const base = isRecord(original) ? original : {};
  const properties = isRecord(base.properties) ? base.properties : {};
  const edits = isRecord(properties.edits) ? properties.edits : {};
  // The SDK normally enforces nonempty edits in its execute, which this profile never invokes.
  return { ...base, properties: { ...properties, edits: { ...edits, minItems: 1 } } } as ToolDefinition["parameters"];
}

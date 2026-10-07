import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import type { PiRunnerRunOptions, PiRunnerToolHandledResult } from "../types.js";

/** Register a distinct Host bridge. Never route these calls through MCP or a shell. */
export function createLingStackHostCapabilityExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return pi => {
    assertHostCapabilityToolSurface(options);
    const definitions = options.hostCapabilityTools ?? [];
    const adapt = createHostToolResultAdapter(pi);
    for (const tool of definitions) pi.registerTool({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.inputSchema as ToolDefinition["parameters"], executionMode: "sequential",
      async execute(toolCallId, input, toolSignal) {
        if (!options.runId || !options.runnerAttemptId || !options.onToolBefore || !options.onApprovalRequired || !options.onHostCapabilityCall) {
          throw new Error("Host capability is not connected to a Run/Attempt identity and its authority handlers.");
        }
        const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(toolSignal ? [toolSignal] : [])]);
        const request = { toolCallId, toolName: tool.name, input, cwd: options.cwd };
        signal.throwIfAborted();
        const before = await options.onToolBefore(request);
        signal.throwIfAborted();
        if (!before.allowed) return adapt(toolCallId, tool.name, failure(before.code, before.reason));
        const decision = await options.onApprovalRequired({ ...request, task: options.task, defaultApproval: "ask" });
        signal.throwIfAborted();
        if (!decision.approved || !decision.approvalId || decision.handledResult) {
          return adapt(toolCallId, tool.name, failure("host_capability_approval_required", decision.reason ?? "A durable, scoped Host approval is required."));
        }
        // Approval may have waited while this attempt was cancelled or its policy revoked.
        const after = await options.onToolBefore(request);
        signal.throwIfAborted();
        if (!after.allowed) return adapt(toolCallId, tool.name, failure(after.code, after.reason));
        const result = await options.onHostCapabilityCall({ ...request, capabilityId: tool.capabilityId, contractVersion: 1,
          runId: options.runId, attemptId: options.runnerAttemptId, approvalId: decision.approvalId, task: options.task, signal });
        signal.throwIfAborted();
        return adapt(toolCallId, tool.name, result);
      },
    });
  };
}

/** Run before the SDK loader too: extension-load errors may be treated as diagnostics by the SDK. */
export function assertHostCapabilityToolSurface(options: PiRunnerRunOptions): void {
  if (options.mcpTools?.some(tool => tool.registeredName.startsWith("host_")) || options.tools?.some(name => name.startsWith("host_"))) {
    throw new Error("Host capability names are reserved; MCP and core tools cannot impersonate them.");
  }
  const seen = new Set<string>();
  for (const tool of options.hostCapabilityTools ?? []) {
    const id = tool.name === "host_open_local_target" ? "host.open_local_target"
      : tool.name === "host_local_network_info" ? "host.local_network_info" : undefined;
    if (!id || tool.capabilityId !== id || tool.contractVersion !== 1 || seen.has(tool.name)) {
      throw new Error("Invalid or colliding Host capability tool definition.");
    }
    seen.add(tool.name);
  }
}
function failure(code: string, message: string): PiRunnerToolHandledResult {
  return { isError: true, content: [{ type: "text", text: message }], details: { code } };
}

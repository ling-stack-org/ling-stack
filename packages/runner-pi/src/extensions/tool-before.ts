import type { ExtensionFactory, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions } from "../types.js";

/** All tool names pass through this boundary, including dynamic and future tools. */
export function createLingStackToolBeforeExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
      if (!options.onToolBefore) return undefined;
      try {
        const decision = await options.onToolBefore({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          cwd: options.cwd,
        });
        return decision.allowed ? undefined : {
          block: true,
          reason: decision.code + ": " + decision.reason,
        };
      } catch (error) {
        return {
          block: true,
          reason: "tool_before_gate_failed: " + (error instanceof Error ? error.message : String(error)),
        };
      }
    });
  };
}

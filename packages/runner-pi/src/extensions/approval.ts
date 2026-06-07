import type { ExtensionFactory, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { APPROVAL_REQUIRED_TOOLS, SIDE_EFFECT_TOOLS } from "../constants.js";
import type { PiRunnerApprovalToolName, PiRunnerRunOptions } from "../types.js";

export function createLingStackApprovalExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
      if (!isApprovalToolName(event.toolName)) {
        return undefined;
      }
      if (event.toolName === "edit" || event.toolName === "write") {
        return undefined;
      }

      if (!options.onApprovalRequired) {
        if (!SIDE_EFFECT_TOOLS.has(event.toolName)) {
          return undefined;
        }
        return {
          block: true,
          reason: `Ling Stack blocked ${event.toolName}: no approval handler is configured.`,
        };
      }

      try {
        const decision = await options.onApprovalRequired({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          task: options.task,
          cwd: options.cwd,
        });

        if (decision.approved) {
          return undefined;
        }

        return {
          block: true,
          reason: decision.reason ?? `Ling Stack approval denied ${event.toolName}.`,
        };
      } catch (error) {
        return {
          block: true,
          reason: `Ling Stack approval check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  };
}

function isApprovalToolName(toolName: string): toolName is PiRunnerApprovalToolName {
  return APPROVAL_REQUIRED_TOOLS.has(toolName);
}

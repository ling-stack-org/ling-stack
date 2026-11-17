import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions } from "../types.js";

export function createLingStackHooksExtension(options: PiRunnerRunOptions, stage: "before" | "after"): ExtensionFactory {
  return pi => {
    if (stage === "before") pi.on("tool_call", async event => {
      try {
        if (!options.onLifecycleHook) throw new Error("hooks_runtime_missing");
        const result = await options.onLifecycleHook({ event: "before_tool", toolCallId: event.toolCallId,
          parentToolCallId: event.parentToolCallId, toolName: event.toolName, input: event.input });
        return result.denied ? { block: true, reason: result.denied } : undefined;
      } catch (error) {
        if (options.onTaskContinuationDirectiveFailure) options.onTaskContinuationDirectiveFailure(error);
        throw error;
      }
    });
    if (stage === "after") pi.on("tool_result", async event => {
      try {
        if (!options.onLifecycleHook) throw new Error("hooks_runtime_missing");
        await options.onLifecycleHook({ event: "after_tool", toolCallId: event.toolCallId,
          parentToolCallId: event.parentToolCallId, toolName: event.toolName, input: event.input,
          isError: event.isError, result: { content: event.content, details: event.details } });
        return undefined;
      } catch (error) {
        if (options.onTaskContinuationDirectiveFailure) options.onTaskContinuationDirectiveFailure(error);
        throw error;
      }
    });
  };
}

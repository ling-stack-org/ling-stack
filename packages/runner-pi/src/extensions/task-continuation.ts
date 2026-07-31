import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiRunnerRunOptions } from "../types.js";

/** Pause only at safe model/tool boundaries; never interrupt an atomic tool. */
export function createLingStackTaskContinuationExtension(
  options: PiRunnerRunOptions,
): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async () => {
      await options.onTaskContinuationBoundary?.("before_agent_start");
    });
    pi.on("before_provider_request", async () => {
      await options.onTaskContinuationBoundary?.("before_provider_request");
    });
    pi.on("tool_call", async () => {
      await options.onTaskContinuationBoundary?.("tool_call");
    });
  };
}

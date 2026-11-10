import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createDelegationInstructionContextProjector, readDelegationInstructionDirective } from "../delegation-instruction.js";
import type { PiRunnerRunOptions } from "../types.js";

/** Pause only at safe model/tool boundaries; never interrupt an atomic tool. */
export function createLingStackTaskContinuationExtension(
  options: PiRunnerRunOptions,
): ExtensionFactory {
  return (pi) => {
    const instructions = createDelegationInstructionContextProjector();
    pi.on("before_agent_start", async () => {
      await options.onTaskContinuationBoundary?.("before_agent_start");
    });
    // Inject provider-neutral AgentMessages. Pi may swallow a context-hook error,
    // so every failure is also latched by createPiTaskBoundary.
    pi.on("context", async (event) => {
      // Host boundary errors (including the intentional user-input yield) are
      // already latched by createPiTaskBoundary. Do not reinterpret them as a
      // directive projection failure here.
      const directive = await options.onTaskContinuationBoundary?.("before_provider_request");
      try {
        if (directive !== undefined) instructions.accept(readDelegationInstructionDirective(directive));
        return { messages: instructions.project(event.messages) };
      } catch (error) {
        options.onTaskContinuationDirectiveFailure?.(error);
        throw error;
      }
    });
    pi.on("tool_call", async () => {
      await options.onTaskContinuationBoundary?.("tool_call");
    });
  };
}

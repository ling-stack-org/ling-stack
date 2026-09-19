import { createBashToolDefinition, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeHandledToolResultPreservingError } from "../content.js";
import type { PiRunnerApprovalDecision, PiRunnerRunOptions } from "../types.js";

export function createLingStackBashToolExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const originalBash = createBashToolDefinition(options.cwd) as ToolDefinition;

    pi.registerTool({
      name: "bash",
      label: "bash",
      description: originalBash.description,
      parameters: originalBash.parameters,
      async execute(toolCallId, params) {
        const decision = await requireDaemonHandledBash(options, toolCallId, params);
        if (!decision.handledResult) {
          throw new Error("Ling Stack unified exec approved bash without a handled result.");
        }
        return normalizeHandledToolResultPreservingError(decision.handledResult);
      },
      renderCall: originalBash.renderCall,
      renderResult: originalBash.renderResult,
      renderShell: originalBash.renderShell,
    });
  };
}

async function requireDaemonHandledBash(
  options: PiRunnerRunOptions,
  toolCallId: string,
  input: unknown,
): Promise<PiRunnerApprovalDecision> {
  if (!options.onApprovalRequired) {
    throw new Error("Ling Stack blocked bash: no approval handler is configured.");
  }
  const decision = await options.onApprovalRequired({
    toolCallId,
    toolName: "bash",
    input,
    task: options.task,
    cwd: options.cwd,
  });
  if (decision.handledResult) {
    return decision;
  }
  if (!decision.approved) {
    throw new Error(decision.reason ?? "Ling Stack approval denied bash.");
  }
  return decision;
}

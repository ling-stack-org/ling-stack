import { createBashToolDefinition, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeHandledToolResultPreservingError } from "../content.js";
import type { PiRunnerApprovalDecision, PiRunnerRunOptions } from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackBashToolExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const originalBash = createBashToolDefinition(options.cwd) as ToolDefinition;

    pi.registerTool({
      name: "bash",
      label: "bash",
      description: `${originalBash.description} For a simple low-risk command, you may propose a conservative argv prefix in prefix_rule so the user can allow similar commands in this workspace.`,
      parameters: createCommandRuleAwareBashParameters(originalBash.parameters),
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

function createCommandRuleAwareBashParameters(
  original: ToolDefinition["parameters"],
): ToolDefinition["parameters"] {
  const base = isRecord(original) ? original : {};
  const properties = isRecord(base.properties) ? base.properties : {};
  return {
    ...base,
    type: "object",
    properties: {
      ...properties,
      prefix_rule: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 8,
        description: "Optional literal argv prefix for a workspace-scoped Allow similar commands decision. It must be a true prefix of this command.",
      },
    },
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

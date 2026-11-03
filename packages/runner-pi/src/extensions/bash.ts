import { createBashToolDefinition, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import type { PiRunnerApprovalDecision, PiRunnerRunOptions } from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackBashToolExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const adaptResult = createHostToolResultAdapter(pi);
    const originalBash = createBashToolDefinition(options.cwd) as ToolDefinition;

    pi.registerTool({
      name: "bash",
      label: "bash",
      description: "Execute a shell command through the Ling Stack Host, which validates the working directory and returns stdout/stderr. In a confirmed workflow, the immutable operation selects the working directory; cwd must match it. If cwd is omitted, the Host uses that bound directory or the session workspace by default. Keep an exact command unchanged rather than adding cd to select its directory. Optionally provide a timeout in seconds. For a simple low-risk command, you may propose a conservative argv prefix in prefix_rule so the user can allow similar commands in this workspace.",
      parameters: createCommandRuleAwareBashParameters(originalBash.parameters),
      async execute(toolCallId, params, signal) {
        signal?.throwIfAborted();
        const decision = await requireDaemonHandledBash(options, toolCallId, params);
        signal?.throwIfAborted();
        if (!decision.handledResult) {
          throw new Error("Ling Stack unified exec approved bash without a handled result.");
        }
        return adaptResult(toolCallId, "bash", {
          ...decision.handledResult,
          isError: !decision.approved || decision.handledResult.isError === true,
        });
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
      cwd: {
        type: "string",
        minLength: 1,
        description: "Optional command working directory, relative to the session workspace or absolute. The Host validates it; in a confirmed workflow it must match the immutable operation directory and does not grant additional access.",
      },
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

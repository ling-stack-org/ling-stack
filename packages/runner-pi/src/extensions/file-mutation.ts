import { createEditToolDefinition, createWriteToolDefinition, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHostToolResultAdapter } from "../host-tool-results.js";
import type { PiRunnerApprovalDecision, PiRunnerRunOptions } from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackFileMutationToolExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const adaptResult = createHostToolResultAdapter(pi);
    const originalEdit = createEditToolDefinition(options.cwd) as ToolDefinition;
    const originalWrite = createWriteToolDefinition(options.cwd) as ToolDefinition;

    pi.registerTool({
      name: "edit",
      label: "edit",
      description: `${originalEdit.description} You may also provide patchText with a Codex-compatible apply-patch envelope for multi-file edits.`,
      parameters: createPatchableEditParameters(originalEdit.parameters),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        signal?.throwIfAborted();
        const decision = await requireFileMutationApproval(options, "edit", toolCallId, params);
        signal?.throwIfAborted();
        if (decision.handledResult) {
          return adaptResult(toolCallId, "edit", {
            ...decision.handledResult,
            isError: !decision.approved || decision.handledResult.isError === true,
          });
        }
        return originalEdit.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall: originalEdit.renderCall,
      renderResult: originalEdit.renderResult,
      renderShell: originalEdit.renderShell,
    });

    pi.registerTool({
      name: "write",
      label: "write",
      description: `${originalWrite.description} For structured multi-file changes, provide patchText with a Codex-compatible apply-patch envelope.`,
      parameters: createPatchableWriteParameters(originalWrite.parameters),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        signal?.throwIfAborted();
        const decision = await requireFileMutationApproval(options, "write", toolCallId, params);
        signal?.throwIfAborted();
        if (decision.handledResult) {
          return adaptResult(toolCallId, "write", {
            ...decision.handledResult,
            isError: !decision.approved || decision.handledResult.isError === true,
          });
        }
        return originalWrite.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall: originalWrite.renderCall,
      renderResult: originalWrite.renderResult,
      renderShell: originalWrite.renderShell,
    });
  };
}

async function requireFileMutationApproval(
  options: PiRunnerRunOptions,
  toolName: "edit" | "write",
  toolCallId: string,
  input: unknown,
): Promise<PiRunnerApprovalDecision> {
  if (!options.onApprovalRequired) {
    throw new Error(`Ling Stack blocked ${toolName}: no approval handler is configured.`);
  }
  const decision = await options.onApprovalRequired({
    toolCallId,
    toolName,
    input,
    task: options.task,
    cwd: options.cwd,
  });
  if (!decision.approved && !decision.handledResult) {
    throw new Error(decision.reason ?? `Ling Stack approval denied ${toolName}.`);
  }
  return decision;
}

function createPatchableEditParameters(original: ToolDefinition["parameters"]): ToolDefinition["parameters"] {
  return mergePatchParameters(original, [
    { required: ["path", "edits"] },
    { required: ["patchText"] },
    { required: ["patch"] },
  ]);
}

function createPatchableWriteParameters(original: ToolDefinition["parameters"]): ToolDefinition["parameters"] {
  return mergePatchParameters(original, [
    { required: ["path", "content"] },
    { required: ["patchText"] },
    { required: ["patch"] },
  ]);
}

function mergePatchParameters(
  original: ToolDefinition["parameters"],
  anyOf: readonly { readonly required: readonly string[] }[],
): ToolDefinition["parameters"] {
  const base = isRecord(original) ? original : {};
  const { required: _required, ...rest } = base;
  const properties = isRecord(base.properties) ? base.properties : {};
  return {
    ...rest,
    type: "object",
    properties: {
      ...properties,
      patchText: {
        type: "string",
        description: "Codex-compatible apply-patch text beginning with *** Begin Patch.",
      },
      patch: {
        type: "string",
        description: "Alias for patchText.",
      },
    },
    anyOf,
  } as ToolDefinition["parameters"];
}

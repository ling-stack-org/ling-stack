import type { TextContent } from "@earendil-works/pi-ai";
import { createEditToolDefinition, createWriteToolDefinition, type AgentToolResult, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { normalizeMcpToolResultContent } from "../content.js";
import type { PiRunnerApprovalDecision, PiRunnerRunOptions, PiRunnerToolHandledResult } from "../types.js";
import { isRecord } from "../utils.js";

export function createLingStackFileMutationToolExtension(options: PiRunnerRunOptions): ExtensionFactory {
  return (pi) => {
    const originalEdit = createEditToolDefinition(options.cwd) as ToolDefinition;
    const originalWrite = createWriteToolDefinition(options.cwd) as ToolDefinition;

    pi.registerTool({
      name: "edit",
      label: "edit",
      description: `${originalEdit.description} You may also provide patchText with a Codex-compatible apply-patch envelope for multi-file edits.`,
      parameters: createPatchableEditParameters(originalEdit.parameters),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const decision = await requireFileMutationApproval(options, "edit", toolCallId, params);
        if (decision.handledResult) {
          return normalizeHandledToolResult(decision.handledResult);
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
        const decision = await requireFileMutationApproval(options, "write", toolCallId, params);
        if (decision.handledResult) {
          return normalizeHandledToolResult(decision.handledResult);
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
  if (!decision.approved) {
    throw new Error(decision.reason ?? `Ling Stack approval denied ${toolName}.`);
  }
  return decision;
}

function normalizeHandledToolResult(result: PiRunnerToolHandledResult): AgentToolResult<any> {
  if (result.isError) {
    throw new Error(formatHandledToolError(result));
  }
  return {
    content: normalizeMcpToolResultContent(result.content),
    details: result.details,
  };
}

function formatHandledToolError(result: PiRunnerToolHandledResult): string {
  const text = result.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "Ling Stack handled tool call failed.";
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

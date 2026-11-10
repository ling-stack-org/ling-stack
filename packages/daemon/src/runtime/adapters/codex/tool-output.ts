import { NativeOutputError } from "../native-stream-redaction.js";
import type { ThreadItem } from "./protocol/v2/ThreadItem.js";
import { codexDynamicContent, codexMcpContent } from "./tool-content.js";
import { codexObservedTool, codexObservedTools } from "./observed-tools.js";

type ToolKind = Extract<ThreadItem, { type: "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" }>["type"];
export const codexOutputTools: ReadonlySet<string> = new Set<string>([
  ...new Set<ToolKind>(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"]), ...codexObservedTools, "imageGeneration",
]);
export interface CodexToolOutput { readonly toolName: string; readonly args: unknown; readonly result: Record<string, unknown>; readonly isError: boolean }

export function codexToolOutput(item: Record<string, unknown>, completed: boolean): CodexToolOutput {
  if (item.type === "imageGeneration") return imageGeneration(item, completed);
  if (typeof item.type === "string" && codexObservedTools.has(item.type)) return codexObservedTool(item, completed);
  const status = item.status;
  const terminalStatuses = item.type === "commandExecution" || item.type === "fileChange"
    ? ["completed", "failed", "declined"] : ["completed", "failed"];
  if (typeof status !== "string" || !(completed ? terminalStatuses : ["inProgress"]).includes(status)) invalid();
  let isError = status !== "inProgress" && status !== "completed";
  switch (item.type) {
    case "commandExecution": {
      if (!text(item.command) || !text(item.cwd) || (item.aggregatedOutput != null && typeof item.aggregatedOutput !== "string")
        || (item.exitCode != null && !Number.isSafeInteger(item.exitCode))) invalid();
      isError ||= typeof item.exitCode === "number" && item.exitCode !== 0;
      return { toolName: "bash", args: { command: item.command, cwd: item.cwd }, isError,
        result: { status, content: content(item.aggregatedOutput), exitCode: item.exitCode ?? null, durationMs: item.durationMs ?? null } };
    }
    case "fileChange": {
      if (!Array.isArray(item.changes) || item.changes.length > 256 || !item.changes.every(change => record(change)
        && text(change.path) && typeof change.diff === "string" && record(change.kind)
        && typeof change.kind.type === "string" && ["add", "update", "delete"].includes(change.kind.type)
        && (change.kind.move_path == null || (change.kind.type === "update" && text(change.kind.move_path))))) invalid();
      const changes = item.changes.map(change => ({ path: change.path, kind: change.kind, diff: change.diff }));
      return { toolName: "apply_patch", args: { changes }, isError, result: { status, changes } };
    }
    case "mcpToolCall": {
      if (!text(item.server) || !text(item.tool) || item.arguments === undefined
        || (item.result != null && !record(item.result)) || (item.error != null && !record(item.error))) invalid();
      if (record(item.result) && !Array.isArray(item.result.content)) invalid();
      isError ||= item.error != null;
      return { toolName: `mcp:${item.server}/${item.tool}`, args: item.arguments, isError,
        result: { status, content: record(item.result) ? codexMcpContent(item.result.content) : [],
          structuredContent: record(item.result) ? item.result.structuredContent ?? null : null,
          ...(record(item.error) ? { error: { message: typeof item.error.message === "string" ? item.error.message : "Native tool failed." } } : {}) } };
    }
    case "dynamicToolCall": {
      if (!text(item.tool) || item.arguments === undefined || (item.namespace != null && !text(item.namespace))
        || (completed && status === "completed" && typeof item.success !== "boolean")
        || (item.contentItems != null && !Array.isArray(item.contentItems))) invalid();
      isError ||= item.success === false;
      return { toolName: item.namespace ? `${item.namespace}.${item.tool}` : item.tool, args: item.arguments, isError,
        result: { status, content: codexDynamicContent(item.contentItems ?? []), success: item.success ?? null } };
    }
    default: throw new NativeOutputError("unsupported_item");
  }
}

function imageGeneration(item: Record<string, unknown>, completed: boolean): CodexToolOutput {
  if (!(completed ? ["completed", "failed"] : ["in_progress"]).includes(String(item.status))
    || typeof item.status !== "string" || typeof item.result !== "string"
    || (item.revisedPrompt != null && typeof item.revisedPrompt !== "string")
    || (item.status === "completed" ? !item.result || item.failure != null : Boolean(item.result))) invalid();
  if (item.failure != null && (!record(item.failure) || item.status !== "failed"
    || item.failure.type !== "usageLimitExceeded" || !text(item.failure.limitId)
    || (item.failure.resetsAt !== null && !Number.isSafeInteger(item.failure.resetsAt)))) invalid();
  return { toolName: "image_generation", args: {}, isError: item.status === "failed",
    result: { status: item.status, revisedPrompt: item.revisedPrompt ?? null,
      content: item.status === "completed" ? [{ type: "image", mimeType: "image/*", data: item.result }] : [],
      ...(record(item.failure) ? { failure: { type: item.failure.type, limitId: item.failure.limitId, resetsAt: item.failure.resetsAt } } : {}) } };
}

export function content(text: unknown) { return typeof text === "string" && text ? [{ type: "text", text }] : []; }
function invalid(): never { throw new NativeOutputError("invalid_event"); }
function text(value: unknown): value is string { return typeof value === "string" && Boolean(value); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

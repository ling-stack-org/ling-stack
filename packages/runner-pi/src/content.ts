import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PiRunnerMcpToolCallResult, PiRunnerToolHandledResult } from "./types.js";

export function normalizeMcpToolResultContent(
  content: PiRunnerMcpToolCallResult["content"],
): (TextContent | ImageContent)[] {
  const normalized: (TextContent | ImageContent)[] = [];
  for (const item of content) {
    if (item.type === "text") {
      normalized.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      normalized.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return normalized.length > 0 ? normalized : [{ type: "text", text: "MCP tool completed without textual output." }];
}

export function normalizeHandledToolResult(result: PiRunnerToolHandledResult): AgentToolResult<any> {
  if (result.isError) {
    throw new Error(formatHandledToolError(result));
  }
  return {
    content: normalizeMcpToolResultContent(result.content),
    details: result.details,
  };
}

export function normalizeHandledToolResultPreservingError(result: PiRunnerToolHandledResult): AgentToolResult<any> {
  const normalized: AgentToolResult<any> & { readonly isError: boolean } = {
    content: normalizeMcpToolResultContent(result.content),
    details: result.details,
    isError: result.isError ?? false,
  };
  return normalized;
}

function formatHandledToolError(result: PiRunnerToolHandledResult): string {
  const text = result.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || "Ling Stack handled tool call failed.";
}

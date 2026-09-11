import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PiRunnerMcpToolCallResult, PiRunnerToolHandledResult } from "./types.js";

export function normalizeMcpToolResultContent(
  content: PiRunnerMcpToolCallResult["content"],
  isError = false,
): (TextContent | ImageContent)[] {
  const normalized: (TextContent | ImageContent)[] = [];
  for (const item of content) {
    if (item.type === "text") {
      normalized.push({ type: "text", text: item.text });
    } else if (item.type === "image") {
      normalized.push({ type: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return normalized.length > 0 ? normalized : [{
    type: "text",
    text: isError ? "Ling Stack tool call failed without textual output." : "Ling Stack tool completed without textual output.",
  }];
}

/** Normalize content without discarding failure evidence; status is bridged by host-tool-results. */
export function normalizeHandledToolResult(result: PiRunnerToolHandledResult): AgentToolResult<unknown> {
  return {
    content: normalizeMcpToolResultContent(result.content, result.isError === true),
    details: result.details,
  };
}

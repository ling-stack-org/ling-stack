import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { PiRunnerMcpToolCallResult } from "./types.js";

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

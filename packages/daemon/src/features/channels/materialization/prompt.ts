import type { ChannelInputMaterialization } from "@ling-stack/core";

export function renderMaterializationForPrompt(row: ChannelInputMaterialization): string | undefined {
  if (row.status !== "available" || !row.contentText?.trim()) {
    return undefined;
  }
  return [
    `Materialized input: ${row.sourceKind}:${row.sourceId}`,
    `Content kind: ${row.contentKind}${row.truncated ? " (truncated)" : ""}`,
    row.contentText.trim(),
  ].join("\n");
}

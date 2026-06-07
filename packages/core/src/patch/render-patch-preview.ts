import type { PatchPlan } from "./apply-patch-types.js";

const DEFAULT_PREVIEW_LIMIT = 20_000;

export function renderPatchPreview(plan: PatchPlan, limit = DEFAULT_PREVIEW_LIMIT): string {
  const parts: string[] = [];
  for (const operation of plan.operations) {
    parts.push(`diff --ling a/${operation.path} b/${operation.path}`);
    if (operation.kind === "add") {
      parts.push("--- /dev/null");
      parts.push(`+++ b/${operation.path}`);
    } else if (operation.kind === "delete") {
      parts.push(`--- a/${operation.path}`);
      parts.push("+++ /dev/null");
    } else {
      parts.push(`--- a/${operation.path}`);
      parts.push(`+++ b/${operation.path}`);
    }
    for (const hunk of operation.hunks) {
      parts.push(formatHunkHeader(hunk));
      for (const line of hunk.lines) {
        if (line.kind === "context") {
          parts.push(` ${line.text}`);
        } else if (line.kind === "add") {
          parts.push(`+${line.text}`);
        } else {
          parts.push(`-${line.text}`);
        }
      }
    }
  }
  const preview = `${parts.join("\n")}\n`;
  if (preview.length <= limit) {
    return preview;
  }
  return `${preview.slice(0, limit)}\n... truncated patch preview (${preview.length - limit} chars omitted)\n`;
}

function formatHunkHeader(hunk: PatchPlan["operations"][number]["hunks"][number]): string {
  if (
    hunk.oldStart !== undefined &&
    hunk.oldLines !== undefined &&
    hunk.newStart !== undefined &&
    hunk.newLines !== undefined
  ) {
    return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  }
  return "@@";
}

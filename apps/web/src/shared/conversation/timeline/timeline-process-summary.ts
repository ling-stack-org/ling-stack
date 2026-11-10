import type { ConversationTimelineItem } from "@ling-stack/conversation-ui-core";

/** Count settled typed facts, never infer checks or file edits from command text. */
export interface TimelineProcessSummary {
  readonly reads: number;
  readonly explorations: number;
  readonly changedFiles: number;
  readonly commands: number;
  readonly tools: number;
  readonly toolLoads: number;
  readonly webSearches: number;
}

export function summarizeTimelineProcess(items: readonly ConversationTimelineItem[]): TimelineProcessSummary {
  let reads = 0, explorations = 0, commands = 0, tools = 0, toolLoads = 0, webSearches = 0;
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = (item: ConversationTimelineItem): void => {
    if (item.kind === "commandBatch") { item.batch.commands.forEach(visit); return; }
    if (item.kind === "explorationBatch") { item.batch.children.forEach(visit); return; }
    if (item.status !== "succeeded") return;
    if (!["exploration", "fileChange", "commandExecution", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.kind)) return;
    const key = item.actionId ?? item.id;
    if (seen.has(key)) return;
    seen.add(key);
    if (item.kind === "exploration") {
      if (item.operation === "read") reads += 1;
      else explorations += 1;
    } else if (item.kind === "fileChange") {
      for (const file of item.files) files.add(file.fileRef.path ?? file.fileRef.id);
    } else if (item.kind === "commandExecution") commands += 1;
    else if (item.kind === "mcpToolCall" || item.kind === "dynamicToolCall" || item.kind === "collabAgentToolCall") {
      // Exact runner tool identities; descriptions and shell text are not facts.
      if (item.toolName === "load_tools") toolLoads += 1;
      else if (item.toolName === "web_search") webSearches += 1;
      else tools += 1;
    }
  };
  items.forEach(visit);
  return { reads, explorations, changedFiles: files.size, commands, tools, toolLoads, webSearches };
}

export function timelineActivityCategory(facts: TimelineProcessSummary): "tool" | "edit" | "search" | "web" | "command" {
  if (facts.toolLoads || facts.tools) return "tool";
  if (facts.changedFiles) return "edit";
  if (facts.reads || facts.explorations) return "search";
  if (facts.webSearches) return "web";
  return "command";
}

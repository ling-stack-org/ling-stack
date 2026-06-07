import type { RunSession, ToolName } from "../types.js";

export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function splitShellishArgs(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isRunnerTool(tool: ToolName): tool is "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write" {
  return ["read", "grep", "find", "ls", "bash", "edit", "write"].includes(tool);
}

export function readRunTask(run: RunSession): { readonly id: string; readonly title: string; readonly prompt: string; readonly channelId: string } {
  const task = readRecord(run.taskSnapshot);
  const prompt = readOptionalString(task, "prompt");
  if (!prompt) {
    throw new Error("This run cannot be rerun because its task snapshot has no prompt.");
  }

  return {
    id: readOptionalString(task, "id") ?? run.taskId,
    title: readOptionalString(task, "title") ?? run.taskId,
    prompt,
    channelId: readOptionalString(task, "channelId") ?? run.channelId ?? "workspace",
  };
}

export function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function readStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const items = field.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length > 0 ? items : undefined;
}

export function readToolArray(value: Record<string, unknown>, key: string): ToolName[] | undefined {
  const field = value[key];
  if (!Array.isArray(field)) {
    return undefined;
  }
  const tools = field.filter((item): item is ToolName => typeof item === "string" && isRunnerTool(item as ToolName));
  return tools.length > 0 ? tools : undefined;
}

export function removeUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

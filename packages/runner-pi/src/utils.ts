import type { PiRunnerRunOptions, PiRunnerTask } from "./types.js";

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

export function getLingStackSystemPrompt(options: PiRunnerRunOptions): string {
  return (
    options.systemPrompt ??
    [
      "You are running inside Ling Stack as a scoped AI teammate.",
      "Work on the assigned task only.",
      "Use tools when they materially improve correctness.",
      "Keep outputs concise and leave an auditable trail through tool calls.",
    ].join("\n")
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatTaskPrompt(task: PiRunnerTask): string {
  const lines = [`Task: ${task.title}`, "", task.prompt];
  if (task.channelId) {
    lines.unshift(`Channel: ${task.channelId}`, "");
  }
  return lines.join("\n");
}

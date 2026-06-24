import { isRecord } from "./validation.js";

export function extractAssistantText(messages: readonly unknown[]): string | undefined {
  const roleAwareMessages = messages.filter((message) => typeof readMessageRole(message) === "string");
  const candidates = roleAwareMessages.length > 0
    ? roleAwareMessages.filter((message) => readMessageRole(message) === "assistant")
    : messages;
  for (const message of [...candidates].reverse()) {
    const text = extractTextFromUnknown(message);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function readMessageRole(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.role !== "string") {
    return undefined;
  }
  return value.role;
}

function extractTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    return value.map(extractTextFromUnknown).filter(Boolean).join("").trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["text", "content", "message"]) {
    const text = extractTextFromUnknown(value[key]);
    if (text) {
      return text;
    }
  }
  return undefined;
}

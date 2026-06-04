import { isRecord } from "./validation.js";

export function extractAssistantText(messages: readonly unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const text = extractTextFromUnknown(message);
    if (text) {
      return text;
    }
  }
  return undefined;
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

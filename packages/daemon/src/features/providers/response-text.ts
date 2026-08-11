import type { ProviderApi } from "@ling-stack/core";

export function extractProviderResponseText(api: ProviderApi, value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  if (api === "anthropic-messages") {
    return joinTextBlocks(value.content, new Set(["text"]));
  }
  if (api === "openai-responses") {
    const outputText = readNonEmptyString(value.output_text);
    if (outputText) {
      return outputText;
    }
    return Array.isArray(value.output)
      ? value.output.map((item) => isRecord(item) ? joinTextBlocks(item.content, new Set(["text", "output_text"])) : "").join("")
      : "";
  }
  if (!Array.isArray(value.choices)) {
    return "";
  }
  return value.choices.map((choice) => {
    if (!isRecord(choice)) {
      return "";
    }
    const legacyText = readNonEmptyString(choice.text);
    if (legacyText) {
      return legacyText;
    }
    const message = isRecord(choice.message) ? choice.message : undefined;
    if (!message) {
      return "";
    }
    const contentText = readNonEmptyString(message.content);
    return contentText || joinTextBlocks(message.content, new Set(["text", "output_text"]));
  }).join("");
}

function joinTextBlocks(value: unknown, allowedTypes: ReadonlySet<string>): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.map((item) => {
    if (!isRecord(item) || typeof item.type !== "string" || !allowedTypes.has(item.type)) {
      return "";
    }
    return typeof item.text === "string" ? item.text : "";
  }).join("");
}

function readNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { Translate } from "../../i18n.js";
import type { ProviderThinkingMode } from "../../types.js";
import type { ConversationHomeModelOption } from "./normal-conversation-types.js";

export function normalConversationModelLabel(option: ConversationHomeModelOption): string {
  return option.label?.trim() || option.model;
}

export function normalConversationThinkingOptions(
  modes: readonly ProviderThinkingMode[],
): readonly ProviderThinkingMode[] {
  const selectedModes = new Set(modes);
  const order: readonly ProviderThinkingMode[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const orderedModes = order.filter((mode) => selectedModes.has(mode));
  if (!orderedModes.some((mode) => mode !== "off")) {
    return [];
  }
  return orderedModes.includes("off") ? orderedModes : ["off", ...orderedModes];
}

export function normalConversationThinkingLabel(mode: ProviderThinkingMode, t: Translate): string {
  switch (mode) {
    case "off":
      return t("Off");
    case "auto":
      return t("Auto");
    case "minimal":
      return t("Minimal");
    case "low":
      return t("Low");
    case "medium":
      return t("Medium");
    case "high":
      return t("High");
    case "xhigh":
      return t("XHigh");
  }
}

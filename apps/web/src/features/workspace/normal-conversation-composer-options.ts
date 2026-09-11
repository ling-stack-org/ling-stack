import type { Translate } from "../../i18n.js";
import type { ProviderThinkingMode, ReasoningSummaryMode } from "../../types.js";
import type { ConversationHomeModelOption } from "./normal-conversation-types.js";

export function normalConversationModelLabel(option: ConversationHomeModelOption): string {
  return option.label?.trim() || option.model;
}

export const reasoningSummaryOptions: readonly ReasoningSummaryMode[] = ["auto", "concise", "detailed", "none"];

export function reasoningSummaryLabel(mode: ReasoningSummaryMode, t: Translate): string {
  if (mode === "auto") return t("Automatic");
  if (mode === "concise") return t("Concise");
  if (mode === "detailed") return t("Detailed");
  return t("None");
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

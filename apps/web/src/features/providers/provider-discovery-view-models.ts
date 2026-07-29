import type { ProviderModelOption, ProviderThinkingMode } from "../../types.js";
import type { ProviderWorkbenchTranslate } from "./provider-workbench-view-models.js";

export function providerModelSourceLabel(source: string, t: ProviderWorkbenchTranslate): string {
  if (source === "builtin:generation-models" || source === "builtin:media-models") {
    return t("Built-in generation model candidates");
  }
  return source;
}

export function providerModelThinkingLabel(
  model: ProviderModelOption,
  t: ProviderWorkbenchTranslate,
): string {
  const modes = modelThinkingModes(model);
  if (modes.length === 0) return t("No thinking");
  return t("Thinking: {modes}", { modes: modes.map((mode) => providerThinkingModeLabel(mode, t)).join(" / ") });
}

export function providerModelCapabilitySourceLabel(
  model: ProviderModelOption,
  t: (key: string) => string,
): string {
  if (model.capabilitySource === "upstream") return t("Capability: provider");
  if (model.capabilitySource === "model_catalog") return t("Capability: Ling catalog");
  if (model.capabilitySource === "provider_template") return t("Capability: template");
  if (model.capabilitySource === "user_override") return t("Capability: custom");
  return t("Capability: unknown");
}

export function modelThinkingModes(model: ProviderModelOption): readonly ProviderThinkingMode[] {
  return providerOrderedThinkingModes(model.thinkingModes ?? []).filter((mode) => mode !== "off");
}

export function providerOrderedThinkingModes(modes: readonly ProviderThinkingMode[]): readonly ProviderThinkingMode[] {
  const selectedModes = new Set(modes);
  const order: readonly ProviderThinkingMode[] = ["off", "auto", "minimal", "low", "medium", "high", "xhigh"];
  return order.filter((mode) => selectedModes.has(mode));
}

export function providerThinkingModeLabel(mode: ProviderThinkingMode, t: (key: string) => string): string {
  switch (mode) {
    case "off": return t("Off");
    case "auto": return t("Auto");
    case "minimal": return t("Minimal");
    case "low": return t("Low");
    case "medium": return t("Medium");
    case "high": return t("High");
    case "xhigh": return t("XHigh");
  }
}
